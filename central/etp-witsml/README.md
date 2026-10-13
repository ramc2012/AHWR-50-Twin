# CRMF ETP/WITSML server

The CMF historian over the Energistics standards: **ETP v1.2** (the current ETP
release; the API Energistics specifies for WITSML 2.1) publishing **WITSML 2.1**
objects (Energistics common 2.3). Deployment notes: `../deploy/k8s/platform/standards/00-etp-witsml-note.md`.

| Endpoint | |
|---|---|
| `ws(s)://<host>:8443/` | ETP v1.2, subprotocol `etp12.energistics.org`, binary Avro (official schemas, `lib/etp12/schemas.json`) |
| `/.well-known/etp-server-capabilities` | ServerCapabilities (binary; `?$format=json`; `?GetVersions=true`) |
| `/witsml21/objects`, `/witsml21/object/<uuid>` | WITSML 2.1 objects over HTTP (Bearer portal token) |
| `/healthz` | database reachable |

Protocols: Core; Discovery (3), Store (4), ChannelSubscribe (21), ChannelDataFrame (2)
for readers (`Bearer <portal JWT>`, viewer or above); Store put + ChannelDataLoad (22)
and ChannelStreaming consumer (1) for rig edges (`Basic <rig id>:<device token>`),
own rig only.

Objects (identifiers: `lib/ids.js`, RFC 4122 v5, identical at the edge): Rig; Channel
per (rig, metric) with mnemonic, Energistics unit and PWLS property kind (from the
edge's channel dictionary); Well and Wellbore; per well run a RigUtilization, Log
and ChannelSet; BusinessAssociate; PropertyKind.

`lib/etp12`, `lib/ids.js`, `lib/witsml21.js` and `lib/propertyKinds.json` are the
same files as in AHWR-150-EDGE `app/backend/lib`; keep them in step.

## Tests

```
npm test                                   # unit tests
ETP_TEST_URL=ws://127.0.0.1:8443 ETP_TEST_JWT_SECRET=<JWT_SECRET> \
  WITSML21_XSD_DIR=<energyml/data of the official schemas> npm test   # against a running server with rig data
python -I test/tools/etpproto-conformance.py ws://127.0.0.1:8443 <viewer JWT>   # independent client (Geosiris etpproto)
```
