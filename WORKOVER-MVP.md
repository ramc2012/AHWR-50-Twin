# Workover MVP — implemented features

This increment adds the workover-defining layer identified in
[WORKOVER-GAP-ANALYSIS.md](WORKOVER-GAP-ANALYSIS.md). All four priority items are
built, wired to live data, role-gated, and verified in the local Docker stack.

Open the app at **http://localhost:8080**, sign in, and use the nav for **Activity,
Alarms, Workover, Reports**. The mock generator drives a scripted workover cycle
(RIH → make-up → circulate → POOH → break-out) so every feature is demonstrable
without a physical PLC.

## 1. Workover activity + NPT tracking  (`/activity`)
- Auto-classifies activity from live signals (block travel, pump rate, tong sequence):
  `RIH, POOH, MAKE_UP, BREAK_OUT, CIRCULATE, SWAB, FISHING, RIG_UP, RIG_DOWN, IDLE, WAIT`.
- **Manual override** (operator/admin): set the activity, choose an **NPT reason**
  for non-productive time, or **Return to Auto**.
- Timestamped **timeline** with per-entry duration + depth, and a **productive vs NPT**
  roll-up for the day. Transitions persist to `activity_log.json`.

## 2. Alarm management  (`/alarms` + persistent AppBar banner)
- Master setpoint DB (`alarms_config.json`) with per-tag **HiHi/Hi/Lo/LoLo + deadband
  + on-delay + priority**, evaluated server-side each tick.
- ISA-18.2-style **state machine**: `UNACK → ACK → return-to-normal`, with **first-out**,
  deadband anti-chatter, and an **event history** (`alarms_events.json`).
- **Persistent banner** on every page (highest priority + active/unack counts),
  **acknowledge / ack-all**, and a **Web-Audio audible annunciator** (armed by the
  speaker toggle to satisfy browser autoplay; per-priority tone/cadence).
- Default workover alarm set: hook-load high, pump/standpipe high, **tubing high**,
  **casing high**, **BOP accumulator low**, **pit gain/loss**, HPU oil-temp high,
  engine oil-pressure low, engine coolant high. (Admins can edit via `PUT /api/alarms/config`.)

## 3. Wellhead pressure + torque-turn  (`/workover`)
- **Tubing / casing / wellhead pressure** gauges (bar) with HI-limit markers, fed by a
  new `wellhead` measurement (`Tubing/Casing/Wellhead Pressure-Bar` added to FIELD_MAP).
- **Torque-turn**: live make-up torque-vs-time chart with min/max limit lines; on each
  PCT make-up sequence the backend records a **connection** (joint #, peak torque,
  PASS/FAIL vs limits), giving a **pull/run tally** (run / pass / fail / joint count).

## 4. Daily workover report  (`/reports`)
- Built from the activity time-log + connections + alarms: editable header, **time
  summary** (productive vs NPT), **depth progress**, **connections** tally, **activity
  breakdown** by code, and **alarms logged**.
- Export: **Print/PDF** (print-styled) and **CSV** (no extra dependencies).

> **Project principle — monitoring only.** This twin never writes to the PLC/OT (no
> backflow of signal). Safety functions like **ESD and lockout are read-only alarms**,
> surfaced on the top alarm strip — never commands or actuation.

## 5. Maintenance & asset health  (`/maintenance`)
- **Run-hours** per major asset — measured from PLC tags (engine, HPU, top drive) and
  **derived** by accruing time while the condition holds (drawworks while hoisting,
  mud pump while pumping).
- **Preventive-maintenance schedule** with per-task interval, last service, next-due and
  a **due-in / due-soon / overdue** status; a **Service** action resets the task (and
  auto-logs it to the calibration/service history).
- **Calibration history** — auto-captured from the Zero-WOB tare and Set-Depth actions,
  plus manual entries.
- **Downtime / failure log** with standard **reason codes** (mechanical, electrical,
  hydraulic, instrumentation, waiting-on-parts, scheduled-maint, other), severity,
  open/closed state and duration.
- **Asset-health cards** + KPI row (overdue / due-soon / open-downtime counts).

## API (all require `Authorization: Bearer <jwt>`; writes are role-gated)
```
GET  /api/activity/current | /api/activity/codes | /api/activity/log?date=
POST /api/activity/set            {code, npt?}            (operator/admin)
GET  /api/alarms | /api/alarms/history?limit= | /api/alarms/config
POST /api/alarms/:id/ack | /api/alarms/ack-all            (operator/admin)
PUT  /api/alarms/config                                   (admin)
GET  /api/connections?date= | /api/torqueturn/current
GET  /api/report/daily?date= | /api/report/header
PUT  /api/report/header                                   (operator/admin)
GET  /api/maintenance/summary | /pm | /calibrations | /downtime | /reason-codes
POST /api/maintenance/pm/:id/service                      (operator/admin)
POST /api/maintenance/calibrations                        (operator/admin)
POST /api/maintenance/downtime | /downtime/:id/close      (operator/admin)
GET  /api/variables | /api/variables/source-types
PUT  /api/variables                                       (admin)
```
Socket events: `rig_data` now carries `wellhead`, `safety`, `_activity`, `_alarms`,
`_torqueturn`; plus `alarms` (active list + counts) and `connection_made`.

## 6. ESD / lockout — read-only safety alarms + top alarm strip
- `safety.esd_active` and `safety.lockout_active` are **read-only PLC digital inputs**
  (mapped in `fieldmap.js`); they raise **P1 alarms** (`EMERGENCY SHUTDOWN ACTIVE`,
  `EQUIPMENT LOCKOUT ACTIVE`). **No command/actuation path exists** — monitoring only.
- A persistent **top alarm strip** (full-width, every route) shows the highest active
  alarm with priority color, value, time-in, P1/P2/P3 counts, **Ack / Ack-all**, and the
  audible annunciator; unacknowledged P1/P2 pulse. Calm "no active alarms" state otherwise.

## 7. Variables mapping with sources  (`/variables`, admin-editable)
- A registry of all **146** application variables → their **source** (`s7comm`, `modbus`,
  `opcua`, `mqtt`, `derived`, `manual`), source tag, PLC address (joined from the live PLC
  config when present), engineering unit, kind (analog/status), scale, offset, enabled.
- Seeded from the shared `fieldmap.js`; admin edits persist to `variables_map.json`
  (merged by id). Search + source-type + measurement filters. Read-only for non-admins.

## 8. UI customization with themes
- 4 selectable themes via a palette switcher in the AppBar, persisted in `localStorage`:
  **Control Dark** (default), **HP-HMI (ISA-101)** desaturated operator palette,
  **Light**, **High Contrast**. Swaps the MUI palette + page background app-wide.

## 11. EDR rework, navigation & domain login (latest)
- **Strip-chart EDR** (`EDR/EdrView.jsx`): Time/Depth index toggle, selectable **readouts row on top**,
  **HOLE/BIT depth band on the left**, **scroll rails on both sides**, per-strip independent pens with a
  **fixed-height adaptive bottom legend** (font shrinks / labels drop / value is pen-colored as pen count
  rises). Reusable `mode="compact"` single strip is embedded **right-most** on every equipment page and on
  Well Control / Fishing / Workover.
- **Navigation**: Live Trends deprecated; **Operations** tabbed page (Well Control · Fishing · Workover);
  **Settings** tabbed page (Variables for all read-only; Administration = users/PLC/system, admin only) —
  Variables + user management now live here.
- **CAN/J1939 module removed** entirely (gateway, seeds, catalog, measurement).
- **Windows-domain login verified** end-to-end against a bundled mock AD (ldapjs): `driller1`→operator,
  `toolpusher1`→admin, `viewer1`→viewer, `DOMAIN\user` form, local break-glass admin intact. Fixed a real
  bug (`lib/ldap.js` passed `tlsOptions` on plain `ldap://`, forcing a failed TLS handshake). Login page now
  shows a **Local account / Windows Domain** selector when domain auth is enabled.

## 9. Edge stack — sync, data quality, WITSML (per the ONGC AHWR proposal §4.1 / §6.3)
This app is the **rig-edge digital twin** of the two-layer ONGC proposal; the fleet/central
layer is the separate CRMF, so the **Fleet page has been removed** from the edge app.
- **Sync Agent — Store & Forward** (`/sync`): batches live telemetry + events, gzip-compresses,
  buffers to disk (capped at `maxBufferDays`, default 15), and forwards to the central CRMF
  with a per-rig **device identity** (`DEVICE_ID` + optional token). On WAN/central outage it
  keeps buffering and **automatically replays oldest-first on reconnection**, back-pressure
  aware. **Outbound only** — never writes to the PLC (monitoring-only). A local demo ingest
  stub (`sync-sink`, demo profile) stands in for the CRMF so the loop is demonstrable.
- **Edge health / data-quality agent**: per-rig health score from data freshness
  (stale/missing sources), collector/PLC link, and sync lag — shown on the Edge Sync page.
- **WITSML 1.4.1 agent (export)**: standards-compliant `<wells>` and date-time `<logs>` XML
  download for interoperability with the central WITSML store / office systems.
- **ETP 2.0 publisher** (`lib/etp.js`, shown on the Edge Sync page): connects to an ETP
  server over WebSocket (subprotocol `etp12.energistics.org`), performs the Session
  handshake (RequestSession → OpenSession), advertises ChannelMetadata, then streams
  ChannelData frames — **JSON-encoded subset** (`application/x-etp-message+json`). Outbound
  only. A demo `etp-sink` stands in for the central ETP server. (Full Avro binary encoding +
  complete capability set is the documented next step.)

Config via env (compose, with defaults): `CENTRAL_URL`, `DEVICE_ID`, `DEVICE_TOKEN`,
`SYNC_ENABLED`, `SYNC_BATCH_SECONDS`, `SYNC_BUFFER_DAYS`, `ETP_ENABLED`, `ETP_URL`, `ETP_STREAM_SECONDS`.

## 10. Multi-protocol sources, OPC UA devices & editable variable mapping
- **Map any variable to any source** — the variables registry (`/variables`) is protocol-aware:
  `s7comm, modbus, opcua, mqtt, derived, manual`, each with its own connection config
  (e.g. OPC UA endpoint/namespace/nodeId; Modbus host/register/type; MQTT broker/topic).
  Admin edits the source + per-source fields in an editor that renders dynamically per type.
- **Add / delete variables** — admins can add custom variables (any measurement.field + source)
  and delete custom ones; built-ins can be disabled but not deleted. Persists to `variables_map.json`.
- **OPC UA protocol devices (live)** — a dedicated OPC UA collector (`telegraf/opcua.conf`,
  `telegraf-opcua` service) reads an OPC UA server (`opc-plc` simulator, demo profile) into the
  `opcua_demo` measurement, surfaced as `opcua`-sourced variables. Separate collector lane from
  S7comm (which fails closed without a real PLC).
- **Collector-config generation** — the mapping generates Telegraf input TOML per protocol
  (`[[inputs.opcua]]`, `[[inputs.modbus]]`, `[[inputs.mqtt_consumer]]`), previewable in the UI.

## Source
- Backend modules: `backend/lib/{alarms,workover,maintenance,variables,fieldmap,sync,health,witsml,etp,persist}.js`;
  wired in `backend/server.js` (FIELD_MAP now lives in `fieldmap.js`, shared by the
  variables registry).
- Mock cycle (+ read-only ESD/lockout status): `mock/mock-data.js`. Demo stubs: `sync-sink/`
  (CRMF HTTP ingest), `etp-sink/` (ETP 2.0 WebSocket server). OPC UA: `telegraf/opcua.conf` +
  `opc-plc` simulator.
- Frontend: `frontend/src/components/{Activity,Alarms,Workover,Reports,Maintenance,Variables,Sync}/*`,
  the global `Alarms/AlarmStrip.jsx`, `Layout/ThemeSwitcher.jsx`, `context/ThemeModeContext.jsx`,
  `utils/{format,alarms}.js`; routes in `App.jsx`, strip/switcher/nav in `Layout.jsx`.
  (The central **Fleet** page was removed — it belongs to the CRMF, not the edge app.)
- Runtime state persists in the `backend_data` Docker volume (`/data`), never committed;
  the sync buffer lives in `/data/sync_buffer`.

## Not yet (future increments — central CRMF / out of edge scope)
ETP 2.0 **Avro binary** encoding (the JSON subset is implemented), historian replay + min/max envelopes,
per-tag (vs per-source) data-quality flags. Fleet/remote multi-rig, SMS/email alerting and
cloud sync are the **central CRMF**'s responsibility, not the edge app.
(All read-only — per the monitoring-only principle, no control write-back is ever added.)
