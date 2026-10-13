'use strict';
// ETP v1.2 server of the CMF (WebSocket subprotocol etp12.energistics.org,
// binary Avro). Roles this server plays:
//   Discovery (3) store        users, edges   GetResources (graph per lib/store.js), GetDeletedResources
//   Store (4) store            users: get; edges: get + put their own rig's objects
//   ChannelSubscribe (21) store users          GetChannelMetadata, SubscribeChannels, GetRanges, UnsubscribeChannels
//   ChannelDataFrame (2) store users           GetFrameMetadata, GetFrame (ChannelSets of well runs)
//   ChannelDataLoad (22) store edges           OpenChannels (resume index = the store's last point),
//                                              ChannelData, CloseChannels
//   ChannelStreaming (1) consumer edges        an edge streaming as a simple producer
// Monitoring-only: nothing here writes to a rig or PLC; edges write their own
// rig's data into the CMF historian.
const crypto = require('crypto');
const codec = require('./etp12/codec');
const { EtpSession } = require('./etp12/session');
const uri = require('./etp12/uri');
const store = require('./store');
const load = require('./load');

const { PROTOCOL: P, ERRORS: E, VERSION } = codec;
const SERVER_INSTANCE = crypto.randomUUID();
const STARTED_US = Date.now() * 1000;
const APP_NAME = 'CRMF ETP/WITSML server';
const APP_VERSION = (() => { try { return require('../package.json').version; } catch { return '1.0.0'; } })();
const MAX_MESSAGE = Number(process.env.ETP_MAX_MESSAGE_BYTES || 16 * 1024 * 1024);
const MAX_RESPONSE_COUNT = 10000;
const RESOURCES_PER_MESSAGE = 1000;
const DATA_ITEMS_PER_MESSAGE = 5000;
const MAX_FRAME_ROWS = Number(process.env.ETP_MAX_FRAME_ROWS || 100000);
const MAX_RANGE_ITEMS = Number(process.env.ETP_MAX_RANGE_ITEMS || 1000000);
const STREAM_MS = Number(process.env.ETP_STREAM_MS || 1000);

const long = (n) => ({ item: { long: Math.round(n) } });
const bool = (b) => ({ item: { boolean: !!b } });
const uuidBytes = (u) => Buffer.from(String(u).replace(/-/g, ''), 'hex');
const hdr = (msg) => ({ protocol: msg.protocol, header: msg.header });

// Who may use each protocol, and the role this server plays.
const OFFER = [
    { protocol: P.Discovery, role: 'store', who: ['user', 'edge'] },
    { protocol: P.Store, role: 'store', who: ['user', 'edge'] },
    { protocol: P.ChannelSubscribe, role: 'store', who: ['user'] },
    { protocol: P.ChannelDataFrame, role: 'store', who: ['user'] },
    { protocol: P.ChannelDataLoad, role: 'store', who: ['edge'] },
    { protocol: P.ChannelStreaming, role: 'consumer', who: ['edge'] },
];
const PROTOCOL_CAPS = {
    [P.Discovery]: { MaxResponseCount: long(MAX_RESPONSE_COUNT) },
    [P.Store]: { MaxDataObjectSize: long(MAX_MESSAGE) },
    [P.ChannelSubscribe]: { MaxRangeDataItemCount: long(MAX_RANGE_ITEMS) },
    [P.ChannelDataFrame]: { MaxFrameResponseRowCount: long(MAX_FRAME_ROWS) },
    [P.ChannelDataLoad]: {},
    [P.ChannelStreaming]: {},
};
const ENDPOINT_CAPS = {
    MaxWebSocketMessagePayloadSize: long(MAX_MESSAGE),
    MaxWebSocketFramePayloadSize: long(MAX_MESSAGE),
    SupportsAlternateRequestUris: bool(false),
    SupportsMessageHeaderExtensions: bool(false),
    ChangeRetentionPeriod: long(86400),
};
const dataObjectCaps = (principal) => ({
    SupportsGet: bool(true),
    SupportsPut: bool(principal && principal.kind === 'edge'),
    SupportsDelete: bool(false),
});

/** The .well-known/etp-server-capabilities record. */
function serverCapabilities() {
    return {
        applicationName: APP_NAME, applicationVersion: APP_VERSION,
        contactInformation: { organizationName: process.env.ETP_CONTACT_ORG || '', contactName: '', contactPhone: '', contactEmail: process.env.ETP_CONTACT_EMAIL || '' },
        supportedCompression: [], supportedEncodings: ['binary'], supportedFormats: ['xml'],
        supportedDataObjects: store.TYPES.map((t) => ({ qualifiedType: t, dataObjectCapabilities: dataObjectCaps(null) })),
        supportedProtocols: OFFER.map((o) => ({ protocol: o.protocol, protocolVersion: VERSION, role: o.role, protocolCapabilities: PROTOCOL_CAPS[o.protocol] })),
        endpointCapabilities: ENDPOINT_CAPS,
    };
}

// ---- Channel metadata --------------------------------------------------------------
const indexInterval = (start, end) => ({
    startIndex: start ? long(codec.micros(start)) : { item: null },
    endIndex: end ? long(codec.micros(end)) : { item: null },
    uom: 'us', depthDatum: '',
});
const timeIndex = (start, end) => ({
    indexKind: 'DateTime', interval: indexInterval(start, end), direction: 'Increasing', name: 'TIME',
    uom: 'us', depthDatum: '', indexPropertyKindUri: '', filterable: true,
});
function channelMetadata(node, id) {
    const e = node.entry;
    return {
        uri: store.uriOf(node), id, indexes: [timeIndex(e.firstTs, e.lastTs)],
        channelName: e.mnemonic, dataKind: 'typeDouble', uom: e.uom, depthDatum: '',
        channelClassUri: uri.object('eml23.PropertyKind', e.propertyKind.uuid),
        status: node.active ? 'Active' : 'Inactive',
        source: `${node.rigId}: ${e.label || e.metric} [${e.metric}]`.slice(0, 256),
        axisVectorLengths: [], attributeMetadata: [], customData: {},
    };
}
const dataItem = (channelId, ts, stored, factor) => ({
    channelId, indexes: [long(new Date(ts).getTime() * 1000)],
    value: { item: { double: Number(stored) * (factor || 1) } }, valueAttributes: [],
});

// ---- Session ------------------------------------------------------------------------
class ServerSession {
    constructor(ws, principal, log) {
        this.principal = principal;
        this.log = log;
        this.etp = new EtpSession(ws, { side: 'server' });
        this.state = 'connected';
        this.protocols = new Map();     // protocol -> role we play
        this.ids = { [P.ChannelSubscribe]: new Map(), [P.ChannelDataLoad]: new Map() };  // uuid -> id
        this.byId = { [P.ChannelSubscribe]: new Map(), [P.ChannelDataLoad]: new Map() };  // id -> node
        this.subscriptions = new Map(); // channelId -> { node, cursor (ms), dataChanges }
        this.producerChannels = new Map(); // Protocol 1: producer's id -> node
        this.streamTimer = null;
        // Messages are handled one at a time, in arrival order.
        this.chain = Promise.resolve();
        this.etp.on('message', (msg) => {
            this.chain = this.chain.then(() => this.dispatch(msg)).catch((e) => {
                this.log(`error in ${msg.name}: ${e.stack || e.message}`);
                this.etp.exception(hdr(msg), e.etpCode || E.EREQUEST_DENIED, e.message);
            });
        });
        this.etp.on('close', () => { clearInterval(this.streamTimer); this.state = 'closed'; });
        this.openTimer = setTimeout(() => {
            if (this.state === 'connected') { this.etp.exception(null, E.ETIMED_OUT, 'no RequestSession received'); this.etp.close('session establishment timeout'); }
        }, 30000);
    }

    channelId(protocol, node) {
        const map = this.ids[protocol];
        if (!map.has(node.uuid)) { const id = map.size + 1; map.set(node.uuid, id); this.byId[protocol].set(id, node); }
        return map.get(node.uuid);
    }

    async dispatch(msg) {
        if (this.state === 'closed') return undefined;
        if (msg.protocol === P.Core) return this.core(msg);
        if (this.state !== 'open') return this.etp.exception(hdr(msg), E.EINVALID_STATE, 'no ETP session; send RequestSession first');
        if (!this.protocols.has(msg.protocol)) return this.etp.exception(hdr(msg), E.EUNSUPPORTED_PROTOCOL, `protocol ${msg.protocol} was not negotiated for this session`);
        const handler = this[`p${msg.protocol}_${msg.name}`];
        if (!handler) return this.etp.exception(hdr(msg), E.EINVALID_MESSAGETYPE, `${msg.name} is not accepted by this ${this.protocols.get(msg.protocol)}`);
        return handler.call(this, msg);
    }

    // ---- Core ----------------------------------------------------------------------
    core(msg) {
        switch (msg.name) {
            case 'RequestSession': return this.requestSession(msg);
            case 'CloseSession': this.etp.close('closed by client'); return undefined;
            case 'Pong': case 'Acknowledge': return undefined;
            case 'ProtocolException': this.log(`client exception: ${JSON.stringify(msg.body.error)}`); return undefined;
            case 'Authorize': return this.etp.exception(hdr(msg), E.ENOTSUPPORTED, 'authorize on the WebSocket upgrade (Authorization header)');
            default: return this.etp.exception(hdr(msg), E.EINVALID_MESSAGETYPE, `${msg.name} is not accepted`);
        }
    }

    requestSession(msg) {
        if (this.state !== 'connected') return this.etp.exception(hdr(msg), E.EINVALID_STATE, 'session already established');
        clearTimeout(this.openTimer);
        const who = this.principal.kind;
        const agreed = [];
        for (const rp of msg.body.requestedProtocols || []) {
            const o = OFFER.find((x) => x.protocol === rp.protocol && x.role === rp.role && x.who.includes(who));
            const v = rp.protocolVersion || {};
            if (o && v.major === 1 && v.minor === 2 && !agreed.some((a) => a.protocol === o.protocol)) agreed.push(o);
        }
        if (!agreed.length) {
            this.etp.exception(hdr(msg), E.ENOSUPPORTEDPROTOCOLS, `none of the requested protocols/roles is offered to a ${who}`);
            return this.etp.close('no supported protocols');
        }
        const formats = msg.body.supportedFormats || [];
        if (formats.length && !formats.includes('xml')) {
            this.etp.exception(hdr(msg), E.ENOSUPPORTEDFORMATS, 'this store supports the xml format only');
            return this.etp.close('no supported formats');
        }
        const wanted = (msg.body.supportedDataObjects || []).map((d) => d.qualifiedType);
        const types = store.TYPES.filter((t) => !wanted.length || wanted.some((w) => w === t || (w.endsWith('.*') && t.startsWith(w.slice(0, -1)))));
        for (const o of agreed) this.protocols.set(o.protocol, o.role);
        this.sessionId = crypto.randomUUID();
        this.etp.send(P.Core, 'OpenSession', {
            applicationName: APP_NAME, applicationVersion: APP_VERSION,
            serverInstanceId: uuidBytes(SERVER_INSTANCE),
            supportedProtocols: agreed.map((o) => ({ protocol: o.protocol, protocolVersion: VERSION, role: o.role, protocolCapabilities: PROTOCOL_CAPS[o.protocol] })),
            supportedDataObjects: types.map((t) => ({ qualifiedType: t, dataObjectCapabilities: dataObjectCaps(this.principal) })),
            supportedCompression: '', supportedFormats: ['xml'],
            currentDateTime: Date.now() * 1000, earliestRetainedChangeTime: STARTED_US,
            sessionId: uuidBytes(this.sessionId), endpointCapabilities: ENDPOINT_CAPS,
        }, { correlationId: msg.header.messageId });
        this.state = 'open';
        this.log(`session ${this.sessionId} opened for ${who} ${this.principal.rigId || this.principal.user}: protocols ${agreed.map((o) => o.protocol).join(',')}`);
        // As a ChannelStreaming consumer, ask the edge producer to start.
        if (this.protocols.get(P.ChannelStreaming) === 'consumer') this.etp.send(P.ChannelStreaming, 'StartStreaming', {});
        return undefined;
    }

    // ---- Discovery (3) ---------------------------------------------------------------
    async p3_GetResources(msg) {
        const b = msg.body;
        const ctx = b.context;
        const target = uri.parse(ctx.uri);
        if (!target) return this.etp.exception(hdr(msg), E.EINVALID_URI, `not a canonical Energistics URI: ${ctx.uri}`);
        if (target.dataspace) return this.etp.exception(hdr(msg), E.ENOT_FOUND, `dataspace '${target.dataspace}' does not exist (only the default dataspace eml:///)`);
        const s = await store.get();
        const typeOk = (t) => !ctx.dataObjectTypes.length || ctx.dataObjectTypes.some((w) => w === t || (w.endsWith('.*') && t.startsWith(w.slice(0, -1))));
        let result;
        if (target.kind === 'dataspace') {
            result = [...s.nodes.values()];             // scope and depth are ignored for a dataspace
        } else {
            const start = s.nodes.get(target.uuid);
            if (!start || start.type !== target.type) return this.etp.exception(hdr(msg), E.ENOT_FOUND, `${ctx.uri} not found`);
            const nav = (kind) => ctx.navigableEdges === 'Both' || ctx.navigableEdges === kind;
            const dirs = { self: [], sources: ['s'], sourcesOrSelf: ['s'], targets: ['t'], targetsOrSelf: ['t'] }[b.scope] || [];
            const seen = new Set([start.uuid]);
            const found = [];
            let frontier = [start];
            for (let d = 0; d < Math.max(0, ctx.depth) && frontier.length && dirs.length; d++) {
                const next = [];
                for (const n of frontier) {
                    const edges = dirs[0] === 's' ? store.sources(s, n) : store.targets(s, n);
                    for (const e of edges) {
                        if (!nav(e.kind) || seen.has(e.node.uuid)) continue;
                        seen.add(e.node.uuid); found.push(e.node); next.push(e.node);
                    }
                }
                frontier = next;
            }
            result = b.scope.endsWith('OrSelf') || b.scope === 'self' ? [start, ...found] : found;
            if (ctx.includeSecondaryTargets || ctx.includeSecondarySources) {
                const extra = [];
                for (const n of result) {
                    const more = [
                        ...(ctx.includeSecondaryTargets ? store.targets(s, n) : []),
                        ...(ctx.includeSecondarySources ? store.sources(s, n) : []),
                    ].filter((e) => e.kind === 'Secondary');
                    for (const e of more) if (!seen.has(e.node.uuid)) { seen.add(e.node.uuid); extra.push(e.node); }
                }
                result = result.concat(extra);
            }
        }
        result = result.filter((n) => typeOk(n.type));
        if (b.activeStatusFilter) {
            const want = Object.values(b.activeStatusFilter)[0];   // wrapped union {ActiveStatusKind: 'Active'}
            result = result.filter((n) => (n.active === false ? 'Inactive' : 'Active') === want);
        }
        if (b.storeLastWriteFilter && b.storeLastWriteFilter.long) {
            const after = Number(b.storeLastWriteFilter.long);
            result = result.filter((n) => (n.lastChanged || n.created) * 1000 > after);
        }
        const resources = result.map((n) => store.resource(s, n, { countObjects: b.countObjects }));
        const parts = [];
        for (let i = 0; i < resources.length; i += RESOURCES_PER_MESSAGE) parts.push(['GetResourcesResponse', { resources: resources.slice(i, i + RESOURCES_PER_MESSAGE) }]);
        if (!parts.length) parts.push(['GetResourcesResponse', { resources: [] }]);
        if (b.includeEdges && resources.length) {
            const inSet = new Set(result.map((n) => n.uuid));
            const edges = [];
            for (const n of result) {
                for (const e of store.targets(s, n)) {
                    edges.push({ sourceUri: store.uriOf(n), targetUri: store.uriOf(e.node), relationshipKind: e.kind, customData: {} });
                }
                for (const e of store.sources(s, n)) {
                    if (!inSet.has(e.node.uuid)) edges.push({ sourceUri: store.uriOf(e.node), targetUri: store.uriOf(n), relationshipKind: e.kind, customData: {} });
                }
            }
            for (let i = 0; i < edges.length; i += RESOURCES_PER_MESSAGE) parts.push(['GetResourcesEdgesResponse', { edges: edges.slice(i, i + RESOURCES_PER_MESSAGE) }]);
        }
        if (parts.length > MAX_RESPONSE_COUNT) {
            this.etp.replySequence(hdr(msg), parts.slice(0, MAX_RESPONSE_COUNT).map((p) => p), { protocol: P.Discovery });
            return this.etp.exception(hdr(msg), E.ERESPONSECOUNT_EXCEEDED, 'response count limit reached');
        }
        return this.etp.replySequence(hdr(msg), parts, { protocol: P.Discovery });
    }

    p3_GetDeletedResources(msg) {
        const ds = uri.parse(msg.body.dataspaceUri);
        if (!ds || ds.kind !== 'dataspace') return this.etp.exception(hdr(msg), E.EINVALID_URI, 'dataspaceUri must be a dataspace URI');
        // Objects are derived from the historian and never deleted through ETP.
        return this.etp.reply(hdr(msg), 'GetDeletedResourcesResponse', { deletedResources: [] });
    }

    // ---- Store (4) -----------------------------------------------------------------------
    async p4_GetDataObjects(msg) {
        const { uris, format } = msg.body;
        if (format && format !== 'xml') return this.etp.exception(hdr(msg), E.ENOSUPPORTEDFORMATS, 'this store supports the xml format only');
        const s = await store.get();
        const ok = {}; const errors = {};
        for (const [key, u] of Object.entries(uris)) {
            const t = uri.parse(u);
            if (!t || t.kind !== 'object') { errors[key] = { code: E.EINVALID_URI, message: `not a data object URI: ${u}` }; continue; }
            const n = s.nodes.get(t.uuid);
            if (!n || n.type !== t.type) { errors[key] = { code: E.ENOT_FOUND, message: `${u} not found` }; continue; }
            const xml = await store.xmlOf(s, n);
            ok[key] = { resource: store.resource(s, n), format: 'xml', blobId: null, data: Buffer.from(xml, 'utf8') };
        }
        return this.mapReply(msg, 'GetDataObjectsResponse', { dataObjects: ok }, errors);
    }

    async p4_PutDataObjects(msg) {
        if (this.principal.kind !== 'edge') return this.etp.exception(hdr(msg), E.EREQUEST_DENIED, 'only rig edges may put data objects');
        const ok = {}; const errors = {};
        for (const [key, obj] of Object.entries(msg.body.dataObjects)) {
            const t = uri.parse(obj.resource.uri);
            if (!t || t.kind !== 'object' || t.dataspace) { errors[key] = { code: E.EINVALID_URI, message: `not a default-dataspace object URI: ${obj.resource.uri}` }; continue; }
            if (obj.format && obj.format !== 'xml') { errors[key] = { code: E.ENOSUPPORTEDFORMATS, message: 'xml only' }; continue; }
            const custom = Object.fromEntries(Object.entries(obj.resource.customData || {}).map(([k, v]) => [k, codec.dataValueOf(v)]));
            try {
                await load.putObject(this.principal.rigId, t.type, t.uuid, Buffer.from(obj.data).toString('utf8'), custom);
                ok[key] = { createdContainedObjectUris: [], deletedContainedObjectUris: [], joinedContainedObjectUris: [], unjoinedContainedObjectUris: [] };
            } catch (e) {
                errors[key] = { code: e.etpCode || E.EINVALID_OBJECT, message: e.message };
            }
        }
        if (Object.keys(ok).length) store.invalidate();
        return this.mapReply(msg, 'PutDataObjectsResponse', { success: ok }, errors);
    }

    p4_DeleteDataObjects(msg) { return this.etp.exception(hdr(msg), E.EREQUEST_DENIED, 'objects are derived from the historian and cannot be deleted'); }
    p4_Chunk(msg) { return this.etp.exception(hdr(msg), E.ENOTSUPPORTED, 'chunked objects are not supported; objects up to MaxDataObjectSize'); }

    /** Plural (map) reply: positive response (if any), then map errors (if any); FIN on the last. */
    mapReply(msg, name, body, errors) {
        const hasOk = Object.keys(Object.values(body)[0]).length > 0;
        const hasErr = Object.keys(errors).length > 0;
        if (hasOk || !hasErr) this.etp.send(msg.protocol, name, body, { correlationId: msg.header.messageId, final: !hasErr });
        if (hasErr) this.etp.exception(hdr(msg), 0, '', { errors });
    }

    // ---- ChannelSubscribe (21) -------------------------------------------------------------
    async p21_GetChannelMetadata(msg) {
        const s = await store.get();
        const ok = {}; const errors = {};
        for (const [key, u] of Object.entries(msg.body.uris)) {
            const t = uri.parse(u);
            const n = t && t.kind === 'object' ? s.nodes.get(t.uuid) : null;
            if (!n || n.type !== 'witsml21.Channel') { errors[key] = { code: t ? E.ENOT_FOUND : E.EINVALID_URI, message: `${u} is not a channel of this store` }; continue; }
            ok[key] = channelMetadata(n, this.channelId(P.ChannelSubscribe, n));
        }
        return this.mapReply(msg, 'GetChannelMetadataResponse', { metadata: ok }, errors);
    }

    async p21_SubscribeChannels(msg) {
        const ok = {}; const errors = {};
        const byId = this.byId[P.ChannelSubscribe];
        const now = Date.now();
        const backlog = [];
        for (const [key, info] of Object.entries(msg.body.channels)) {
            const node = byId.get(Number(info.channelId));
            if (!node) { errors[key] = { code: E.EINVALID_ARGUMENT, message: `channel id ${info.channelId} unknown; send GetChannelMetadata first` }; continue; }
            const start = codec.indexOf(info.startIndex);
            const latest = info.requestLatestIndexCount && info.requestLatestIndexCount.int;
            this.subscriptions.set(Number(info.channelId), { node, cursor: start !== null ? Math.floor(start / 1000) - 1 : now });
            if (latest) backlog.push({ id: Number(info.channelId), node, latest });
            ok[key] = '';
        }
        this.mapReply(msg, 'SubscribeChannelsResponse', { success: ok }, errors);
        for (const b of backlog) {
            const rows = await store.latestRows(b.node.rigId, b.node.entry.metric, b.latest);
            if (rows.length) {
                this.etp.send(P.ChannelSubscribe, 'ChannelData', { data: rows.map((r) => dataItem(b.id, r.ts, r.value, b.node.entry.factor)) });
                this.subscriptions.get(b.id).cursor = new Date(rows[rows.length - 1].ts).getTime();
            }
        }
        if (!this.streamTimer && this.subscriptions.size) this.streamTimer = setInterval(() => this.pushSubscriptions().catch((e) => this.log(`stream: ${e.message}`)), STREAM_MS);
        return undefined;
    }

    async pushSubscriptions() {
        if (this.state !== 'open' || !this.subscriptions.size || this.pushing) return;
        this.pushing = true;
        try {
            const byRig = new Map();
            for (const [id, sub] of this.subscriptions) {
                if (!byRig.has(sub.node.rigId)) byRig.set(sub.node.rigId, []);
                byRig.get(sub.node.rigId).push([id, sub]);
            }
            for (const [rigId, list] of byRig) {
                const from = new Date(Math.min(...list.map(([, x]) => x.cursor)) + 1);
                const metrics = list.map(([, x]) => x.node.entry.metric);
                const rows = await store.channelRows(rigId, metrics, from, new Date(), DATA_ITEMS_PER_MESSAGE * 4);
                const idOf = new Map(list.map(([id, x]) => [x.node.entry.metric, [id, x]]));
                const data = [];
                for (const r of rows) {
                    const [id, sub] = idOf.get(r.metric);
                    const t = new Date(r.ts).getTime();
                    if (t <= sub.cursor) continue;
                    data.push(dataItem(id, r.ts, r.value, sub.node.entry.factor));
                    sub.cursor = t;
                }
                for (let i = 0; i < data.length; i += DATA_ITEMS_PER_MESSAGE) this.etp.send(P.ChannelSubscribe, 'ChannelData', { data: data.slice(i, i + DATA_ITEMS_PER_MESSAGE) });
            }
        } finally { this.pushing = false; }
    }

    p21_UnsubscribeChannels(msg) {
        const stopped = {};
        for (const [key, id] of Object.entries(msg.body.channelIds)) { this.subscriptions.delete(Number(id)); stopped[key] = id; }
        if (!this.subscriptions.size) { clearInterval(this.streamTimer); this.streamTimer = null; }
        return this.etp.send(P.ChannelSubscribe, 'SubscriptionsStopped', { reason: 'unsubscribed', channelIds: stopped }, { correlationId: msg.header.messageId });
    }

    async p21_GetRanges(msg) {
        const byId = this.byId[P.ChannelSubscribe];
        const items = [];
        for (const range of msg.body.channelRanges) {
            const from = codec.indexOf(range.interval.startIndex);
            const to = codec.indexOf(range.interval.endIndex);
            if (from === null || to === null) return this.etp.exception(hdr(msg), E.EINVALID_ARGUMENT, 'interval needs start and end time indexes');
            const nodes = range.channelIds.map((id) => [Number(id), byId.get(Number(id))]);
            const missing = nodes.find(([, n]) => !n);
            if (missing) return this.etp.exception(hdr(msg), E.EINVALID_ARGUMENT, `channel id ${missing[0]} unknown`);
            const byRig = new Map();
            for (const [id, n] of nodes) { if (!byRig.has(n.rigId)) byRig.set(n.rigId, []); byRig.get(n.rigId).push([id, n]); }
            for (const [rigId, list] of byRig) {
                const idOf = new Map(list.map(([id, n]) => [n.entry.metric, [id, n]]));
                const rows = await store.channelRows(rigId, [...idOf.keys()], codec.fromMicros(from), codec.fromMicros(to), MAX_RANGE_ITEMS + 1 - items.length);
                for (const r of rows) { const [id, n] = idOf.get(r.metric); items.push(dataItem(id, r.ts, r.value, n.entry.factor)); }
            }
            if (items.length > MAX_RANGE_ITEMS) return this.etp.exception(hdr(msg), E.ELIMIT_EXCEEDED, `more than MaxRangeDataItemCount (${MAX_RANGE_ITEMS}) points; request a shorter interval`);
        }
        const parts = [];
        for (let i = 0; i < items.length; i += DATA_ITEMS_PER_MESSAGE) parts.push({ data: items.slice(i, i + DATA_ITEMS_PER_MESSAGE) });
        return this.etp.reply(hdr(msg), 'GetRangesResponse', parts.length ? parts : [{ data: [] }]);
    }

    p21_CancelGetRanges() { return undefined; }
    p21_GetChangeAnnotations(msg) { return this.etp.exception(hdr(msg), E.ENOTSUPPORTED, 'change annotations are not tracked'); }

    // ---- ChannelDataFrame (2) ---------------------------------------------------------------
    async frameSet(msg, u) {
        const t = uri.parse(u);
        if (!t || t.kind !== 'object') { this.etp.exception(hdr(msg), E.EINVALID_URI, `not a data object URI: ${u}`); return null; }
        const s = await store.get();
        const n = s.nodes.get(t.uuid);
        if (!n || n.type !== 'witsml21.ChannelSet') { this.etp.exception(hdr(msg), E.ENOT_FOUND, `${u} is not a channel set of this store`); return null; }
        return { s, n, channels: s.channelsByRig.get(n.rigId) || [] };
    }

    async p2_GetFrameMetadata(msg) {
        const f = await this.frameSet(msg, msg.body.uri);
        if (!f) return undefined;
        const ext = await store.runExtent(f.n.run);
        return this.etp.reply(hdr(msg), 'GetFrameMetadataResponse', {
            uri: msg.body.uri, indexes: [timeIndex(ext.start, ext.end)],
            channels: f.channels.map((c) => ({
                uri: store.uriOf(c), channelName: c.entry.mnemonic, dataKind: 'typeDouble', uom: c.entry.uom, depthDatum: '',
                channelPropertyKindUri: uri.object('eml23.PropertyKind', c.entry.propertyKind.uuid),
                status: c.active ? 'Active' : 'Inactive', source: `${c.rigId}: ${c.entry.label || c.entry.metric}`.slice(0, 256),
                axisVectorLengths: [], attributeMetadata: [], customData: {},
            })),
        });
    }

    async p2_GetFrame(msg) {
        const f = await this.frameSet(msg, msg.body.uri);
        if (!f) return undefined;
        const run = f.n.run;
        const iv = msg.body.requestedInterval;
        const reqFrom = codec.indexOf(iv.startIndex);
        const reqTo = codec.indexOf(iv.endIndex);
        const runFrom = Date.parse(run.startedAt);
        const runTo = run.endedAt ? Date.parse(run.endedAt) : Date.now();
        const from = new Date(Math.max(runFrom, reqFrom !== null ? reqFrom / 1000 : runFrom));
        const to = new Date(Math.min(runTo, reqTo !== null ? reqTo / 1000 : runTo));
        const metrics = f.channels.map((c) => c.entry.metric);
        const col = new Map(metrics.map((m, i) => [m, i]));
        const rows = to > from ? await store.channelRows(f.n.rigId, metrics, from, to, (MAX_FRAME_ROWS + 1) * metrics.length) : [];
        const frame = [];
        let last = null;
        for (const r of rows) {
            const t = new Date(r.ts).getTime();
            if (!last || last.t !== t) {
                if (frame.length > MAX_FRAME_ROWS) break;
                last = { t, points: metrics.map(() => ({ value: { item: null }, valueAttributes: [] })) };
                frame.push(last);
            }
            const i = col.get(r.metric);
            last.points[i] = { value: { item: { double: Number(r.value) * (f.channels[i].entry.factor || 1) } }, valueAttributes: [] };
        }
        if (frame.length > MAX_FRAME_ROWS) return this.etp.exception(hdr(msg), E.ELIMIT_EXCEEDED, `more than MaxFrameResponseRowCount (${MAX_FRAME_ROWS}) rows; request a shorter interval`);
        const items = [['GetFrameResponseHeader', { channelUris: f.channels.map((c) => store.uriOf(c)), indexes: [timeIndex(from.toISOString(), to.toISOString())] }]];
        const rowsPer = Math.max(1, Math.floor(DATA_ITEMS_PER_MESSAGE / Math.max(1, metrics.length)) * 4);
        for (let i = 0; i < frame.length; i += rowsPer) {
            items.push(['GetFrameResponseRows', { frame: frame.slice(i, i + rowsPer).map((x) => ({ indexes: [long(x.t * 1000)], points: x.points })) }]);
        }
        return this.etp.replySequence(hdr(msg), items, { protocol: P.ChannelDataFrame });
    }

    p2_CancelGetFrame() { return undefined; }

    // ---- ChannelDataLoad (22): an edge loading its rig's channels ---------------------------
    async p22_OpenChannels(msg) {
        const s = await store.get({ fresh: true });
        const ok = {}; const errors = {};
        for (const [key, u] of Object.entries(msg.body.uris)) {
            const t = uri.parse(u);
            const n = t && t.kind === 'object' ? s.nodes.get(t.uuid) : null;
            if (!n || n.type !== 'witsml21.Channel') { errors[key] = { code: t ? E.ENOT_FOUND : E.EINVALID_URI, message: `${u} not found; put the Channel (Store) first` }; continue; }
            if (n.rigId !== this.principal.rigId) { errors[key] = { code: E.EREQUEST_DENIED, message: `${u} belongs to rig ${n.rigId}` }; continue; }
            // The channel's end index tells the customer where to resume.
            ok[key] = { metadata: channelMetadata(n, this.channelId(P.ChannelDataLoad, n)), preferRealtime: true, dataChanges: false };
        }
        return this.mapReply(msg, 'OpenChannelsResponse', { channels: ok }, errors);
    }

    async p22_ChannelData(msg) {
        const byId = this.byId[P.ChannelDataLoad];
        const points = [];
        for (const d of msg.body.data) {
            const n = byId.get(Number(d.channelId));
            if (!n) return this.etp.exception(hdr(msg), E.EINVALID_ARGUMENT, `channel id ${d.channelId} is not open`);
            points.push({ metric: n.entry.metric, factor: n.entry.factor, ts: codec.indexOf(d.indexes[0]), value: codec.dataValueOf(d.value) });
        }
        return this.store(msg, points);
    }

    /**
     * Store data points. If storing fails, the session is closed before any later
     * message is handled, so the customer reconnects and OpenChannels resumes it
     * from the last point actually stored (no gap).
     */
    async store(msg, points) {
        try {
            await load.storePoints(this.principal.rigId, points);
        } catch (e) {
            this.log(`storing ${points.length} points failed: ${e.message}; closing the session`);
            this.etp.exception(hdr(msg), E.EINVALID_STATE, `points not stored (${e.message}); reconnect to resume`);
            this.state = 'closed';
            this.etp.close('storage error');
        }
        return undefined;
    }

    p22_CloseChannels(msg) {
        for (const id of Object.values(msg.body.id)) this.byId[P.ChannelDataLoad].delete(Number(id));
        return this.etp.send(P.ChannelDataLoad, 'ChannelsClosed', { reason: 'closed by customer', id: msg.body.id }, { correlationId: msg.header.messageId });
    }

    p22_TruncateChannels(msg) { return this.etp.exception(hdr(msg), E.EREQUEST_DENIED, 'the historian is append-only for edge loads'); }
    p22_ReplaceRange(msg) { return this.etp.exception(hdr(msg), E.EREQUEST_DENIED, 'the historian is append-only for edge loads'); }

    // ---- ChannelStreaming (1): consumer of an edge's simple stream -----------------------------
    async p1_ChannelMetadata(msg) {
        const s = await store.get({ fresh: true });
        for (const rec of msg.body.channels) {
            const t = uri.parse(rec.uri);
            const n = t ? s.nodes.get(t.uuid) : null;
            if (n && n.type === 'witsml21.Channel' && n.rigId === this.principal.rigId) this.producerChannels.set(Number(rec.id), n);
        }
        return undefined;
    }

    async p1_ChannelData(msg) {
        const points = [];
        for (const d of msg.body.data) {
            const n = this.producerChannels.get(Number(d.channelId));
            if (!n) continue;   // channel not (yet) in the store's dictionary
            points.push({ metric: n.entry.metric, factor: n.entry.factor, ts: codec.indexOf(d.indexes[0]), value: codec.dataValueOf(d.value) });
        }
        return this.store(msg, points);
    }

    p1_TruncateChannels() { return undefined; }
}

module.exports = { ServerSession, serverCapabilities, OFFER };
