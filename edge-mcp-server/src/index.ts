#!/usr/bin/env node
/**
 * AHWR-50 Edge MCP Server (READ-ONLY).
 *
 * Exposes the edge rig digital twin's live + historical data to AI systems via
 * the Model Context Protocol. Every tool is read-only: the server authenticates
 * upstream with a dedicated opaque service credential that the backend accepts
 * only for safe HTTP methods. Transport is streamable HTTP
 * (stateless JSON) so remote AI clients can connect over the network.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import axios from "axios";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import https from "node:https";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";

// --- Config ----------------------------------------------------------------
const BACKEND_URL = process.env.BACKEND_URL || "http://backend:5000";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MCP_BACKEND_TOKEN = process.env.MCP_BACKEND_TOKEN || "";
const MCP_AUTH_MODE = (process.env.MCP_AUTH_MODE || "api-key").toLowerCase();
const MCP_API_KEY = process.env.MCP_API_KEY || "";
const MCP_API_KEY_ID = process.env.MCP_API_KEY_ID || "local";
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || "";
const MCP_OAUTH_ISSUER = process.env.MCP_OAUTH_ISSUER || "";
const MCP_OAUTH_AUDIENCE = process.env.MCP_OAUTH_AUDIENCE || MCP_PUBLIC_URL;
const MCP_OAUTH_JWKS_URL = process.env.MCP_OAUTH_JWKS_URL ||
  (MCP_OAUTH_ISSUER ? `${MCP_OAUTH_ISSUER.replace(/\/$/, "")}/.well-known/jwks.json` : "");
const MCP_OAUTH_SCOPES = (process.env.MCP_OAUTH_SCOPES || "mcp:tools").split(/\s+/).filter(Boolean);
const MCP_ALLOWED_ORIGINS = new Set(
  (process.env.MCP_ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean),
);
const MCP_ALLOWED_HOSTS = new Set(
  (process.env.MCP_ALLOWED_HOSTS || "127.0.0.1,localhost,[::1]").split(",")
    .map((v) => v.trim().toLowerCase()).filter(Boolean),
);
const CHARACTER_LIMIT = 25000;
const MAX_BACKEND_BYTES = 1_000_000;

if (!MCP_BACKEND_TOKEN || MCP_BACKEND_TOKEN.length < 32) {
  console.error("FATAL: MCP_BACKEND_TOKEN env var is required (>=32 chars).");
  process.exit(1);
}
if (!["api-key", "oauth"].includes(MCP_AUTH_MODE)) {
  console.error("FATAL: MCP_AUTH_MODE must be 'api-key' or 'oauth'.");
  process.exit(1);
}
if (MCP_AUTH_MODE === "api-key" && !MCP_API_KEY && !process.env.MCP_API_KEYS_JSON) {
  console.error("FATAL: API-key mode requires MCP_API_KEY or MCP_API_KEYS_JSON.");
  process.exit(1);
}
if (MCP_AUTH_MODE === "oauth" &&
    (!MCP_PUBLIC_URL || !MCP_OAUTH_ISSUER || !MCP_OAUTH_AUDIENCE || !MCP_OAUTH_JWKS_URL)) {
  console.error("FATAL: OAuth mode requires MCP_PUBLIC_URL, MCP_OAUTH_ISSUER, MCP_OAUTH_AUDIENCE, and a JWKS URL.");
  process.exit(1);
}

type AuthContext = { clientId: string; mode: "api-key" | "oauth"; subject?: string };
type ApiCredential = { clientId: string; secret: string };

function loadApiCredentials(): ApiCredential[] {
  const credentials: ApiCredential[] = [];
  if (MCP_API_KEY.length >= 16) credentials.push({ clientId: MCP_API_KEY_ID, secret: MCP_API_KEY });
  const raw = process.env.MCP_API_KEYS_JSON;
  if (!raw) return credentials;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [clientId, secret] of Object.entries(parsed)) {
      if (clientId && typeof secret === "string" && secret.length >= 16) {
        credentials.push({ clientId, secret });
      }
    }
  } catch {
    console.error("FATAL: MCP_API_KEYS_JSON must be a JSON object mapping client ids to secrets.");
    process.exit(1);
  }
  return credentials;
}

const API_CREDENTIALS = loadApiCredentials();
if (MCP_AUTH_MODE === "api-key" && API_CREDENTIALS.length === 0) {
  console.error("FATAL: API-key credentials must be at least 16 characters.");
  process.exit(1);
}
const OAUTH_JWKS = MCP_AUTH_MODE === "oauth" ? createRemoteJWKSet(new URL(MCP_OAUTH_JWKS_URL)) : null;

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Shared HTTP helper ----------------------------------------------------
async function apiGet<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await axios.get<T>(`${BACKEND_URL}${path}`, {
    params,
    timeout: 30000,
    maxContentLength: MAX_BACKEND_BYTES,
    maxBodyLength: MAX_BACKEND_BYTES,
    headers: { Authorization: `Bearer ${MCP_BACKEND_TOKEN}`, Accept: "application/json" },
  });
  return res.data;
}

function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      switch (error.response.status) {
        case 401: return "Error: Backend rejected the MCP read-only service credential.";
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
  let structured: Record<string, unknown> =
    obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? obj as Record<string, unknown>
      : { data: obj };
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n… [truncated at ${CHARACTER_LIMIT} chars — narrow the query]`;
    structured = {
      truncated: true,
      note: "Response truncated; narrow your query (e.g. fewer metrics or a shorter range).",
    };
  }
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}
function errResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const METRICS = z.string().min(1).max(1000)
  .refine((value) => {
    const metrics = value.split(",").map((metric) => metric.trim()).filter(Boolean);
    return metrics.length > 0 && metrics.length <= 20;
  }, "Provide between 1 and 20 comma-separated metrics.");
const RANGE = z.string().regex(/^-\d+[mhd]$/, "Use a relative range like -15m, -1h, -24h")
  .refine((value) => {
    const match = /^-(\d+)([mhd])$/.exec(value);
    if (!match) return false;
    const amount = Number(match[1]);
    const multiplier = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
    return amount > 0 && amount * multiplier <= 30 * 86_400_000;
  }, "Range must be positive and no longer than 30 days.");

// --- Server + tools --------------------------------------------------------
function createMcpServer(): McpServer {
const server = new McpServer({ name: "ahwr-edge-mcp-server", version: "1.1.0" });

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
    metrics: METRICS.describe("1-20 comma-separated dataKeys, e.g. 'drilling.rop,mudpump.pressure'."),
    range: RANGE.default("-15m")
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
return server;
}

// --- Streamable HTTP transport (stateless JSON) ----------------------------
const app = express();
app.set("trust proxy", process.env.MCP_TRUST_PROXY === "true" ? 1 : false);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "ahwr-edge-mcp-server", backend: BACKEND_URL, tls: !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) });
});

function requestIsFromAllowedOrigin(req: Request): boolean {
  const host = req.hostname?.toLowerCase();
  if (!host) return false;
  if (!MCP_ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  return typeof origin !== "string" || MCP_ALLOWED_ORIGINS.has(origin);
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function oauthClientId(payload: JWTPayload): string {
  const clientId = payload.client_id ?? payload.azp ?? payload.sub;
  return typeof clientId === "string" && clientId ? clientId : "oauth-client";
}

async function authorize(req: Request): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;
  if (MCP_AUTH_MODE === "api-key") {
    const credential = API_CREDENTIALS.find((candidate) => secureEqual(token, candidate.secret));
    return credential ? { clientId: credential.clientId, mode: "api-key" } : null;
  }
  try {
    const { payload } = await jwtVerify(token, OAUTH_JWKS!, {
      issuer: MCP_OAUTH_ISSUER,
      audience: MCP_OAUTH_AUDIENCE,
    });
    const scopes = new Set(typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []);
    if (!MCP_OAUTH_SCOPES.every((scope) => scopes.has(scope))) return null;
    return { clientId: oauthClientId(payload), mode: "oauth", subject: payload.sub };
  } catch {
    return null;
  }
}

function unauthorized(res: Response): void {
  if (MCP_AUTH_MODE === "oauth") {
    const metadataUrl = new URL("/.well-known/oauth-protected-resource", MCP_PUBLIC_URL).toString();
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
  } else {
    res.setHeader("WWW-Authenticate", 'Bearer realm="ahwr-edge-mcp"');
  }
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

// Audit log every MCP request (who/when/what) — attribution for read access.
function auditLog(req: Request, auth: AuthContext | null) {
  const body = (req.body || {}) as { method?: string; params?: { name?: string } };
  console.error(JSON.stringify({
    ts: new Date().toISOString(), evt: "mcp", server: "edge",
    ip: req.ip, method: body.method || null, tool: body.params?.name || null,
    authorized: !!auth, client_id: auth?.clientId || null, subject: auth?.subject || null,
    auth_mode: auth?.mode || null,
  }));
}

const mcpLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.MCP_RATE_LIMIT_PER_MINUTE || 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const activeTransports = new Set<StreamableHTTPServerTransport>();

if (MCP_AUTH_MODE === "oauth") {
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: MCP_PUBLIC_URL,
      authorization_servers: [MCP_OAUTH_ISSUER],
      scopes_supported: MCP_OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
}

app.post("/mcp", mcpLimiter, async (req: Request, res: Response) => {
  if (!requestIsFromAllowedOrigin(req)) {
    res.status(403).json({ jsonrpc: "2.0", error: { code: -32002, message: "Forbidden origin or host" }, id: null });
    return;
  }
  const authContext = await authorize(req);
  auditLog(req, authContext);
  if (!authContext) return unauthorized(res);
  // New transport per request → stateless, no request-id collisions.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const requestServer = createMcpServer();
  activeTransports.add(transport);
  res.on("close", () => {
    activeTransports.delete(transport);
    void transport.close();
  });
  try {
    await requestServer.connect(transport);
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
  const httpServer = https.createServer(creds, app).listen(PORT, () => {
    console.error(`ahwr-edge-mcp-server (read-only, TLS+${MCP_AUTH_MODE}) on https://0.0.0.0:${PORT}/mcp  → backend ${BACKEND_URL}`);
  });
  installShutdownHandlers(httpServer);
} else {
  const httpServer = app.listen(PORT, () => {
    console.error(`ahwr-edge-mcp-server (read-only, HTTP+${MCP_AUTH_MODE}) on http://0.0.0.0:${PORT}/mcp  → backend ${BACKEND_URL}`);
  });
  installShutdownHandlers(httpServer);
}

function installShutdownHandlers(httpServer: ReturnType<typeof app.listen>): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down MCP server.`);
    await Promise.allSettled([...activeTransports].map((transport) => transport.close()));
    httpServer.close((error) => process.exit(error ? 1 : 0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}
