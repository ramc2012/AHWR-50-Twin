# ahwr-central-mcp-server (read-only)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the **CRMF central facility** (fleet monitoring) to AI systems — **read-only**.

It uses a dedicated opaque `MCP_BACKEND_TOKEN`. The central backend recognizes
that credential as `mcp-readonly` and rejects every non-safe HTTP method before
route handling. The MCP process never receives the central JWT signing secret.
Transport is **streamable HTTP** (stateless JSON) at `POST /mcp`.

**Security:** serves HTTPS, requires authenticated access, validates Host and
Origin, rate-limits requests, and records the authenticated client id. API-key
mode is intended for loopback/trusted-workstation use. Remote multi-user
deployments use OAuth resource-server mode with issuer, audience, JWKS, and
scope validation.

## Tools (all read-only)

| Tool | Purpose |
|------|---------|
| `central_get_fleet` | All rigs + live status / health / alarms / sync lag |
| `central_get_fleet_summary` | Fleet KPI aggregates |
| `central_get_rig` | One rig's detail + rolled-up status |
| `central_get_rig_live` | One rig's live telemetry mirror |
| `central_get_rig_history` | Multi-metric history for a rig (`metrics`, `minutes`) |
| `central_get_rig_alarms` | A rig's alarm history |
| `central_get_rig_activity` | A rig's activity timeline (`hours`) |
| `central_get_alarms` | Fleet-wide active alarms (`priority` filter) |
| `central_get_data_quality` | Per-rig data-quality / completeness / freshness |
| `central_get_governance` | Rollout gates, escalations, decisions |
| `central_get_workover` | Cross-fleet workover analytics (`hours`) |
| `central_get_wells` | Fleet wells (`query`/`status`/`assetUnit`) |
| `central_get_maintenance_summary` | PM compliance + overdue/breakdown counts |
| `central_get_fleet_report` | Period-aware fleet report (`period`) |
| `central_list_tags` | Canonical tag dictionary (valid dataKeys) |

## Run (via the central stack)

Wired into `central/docker-compose.yml` as the `crmf-mcp` service:

```bash
cd central
docker compose --profile demo up -d --build      # brings up timescaledb, backend, fleet-sim, crmf-mcp, portal
# MCP endpoint: http://127.0.0.1:8766/mcp
```

Required local config: `MCP_BACKEND_TOKEN` (same opaque value on backend and
MCP, minimum 32 characters), `MCP_API_KEY`, and `BACKEND_URL`.
`MCP_API_KEY_ID` labels the client in audit records; `MCP_API_KEYS_JSON`
supports multiple client-id/key pairs.

Network controls: `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`,
`MCP_RATE_LIMIT_PER_MINUTE`, `MCP_TRUST_PROXY`,
`MCP_CENTRAL_BIND`/`MCP_CENTRAL_PORT`.

Remote OAuth mode uses `MCP_AUTH_MODE=oauth`, `MCP_PUBLIC_URL` (the full public
MCP endpoint, such as `https://mcp.example.com/mcp`),
`MCP_OAUTH_ISSUER`, `MCP_OAUTH_AUDIENCE`, `MCP_OAUTH_JWKS_URL`, and
`MCP_OAUTH_SCOPES`. The server publishes protected-resource metadata and
returns a standards-compatible `WWW-Authenticate` challenge.

## Scope

Read-only only — control/governance writes (gate changes, escalations, user/rig management) are intentionally **not** exposed.
The edge counterpart is `edge-mcp-server/` (per-rig). Central is monitoring-only by design.
