# CRMF — Centralised Rig Monitoring Facility

A **separately deployable** central platform for the ONGC AHWR fleet, implementing
the *Central Facility* of the DGC proposal (§3 architecture, §5 hardware sizing,
§6 software requirements). It aggregates live data from up to 50+ rig-edge digital
twins and provides fleet-wide surveillance, a data-quality monitor, an alarm
command centre, a workover-performance view, automated reporting, and a governance
& rollout workspace.

> **Monitoring-only.** The CRMF only ever *receives* telemetry and events from the
> rig edge. There is no path from this platform back to any rig or PLC, by design
> (proposal §6.6; ESD/lockout surface as read-only alarms on the top alarm strip).

This project is fully self-contained and **does not modify the rig-edge app**. The
edge's existing store-and-forward sync agent (`../backend/lib/sync.js`) already
POSTs gzipped batches to `/ingest` in exactly the contract this backend accepts —
point its `CENTRAL_URL` here and a real rig streams in with zero code changes.

---

## Quickstart (demo fleet)

```bash
cd central
cp .env.example .env
# No credential ships with a working default any more. Fill in, each with a fresh
# `openssl rand -hex 32`:  PGPASSWORD, JWT_SECRET, MCP_BACKEND_TOKEN, ADMIN_PASSWORD
# and INGEST_TOKEN (the demo fleet-sim authenticates with it).
docker compose --profile demo up -d --build
```

Open **http://localhost:8090** and sign in (or **https://localhost:8443** once a cert
and key are placed in `central/certs/` — see `.env.example` → "Portal TLS"; nginx adds
the HTTPS listener automatically when they exist, and does nothing when they do not):

| User | Password | Role |
|------|----------|------|
| `admin` | `admin123` | admin (edit governance) |
| `operator` | `operator123` | operator |
| `viewer` | `viewer123` | viewer (read-only) |

The `demo` profile starts a **fleet simulator** that emulates ~14 rig-edge sync
agents (1 Hz × 100 channels, store-and-forward batches). One rig is intentionally
*degraded* (missing tags → lower health score) and one is *flaky* (drops offline
and recovers) so the data-quality monitor and alarm command centre show live,
meaningful state. The remaining 36 rigs sit in earlier rollout stages (pending /
implementation) to exercise the governance workspace.

To run **without** the simulator (production-shaped), drop the profile:

```bash
docker compose up -d --build
```

…then point real rig-edge agents at `http://<this-host>:6000` via their
`CENTRAL_URL`.

---

## Architecture

```
 rig-edge sync agents ──HTTPS gzip batches──▶  crmf-backend (/ingest)
 (store-and-forward,     X-Device-Id + token        │
  proposal §6.3)                                     ├─▶ TimescaleDB  (telemetry hypertable,
                                                     │     1-min continuous aggregate, compression)
                                                     ├─▶ PostgreSQL   (rig/tag/governance masters)
                                                     └─▶ Socket.IO ──▶ crmf-frontend (fleet portal)
```

| Service | Tech | Role |
|---------|------|------|
| `timescaledb` | TimescaleDB 2.17 / PostgreSQL 16 | Canonical telemetry + relational store (proposal §6.4) |
| `crmf-backend` | Node.js, Express, Socket.IO, `pg` | Ingestion, fleet API, live updates, RBAC |
| `crmf-frontend` | React 18, Vite, MUI, Recharts, nginx | Fleet portal UI |
| `fleet-sim` *(demo)* | Node.js | Emulates rig-edge sync agents |

The stack mirrors the rig-edge app's technology choices so the two are operationally
consistent.

---

## Portal modules (proposal §6.1)

- **Fleet Overview** — KPI bar, geographic field map, searchable/filterable rig list with live status, data-quality and alarm rollups.
- **Rig Drill-Down** — per-rig KPIs, live trend charts (TimescaleDB-backed), equipment/parameter groups, alarm and torque-turn connection history, deployment status.
- **Alarm Command Centre** — cross-rig active alarms, priority filters, P1 (ESD/lockout/well-control) surfacing.
- **Data Quality Monitor** — per-rig freshness + tag-completeness health score, sync-lag and stale/missing-tag flags.
- **Workover Performance** — torque-turn connection quality and fleet benchmarking, activity/NPT feed.
- **Governance & Rollout Workspace** — stage-gate funnel, per-rig rollout status (editable), value-realization KPIs (§7), escalation register, decision log.
- **Reports** — consolidated fleet operations report + CSV export.
- **Config Registry** — standard tag dictionary (§4.4) and rig master.

---

## Ingestion contract

`POST /ingest` accepts the edge sync agent's native payload:

```
Headers: X-Device-Id, X-Schema-Version, Content-Encoding: gzip,
         Authorization: Bearer <device-token>   (optional)
Body (gzipped JSON):
{ "seq": 123, "deviceId": "AHWR-50-3", "schemaVersion": "1.0",
  "createdAt": "<ISO>",
  "channels": [ { "ts": "<ISO>", "values": { "drawworks.hook_load": 96.2, ... } } ],
  "events":   [ { "ts": "<ISO>", "type": "alarm|connection|activity", "payload": {...} } ] }
Response: { "ack": true, "seq": 123, "receivedPoints": N, "receivedEvents": M }
```

Unknown devices auto-register as **pending** rigs so onboarding is visible in the
governance workspace.

---

## Connecting the existing rig-edge app

In the edge stack's `.env` (repo root), set:

```env
CENTRAL_URL=https://<crmf-host>:8443      # portal nginx terminates TLS and proxies /ingest
DEVICE_ID=AHWR-50-3
DEVICE_TOKEN=<per-rig device token>       # from POST /api/rigs, or the global INGEST_TOKEN
SYNC_ENABLED=true
```

The edge buffers during any WAN/central outage and replays oldest-first on
restoration — central downtime never affects rig operations (proposal §6.3).
### Migrating an existing rig off `http://<crmf-host>:6000`

`crmf-backend` no longer publishes its port on all interfaces: it binds
`${INGEST_BIND:-127.0.0.1}`, and rigs reach `/ingest` through the portal's nginx,
which terminates TLS and caps the request body. This matches what the Kubernetes
Ingress has always done (`deploy/helm/crmf/templates/ingress.yaml` routes `/ingest`
to `crmf-backend`). Migrate in this order — no step loses buffered data:

1. Set `INGEST_BIND=0.0.0.0` in `central/.env` and redeploy central. Old rigs keep
   working exactly as before while the new path is proven.
2. Install the portal cert+key in `central/certs/` and recreate `crmf-frontend`.
   Confirm `docker logs crmf_frontend | grep crmf-tls` reports HTTPS enabled.
3. On ONE rig, point `CENTRAL_URL` at `https://<crmf-host>:8443` and restart its
   backend. If the portal cert is self-signed, the rig's Node process will refuse
   it — install the issuing CA on the rig node and set
   `NODE_EXTRA_CA_CERTS=/certs/ongc-ca.crt` on the edge `backend` service. Until
   that is done the edge reports a network error and **back-pressures**; it does
   not dead-letter, so the buffer replays in full once trust is fixed.
4. Roll the remaining rigs, then remove `INGEST_BIND` from `central/.env` (back to
   loopback) and drop the `:80` port mapping from `crmf-frontend` so nothing is
   served in cleartext.

HTTP status contract, unchanged from what `backend/lib/sync.js` already expects:
**401** (wrong/rotated token) back-pressures and never dead-letters; **413**
(batch above `INGEST_MAX_BODY` / `INGEST_MAX_INFLATED_BYTES`) dead-letters that
one batch and keeps draining the rest.

---

## Configuration

See `.env.example`. Key variables: `PGPASSWORD`, `JWT_SECRET`, `INGEST_TOKEN`,
`FLEET_SIZE`, `ACTIVE_RIGS`, `FRONTEND_PORT`, `OFFLINE_SEC`,
`CENTRAL_LATENCY_TARGET`.

## Production notes

- Place `crmf-backend` behind the API gateway / MQTT broker on the ONGC WAN VPN; issue per-rig device certificates/tokens. Its compose port binds loopback (`INGEST_BIND`) and `/ingest` is reached through the portal's nginx, mirroring the Ingress.
- Terminate TLS on the portal (`central/certs/crmf.crt` + `crmf.key`, or cert-manager in k8s) and stop publishing the `:80` mapping. Retire the global `INGEST_TOKEN` in favour of per-rig device tokens (`POST /api/rigs`, `POST /api/rigs/:id/rotate-token`); with `INGEST_TOKEN` empty, only provisioned rigs can ingest.
- `/ingest` authenticates BEFORE it decompresses, and bounds the inflated body (`INGEST_MAX_BODY`, `INGEST_MAX_INFLATED_BYTES`). Keep `cpus`/`mem_limit` on `crmf-backend` in step with `NODE_OPTIONS=--max-old-space-size`.
- TimescaleDB ships HA (Patroni) + streaming replication to the DR site (proposal §5.3); this compose runs a single node for the pilot.
- Federate Keycloak/ONGC AD for SSO on top of the built-in local accounts (proposal §6.5).
