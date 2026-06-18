# AHWR Digital Twin — Deployment Guide

How to deploy the **edge** rig twins and the **central** CRMF facility, register edges with
central, and verify the end-to-end signal flow. Covers the Docker-Compose path (pilot / lab)
and the production Kubernetes path (central HA).

> **Monitoring-only.** Data flows one way: edge → central. Nothing is ever written back to a
> rig or PLC; ESD/lockout surface as read-only alarms.

---

## 1. Architecture

```
 RIG SITE 1            RIG SITE 2            RIG SITE 3
┌───────────┐        ┌───────────┐        ┌───────────┐
│ edge twin │        │ edge twin │        │ edge twin │   each = influxdb + telegraf
│ DEVICE_ID │        │ DEVICE_ID │        │ DEVICE_ID │         + backend + frontend(HMI)
│ =AHWR-01  │        │ =AHWR-02  │        │ =AHWR-03  │   (one industrial PC per rig)
└─────┬─────┘        └─────┬─────┘        └─────┬─────┘
      │  gzip batches → POST /ingest  (Bearer per-rig DEVICE_TOKEN)  ── ONE-WAY ──►
      └──────────────┬─────┴──────────────┬─────┘
                     ▼   ONGC WAN / VPN    ▼
              ┌──────────────────────────────────────┐
              │  CENTRAL CRMF                         │  timescaledb + crmf-backend
              │  ingest :6000   portal :8090          │         + react portal
              └──────────────────────────────────────┘
```

The edge image is **identical on every rig**; only three values differ per node:
`DEVICE_ID`, `DEVICE_TOKEN`, `CENTRAL_URL`. A real rig connects to central with **zero code
changes** — just set those env vars.

| App | Repo path | Store | Ports (host) |
|-----|-----------|-------|--------------|
| Edge twin | `./` (root) | InfluxDB 2.7 (local historian) | HMI `8080` |
| Central CRMF | `central/` | TimescaleDB / PostgreSQL | portal `8090`, ingest `6000` |

---

## 2. Prerequisites

- **Edge node (per rig):** fanless industrial PC, 4 vCPU / 16 GB / 512 GB SSD min (8/32/1 TB
  recommended), dual Ethernet, UPS; Docker + Docker Compose. WAN/VPN uplink to central.
- **Central host (pilot):** Linux VM, 4 vCPU / 8–16 GB / 100 GB SSD; Docker + Docker Compose.
- **Central production (HA):** RKE2 Kubernetes cluster — see §7.
- Tooling: `docker`, `docker compose`. For K8s: `kubectl`, `helm`, (`kind` for the local
  profile).

---

## 3. Deploy the CENTRAL facility (Compose)

```bash
cd central
cp .env.example .env
```
Edit `.env` and set the secrets:
```ini
PGUSER=crmf                      # DB OWNER/bootstrap role (NOT the backend's login user)
PGPASSWORD=<strong-db-password>  # the backend connects as least-priv crmf_app with this pw
JWT_SECRET=<long-random>
ADMIN_PASSWORD=<portal-admin-password>
INGEST_TOKEN=<shared-ingest-token>   # demo fallback; production uses per-rig tokens (§5)
```
Bring it up:
```bash
docker compose --profile demo up -d --build   # demo = bundled fleet-sim + openldap + sinks
# production shape (real edges only, no simulators):
#   docker compose up -d --build
```
- **Portal:** http://localhost:8090  (login `admin` / your `ADMIN_PASSWORD`)
- **Ingest endpoint** edges POST to: `http://<central-host>:6000/ingest`

> The backend connects to the DB as the least-privilege role **`crmf_app`** (so it cannot
> tamper with the append-only `audit_log`). Its password is set from `PGPASSWORD` automatically
> on first DB init. **Fresh-volume rule:** schema + the `crmf_app` password initialize only on a
> NEW volume — after changing the schema or DB auth, recreate with
> `docker compose --profile demo down -v && up --build`. For an EXISTING central, run a one-time
> `ALTER ROLE crmf_app LOGIN PASSWORD '<= PGPASSWORD>'` instead (so you don't wipe history).

---

## 4. Deploy an EDGE twin (Compose)

On each rig node:
```bash
cd <repo-root>
cp .env.example .env
```
Edit `.env` for THIS rig:
```ini
# --- identity (UNIQUE per rig; never change DEVICE_ID once deployed — see §8) ---
DEVICE_ID=AHWR-01
DEVICE_TOKEN=<from central, see §5>
CENTRAL_URL=https://crmf.ongc.local      # §6
SYNC_ENABLED=true
SYNC_BATCH_SECONDS=10                     # batch cadence (lower = fresher, more WAN overhead)
SYNC_BUFFER_DAYS=15                       # store-and-forward disk buffer cap during outages

# --- data source ---
DATA_SOURCE=plc                           # 'mock' for a no-PLC demo

# --- local historian + auth ---
INFLUX_PASSWORD=<strong>
INFLUX_TOKEN=<openssl rand -hex 24>
JWT_SECRET=<openssl rand -hex 32>
ADMIN_PASSWORD=<edge-admin-password>

# --- HMI exposure ---
FRONTEND_BIND=127.0.0.1                    # loopback-only; set to the rig NIC IP for LAN access
FRONTEND_PORT=8080
```
Bring it up:
```bash
docker compose up -d --build               # real PLC
# or for a no-PLC demo with synthetic telemetry:
docker compose --profile demo up -d --build
```
- **Rig HMI:** http://127.0.0.1:8080  (operator dashboard; works locally even if the WAN/central
  is down — the edge buffers and replays on reconnect).

---

## 5. REGISTER an edge with central

### Recommended — per-rig token
1. Central portal → **Settings → Add rig** → enter the rig id (e.g. `AHWR-01`), leave the
   **Device token blank** → Save.
2. A dialog reveals the **generated `device_token` once** — copy it. (Use **Rotate** later to
   issue a fresh one; rotating invalidates the old token on the edge.)
3. Put it on the edge: set `DEVICE_ID=AHWR-01` and `DEVICE_TOKEN=<that token>`, then recreate the
   edge backend (`docker compose up -d`).

API equivalent:
```bash
TOK=$(curl -s http://<central>:8090/api/auth/login -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}' | jq -r .token)

curl -s http://<central>:8090/api/rigs -H "Authorization: Bearer $TOK" \
     -H 'Content-Type: application/json' \
     -d '{"rigId":"AHWR-01","name":"Workover Rig 01","assetUnit":"Ankleshwar"}' | jq -r .device_token
# → set that value as DEVICE_TOKEN on the edge

# rotate later:
curl -s -X POST http://<central>:8090/api/rigs/AHWR-01/rotate-token \
     -H "Authorization: Bearer $TOK" | jq -r .device_token
```
A tokened rig is bound to its own credential — the shared token will **not** work for it
(correct token → 200, wrong → 401).

### Quick / demo — shared token
Set the edge's `DEVICE_TOKEN` equal to central's `INGEST_TOKEN`. Unknown device ids
auto-register as **`pending`** in the Governance workspace. Fine for labs; use per-rig tokens in
production. Ingest is **fail-closed** — no/incorrect token → `401`.

---

## 6. Edge → central networking (`CENTRAL_URL`)

| Scenario | `CENTRAL_URL` |
|----------|---------------|
| Both on one Docker-Desktop host | `http://host.docker.internal:6000` |
| Real rigs → central over WAN | `https://crmf.ongc.local` (ingress routes `/ingest` to the backend) |
| Same Docker network | the central backend service name + `:6000` |

The edge posts gzip batches to `${CENTRAL_URL}/ingest` with `X-Device-Id` + `Bearer
<DEVICE_TOKEN>`. On any outage it buffers to disk (`SYNC_BUFFER_DAYS`) and replays oldest-first
on reconnect — a sustained outage replays **in full** (only the day-based cap drops data).

---

## 7. Production central on Kubernetes

The full HA stack lives under `central/deploy/`:
- **Helm chart** `deploy/helm/crmf` — backend (HPA/PDB/NetworkPolicy/ServiceMonitor) + frontend +
  Ingress (`/ingest`, `/api`, `/socket.io` → backend; `/` → portal) + TLS via cert-manager.
- **Platform CRs** `deploy/k8s/platform/` — CloudNativePG TimescaleDB (HA + DR), Strimzi Kafka,
  EMQX MQTT, Keycloak+AD SSO, MinIO, External-Secrets/Vault, kube-prometheus.
- **Ansible** `deploy/ansible/` — RKE2 bootstrap + operator/app install.

Before applying, create the prerequisite Secrets (or let External-Secrets/Vault materialize them):
`crmf-db-app` (owner `crmf`), **`crmf-db-app-login`** (login `crmf_app`, password = backend
`PGPASSWORD`), `crmf-db-superuser` (`postgres`), `crmf-backup-s3`. See
`deploy/k8s/platform/timescaledb/README.md §2`. Key chart setting: `config.PGUSER=crmf_app`.

```bash
helm upgrade --install crmf central/deploy/helm/crmf -n crmf \
  -f central/deploy/helm/crmf/values-prod.yaml --create-namespace
```

### Try it locally first (kind)
A runnable, scaled-down mirror of the prod mechanics (operators + CNPG TimescaleDB + the Helm app
with real probes/HPA/PDB/NetworkPolicy/Ingress+TLS + live data):
```bash
cd central && docker compose build crmf-backend crmf-frontend fleet-sim   # build images once
cd deploy/local && ./up.sh        # → https://crmf.localtest.me:9443 (admin/admin123)
./down.sh                          # tear down
```
See `central/deploy/local/README.md` for what maps to production.

---

## 8. Verify the signal flow

```bash
# EDGE — is the sync agent delivering?
docker exec <edge_backend> printenv CENTRAL_URL DEVICE_ID            # config applied
#   /api/sync/status → connected:true, bufferedBatches→0, ackedBatches climbing, lastError:null
docker exec <edge_backend> sh -c 'ls /data/sync_buffer | wc -l'      # backlog drains toward 0

# CENTRAL — did it land?
curl -s http://<central>:8090/api/fleet -H "Authorization: Bearer $TOK" \
  | jq '.[] | select(.rig_id=="AHWR-01") | {rig_id,status}'           # status "online"
docker exec <central_db> psql -U crmf -d crmf -tAc \
  "SELECT count(*),count(DISTINCT metric),max(ts) FROM telemetry WHERE rig_id='AHWR-01';"
#   → row count climbing  (verified end-to-end: 2975 rows / 119 metrics from a real edge mock)
```
**Resilience test:** block the WAN → `bufferedBatches` grows, rig goes `stale`; restore → buffer
drains, rig flips back `online`.

---

## 9. Operations

- **Retention / disk:** central is the disk driver — budget by retention × tag-rate. Enable
  TimescaleDB compression + drop-chunks policies for long horizons; snapshot/back up the
  `crmf_pgdata` volume (losing it loses history *and* forces a schema re-init).
- **Scaling:** backend HPA 3→12 (prod). For >50 rigs use the K8s path, not single-node compose.
- **Secrets:** never commit real `.env` (gitignored). In prod, source `PGPASSWORD`/`JWT_SECRET`/
  `INGEST_TOKEN`/`ADMIN_PASSWORD` from Vault via External-Secrets; keep `crmf-db-app-login`
  password == `crmf-secrets.PGPASSWORD`.
- **Latency:** glass-to-glass is dominated by the edge batching policy (`SYNC_BATCH_SECONDS`,
  default 10 s) — typical ~8–10 s end-to-end, well under the 30 s target. Lower it for fresher
  data at the cost of WAN overhead.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Edge buffer grows, nothing delivered | Token mismatch (`401`) or wrong `CENTRAL_URL`. Check `/api/sync/status` `lastError`; confirm `DEVICE_TOKEN` matches central's per-rig token (or the shared `INGEST_TOKEN`). |
| Rig shows `pending` in central | Unknown/auto-registered device on the shared token — register it (§5) or set its per-rig token. |
| Backend crash-loops `schema not initialised` / `password authentication failed for user crmf_app` | DB volume initialized before the `crmf_app` password was set — recreate the volume (`down -v`) for a demo, or run `ALTER ROLE crmf_app LOGIN PASSWORD …` once for an existing deployment. |
| Don't change a deployed rig's `DEVICE_ID` | Buffered batches carry the old `deviceId` in their body (central trusts the body over the header) → token mismatch → wedge. Pick the id once. |
| Don't reuse a demo `fleet-sim` rig id for a real edge | The simulator's epoch-based sequence numbers collide with the real agent's via the replay high-water check. Use a distinct id. |

---

_See also: `central/README.md`, `central/deploy/README.md`, `central/deploy/local/README.md`,
`central/deploy/k8s/platform/timescaledb/README.md`._
