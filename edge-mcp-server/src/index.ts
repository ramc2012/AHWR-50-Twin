#!/usr/bin/env node
/**
 * AHWR-50 Edge MCP Server (READ-ONLY).
 *
 * Exposes the edge rig digital twin's live + historical data to AI systems via
 * the Model Context Protocol. Every tool is read-only: the server mints a
 * `viewer`-role JWT (signed with the shared backend secret), so the backend's
 * RBAC rejects any write even if attempted. Transport is streamable HTTP
 * (stateless JSON) so remote AI clients can connect over the network.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { z } from "zod";
import https from "node:https";
import fs from "node:fs";

// --- Config ----------------------------------------------------------------
const BACKEND_URL = process.env.BACKEND_URL || "http://backend:5000";
const PORT = parseInt(process.env.PORT || "3000", 10);
const JWT_SECRET = process.env.JWT_SECRET || "";
const MCP_API_KEY = process.env.MCP_API_KEY || ""; // optional bearer guard on /mcp
const CHARACTER_LIMIT = 25000;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error("FATAL: JWT_SECRET env var is required (>=16 chars) to mint the read-only backend token.");
  process.exit(1);
}

// --- Auth: mint + cache a viewer JWT (read-only by construction) -----------
let cached: { token: string; exp: number } | null = null;
function viewerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const token = jwt.sign({ sub: 0, username: "mcp-readonly", role: "viewer" }, JWT_SECRET, { expiresIn: "1h" });
  cached = { token, exp: now + 3600 };
  return token;
}

// --- Shared HTTP helper ----------------------------------------------------
async function apiGet<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await axios.get<T>(`${BACKEND_URL}${path}`, {
    params,
    timeout: 30000,
    headers: { Authorization: `Bearer ${viewerToken()}`, Accept: "application/json" },
  });
  return res.data;
}

function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      switch (error.response.status) {
        case 401: return "Error: Backend rejected the read-only token (check JWT_SECRET matches the backend).";
        case 403: return "Error: Permission denied (this MCP server is read-only).";
        case 404: return "Error: Resource not found. Check the parameter values.";
        case 503: return "Error: Backend unavailable (no live data source). Try again shortly.";
        default: return `Error: backend request failed with status ${error.response.status}.`;
      }
    }
    if (error.code === "ECONNABORTED") return "Error: request to the edge backend timed out.";
    if (error.code === "ECONNREFUSED") return `Error: cannot reach the edge backend at ${BACKEND_URL}.`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

// Consistent JSON tool result (text + structuredContent), with truncation.
function jsonResult(obj: unknown) {
  let text = JSON.stringify(obj, null, 2);
  let structured: unknown = obj;
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n… [truncated at ${CHARACTER_LIMIT} chars — narrow the query]`;
    structured = { truncated: true, note: "Response truncated; narrow your query (e.g. fewer metrics or a shorter range).", preview: obj };
  }
  return { content: [{ type: "text" as const, text }], structuredContent: structured as Record<string, unknown> };
}
function errResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// --- Server + tools --------------------------------------------------------
const server = new McpServer({ name: "ahwr-edge-mcp-server", version: "1.0.0" });

server.registerTool("edge_get_rig_snapshot", {
  title: "Get rig telemetry snapshot",
  description:
    "Return the latest full telemetry snapshot from the edge rig (one frame). Includes every subsystem group " +
    "(drilling, drawworks, mudpump, fluid, hpu, htd, pct, cat_engine, cwk, well_control, safety, wellhead, acs), " +
    "the server-computed derived KPIs (_kpi.*: mse, ecd, ann_velocity, spp_dev_pct, overpull, friction, kick/loss_confidence, etc.), " +
    "alarm counts (_alarms), current workover activity (_activity), and feed freshness (_meta: source, stale, age_ms). " +
    "Read-only. Use this for 'what is the rig doing right now'.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/rig/latest")); }
  catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_list_parameters", {
  title: "List all alarmable parameters (catalog)",
  description:
    "List every parameter available on the rig — raw tags AND derived KPIs — each with its current live value, unit, " +
    "group, and whether it is a derived KPI. Use this to discover signal names (dataKeys like 'drawworks.hook_load' or " +
    "'_kpi.mse') before calling edge_get_history, or to answer 'what can I monitor'. Read-only.",
  inputSchema: {
    query: z.string().max(80).optional().describe("Case-insensitive filter on dataKey or label (e.g. 'pressure', 'mse')."),
    group: z.string().max(40).optional().describe("Filter to one group (e.g. 'drilling', 'well_control', '_kpi')."),
  },
  annotations: RO,
}, async ({ query, group }) => {
  try {
    const all = await apiGet<Array<Record<string, unknown>>>("/api/alarms/catalog");
    const q = (query || "").toLowerCase();
    const list = all.filter((p) =>
      (!group || String(p.group) === group) &&
      (!q || String(p.dataKey).toLowerCase().includes(q) || String(p.label || "").toLowerCase().includes(q)));
    return jsonResult({ total: list.length, parameters: list });
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_alarms", {
  title: "Get active alarms",
  description:
    "Return the currently active alarms (the ISA-18.2 state machine: UNACK / ACK / RTN_UNACK) with priority (P1/P2/P3), " +
    "condition (HI/HIHI/LO/LOLO), breaching value vs limit, and counts by priority. Read-only — does not acknowledge anything.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/alarms")); }
  catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_alarm_config", {
  title: "Get alarm rule configuration",
  description:
    "Return the configured alarm rules (per-parameter setpoints): dataKey, label, priority, hi/hiHi/lo/loLo limits, " +
    "deadband, on-delay, enabled flag. Read-only — to see what would alarm and at what thresholds.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/alarms/config")); }
  catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_history", {
  title: "Get historical telemetry",
  description:
    "Return historical time-series for one or more parameters from the historian. Provide `metrics` as comma-separated " +
    "dataKeys (e.g. 'drilling.rop,drawworks.hook_load') — discover names via edge_list_parameters — and a `range` such as " +
    "'-15m', '-1h', '-4h', '-24h'. Read-only. Use for trends and 'how did X change over the last hour'.",
  inputSchema: {
    metrics: z.string().min(1).describe("Comma-separated dataKeys, e.g. 'drilling.rop,mudpump.pressure'."),
    range: z.string().regex(/^-\d+[mhd]$/, "Use a relative range like -15m, -1h, -24h").default("-15m")
      .describe("Relative time range: -15m, -1h, -4h, -24h (default -15m)."),
  },
  annotations: RO,
}, async ({ metrics, range }) => {
  try {
    const rows = await apiGet("/api/history", { metrics, range });
    return jsonResult({ metrics: metrics.split(",").map((m) => m.trim()), range, rows });
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_efficiency", {
  title: "Get rig energy/efficiency analytics",
  description:
    "Return the rig's power & energy analytics: per-circuit hydraulic kW (mud/HTD/pulldown), rotation efficiency, engine kW, " +
    "fuel burn (L/h), conversion %, and load-sense margin. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/efficiency")); }
  catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_health", {
  title: "Get edge health & data freshness",
  description:
    "Return edge node health: whether the historian is live, telemetry data age/staleness, and central-sync status " +
    "(connected, buffered batches, ack lag). Read-only. Use to judge whether the live data can be trusted.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/health/edge")); }
  catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_wells", {
  title: "List wells and the active well",
  description:
    "Return the well registry for this rig (status: pending/active/complete) plus the currently active well, if any. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try {
    const [wells, active] = await Promise.all([
      apiGet("/api/wells").catch(() => []),
      apiGet("/api/wells/active").catch(() => null),
    ]);
    return jsonResult({ activeWell: active, wells });
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("edge_get_activity", {
  title: "Get current workover activity",
  description:
    "Return the current auto-detected workover activity/phase (e.g. CIRCULATE, RIH, POOH, MAKE_UP, IDLE), whether it is " +
    "productive, and any NPT reason. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/activity/current")); }
  catch (e) { return errResult(handleApiError(e)); }
});

// --- Streamable HTTP transport (stateless JSON) ----------------------------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "ahwr-edge-mcp-server", backend: BACKEND_URL, tls: !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) });
});

// Optional bearer guard so not just anyone on the network can call the tools.
function authorized(req: Request): boolean {
  if (!MCP_API_KEY) return true; // unset = open (intended for trusted/loopback deployments)
  const h = req.headers["authorization"];
  return typeof h === "string" && h === `Bearer ${MCP_API_KEY}`;
}

// Audit log every MCP request (who/when/what) — attribution for read access.
function auditLog(req: Request, ok: boolean) {
  const body = (req.body || {}) as { method?: string; params?: { name?: string } };
  console.error(JSON.stringify({
    ts: new Date().toISOString(), evt: "mcp", server: "edge",
    ip: req.ip, method: body.method || null, tool: body.params?.name || null, authorized: ok,
  }));
}

app.post("/mcp", async (req: Request, res: Response) => {
  const ok = authorized(req);
  auditLog(req, ok);
  if (!ok) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  // New transport per request → stateless, no request-id collisions.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// Serve HTTPS when a cert+key are provided (required for Cowork / claude.ai
// remote connectors); otherwise fall back to HTTP for trusted loopback dev.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;
if (TLS_CERT_FILE && TLS_KEY_FILE) {
  const creds = { cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) };
  https.createServer(creds, app).listen(PORT, () => {
    console.error(`ahwr-edge-mcp-server (read-only, TLS${MCP_API_KEY ? "+auth" : ""}) on https://0.0.0.0:${PORT}/mcp  → backend ${BACKEND_URL}`);
  });
} else {
  app.listen(PORT, () => {
    console.error(`ahwr-edge-mcp-server (read-only, HTTP${MCP_API_KEY ? "+auth" : ""}) on http://0.0.0.0:${PORT}/mcp  → backend ${BACKEND_URL}`);
  });
}
