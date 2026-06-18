# Pending Works — MVP → Full Features

Status of the workover/well-service monitoring app (`nayan/main` @ `43abf73`) against the
10-area reference spec (NOV RigSense/WellData, Drillmec ProRig, McCoy torque-turn, API RP 54,
WITSML). ✅ done · 🟡 partial · 🔴 pending.

| # | Area | Status | Done | Pending to reach "full" |
|---|------|--------|------|--------------------------|
| 1 | Real-time dashboard | ✅ | RigOverview (rewritten), gauges, crown/floor-saver, engine/HPU/HTD live | block **line speed**, drawworks **drum RPM**, **mast load**, E-stop status |
| 2 | Workover operation monitoring | ✅ | Activity/NPT tracking (auto + manual), Fishing ops, op-mode | richer per-activity detail (rod jobs, cleanout, packer) |
| 3 | Pressure / flow / fluid | 🟡 | tubing/casing/wellhead pressure, SPP, SPM, pit tanks, trip-tank gain/loss | **flow-out in volumetric units** (still %), pumped-volume totalizer, mud density/temp |
| 4 | Tubular & tong (torque-turn) | ✅ | Torque-turn capture, peak torque, pass/fail, joint tally, live samples | torque-vs-**turns** (needs turn encoder), string/tally records export |
| 5 | Safety & alarm | ✅ | Alarm engine (Hi/HiHi/Lo/LoLo, deadband, on-delay), banner, ack/silence, audible, history, config | **gas/H2S/LEL**, E-stop, alarm shelving |
| 6 | Reports & job records | 🟡 | Daily workover report, CSV/XLSX/PNG export | **PDF** export, tour sheet, **pull/run tally report**, torque-turn & pressure-test reports, full RP 59 kill-sheet step-down |
| 7 | Remote / fleet | ✅ (central) | **CRMF central facility** delivers the central side (see `central/`): real multi-rig ingestion (TimescaleDB), fleet map, per-rig data-quality/sync-health, alarm command centre, **alarm notifications (webhook/email)**, governance/rollout, immutable audit. | edge-side **historical scrub-back replay** UI; SMS provider (webhook→gateway only) |
| 8 | Integration & data standards | 🔴 | Modbus TCP + S7comm + REST | **WITSML/WITS**, **CAN/J1939** engine gateway, OPC-UA, MQTT |
| 9 | Maintenance & asset health | ✅ | Run-hours (measured+derived), PM due/overdue, calibration history, downtime/reason codes | brake-temp trends, spares log |
| 10 | Retrofit support | 🟡 | Modbus retrofit path, admin PLC config, **offline export/import** scripts | **J1939 gateway**, automated cloud sync |

## Cross-cutting (from the rig-standards review, still open)

- 🔴 **Well-control depth (safety):** BOP/accumulator/ram **not wired to real PLC** FIELD_MAP (only the mock feeds it → shows "unavailable" against a real S7 PLC). No **kick detection** (delta-flow + pit-gain), no **ECD/ESD**, no **choke manifold**.
- 🔴 **Historian / data quality:** `/api/history` is **`last()`-only** — peaks/troughs lost; no **min/max envelopes**, no **scrub-back replay**, no per-tag freshness/quality flags, no retention tiers.
- 🟡 **Audit trail:** only **dashboard-layout** changes are audited; safety actions (Zero-WOB tare, Set-Depth, PLC-config, user CRUD) are **not** in an immutable audit log.
- 🟡 **Role-tailored views:** only `admin` differs (Settings + edit); no driller / company-man / mud-engineer discipline displays.
- 🟡 **Equipment depth:** mud pump is a single aggregate (no per-pump SPM/liner/online).

## Central facility (CRMF) backlog — `central/`

The central platform (`central/`) is built, security-hardened and audited (see
`central/AUDIT.md`: Critical+High+Medium gaps #1–#30 fixed & verified). Remaining:

- 🟡 **Alarm notifications** — webhook + email dispatch on P1/escalation is now implemented
  (`central/backend/lib/notify.js`); SMS is via a webhook→gateway, no direct SMS provider.
- ✅ **Per-rig remote HMI mirror** — the central rig drill-down now mirrors the full edge operator
  HMI (read-only tabs: Dashboard, Equipment, Well Control/BOP, Trends/EDR, Workover, Alarms, Daily
  Report, Maintenance) fed by `GET /api/rigs/:id/live` which reconstructs the edge `rig_data` shape
  from central telemetry. Left nav is collapsible. Remaining: historical **scrub-back replay** UI.
- 🔴 **Scaffold-only platform services** (ship at `replicas: 0` / placeholder image): in-house
  **ETP 2.0 server + WITSML 1.4.1 store**, **ML inference** (HPU condition / hookload anomaly /
  NPT classifier — MLflow/KServe), **Kafka derived-channels stream processor**, **MQTT→Kafka bridge**.
- 🔴 **Historical scrub-back replay** UI (TimescaleDB history exists; no replay scrubber).
- 🟡 **K8s never `kubectl apply`'d** — the deploy layer is `helm`/`kubeconform`-validated only.
- ⚪ Deferred low audit items #31–#35 (frontend a11y/code-split, lexical-ts compare, metrics
  accuracy, k8s nginx-resolver/PodMonitor-label polish).

## Branch note
`codex/fix-edr-timescale-history-auth` (`443b8b2`, "EDR timescale + stale-session/auth fix")
is **not** in `nayan/main` and touches `server.js` / `EdrDashboard.jsx` / `AuthContext.jsx`,
which `43abf73` also rewrote → merging needs conflict resolution. Decide whether to merge it
or treat it as superseded.

## Suggested priority (MVP → full)

1. **Well-control safety depth** — wire BOP/accumulator/ram FIELD_MAP, kick detection
   (fix flow-out units → delta-flow + pit-gain alarm), choke manifold. *(highest safety value)*
2. **Fleet completion** — real multi-rig ingestion + alarm **notifications (email/webhook)** +
   fleet map + historical replay. *(turns the scaffold into a product)*
3. **Reporting** — PDF export + tour sheet + pull/run tally + torque-turn/pressure-test reports.
4. **Data standards** — WITSML/WITS export, then J1939 engine gateway.
5. **Historian/data quality** — min/max envelopes + scrub-back replay + per-tag quality.
6. **Governance** — general audit trail + role-tailored discipline views.
