import { io } from 'socket.io-client';

// ONE shared socket instance for the whole app.
// - autoConnect:false so the connection is owned by Layout (after auth), not by import side-effects.
// - auth is a callback so the LATEST token is read on every (re)connect.
export const socket = io('/', {
    autoConnect: false,
    auth: (cb) => cb({ token: localStorage.getItem('romii_token') }),
    // Go straight to WebSocket. The default polling-then-upgrade handshake costs an
    // extra round trip on every reconnect, which is the common case on a rig link.
    transports: ['websocket', 'polling'],
    // Reconnect fast and keep trying: an unattended console must come back on its own
    // after a link flap, not sit disconnected until someone reloads the page.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
});
// ---------------------------------------------------------------------------
// Module-level telemetry cache
//
// Handlers are registered ONCE, here, at import time -- not per component. The
// backend primes each new *connection* (server.js io.on('connection') emits
// rig_data/alarms/...), but that does nothing for a route that mounts mid-session:
// without a cache every remount paints zeros until the next 1 Hz tick. On an HMI
// a flash of zeros reads as "no pressure", which is the one thing this console
// must never imply.
//
// Registering at import is safe because the socket is autoConnect:false -- no
// frame can arrive before Layout calls connectSocket() after auth.
// ---------------------------------------------------------------------------

// Ring depth for recent LIVE frames. At the backend's 1 Hz POLL_INTERVAL_MS this
// is 5 minutes, matching EfficiencyPage's TREND_CAP -- the only view with no
// historian endpoint behind it. Deliberately NOT an hour's worth: a frame carries
// ~146 numeric tags across 12 measurement blocks plus the derived _activity /
// _alarmMap / _efficiency / _kpi blocks, so an hour is tens of MB of retained
// heap on a panel PC that is also rendering the EDR and Trends charts.
const MAX_RECENT_FRAMES = 300;

// A cached frame older than this must never be painted as if it were current.
export const CACHE_MAX_AGE_MS = 15000;

let latestRigData = null;
let latestRigDataAt = 0;
let latestAlarms = null;
const recentRigFrames = [];

/** True only for a frame that came from a connected, non-stale, real source. */
export function isLiveRigPayload(payload) {
    const meta = payload?._meta;
    if (!meta) return false;
    return meta.connected === true && meta.source !== 'none' && meta.stale !== true;
}

socket.on('rig_data', (payload) => {
    if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) return;
    latestRigData = payload;
    latestRigDataAt = Date.now();
    // Only live frames enter the history ring: a stale or disconnected frame is
    // not a sample, and trending it would draw a flat line that never happened.
    if (!isLiveRigPayload(payload)) return;
    recentRigFrames.push({ at: latestRigDataAt, payload });
    if (recentRigFrames.length > MAX_RECENT_FRAMES) {
        recentRigFrames.splice(0, recentRigFrames.length - MAX_RECENT_FRAMES);
    }
});

socket.on('alarms', (payload) => { if (payload) latestAlarms = payload; });

/**
 * Last frame received, or null when nothing is cached or the cache is older than
 * `maxAgeMs`. Callers that plot points at their own timestamps (EDR) pass
 * Infinity -- an old sample drawn at its real time is honest; the same sample on
 * a live tile is not.
 */
export function getLatestRigData(maxAgeMs = CACHE_MAX_AGE_MS) {
    if (!latestRigData) return null;
    if (Number.isFinite(maxAgeMs) && (Date.now() - latestRigDataAt) > maxAgeMs) return null;
    return latestRigData;
}

/** Age of the cached frame in ms, or null when the cache is empty. */
export function getLatestRigDataAge() {
    return latestRigData ? Date.now() - latestRigDataAt : null;
}

/** Recent LIVE frames, oldest first: [{ at, payload }]. */
export function getRecentRigFrames(limit = MAX_RECENT_FRAMES) {
    const n = Math.max(1, Math.min(MAX_RECENT_FRAMES, Number(limit) || MAX_RECENT_FRAMES));
    return recentRigFrames.slice(-n);
}

/** Last `alarms` payload ({ active, counts }), or null. */
export function getLatestAlarms() {
    return latestAlarms;
}


export function connectSocket() {
    if (!socket.connected) socket.connect();
}

export function disconnectSocket() {
    // An explicit teardown means logout, so drop the cache: the next user must
    // never be shown the previous session's frame. Deliberately NOT done on the
    // transport 'disconnect' event -- surviving a link flap is the entire point
    // of the cache.
    latestRigData = null;
    latestRigDataAt = 0;
    latestAlarms = null;
    recentRigFrames.length = 0;
    if (socket.connected) socket.disconnect();
}
