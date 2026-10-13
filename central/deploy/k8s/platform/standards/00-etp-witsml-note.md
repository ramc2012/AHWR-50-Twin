# Energistics standards endpoint — ETP v1.2 + WITSML 2.1 (CRMF interoperability)

CRMF exposes its rig data through the Energistics standards so third-party
WITSML/ETP clients can read it without a bespoke integration, and so rig edges can
load the store over a standard protocol:

- **ETP v1.2** (Energistics Transfer Protocol, Sept 2021 — the current release;
  there is no ETP 2.x): WebSocket subprotocol `etp12.energistics.org`, binary Avro
  with the official v1.2 schemas. ETP v1.2 is the API Energistics specifies for
  WITSML 2.1.
- **WITSML 2.1** data objects (Energistics common 2.3): Well, Wellbore, Rig,
  RigUtilization (a rig working a well), Log and ChannelSet (per well run),
  Channel (per rig and metric), BusinessAssociate, and the PWLS PropertyKinds the
  channels reference. Every object is validated against the official XSDs in the
  test suites.

The server is `repo/central/etp-witsml` (image `crmf/crmf-etp-witsml`). It reads
the same TimescaleDB historian as the rest of CRMF.

## Protocols

| Protocol | Role of this server | Who | What |
|---|---|---|---|
| Core (0) | server | all | RequestSession/OpenSession, Ping/Pong, CloseSession |
| Discovery (3) | store | users, edges | GetResources over the object graph (well → wellbore → runs, logs, channel sets → channels); GetDeletedResources |
| Store (4) | store | users: get; edges: get + put | GetDataObjects (WITSML 2.1 XML); PutDataObjects of an edge's own rig |
| ChannelSubscribe (21) | store | users | GetChannelMetadata, SubscribeChannels (live), GetRanges, UnsubscribeChannels |
| ChannelDataFrame (2) | store | users | GetFrameMetadata, GetFrame (a well run's channel set) |
| ChannelDataLoad (22) | store | edges | OpenChannels (returns the store's last point per channel, so the edge resumes without gaps), ChannelData, CloseChannels |
| ChannelStreaming (1) | consumer | edges | an edge streaming as a simple producer |

Channel values are presented in the channel's Energistics unit (standpipe
pressure in psi; stored in bar) with a UTC-microsecond time index. Not
implemented: dataspaces other than the default `eml:///`, StoreNotification,
change annotations, compression, Chunk.

## Authentication

On the WebSocket upgrade (RFC 7235 `Authorization` header, ETP v1.2 §4.1.4):

- `Bearer <portal token>` — a CRMF user (backend `/api/auth/login`), role viewer
  or above: read-only.
- `Basic <rig id>:<device token>` — a rig edge, the same per-rig credential as
  `/ingest`: may load data and put objects for its own rig only.

## Deployment shape

```
   ETP / WITSML clients ──▶ Ingress (TLS)  host: etp.ongc.local
                               /     wss  ETP v1.2 (websocket, long timeouts)
                               /.well-known/etp-server-capabilities
                               /witsml21/...   WITSML 2.1 objects over HTTPS
                                       ▼
                     Service crmf-etp-witsml  :8443 etp  :8080 http
                                       ▼
                     Deployment crmf-etp-witsml ── crmf-timescaledb-rw:5432 (crmf_app)
```

- `01-etp-witsml.yaml`: ServiceAccount, ConfigMap, Service, Deployment (one
  replica; JWT_SECRET and PGPASSWORD from `crmf-secrets`).
- The ETP capabilities document must be served on the same host and scheme as the
  WebSocket (`wss://etp.ongc.local/` → `https://etp.ongc.local/.well-known/...`),
  so route both paths of the dedicated host to the `etp` port. The Ingress needs
  the same websocket annotations as `/socket.io`
  (`nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`, upgrade headers) and
  TLS via the cert-manager ClusterIssuer `letsencrypt-or-ongc-ca`. It is not
  created here, to avoid colliding with the app Ingress owned by another agent.
- Schema: `timescaledb/06-migrations.yaml` (Job) adds the identity tables
  (`channels`, `wellbores`, `business_associates`, uuid columns) to an existing
  cluster; Docker Compose runs `db/migrate.sh` (`crmf-db-migrate`).

## Data sources

- HTTP sync (`/ingest`, unchanged contract, plus the channel dictionary): rig
  telemetry, events, the active well and run; remains the path for the portal's
  live views.
- ETP store mode from the edge (optional, alongside sync): the same telemetry,
  deduplicated by the historian's unique (rig, metric, time) index, plus the
  rig's WITSML objects.

Monitoring-only: the server publishes CRMF data outward and accepts edge loads
of their own rig's data; nothing is ever written back to a rig or PLC.
