# ROM-II / AHWR Digital Twin

Real-time digital-twin dashboard for an oil-rig drilling operation. Live PLC
telemetry (Siemens **S7comm** / **Modbus TCP**) is collected by **Telegraf**,
stored in **InfluxDB**, served by a **Node.js / Express + Socket.io** backend,
and visualised in a **React (Vite + MUI)** operator dashboard.

```
 PLC (S7comm/Modbus)
        │
        ▼
   Telegraf ──► InfluxDB 2.7 ──► Backend (Express + Socket.io) ──► Frontend (React, served by nginx)
   (1 Hz poll)   (historian)      • JWT auth + RBAC                   • live gauges & trends
                                  • drilling physics engine           • only published service
                                  • rewrites telegraf.conf (hot-reload)
```

> **Deploying for real?** See the full **[Deployment Guide](docs/DEPLOYMENT.md)** — edge + central
> setup, edge registration, signal-flow verification, and the production Kubernetes path. The
> central **CRMF** fleet-aggregation facility (the proposal's Central Facility) lives in
> **[`central/`](central/)**.

## Quickstart (local, with synthetic live data)

Requires Docker + Docker Compose v2.

```bash
cp .env.example .env        # then edit secrets (a ready-to-use .env is already provided for local)
docker compose --profile demo up -d --build
```

Open **http://localhost:8080** and sign in with the seeded admin
(`ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`).

- `--profile demo` starts a **mock telemetry generator** so the dashboard shows
  live, moving data without a physical PLC. Omit it to run "for real": the
  dashboard then honestly shows **NO DATA / STALE** until a PLC is configured.
- Only the frontend is published, and only on `127.0.0.1:8080`. The backend and
  InfluxDB are reachable only on the internal Docker network.

Stop / reset:

```bash
docker compose --profile demo down          # stop
docker compose --profile demo down -v       # stop + wipe InfluxDB & state volumes
```

## Connecting a real PLC

1. Sign in as an admin and open **Settings / Admin → PLC config**.
2. Add the device (S7comm or Modbus), its IP/port and register/field map.
3. On save, the backend validates the input, rewrites the managed section of
   `telegraf/telegraf.conf`, and Telegraf **hot-reloads** it automatically
   (`--watch-config`). No container restart and no Docker socket is involved.

Set `DATA_SOURCE=plc` in `.env` for a real deployment.

## Windows domain login (Active Directory)

The app can authenticate users against Active Directory over **LDAP/LDAPS**, with
AD security groups mapped to app roles. Set `AUTH_MODE` and the `LDAP_*` vars in
`.env` (see [`.env.example`](.env.example)):

```env
AUTH_MODE=both                 # local + domain (recommended); or 'ldap' for domain-only
LDAP_URL=ldaps://dc01.corp.example.com:636
LDAP_BIND_DN=CN=svc-romii,OU=Service,DC=corp,DC=example,DC=com
LDAP_BIND_PASSWORD=********
LDAP_SEARCH_BASE=DC=corp,DC=example,DC=com
LDAP_DOMAIN=corp.example.com
LDAP_ROLE_ADMIN=RigAdmins       # AD group -> admin
LDAP_ROLE_OPERATOR=Drillers     # AD group -> operator
LDAP_DEFAULT_ROLE=viewer
```

- Users sign in with `DOMAIN\username`, `username@domain`, or bare `username` +
  their domain password. The backend binds to the DC to verify, reads `memberOf`,
  maps groups → role, and mirrors the account into the local store (just-in-time
  provisioning) so roles/status/audit work. Admins can deactivate an AD user
  locally to block sign-in, or pin a role (`roleLocked`).
- **`both`** keeps the seeded local admin as a break-glass account if AD is
  unreachable. **`local`** (default) disables domain login entirely.
- Use **`ldaps://`** (or `LDAP_STARTTLS=true`) in production so credentials aren't
  sent in clear text. `LDAP_TLS_REJECT_UNAUTHORIZED=false` only for self-signed lab DCs.
- No service account? Leave `LDAP_BIND_DN` empty to bind directly as the user's UPN.

> Browser-transparent Kerberos/SPNEGO SSO (no password prompt) is a heavier,
> domain-joined extension and is **not** included; this implements credential-based
> LDAP/AD authentication, which is the portable standard for a containerized app.

## Configuration (`.env`)

| Variable | Purpose |
|----------|---------|
| `INFLUX_TOKEN` | InfluxDB admin token (used by Telegraf/backend) |
| `INFLUX_USERNAME` / `INFLUX_PASSWORD` | InfluxDB initial admin login |
| `INFLUX_ORG` / `INFLUX_BUCKET` / `INFLUX_RETENTION` | bucket + raw-data retention (default 30d) |
| `JWT_SECRET` | signing secret for auth tokens (≥16 chars, required) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | seeds the first admin on first boot |
| `DATA_SOURCE` | label shown in the UI (`mock` / `plc`) |
| `FRONTEND_PORT` | host port for the dashboard (default 8080) |
| `CORS_ORIGIN` | extra browser origins (comma-separated); empty = same-origin only |

## Security model

- **Authentication:** `POST /api/login` verifies a bcrypt password hash and
  returns a signed JWT (8h). Every other `/api/*` route and the Socket.io
  handshake require `Authorization: Bearer <token>`.
- **Authorization (RBAC):** `admin` (user + PLC config), `operator` (drilling
  calibration), `viewer` (read-only). Enforced **server-side**, not just in the UI.
- **Secrets** live only in `.env` (gitignored) — no hardcoded fallbacks; the
  backend refuses to start without `JWT_SECRET` and `INFLUX_TOKEN`.
- **No Docker socket** is mounted anywhere; Telegraf reload is via `--watch-config`.
- Input is validated to prevent **Flux injection** (`/api/history`) and
  **TOML/config injection** (PLC config → `telegraf.conf`).
- Safety-critical signals (BOP/well-control, WOB, depth) are **never fabricated**:
  absent/stale data is shown as `NO DATA / STALE`, not as a benign zero/closed state.

### One-time follow-up (history rewrite)

The original git history still contains the previously-committed secrets
(`users.json`, the old InfluxDB token) and a large `out.txt` log. Those values
have been rotated here, but to scrub them from history run e.g.
[`git filter-repo`](https://github.com/newren/git-filter-repo) /
[BFG](https://rtyley.github.io/bfg-repo-cleaner/) and force-push:

```bash
git filter-repo --invert-paths --path out.txt --path backend/users.json
```

## Repository layout

```
backend/    Express + Socket.io API, drilling physics, auth (lib/auth.js), validation (lib/validate.js)
frontend/   React (Vite + MUI) dashboard; built to static files served by nginx
telegraf/   telegraf.conf (managed PLC section is rewritten by the backend)
mock/       synthetic telemetry generator (demo profile only)
docker-compose.yml
```
