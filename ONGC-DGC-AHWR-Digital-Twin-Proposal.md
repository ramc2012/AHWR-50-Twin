# Proposal for Workover Rig Digital Twin Implementation and ONGC Multi-Rig Scale-Up

## 1. Proposal Title

Implementation of AHWR / Workover Rig Digital Twin System for One Workover Rig Pilot and Enterprise Scale-Up Across ONGC Rigs

## 2. Background and DGC Alignment

ONGC has reconstituted the Digital Governance Council (DGC) to provide centralized oversight for digital initiatives from ideation to scale-up. The DGC scope emphasizes project selection, stage-gate governance, architecture and design control, legacy system rationalization, monitoring of modern initiatives, escalation of scale-up delays, value realization, and communication through project notes, architecture reviews, adoption updates and value realization assessments.

This proposal aligns the AHWR / Workover Rig Digital Twin initiative with that DGC scope by defining:

| DGC Scope Area | Proposal Alignment |
|---|---|
| Project selection and prioritization | Establish one-rig pilot with measurable safety, operational and maintenance KPIs before ONGC-wide rollout. |
| Stage-gate governance | Define discovery, pilot, acceptance, central platform MVP and scale-up gates. |
| Technology architecture and design control | Use standardized edge architecture, approved telemetry stack, cybersecurity controls and central integration patterns. |
| Legacy system rationalization | Integrate with existing PLC/SCADA/ERP where useful, avoid fragmented local dashboards and duplicate data capture. |
| Monitoring of modern initiatives | Central platform provides project status, rig adoption, data quality, uptime and value tracking. |
| Escalation for scale-up delays | Central software flags site readiness, data gaps, connectivity delays and unresolved dependencies. |
| Value realization | Track rig uptime, alarm response, NPT reduction, maintenance compliance, connection quality and reporting efficiency. |
| Communication | Produce project notes, architecture review packs, adoption reports and executive dashboards. |

## 3. Executive Summary

The proposed system will be installed first on one workover rig as a pilot edge digital twin. It will collect PLC and equipment telemetry, maintain a local time-series historian, provide a real-time operator dashboard, alarm management, workover activity reporting, equipment health monitoring, maintenance tracking and secure role-based access.

After pilot validation, the same standard edge package will be replicated across multiple ONGC workover rigs. A central ONGC digital twin platform will aggregate rig health, operational KPIs, alarms, activity, maintenance and adoption status across all connected rigs.

The recommended deployment model is:

1. Edge system at each rig for real-time operations and offline resilience.
2. Central ONGC software platform for fleet visibility, governance, analytics, adoption tracking and reporting.
3. Secure data synchronization from rig edge systems to central platform through VPN/private WAN/ONGC network.

## 4. Objectives

1. Provide a real-time workover rig digital twin dashboard at the rig site.
2. Capture and historize PLC/equipment telemetry with accurate time stamps.
3. Improve visibility of workover operations, equipment health, alarms, trends and maintenance status.
4. Enable standard digital reporting for daily workover reports, connection records, calibration and downtime.
5. Establish a repeatable architecture for deployment across ONGC rigs.
6. Build a central software platform for multi-rig monitoring, scale-up governance and value realization.
7. Integrate with ONGC identity, network and enterprise systems where required.

## 5. Proposed System Architecture

### 5.1 Rig-Side Edge Architecture

Each rig will have an edge digital twin system installed locally.

```
PLC / Equipment Signals
        |
        v
Industrial Network / Protocol Gateway
        |
        v
Telegraf Collector
        |
        v
Local InfluxDB Historian
        |
        v
Node.js Backend API + Socket.IO
        |
        v
React Operator Dashboard via nginx
        |
        v
Secure Sync to ONGC Central Platform
```

### 5.2 Central Architecture

```
Rig Edge Systems
        |
        | Secure VPN / ONGC WAN / HTTPS or MQTT over TLS
        v
Central Ingestion Layer
        |
        +--> Central Time-Series Store
        +--> Central Relational Store
        +--> Object / Report Storage
        |
        v
Fleet Digital Twin Services
        |
        v
Central Web Portal, DGC Governance Dashboard and APIs
```

## 6. Scope of Work

### 6.1 One Workover Rig Pilot

The pilot will include:

1. Site survey and signal availability assessment.
2. PLC/protocol study for S7comm, Modbus TCP, OPC UA or gateway requirement.
3. Hardware installation at rig site.
4. Edge server installation with Dockerized digital twin stack.
5. Tag mapping and telemetry validation.
6. Operator dashboard commissioning.
7. Alarm configuration and acceptance.
8. Workover activity, reports and maintenance module setup.
9. User training for operator, maintenance engineer and admin.
10. Pilot performance monitoring for defined period.
11. DGC review pack and scale-up recommendation.

### 6.2 Multi-Rig ONGC Scale-Up

The scale-up will include:

1. Standardized rig edge hardware kit.
2. Standard tag dictionary and asset model.
3. Deployment playbook for rig installation.
4. Centralized rig onboarding workflow.
5. Remote monitoring of edge health and data quality.
6. Secure central data synchronization.
7. Fleet dashboards and executive KPIs.
8. Periodic adoption and value realization reporting to DGC.

## 7. Functional Requirements - Rig Edge System

| Area | Requirement |
|---|---|
| Real-time dashboard | Live gauges for hook load, WOB, RPM, torque, pressure, flow, bit depth, block position and equipment status. |
| Workover operations | Activity tracking, tour details, connection records, torque-turn data and daily workover reports. |
| Equipment monitoring | CAT engine, HPU, HTD, PCT, catwalk, mud pump, well control and other rig equipment views. |
| Alarms | Priority alarms, acknowledgement, alarm history and annunciator behavior. |
| Trends | Real-time and historical trends with export. |
| Maintenance | Asset health, preventive maintenance schedule, downtime log and calibration history. |
| Reports | Daily workover report, activity summary, connection summary, alarm report and maintenance report. |
| Admin | PLC configuration, tag mapping, user management, role management and system status. |
| Offline operation | Rig dashboard must continue working locally even if central connectivity is unavailable. |
| Sync | Store-and-forward data synchronization when WAN returns. |

## 8. Hardware Requirements - One Workover Rig

### 8.1 Minimum Recommended Rig Edge Hardware

| Item | Recommended Specification | Quantity |
|---|---:|---:|
| Industrial edge computer | Fanless industrial PC, Intel i5/i7 or equivalent, 4 cores minimum, 16 GB RAM minimum, 512 GB industrial SSD minimum, dual Ethernet, 24 V DC input, DIN/panel mount, -10 C to 55 C operating range or better | 1 |
| Storage upgrade | 1 TB industrial SSD for longer local retention and logs | 1 |
| Operator HMI display | 21.5 inch or 24 inch industrial touch monitor, IP65 front, full HD, sunlight-readable preferred | 1 |
| Keyboard/mouse | Industrial keyboard with pointing device or rugged keyboard/mouse set | 1 |
| Managed industrial switch | 8-port managed industrial Ethernet switch, VLAN support, DIN rail, redundant power input | 1 |
| Firewall/VPN router | Industrial firewall/router with VPN, NAT, access control, LTE/5G optional depending on WAN availability | 1 |
| Protocol gateway | OPC UA / Modbus / S7 gateway if direct PLC access is not approved or protocol conversion is required | As required |
| RS485/Ethernet converter | For legacy Modbus RTU or serial instruments | As required |
| UPS | Online or industrial DC UPS, minimum 30 minutes backup for edge computer, switch and router | 1 |
| Panel enclosure | IP54/IP65 enclosure with power distribution, MCB, surge protection, earthing and ventilation | 1 |
| Time sync | NTP via ONGC network; optional GPS/NTP appliance if network time is unavailable | 1 optional |

### 8.2 Recommended Enhanced Rig Hardware

| Item | Purpose |
|---|---|
| Redundant SSD or backup disk | Local backup of configuration and historian exports. |
| Second operator display | Toolpusher/company man/maintenance view. |
| Industrial Wi-Fi access point | Local tablet view, only on secured operations network if permitted. |
| Environmental sensors | Panel temperature, humidity and power health monitoring. |
| Edge backup unit | Cold standby image for fast replacement. |

### 8.3 Hardware Sizing Notes

For one rig with 500 to 2,000 tags at 1-second sampling:

- Edge CPU: 4 cores minimum, 8 cores recommended.
- RAM: 16 GB minimum, 32 GB recommended.
- Local storage: 512 GB minimum, 1 TB recommended.
- Local retention: 30 to 90 days at edge, configurable.
- Network: Segregated OT network and IT/WAN uplink.

## 9. Software Requirements - Rig Edge System

### 9.1 Current Application Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Material UI, Recharts, Lucide icons |
| Backend | Node.js, Express, Socket.IO |
| Historian | InfluxDB 2.7 |
| Collector | Telegraf 1.29 |
| Auth | JWT, bcrypt, RBAC, optional LDAP/LDAPS for Windows AD |
| Web server | nginx |
| Packaging | Docker Compose |
| Demo data | Synthetic mock telemetry generator |

### 9.2 Edge Software Requirements

| Area | Requirement |
|---|---|
| Operating system | Ubuntu Server LTS, Red Hat Enterprise Linux or ONGC-approved Linux distribution. |
| Container runtime | Docker Engine / Docker Compose or ONGC-approved equivalent such as Podman. |
| Database | InfluxDB for time-series; local file/volume for app configuration and users. |
| Collector | Telegraf for PLC polling and data forwarding. |
| Security | TLS, VPN, JWT, RBAC, LDAP/AD integration, password policy and audit logs. |
| Backup | Scheduled backup of config, users, tag maps and important reports. |
| Monitoring | Container health, disk usage, data freshness, collector status and sync status. |
| Update | Versioned container images and controlled update package. |

## 10. Central Software Specification

The central software is required for ONGC-wide rollout and DGC governance. It should be developed as a separate enterprise platform connected to all rig edge systems.

### 10.1 Central Software Objectives

1. Provide fleet-wide visibility across ONGC workover rigs.
2. Monitor rig status, data quality, connectivity, alarms and operations.
3. Track adoption, implementation progress and value realization for DGC.
4. Provide central architecture governance for tag standards, equipment models and dashboard versions.
5. Support enterprise reporting, benchmarking and future analytics.

### 10.2 Central Software Modules

| Module | Key Features |
|---|---|
| Fleet overview | Map/list of all rigs, current status, connectivity, alarm count, active operation and last data timestamp. |
| Rig drill-down | Remote view of selected rig KPIs, trends, alarms, equipment status and reports. |
| Data quality monitor | Missing tags, stale data, abnormal values, collector health, historian health and sync lag. |
| Alarm command center | Cross-rig active alarms, priority filters, acknowledgement audit and recurring alarm analysis. |
| Workover performance | Activity/NPT tracking, connection quality, torque-turn summary, daily workover report consolidation. |
| Maintenance and reliability | Preventive maintenance compliance, downtime, asset health, calibration and failure history. |
| DGC governance | Project stage, site readiness, architecture review status, adoption progress, blockers and value realization. |
| Configuration registry | Rig master, asset master, tag dictionary, protocol configuration templates and dashboard version registry. |
| User and access management | ONGC AD integration, central roles, rig-level permissions and audit logs. |
| Reporting | Daily, weekly and monthly reports for operations, maintenance, alarms, adoption and value realization. |
| Integration API | APIs for SAP ERP, enterprise dashboards, data lake and other ONGC systems. |

### 10.3 Central Data Model

The central system should maintain the following master and transactional entities:

| Entity | Purpose |
|---|---|
| Rig | Rig identity, location, asset owner, status, business unit, network status. |
| Well / Workover job | Well details, job objective, current activity, start/end dates. |
| Asset | Equipment hierarchy such as HPU, HTD, PCT, BOP, CAT engine, mud pump. |
| Tag | Standard tag name, unit, sampling rate, source, alarm limits and data quality rules. |
| Telemetry point | Time-series values from edge historian. |
| Alarm event | Alarm state, priority, acknowledgement, return-to-normal and user action. |
| Activity event | Rig activity, productive/NPT classification, comments and operator. |
| Maintenance record | PM task, calibration, downtime, service action and closure. |
| Connection record | Torque-turn peak, result, duration, joint count and limits. |
| User / Role | Identity, role, rig access, AD group mapping and audit trail. |
| Deployment status | Edge software version, last sync, data lag, open issues and commissioning status. |
| Value metric | Baseline, target, actual value, value category and reporting period. |

### 10.4 Central Ingestion and Synchronization

The central software should support:

1. Secure rig-to-central communication over VPN/private WAN.
2. HTTPS or MQTT over TLS ingestion.
3. Store-and-forward from edge during WAN outage.
4. Compression and batching for low-bandwidth rigs.
5. Per-rig certificates or token-based device identity.
6. Schema versioning for tag and event payloads.
7. Back-pressure handling so central downtime does not affect rig operations.

Recommended ingestion pattern:

```
Rig Edge Sync Agent
  -> Secure API Gateway / MQTT Broker
  -> Stream Processor
  -> Time-Series Store + Relational Store
  -> Fleet Services and Dashboards
```

### 10.5 Recommended Central Technology Stack

| Layer | Recommended Technology |
|---|---|
| Web portal | React or Next.js with enterprise design system |
| API services | Node.js/NestJS or Java Spring Boot as per ONGC standard |
| Real-time messaging | MQTT broker, NATS or Kafka depending on ONGC enterprise architecture |
| Time-series store | InfluxDB Enterprise/Cluster, TimescaleDB or ONGC-approved time-series platform |
| Relational store | PostgreSQL for master data, reports, users, governance and metadata |
| Cache | Redis for session, dashboard cache and queue support |
| Object storage | S3-compatible object store or ONGC-approved document store for reports and files |
| Identity | ONGC Active Directory / LDAP / SSO integration |
| API gateway | ONGC-approved gateway with TLS, rate limits and audit |
| Observability | Prometheus/Grafana or enterprise monitoring stack |
| Deployment | Kubernetes/OpenShift or Docker Compose for smaller central deployment |

The final stack should be approved through DGC architecture review and aligned with ONGC data center/cloud policy.

### 10.6 Central Non-Functional Requirements

| Requirement | Target |
|---|---|
| Multi-rig scalability | 50 rigs initially, scalable to 200+ rigs. |
| Edge real-time latency | 1 second local dashboard update target. |
| Central latency | 5 to 60 seconds depending on WAN and batching policy. |
| Availability | Edge dashboard available locally even if central connection fails. Central target 99.5% or higher. |
| Offline tolerance | Edge should buffer minimum 7 days; recommended 30 days. |
| Security | TLS, VPN, device identity, AD integration, audit logs and least-privilege access. |
| Retention | Edge 30 to 90 days; central 1 to 5 years depending on ONGC policy. |
| Audit | All login, configuration, alarm acknowledgement and report edits logged. |
| Performance | Fleet dashboard load under 5 seconds for normal filters. |
| Data quality | Stale/missing data detection with visible health score per rig. |

### 10.7 Central Governance Features for DGC

The central platform should include a DGC governance workspace:

1. Initiative stage-gate tracker.
2. Site readiness and installation checklist.
3. Architecture review status.
4. Security review status.
5. Adoption progress per rig.
6. Value realization dashboard.
7. Escalation register for stalled rigs or unresolved dependencies.
8. Presentation-ready executive summary export.
9. Project notes and decision log.
10. Central repository of approved hardware/software standards.

## 11. Cybersecurity and Network Requirements

1. Separate OT network from IT/WAN network using firewall rules.
2. No direct internet exposure of backend, historian or PLC network.
3. Only dashboard/service ports approved by ONGC to be exposed.
4. VPN or private WAN for central sync.
5. TLS certificates for all central communication.
6. LDAP/AD integration for user authentication where available.
7. Local break-glass admin account for rig operation during AD/network outage.
8. Role-based access:
   - Admin: user management, PLC config, system config.
   - Operator: operational entries, alarm acknowledgement, calibration.
   - Viewer: read-only dashboard and reports.
9. Regular backup and restore test.
10. Audit logging for configuration and operational actions.

## 12. Integration Requirements

Potential ONGC integrations:

| System | Integration Purpose |
|---|---|
| Active Directory | Central identity and role mapping. |
| SAP ERP / PM | Asset master, maintenance work orders, service history. |
| Enterprise data lake | Long-term analytics and AI/ML use cases. |
| Email/SMS/notification gateway | Alarm escalation and report distribution. |
| Existing SCADA/PLC systems | Read-only telemetry capture without disturbing control logic. |
| DGC reporting process | Adoption, value realization and project status reporting. |

## 13. Implementation Roadmap

### Phase 0 - DGC Approval and Architecture Review

Duration: 2 to 3 weeks

Deliverables:

- Project note.
- Architecture review pack.
- Cybersecurity approach.
- Pilot rig selection.
- Pilot success criteria.
- Hardware BoQ approval.

### Phase 1 - Pilot Rig Discovery

Duration: 2 to 4 weeks

Deliverables:

- Site survey report.
- PLC/protocol availability report.
- Tag list and asset hierarchy.
- Network and panel design.
- Installation plan.

### Phase 2 - Pilot Rig Implementation

Duration: 6 to 8 weeks

Deliverables:

- Edge hardware installed.
- Digital twin stack deployed.
- PLC/tag mapping configured.
- Operator dashboard commissioned.
- Alarm and report modules configured.
- Training completed.
- Site acceptance test.

### Phase 3 - Pilot Operation and Value Validation

Duration: 4 to 8 weeks

Deliverables:

- Pilot performance report.
- Data quality report.
- User adoption report.
- Value realization baseline and actuals.
- DGC scale-up recommendation.

### Phase 4 - Central Software MVP

Duration: 10 to 14 weeks

Deliverables:

- Multi-rig central portal MVP.
- Rig registry and onboarding.
- Fleet dashboard.
- Central alarms and reports.
- Edge sync service.
- DGC governance dashboard.

### Phase 5 - ONGC Multi-Rig Rollout

Duration: Wave-based rollout

Deliverables per wave:

- Rig hardware installation.
- Edge configuration.
- Central onboarding.
- Training and handover.
- Adoption and value report.

## 14. Pilot Acceptance Criteria

| Area | Acceptance Criteria |
|---|---|
| Data acquisition | Minimum agreed critical tags received with correct units and timestamps. |
| Dashboard | Operator dashboard updates live and shows stale/no-data honestly. |
| Alarms | Configured alarms trigger, acknowledge and record history. |
| Reports | Daily workover report and connection records generated. |
| Security | Role-based login works; AD/LDAP tested if available. |
| Reliability | Edge system runs continuously during pilot with defined uptime target. |
| Offline resilience | Local dashboard works during WAN outage. |
| Central sync | Pilot data syncs to central platform or staging endpoint. |
| Training | Operators and admins trained with sign-off. |
| Value | Baseline and post-pilot KPIs documented. |

## 15. Value Realization Metrics

Recommended metrics:

1. Reduction in manual report preparation time.
2. Reduction in telemetry/data gaps.
3. Alarm response time and acknowledgement compliance.
4. NPT visibility and classification accuracy.
5. Preventive maintenance compliance.
6. Equipment downtime tracking completeness.
7. Workover connection quality and torque-turn compliance.
8. Rig digital adoption score.
9. Dashboard uptime and data freshness.
10. Number of rigs onboarded per rollout wave.

## 16. Risks and Mitigation

| Risk | Mitigation |
|---|---|
| PLC data access not available | Use protocol gateway, read-only network tap or phased tag availability. |
| WAN connectivity unstable | Edge-first design with local historian and store-and-forward sync. |
| Non-standard rig configurations | Standard tag dictionary with rig-specific mapping layer. |
| Cybersecurity approval delay | Early DGC/security architecture review. |
| User adoption challenge | Operator training, simple UI, on-site support during pilot. |
| Legacy system overlap | Integrate where useful; avoid replacing approved control systems. |
| Hardware environment issues | Industrial-grade hardware, UPS, panel enclosure and environmental monitoring. |

## 17. Deliverables

1. DGC project note.
2. Architecture review document.
3. Pilot rig site survey report.
4. Hardware BoQ and installation drawing.
5. PLC tag mapping and asset hierarchy.
6. Cybersecurity and network design.
7. Edge digital twin deployment.
8. Operator dashboard and admin module.
9. Alarm, report, workover and maintenance configuration.
10. Central software specification and MVP plan.
11. Training material and SOP.
12. SAT/UAT documents.
13. Pilot value realization report.
14. Scale-up rollout plan.

## 18. Assumptions

1. ONGC will provide access to PLC/protocol documentation for the pilot rig.
2. ONGC will approve network connectivity between rig edge system and central platform.
3. The pilot will start with a defined critical tag list and expand in phases.
4. The system will be read-only with respect to PLC/control systems unless separately approved.
5. Central platform hosting will be provided in ONGC data center/cloud as per policy.
6. SAP/ERP integration will be implemented after master data and API readiness are confirmed.

## 19. Recommended Immediate Next Steps

1. Select pilot workover rig.
2. Conduct rig site survey and tag discovery.
3. Finalize pilot KPIs and DGC stage-gate criteria.
4. Approve edge hardware BoQ.
5. Install pilot system.
6. Begin central platform MVP design using this specification.
7. Prepare DGC architecture review and value realization template.

