# ahwr-edge-mcp-server (read-only)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the **AHWR-50 edge rig digital twin** to AI systems — telemetry, derived KPIs, alarms, history, wells and efficiency — **read-only**.

It uses a dedicated opaque `MCP_BACKEND_TOKEN`. The backend recognizes that
credential as `mcp-readonly` and rejects every non-safe HTTP method before route
handling. The MCP process never receives the backend's JWT signing secret.
Transport is **streamable HTTP** (stateless JSON) at `POST /mcp`.

**Security:** serves **HTTPS** when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set,
requires authenticated access, validates Host and Origin, rate-limits requests,
and audit-logs the authenticated client id. The default `api-key` mode is for a
loopback/trusted workstation. Remote multi-user deployments use the OAuth
resource-server mode with issuer, audience, JWKS, and scope validation.

## Tools (all read-only)

| Tool | Purpose |
|------|---------|
| `edge_get_rig_snapshot` | Latest full telemetry frame (all subsystems + `_kpi.*` + `_alarms` + `_activity` + `_meta`) |
| `edge_list_parameters` | Catalog of every parameter (raw + derived KPI) with live value/unit; filter by `query`/`group` |
| `edge_get_alarms` | Active alarms (ISA-18.2 state machine) + counts |
| `edge_get_alarm_config` | Configured alarm rules / setpoints |
| `edge_get_history` | Historical series for `metrics` (comma-separated dataKeys) over a `range` (`-15m`, `-1h`, …) |
| `edge_get_efficiency` | Power/energy analytics (circuit kW, fuel, efficiency) |
| `edge_get_health` | Edge health + data freshness + sync status |
| `edge_get_wells` | Well registry + active well |
| `edge_get_activity` | Current workover activity/phase + NPT |

## Run (via the rig stack)

It's wired into `docker-compose.yml` as the `mcp-edge` service:

```bash
docker compose up -d --build mcp-edge
# MCP endpoint: http://127.0.0.1:8765/mcp   (loopback-only by default)
```

Required local config: `MCP_BACKEND_TOKEN` (same opaque value on backend and
MCP, minimum 32 characters), `MCP_API_KEY` (client-facing key), and
`BACKEND_URL`. `MCP_API_KEY_ID` labels the client in audit records.
`MCP_API_KEYS_JSON` can supply multiple attributable client keys, for example
`{"codex":"...","ops-assistant":"..."}`.

Network controls: `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`,
`MCP_RATE_LIMIT_PER_MINUTE`, `MCP_TRUST_PROXY`, `MCP_EDGE_BIND`, and
`MCP_EDGE_PORT`.

For remote OAuth mode set `MCP_AUTH_MODE=oauth`, `MCP_PUBLIC_URL` (the full
public MCP endpoint, such as `https://mcp.example.com/mcp`),
`MCP_OAUTH_ISSUER`, `MCP_OAUTH_AUDIENCE`, `MCP_OAUTH_JWKS_URL`, and
`MCP_OAUTH_SCOPES`. The server publishes
`/.well-known/oauth-protected-resource` and returns the corresponding
`WWW-Authenticate` challenge.

## Connect an AI client

Point an MCP client at `https://127.0.0.1:8765/mcp` and send
`Authorization: Bearer <key>`.

Quick check with curl (JSON-RPC):

```bash
curl -sk https://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
(`-k` accepts the local self-signed cert. For Node-based MCP clients like Claude Code, trust it with `NODE_EXTRA_CA_CERTS=<repo>/certs/mcp.crt`.)

## Local dev

```bash
npm ci
MCP_BACKEND_TOKEN=<opaque-readonly-token> MCP_API_KEY=<client-key> \
  BACKEND_URL=http://127.0.0.1:8080 npm run dev
```

## Scope

Read-only only. Control actions (alarm ack, calibration, config, well lifecycle)
are intentionally **not** exposed. Tool responses and upstream payloads are
bounded; history accepts at most 20 metrics and 30 days per request.
