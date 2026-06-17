'use strict';
// ETP 2.0 publisher (Energistics Transfer Protocol) — pragmatic JSON-encoded subset.
// Connects to an ETP server over WebSocket, performs the Session handshake
// (RequestSession -> OpenSession), advertises channel metadata, then streams
// ChannelData frames from the live rig payload. OUTBOUND ONLY (read-only publish).
//
// Scope note: this implements ETP 2.0's message envelope + ChannelStreaming flow with
// the JSON encoding ("application/x-etp-message+json"). Full Avro binary encoding and
// the complete protocol-capability set are the documented next step.
const WebSocket = require('ws'); // present via socket.io's dependency tree
const { getRecent } = require('./sync');

const ETP_SUBPROTOCOL = 'etp12.energistics.org';
// ETP message envelope protocols/messageTypes used here
const P = { Core: 0, ChannelStreaming: 1 };
const MT = { RequestSession: 1, OpenSession: 2, CloseSession: 5, ChannelMetadata: 1, ChannelData: 3 };

// Channels published (mnemonic <- app key).
const CHANNELS = [
    { id: 1, mnem: 'HKLD', key: 'drawworks.hook_load', uom: 't' },
    { id: 2, mnem: 'BPOS', key: 'drawworks.block_position', uom: 'ft' },
    { id: 3, mnem: 'WOB', key: 'drilling.wob', uom: 't' },
    { id: 4, mnem: 'SPPA', key: 'mudpump.pressure', uom: 'bar' },
    { id: 5, mnem: 'TUBP', key: 'wellhead.tubing_pressure', uom: 'bar' },
    { id: 6, mnem: 'CASP', key: 'wellhead.casing_pressure', uom: 'bar' },
    { id: 7, mnem: 'DMEA', key: 'drilling.hole_depth', uom: 'm' },
];

let config = {
    enabled: process.env.ETP_ENABLED === 'true' || (process.env.ETP_URL ? true : false),
    url: process.env.ETP_URL || 'ws://etp-sink:9011',
    deviceId: process.env.DEVICE_ID || 'AHWR-50-EDGE',
    token: process.env.DEVICE_TOKEN || '',
    streamSeconds: Number(process.env.ETP_STREAM_SECONDS || 5),
};
let ws = null, io = null, sessionId = null, msgId = 1;
let state = { connected: false, sessionEstablished: false, framesSent: 0, dataPointsSent: 0, lastSentAt: null, lastError: null };
let streamTimer = null, reconnectTimer = null;

const nextMsgId = () => msgId++;
const emit = () => { if (io) try { io.emit('etp_status', getStatus()); } catch { /* ignore */ } };

function send(protocol, messageType, body) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const message = { header: { protocol, messageType, correlationId: 0, messageId: nextMsgId(), messageFlags: 0 }, body };
    ws.send(JSON.stringify(message));
}

function requestSession() {
    send(P.Core, MT.RequestSession, {
        applicationName: 'AHWR-50 Edge Twin', applicationVersion: '1.0',
        clientInstanceId: config.deviceId,
        requestedProtocols: [{ protocol: P.ChannelStreaming, protocolVersion: { major: 1, minor: 1 }, role: 'producer' }],
        supportedDataObjects: [], supportedFormats: ['application/x-etp-message+json'],
    });
}

function publishMetadata() {
    send(P.ChannelStreaming, MT.ChannelMetadata, {
        channels: CHANNELS.map((c) => ({ channelId: c.id, channelName: c.mnem, uom: c.uom, dataType: 'double', indexes: [{ indexKind: 'time', uom: 's', direction: 'increasing' }] })),
    });
}

function streamData() {
    const snaps = getRecent(config.streamSeconds);
    if (!snaps.length) return;
    const data = [];
    for (const s of snaps) {
        for (const c of CHANNELS) {
            const v = s.values ? s.values[c.key] : undefined;
            if (Number.isFinite(v)) data.push({ channelId: c.id, indexes: [Date.parse(s.ts)], value: { item: Number(v) } });
        }
    }
    if (!data.length) return;
    send(P.ChannelStreaming, MT.ChannelData, { data });
    state.framesSent += 1; state.dataPointsSent += data.length; state.lastSentAt = new Date().toISOString();
    emit();
}

function onMessage(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const { protocol, messageType } = m.header || {};
    if (protocol === P.Core && messageType === MT.OpenSession) {
        sessionId = (m.body && m.body.sessionId) || 'session';
        state.sessionEstablished = true; state.lastError = null;
        publishMetadata();
        clearInterval(streamTimer);
        streamTimer = setInterval(streamData, config.streamSeconds * 1000);
        emit();
    }
}

function connect() {
    if (!config.enabled) return;
    clearTimeout(reconnectTimer);
    try {
        const headers = { 'X-Device-Id': config.deviceId };
        if (config.token) headers['Authorization'] = `Bearer ${config.token}`;
        ws = new WebSocket(config.url, ETP_SUBPROTOCOL, { headers, handshakeTimeout: 6000 });
    } catch (e) { state.lastError = e.message; scheduleReconnect(); return; }

    ws.on('open', () => { state.connected = true; state.lastError = null; requestSession(); emit(); });
    ws.on('message', onMessage);
    ws.on('error', (e) => { state.lastError = e.message; });
    ws.on('close', () => {
        state.connected = false; state.sessionEstablished = false; sessionId = null;
        clearInterval(streamTimer); emit(); scheduleReconnect();
    });
}
function scheduleReconnect() { if (config.enabled) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 8000); } }

function getStatus() {
    return {
        enabled: config.enabled, url: config.url, subprotocol: ETP_SUBPROTOCOL, encoding: 'application/x-etp-message+json',
        connected: state.connected, sessionEstablished: state.sessionEstablished, sessionId,
        channels: CHANNELS.length, framesSent: state.framesSent, dataPointsSent: state.dataPointsSent,
        lastSentAt: state.lastSentAt, lastError: state.lastError, streamSeconds: config.streamSeconds,
    };
}

async function setConfig(next) {
    const wasEnabled = config.enabled;
    if ('enabled' in next) config.enabled = !!next.enabled;
    if ('url' in next && next.url) config.url = next.url;
    if ('streamSeconds' in next) config.streamSeconds = Math.max(1, Number(next.streamSeconds) || 5);
    if (config.enabled && !wasEnabled) connect();
    if (!config.enabled && ws) { try { ws.close(); } catch { /* ignore */ } }
    emit();
    return getStatus();
}

function start(ioRef) { io = ioRef; if (config.enabled) connect(); }

module.exports = { start, getStatus, setConfig };
