'use strict';
// Sync Agent — Store & Forward (rig edge -> central CRMF).
// Batches live telemetry + events, gzip-compresses, buffers to disk (capped by age),
// and forwards to the central ingest endpoint over HTTP. On WAN/central outage it keeps
// buffering and AUTOMATICALLY REPLAYS oldest-first on restoration (back-pressure aware).
// OUTBOUND ONLY — read-only telemetry publish; never writes to the PLC (monitoring-only).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { readJson, writeJson, DATA_DIR } = require('./persist');

const SCHEMA_VERSION = '1.0';
const CONFIG_FILE = 'sync_config.json';
const STATE_FILE = 'sync_state.json';
const BUFFER_DIR = path.join(DATA_DIR, 'sync_buffer');

const DEFAULTS = {
    enabled: process.env.SYNC_ENABLED !== 'false',
    centralUrl: process.env.CENTRAL_URL || 'http://sync-sink:9009',
    deviceId: process.env.DEVICE_ID || 'AHWR-50-EDGE',
    deviceToken: process.env.DEVICE_TOKEN || '',
    batchSeconds: Number(process.env.SYNC_BATCH_SECONDS || 10),
    maxBufferDays: Number(process.env.SYNC_BUFFER_DAYS || 15),
    flushIntervalSec: 5,
    flushBatchesPerCycle: 25,   // back-pressure: bound replay burst
    maxBufferFiles: 200000,
    compression: true,
};

let config = { ...DEFAULTS, ...(readJson(CONFIG_FILE, {}) || {}) };
let st = readJson(STATE_FILE, null) || { nextSeq: 1, droppedBatches: 0, sentBatches: 0, ackedBatches: 0, ackedPoints: 0 };
let connected = false;
let lastSyncAt = null;     // last successful ack time
let lastError = null;
let currentBatch = { channels: [], events: [] };
let lastSealMs = Date.now();
const recent = [];         // ring of recent flattened snapshots (for WITSML export)
const RECENT_MAX = 600;
let io = null;
let flushing = false;

try { fs.mkdirSync(BUFFER_DIR, { recursive: true }); } catch { /* ignore */ }
const persistState = () => writeJson(STATE_FILE, st).catch(() => {});

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Flatten the live payload to {measurement.field: value} for finite numerics only.
function flatten(data) {
    const out = {};
    for (const [meas, fields] of Object.entries(data || {})) {
        if (meas.startsWith('_') || !fields || typeof fields !== 'object') continue;
        for (const [f, v] of Object.entries(fields)) {
            const n = num(v);
            if (n !== null) out[`${meas}.${f}`] = n;
        }
    }
    return out;
}

const bufferFiles = () => {
    try {
        return fs.readdirSync(BUFFER_DIR).filter((f) => f.startsWith('batch-') && f.endsWith('.json.gz'))
            .sort(); // zero-padded seq -> lexical == chronological
    } catch { return []; }
};
const pointsOf = (fname) => { const m = fname.match(/batch-\d+-(\d+)\.json\.gz$/); return m ? Number(m[1]) : 0; };

// Called every tick with the live rig payload.
function enqueueTelemetry(data, nowMs = Date.now()) {
    const values = flatten(data);
    const snap = { ts: new Date(nowMs).toISOString(), values };
    currentBatch.channels.push(snap);
    recent.push(snap);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    if ((nowMs - lastSealMs) >= config.batchSeconds * 1000 || currentBatch.channels.length >= config.batchSeconds) {
        seal(nowMs);
    }
}

function enqueueEvent(type, payload, nowMs = Date.now()) {
    currentBatch.events.push({ ts: new Date(nowMs).toISOString(), type, payload });
    if (currentBatch.events.length > 500) currentBatch.events.splice(0, currentBatch.events.length - 500);
}

function seal(nowMs = Date.now()) {
    lastSealMs = nowMs;
    if (!currentBatch.channels.length && !currentBatch.events.length) return;
    const seq = st.nextSeq++;
    const points = currentBatch.channels.length;
    const batch = {
        seq, deviceId: config.deviceId, schemaVersion: SCHEMA_VERSION,
        createdAt: new Date(nowMs).toISOString(),
        channels: currentBatch.channels, events: currentBatch.events,
    };
    const fname = `batch-${String(seq).padStart(9, '0')}-${String(points).padStart(6, '0')}.json.gz`;
    try {
        const body = config.compression ? zlib.gzipSync(Buffer.from(JSON.stringify(batch))) : Buffer.from(JSON.stringify(batch));
        fs.writeFileSync(path.join(BUFFER_DIR, fname), body);
    } catch (e) { lastError = `buffer write: ${e.message}`; }
    currentBatch = { channels: [], events: [] };
    persistState();
    prune();
}

function prune() {
    const cutoff = Date.now() - config.maxBufferDays * 86400000;
    const files = bufferFiles();
    let dropped = 0;
    for (const f of files) {
        const p = path.join(BUFFER_DIR, f);
        try {
            const old = fs.statSync(p).mtimeMs < cutoff;
            const over = (files.length - dropped) > config.maxBufferFiles;
            if (old || over) { fs.unlinkSync(p); dropped++; }
        } catch { /* ignore */ }
    }
    if (dropped) { st.droppedBatches += dropped; persistState(); }
}

function postBatch(buf, seq) {
    return new Promise((resolve) => {
        let u; try { u = new URL('/ingest', config.centralUrl); } catch { return resolve({ ok: false, err: 'bad centralUrl' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const headers = {
            'Content-Type': 'application/json', 'Content-Encoding': config.compression ? 'gzip' : 'identity',
            'X-Device-Id': config.deviceId, 'X-Schema-Version': SCHEMA_VERSION, 'Content-Length': buf.length,
        };
        if (config.deviceToken) headers['Authorization'] = `Bearer ${config.deviceToken}`;
        const req = lib.request(u, { method: 'POST', headers, timeout: 5000 }, (res) => {
            const c = []; res.on('data', (d) => c.push(d));
            res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(c).toString() }));
        });
        req.on('error', (e) => resolve({ ok: false, err: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
        req.end(buf);
    });
}

// Drain oldest-first, bounded per cycle. Stops on first failure (back-pressure).
async function flush() {
    if (flushing || !config.enabled) return;
    flushing = true;
    try {
        const files = bufferFiles().slice(0, config.flushBatchesPerCycle);
        for (const f of files) {
            const p = path.join(BUFFER_DIR, f);
            let buf; try { buf = fs.readFileSync(p); } catch { continue; }
            const r = await postBatch(buf, f);
            if (r.ok) {
                try { fs.unlinkSync(p); } catch { /* ignore */ }
                st.sentBatches += 1; st.ackedBatches += 1; st.ackedPoints += pointsOf(f);
                connected = true; lastSyncAt = new Date().toISOString(); lastError = null;
            } else {
                connected = false; lastError = r.err || `HTTP ${r.status}`;
                break; // don't hammer a down link
            }
        }
        persistState();
    } finally { flushing = false; emit(); }
}

function getStatus() {
    const files = bufferFiles();
    const bufferedPoints = files.reduce((s, f) => s + pointsOf(f), 0);
    let oldestAgeSec = null;
    if (files.length) { try { oldestAgeSec = Math.round((Date.now() - fs.statSync(path.join(BUFFER_DIR, files[0])).mtimeMs) / 1000); } catch { /* ignore */ } }
    const syncLagSec = files.length ? oldestAgeSec : (lastSyncAt ? Math.round((Date.now() - Date.parse(lastSyncAt)) / 1000) : null);
    return {
        enabled: config.enabled,
        connected,
        deviceId: config.deviceId,
        centralUrl: config.centralUrl,
        batchSeconds: config.batchSeconds,
        maxBufferDays: config.maxBufferDays,
        compression: config.compression,
        bufferedBatches: files.length,
        bufferedPoints,
        oldestBufferedAgeSec: oldestAgeSec,
        syncLagSec,
        lastSyncAt,
        lastError,
        sentBatches: st.sentBatches,
        ackedBatches: st.ackedBatches,
        ackedPoints: st.ackedPoints,
        droppedBatches: st.droppedBatches,
    };
}

function getConfig() { const { deviceToken, ...safe } = config; return { ...safe, deviceTokenSet: !!deviceToken }; }
async function setConfig(next) {
    const allow = ['enabled', 'centralUrl', 'deviceId', 'deviceToken', 'batchSeconds', 'maxBufferDays', 'compression', 'flushBatchesPerCycle'];
    for (const k of allow) if (k in (next || {})) config[k] = next[k];
    config.batchSeconds = Math.max(1, Number(config.batchSeconds) || 10);
    config.maxBufferDays = Math.max(1, Number(config.maxBufferDays) || 15);
    await writeJson(CONFIG_FILE, config);
    emit();
    return getConfig();
}

const getRecent = (n = 300) => recent.slice(-n);

function emit() { if (io) { try { io.emit('sync_status', getStatus()); } catch { /* ignore */ } } }

function start(ioRef) {
    io = ioRef;
    setInterval(() => { flush().catch(() => {}); }, config.flushIntervalSec * 1000);
    // periodic seal even if telemetry pauses, so buffered events are forwarded
    setInterval(() => { if (Date.now() - lastSealMs >= config.batchSeconds * 1000) seal(); }, config.batchSeconds * 1000);
}

module.exports = { start, enqueueTelemetry, enqueueEvent, flush, getStatus, getConfig, setConfig, getRecent };
