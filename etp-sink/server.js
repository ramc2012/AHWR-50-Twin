'use strict';
// Minimal ETP 2.0 server STUB for local demo only — stands in for the CRMF ETP server.
// Speaks the JSON-encoded ETP envelope: answers RequestSession with OpenSession, then
// counts ChannelMetadata/ChannelData frames. Exposes /stats over HTTP. NOT part of the edge app.
const http = require('http');
const { WebSocketServer } = require('ws');

const WS_PORT = Number(process.env.WS_PORT || 9011);
const HTTP_PORT = Number(process.env.HTTP_PORT || 9012);
const P = { Core: 0, ChannelStreaming: 1 };
const MT = { RequestSession: 1, OpenSession: 2, ChannelMetadata: 1, ChannelData: 3 };
const totals = { sessions: 0, metadataFrames: 0, dataFrames: 0, dataPoints: 0, lastDeviceId: null, lastAt: null, startedAt: new Date().toISOString() };
let mid = 1;

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (ws, req) => {
    const deviceId = req.headers['x-device-id'] || null;
    ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        const { protocol, messageType } = m.header || {};
        if (protocol === P.Core && messageType === MT.RequestSession) {
            totals.sessions += 1; totals.lastDeviceId = deviceId; totals.lastAt = new Date().toISOString();
            ws.send(JSON.stringify({ header: { protocol: P.Core, messageType: MT.OpenSession, correlationId: m.header.messageId, messageId: mid++, messageFlags: 0 }, body: { sessionId: `etp-${Date.now()}`, supportedProtocols: [{ protocol: P.ChannelStreaming, role: 'consumer' }] } }));
        } else if (protocol === P.ChannelStreaming && messageType === MT.ChannelMetadata) {
            totals.metadataFrames += 1;
        } else if (protocol === P.ChannelStreaming && messageType === MT.ChannelData) {
            totals.dataFrames += 1;
            totals.dataPoints += Array.isArray(m.body && m.body.data) ? m.body.data.length : 0;
            totals.lastAt = new Date().toISOString();
        }
    });
});
console.log(`ETP-SINK ws listening on ${WS_PORT}`);

http.createServer((req, res) => {
    if (req.url === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(totals)); }
    else { res.writeHead(200); res.end('ok'); }
}).listen(HTTP_PORT, () => console.log(`ETP-SINK http stats on ${HTTP_PORT}`));
