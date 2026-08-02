#!/usr/bin/env node
/**
 * CRMF Central MCP Server (READ-ONLY).
 *
 * Exposes the central fleet-monitoring facility to AI systems via MCP: fleet
 * status, per-rig drill-down, fleet-wide alarms, data quality, governance
 * rollout, workover performance, wells, maintenance and reports. Read-only:
 * a dedicated opaque service credential is accepted by the backend only for
 * safe HTTP methods. Streamable HTTP transport at /mcp.
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
const BACKEND_URL = process.env.BACKEND_URL || "http://crmf-backend:6000";
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
        case 401: return "Error: central backend rejected the MCP read-only service credential.";
        case 403: return "Error: permission denied (this MCP server is read-only).";
        case 404: return "Error: resource not found. Check the rig id / parameters.";
        default: return `Error: central request failed with status ${error.response.status}.`;
      }
    }
    if (error.code === "ECONNABORTED") return "Error: request to the central backend timed out.";
    if (error.code === "ECONNREFUSED") return `Error: cannot reach the central backend at ${BACKEND_URL}.`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

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
      note: "Response truncated; narrow your query (fewer metrics / shorter window / a specific rig).",
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

// --- Server + tools --------------------------------------------------------
function createMcpServer(): McpServer {
const server = new McpServer({ name: "ahwr-central-mcp-server", version: "1.1.0" });

server.registerTool("central_get_fleet", {
  title: "Get fleet status",
  description:
    "Return all rigs in the fleet with live status (online/degraded/stale/offline/pending), health score (0-100), " +
    "active job/activity, alarm counts by priority, and sync lag. Read-only. Use for 'how is the whole fleet doing'.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/fleet")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_fleet_summary", {
  title: "Get fleet KPI summary",
  description: "Return fleet-wide KPI aggregates: rig counts by status, average health, total alarms by priority. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/fleet/summary")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig", {
  title: "Get a single rig's detail",
  description: "Return one rig's metadata + rolled-up live status (health, alarms, active job, last-data time). Read-only.",
  inputSchema: { rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3' (discover ids via central_get_fleet).") },
  annotations: RO,
}, async ({ rigId }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}`)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_live", {
  title: "Get a rig's live telemetry mirror",
  description: "Return the latest telemetry snapshot mirrored from a rig (same shape as the edge HMI). Read-only.",
  inputSchema: { rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'.") },
  annotations: RO,
}, async ({ rigId }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/live`)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_history", {
  title: "Get a rig's historical telemetry",
  description:
    "Return multi-metric time-series history for a rig. Provide `metrics` as comma-separated dataKeys " +
    "(e.g. 'drilling.rop,drawworks.hook_load') and `minutes` of trailing window. Read-only.",
  inputSchema: {
    rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'."),
    metrics: METRICS.describe("1-20 comma-separated dataKeys, e.g. 'drilling.rop,mudpump.pressure'."),
    minutes: z.number().int().min(1).max(10080).default(60).describe("Trailing window in minutes (default 60, max 10080 = 7d)."),
  },
  annotations: RO,
}, async ({ rigId, metrics, minutes }) => {
  try {
    const rows = await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/history-multi`, { metrics, minutes });
    return jsonResult({ rigId, metrics: metrics.split(",").map((m) => m.trim()), minutes, rows });
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_alarms", {
  title: "Get a rig's alarm history",
  description: "Return alarm events and state transitions for a specific rig. Read-only.",
  inputSchema: { rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'.") },
  annotations: RO,
}, async ({ rigId }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/alarms`)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_rig_activity", {
  title: "Get a rig's activity timeline",
  description: "Return the workover activity timeline for a rig (phase segments, productive vs NPT). Read-only.",
  inputSchema: {
    rigId: z.string().min(1).describe("Rig id, e.g. 'AHWR-50-3'."),
    hours: z.number().int().min(1).max(168).default(24).describe("Trailing window in hours (default 24)."),
  },
  annotations: RO,
}, async ({ rigId, hours }) => {
  try { return jsonResult(await apiGet(`/api/rigs/${encodeURIComponent(rigId)}/activity`, { hours })); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_alarms", {
  title: "Get fleet-wide active alarms",
  description: "Return active alarms across the whole fleet, optionally filtered by priority. Read-only.",
  inputSchema: { priority: z.enum(["P1", "P2", "P3"]).optional().describe("Filter to a single priority (P1/P2/P3).") },
  annotations: RO,
}, async ({ priority }) => {
  try { return jsonResult(await apiGet("/api/alarms", priority ? { priority } : undefined)); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_data_quality", {
  title: "Get fleet data-quality",
  description: "Return per-rig data-quality: health scores, metric completeness, and freshness/staleness. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/data-quality")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_governance", {
  title: "Get rollout governance",
  description: "Return the stage-gate rollout funnel (per-rig gate/commissioning/adoption), open escalations, and decisions. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/governance")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_workover", {
  title: "Get fleet workover performance",
  description: "Return cross-fleet workover analytics over a trailing window: ROP, WOB, connection quality, efficiency, NPT. Read-only.",
  inputSchema: { hours: z.number().int().min(1).max(720).default(24).describe("Trailing window in hours (default 24).") },
  annotations: RO,
}, async ({ hours }) => {
  try { return jsonResult(await apiGet("/api/workover", { hours })); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_wells", {
  title: "List fleet wells",
  description: "Return wells across the fleet (status, asset unit, field), optionally filtered. Read-only.",
  inputSchema: {
    query: z.string().max(80).optional().describe("Free-text search (well name/field)."),
    status: z.string().max(40).optional().describe("Filter by status (e.g. active, completed, planned)."),
    assetUnit: z.string().max(80).optional().describe("Filter by asset unit."),
  },
  annotations: RO,
}, async ({ query, status, assetUnit }) => {
  try {
    const params: Record<string, unknown> = {};
    if (query) params.q = query;
    if (status) params.status = status;
    if (assetUnit) params.assetUnit = assetUnit;
    return jsonResult(await apiGet("/api/wells", params));
  } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_maintenance_summary", {
  title: "Get fleet maintenance summary",
  description: "Return PM compliance %, overdue counts, and breakdown counts per rig + fleet aggregate. Read-only.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/maintenance/summary")); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_get_fleet_report", {
  title: "Get fleet operations report",
  description: "Return a period-aware fleet operations report (KPIs aggregated). Read-only.",
  inputSchema: { period: z.enum(["snapshot", "daily", "weekly", "monthly"]).default("snapshot").describe("Report period (default snapshot).") },
  annotations: RO,
}, async ({ period }) => {
  try { return jsonResult(await apiGet("/api/reports/fleet", { period })); } catch (e) { return errResult(handleApiError(e)); }
});

server.registerTool("central_list_tags", {
  title: "List the standard tag dictionary",
  description: "Return the canonical telemetry tag dictionary the central expects (metric, unit, group). Read-only — use to learn valid dataKeys for central_get_rig_history.",
  inputSchema: {},
  annotations: RO,
}, async () => {
  try { return jsonResult(await apiGet("/api/config/tags")); } catch (e) { return errResult(handleApiError(e)); }
});
return server;
}

// --- Streamable HTTP transport (stateless JSON) ----------------------------
const app = express();
app.set("trust proxy", process.env.MCP_TRUST_PROXY === "true" ? 1 : false);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "ahwr-central-mcp-server", backend: BACKEND_URL, tls: !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) });
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
    res.setHeader("WWW-Authenticate", 'Bearer realm="ahwr-central-mcp"');
  }
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

// Audit log every MCP request (who/when/what) — attribution for read access.
function auditLog(req: Request, auth: AuthContext | null) {
  const body = (req.body || {}) as { method?: string; params?: { name?: string } };
  console.error(JSON.stringify({
    ts: new Date().toISOString(), evt: "mcp", server: "central",
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
    console.error(`ahwr-central-mcp-server (read-only, TLS+${MCP_AUTH_MODE}) on https://0.0.0.0:${PORT}/mcp  → central ${BACKEND_URL}`);
  });
  installShutdownHandlers(httpServer);
} else {
  const httpServer = app.listen(PORT, () => {
    console.error(`ahwr-central-mcp-server (read-only, HTTP+${MCP_AUTH_MODE}) on http://0.0.0.0:${PORT}/mcp  → central ${BACKEND_URL}`);
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
