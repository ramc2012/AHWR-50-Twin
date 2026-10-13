'use strict';
// CRMF ETP/WITSML server: the CMF historian over Energistics standards.
//   ws(s)://<host>:<ETP_PORT>/          ETP v1.2 (subprotocol etp12.energistics.org, binary Avro)
//   /.well-known/etp-server-capabilities ETP v1.2 ServerCapabilities (binary; ?$format=json for JSON)
//   /witsml21/objects, /witsml21/object/<uuid>   WITSML 2.1 objects over HTTP (Bearer CMF token)
//   /healthz
// HTTP_PORT serves the same endpoints (kept for the platform's service contract).
// Monitoring-only: nothing is written to a rig or PLC.
const http = require('http');
const { WebSocketServer } = require('ws');
const codec = require('./lib/etp12/codec');
const { authenticate } = require('./lib/auth');
const { ServerSession, serverCapabilities } = require('./lib/etpServer');
const store = require('./lib/store');
const w21 = require('./lib/witsml21');
const { pool } = require('./lib/db');

const ETP_PORT = Number(process.env.ETP_PORT || 8443);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_MESSAGE = Number(process.env.ETP_MAX_MESSAGE_BYTES || 16 * 1024 * 1024);
w21.setApplication(`CRMF ETP/WITSML ${require('./package.json').version}`);
const log = (m) => console.log(`[etp] ${new Date().toISOString()} ${m}`);

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/healthz') {
            await pool.query('SELECT 1');
            return send(res, 200, 'application/json', JSON.stringify({ status: 'ok' }));
        }
        if (url.pathname === '/.well-known/etp-server-capabilities') {
            if (url.searchParams.get('GetVersions') === 'true') return send(res, 200, 'application/json', JSON.stringify(['etp12.energistics.org']));
            const v = url.searchParams.get('GetVersion') || 'etp12.energistics.org';
            if (v !== 'etp12.energistics.org') return send(res, 404, 'text/plain', `ETP version ${v} is not supported`);
            const type = codec.records.ServerCapabilities;
            const caps = serverCapabilities();
            if (url.searchParams.get('$format') === 'json') return send(res, 200, 'application/json', type.toString(caps));
            return send(res, 200, 'application/x-etp-message', type.toBuffer(caps));
        }
        if (url.pathname.startsWith('/witsml21/')) {
            const who = await authenticate(req.headers.authorization);
            if (!who) return send(res, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }), { 'WWW-Authenticate': 'Bearer' });
            const s = await store.get();
            if (url.pathname === '/witsml21/objects') {
                const type = url.searchParams.get('type');
                const list = [...s.nodes.values()].filter((n) => !type || n.type === type)
                    .map((n) => ({ type: n.type, uuid: n.uuid, uri: store.uriOf(n), title: n.title, rigId: n.rigId || null }));
                return send(res, 200, 'application/json', JSON.stringify(list));
            }
            const m = /^\/witsml21\/object\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
            if (m) {
                const n = s.nodes.get(m[1].toLowerCase());
                if (!n) return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
                return send(res, 200, 'application/xml', await store.xmlOf(s, n));
            }
        }
        return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
    } catch (e) {
        log(`http ${url.pathname}: ${e.message}`);
        return send(res, 500, 'application/json', JSON.stringify({ error: 'internal error' }));
    }
}
function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
}

function attachEtp(server) {
    const wss = new WebSocketServer({
        noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false,
        handleProtocols: (protocols) => (protocols.has(codec.SUBPROTOCOL) ? codec.SUBPROTOCOL : false),
    });
    server.on('upgrade', (req, socket, head) => {
        const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
        const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
        if (!offered.includes(codec.SUBPROTOCOL)) return reject(400, 'Bad Request');
        const encoding = String(req.headers['etp-encoding'] || new URL(req.url, 'http://x').searchParams.get('etp-encoding') || 'binary');
        if (encoding !== 'binary') return reject(400, 'Bad Request');     // JSON encoding is for testing only (spec 3.8)
        authenticate(req.headers.authorization).then((principal) => {
            if (!principal) return reject(401, 'Unauthorized');
            return wss.handleUpgrade(req, socket, head, (ws) => {
                log(`connection from ${principal.kind} ${principal.rigId || principal.user} (${req.socket.remoteAddress})`);
                return new ServerSession(ws, principal, log);
            });
        }).catch((e) => { log(`upgrade: ${e.message}`); reject(500, 'Internal Server Error'); });
    });
}

const etpServer = http.createServer(handle);
attachEtp(etpServer);
etpServer.listen(ETP_PORT, HOST, () => log(`ETP v1.2 listening on ${HOST}:${ETP_PORT}`));
if (HTTP_PORT && HTTP_PORT !== ETP_PORT) {
    const httpServer = http.createServer(handle);
    attachEtp(httpServer);
    httpServer.listen(HTTP_PORT, HOST, () => log(`HTTP listening on ${HOST}:${HTTP_PORT}`));
}
const shutdown = () => { log('shutting down'); etpServer.close(); pool.end().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
