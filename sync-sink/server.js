'use strict';
// Minimal CENTRAL INGEST STUB for local demo only — stands in for the CRMF
// (Centralised Rig Monitoring Facility) ETP/Kafka ingest endpoint. Accepts gzipped
// store-and-forward batches from the edge sync agent, counts them, and acks.
// NOT part of the edge app; it only exists so the edge↔central loop is demonstrable.
const http = require('http');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 9009);
const EXPECT_TOKEN = process.env.INGEST_TOKEN || '';
const totals = { batches: 0, points: 0, events: 0, lastDeviceId: null, lastSeq: null, lastAt: null, startedAt: new Date().toISOString() };

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ingest') {
        if (EXPECT_TOKEN && (req.headers['authorization'] || '') !== `Bearer ${EXPECT_TOKEN}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'unauthorized device' }));
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                let buf = Buffer.concat(chunks);
                if ((req.headers['content-encoding'] || '').includes('gzip')) buf = zlib.gunzipSync(buf);
                const batch = JSON.parse(buf.toString('utf8'));
                const pts = Array.isArray(batch.channels) ? batch.channels.length : 0;
                const evs = Array.isArray(batch.events) ? batch.events.length : 0;
                totals.batches += 1; totals.points += pts; totals.events += evs;
                totals.lastDeviceId = batch.deviceId || req.headers['x-device-id'] || null;
                totals.lastSeq = batch.seq != null ? batch.seq : null;
                totals.lastAt = new Date().toISOString();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ack: true, seq: batch.seq, receivedPoints: pts, receivedEvents: evs }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad batch: ' + e.message }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(totals));
    } else if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        res.writeHead(200); res.end('ok');
    } else {
        res.writeHead(404); res.end('not found');
    }
});
server.listen(PORT, () => console.log(`SYNC-SINK (central ingest stub) listening on ${PORT}`));
