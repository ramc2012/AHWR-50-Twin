'use strict';
// Local-demo ETP v1.2 endpoint (stands in for the CRMF ETP/WITSML server in the
// twin's demo profile; production edges load central/etp-witsml). In memory only.
//   ws://<host>:WS_PORT   subprotocol etp12.energistics.org, binary Avro (official schemas)
//     Store (4)            PutDataObjects: counts the objects put
//     ChannelDataLoad (22) OpenChannels (resume index = last point received), ChannelData
//     ChannelStreaming (1) consumer of a simple producer (sends StartStreaming)
//   http://<host>:HTTP_PORT/stats   counters
// NOT part of the edge application.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const codec = require('./lib/etp12/codec');
const { EtpSession } = require('./lib/etp12/session');
const uri = require('./lib/etp12/uri');

const WS_PORT = Number(process.env.WS_PORT || 9011);
const HTTP_PORT = Number(process.env.HTTP_PORT || 9012);
const { PROTOCOL: P, VERSION } = codec;
const OFFER = [[P.Store, 'store'], [P.ChannelDataLoad, 'store'], [P.ChannelStreaming, 'consumer']];
const totals = { sessions: 0, objects: 0, channels: 0, dataPoints: 0, dataFrames: 0, lastDeviceId: null, lastAt: null, startedAt: new Date().toISOString() };
const lastIndex = new Map();     // channel uri -> last time index (us)
const long = (n) => ({ item: { long: n } });

const wss = new WebSocketServer({ port: WS_PORT, handleProtocols: (p) => (p.has(codec.SUBPROTOCOL) ? codec.SUBPROTOCOL : false) });
wss.on('connection', (ws, req) => {
    if (String(req.headers['etp-encoding'] || 'binary') !== 'binary') return ws.close(1002, 'binary encoding only');
    const s = new EtpSession(ws, { side: 'server' });
    const open = new Map();      // channel id -> uri
    const p1 = new Map();        // producer channel id -> uri
    s.on('message', (m) => {
        const corr = { correlationId: m.header.messageId };
        if (m.name === 'RequestSession') {
            const agreed = m.body.requestedProtocols.filter((r) => OFFER.some(([p, role]) => p === r.protocol && role === r.role));
            if (!agreed.length) return s.exception({ protocol: 0, header: m.header }, codec.ERRORS.ENOSUPPORTEDPROTOCOLS, 'store 4/22 or consumer 1 only');
            totals.sessions += 1; totals.lastDeviceId = m.body.applicationName;
            s.send(P.Core, 'OpenSession', {
                applicationName: 'AHWR demo ETP sink', applicationVersion: '1.2', serverInstanceId: Buffer.alloc(16, 9),
                supportedProtocols: agreed.map((r) => ({ protocol: r.protocol, protocolVersion: VERSION, role: r.role, protocolCapabilities: {} })),
                supportedDataObjects: [], supportedCompression: '', supportedFormats: ['xml'], currentDateTime: Date.now() * 1000,
                earliestRetainedChangeTime: 0, sessionId: crypto.randomBytes(16), endpointCapabilities: {},
            }, corr);
            if (agreed.some((r) => r.protocol === P.ChannelStreaming)) s.send(P.ChannelStreaming, 'StartStreaming', {});
        } else if (m.name === 'PutDataObjects') {
            const keys = Object.keys(m.body.dataObjects);
            totals.objects += keys.length;
            s.send(P.Store, 'PutDataObjectsResponse', { success: Object.fromEntries(keys.map((k) => [k, { createdContainedObjectUris: [], deletedContainedObjectUris: [], joinedContainedObjectUris: [], unjoinedContainedObjectUris: [] }])) }, corr);
        } else if (m.name === 'OpenChannels') {
            const channels = {};
            for (const [k, u] of Object.entries(m.body.uris)) {
                if (!uri.parse(u)) continue;
                const id = open.size + 1; open.set(id, u);
                const end = lastIndex.has(u) ? long(lastIndex.get(u)) : { item: null };
                channels[k] = { metadata: { uri: u, id, indexes: [{ indexKind: 'DateTime', interval: { startIndex: { item: null }, endIndex: end, uom: 'us', depthDatum: '' }, direction: 'Increasing', name: 'TIME', uom: 'us', depthDatum: '', indexPropertyKindUri: '', filterable: true }],
                    channelName: '', dataKind: 'typeDouble', uom: '', depthDatum: '', channelClassUri: '', status: 'Active', source: '', axisVectorLengths: [], attributeMetadata: [], customData: {} }, preferRealtime: true, dataChanges: false };
            }
            totals.channels = Math.max(totals.channels, open.size);
            s.send(P.ChannelDataLoad, 'OpenChannelsResponse', { channels }, corr);
        } else if (m.name === 'ChannelMetadata') {
            for (const c of m.body.channels) p1.set(Number(c.id), c.uri);
            totals.channels = Math.max(totals.channels, p1.size);
        } else if (m.name === 'ChannelData') {
            const ids = m.protocol === P.ChannelStreaming ? p1 : open;
            for (const d of m.body.data) {
                const u = ids.get(Number(d.channelId));
                const t = codec.indexOf(d.indexes[0]);
                if (u && t !== null && t > (lastIndex.get(u) || 0)) lastIndex.set(u, t);
            }
            totals.dataFrames += 1; totals.dataPoints += m.body.data.length; totals.lastAt = new Date().toISOString();
        }
        return undefined;
    });
});
console.log(`ETP v1.2 demo sink: ws on ${WS_PORT}, stats on ${HTTP_PORT}`);

http.createServer((req, res) => {
    if (req.url === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(totals)); return; }
    res.writeHead(200); res.end('ok');
}).listen(HTTP_PORT);
