# ahwr-edge-mcp-server (read-only)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the **AHWR-50 edge rig digital twin** to AI systems — telemetry, derived KPIs, alarms, history, wells and efficiency — **read-only**.

It mints a `viewer`-role JWT (signed with the backend's `JWT_SECRET`), so the backend's RBAC rejects any write even if attempted. Transport is **streamable HTTP** (stateless JSON) at `POST /mcp`.

**Security:** serves **HTTPS** when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set (required for Cowork / claude.ai connectors), requires an **API key** (`MCP_API_KEY` → `Authorization: Bearer <key>`), and **audit-logs** every request. The compose stack mounts a self-signed cert for local use; use a CA-signed cert in production. Endpoint: `https://127.0.0.1:8765/mcp`.

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

Config (env): `JWT_SECRET` (shared with backend, required), `BACKEND_URL` (default `http://backend:5000`),
`MCP_API_KEY` (optional bearer guard on `/mcp`; empty = open on loopback),
`MCP_EDGE_BIND` / `MCP_EDGE_PORT` (host bind/port, default `127.0.0.1:8765`).

## Connect an AI client

Point any MCP client at the streamable-HTTP endpoint `http://127.0.0.1:8765/mcp`. If `MCP_API_KEY` is set, send `Authorization: Bearer <key>`.

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
npm install
JWT_SECRET=<same-as-backend> BACKEND_URL=http://127.0.0.1:8080 npm run dev
```

## Scope

Read-only only. Control actions (alarm ack, calibration, config, well lifecycle) are intentionally **not** exposed.
A central-facility MCP server (fleet-wide) is a separate follow-up.
