'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require("socket.io");
const { InfluxDB } = require('@influxdata/influxdb-client');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const auth = require('./lib/auth');
const validate = require('./lib/validate');
const ldap = require('./lib/ldap');
const alarms = require('./lib/alarms');
const workover = require('./lib/workover');
const maintenance = require('./lib/maintenance');
const variables = require('./lib/variables');
const sync = require('./lib/sync');
const health = require('./lib/health');
const witsml = require('./lib/witsml');
const etp = require('./lib/etp');
const efficiency = require('./lib/efficiency');
const edrCatalog = require('../shared/edrMetrics.json');

const PORT = Number(process.env.PORT || 5000);
const DATA_DIR = process.env.DATA_DIR || __dirname;

// --- SEED DEFAULTS ON FIRST BOOT ---
const DEFAULTS_DIR = path.join(__dirname, 'defaults');
if (fs.existsSync(DEFAULTS_DIR)) {
    const filesToSeed = ['plc_config.json', 'users.json', 'dashboard_layout.json', 'alarms_config.json'];
    for (const file of filesToSeed) {
        const defaultPath = path.join(DEFAULTS_DIR, file);
        const targetPath = path.join(DATA_DIR, file);
        if (fs.existsSync(defaultPath) && !fs.existsSync(targetPath)) {
            try {
                fs.copyFileSync(defaultPath, targetPath);
                console.log(`Seeded default ${file} to ${DATA_DIR}`);
            } catch (err) {
                console.error(`Failed to seed ${file}:`, err.message);
            }
        }
    }
}
// -----------------------------------

const INFLUX_URL = process.env.INFLUX_URL || 'http://influxdb:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const INFLUX_ORG = process.env.INFLUX_ORG || 'romii_org';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'romii_bucket';
const INFLUX_QUERY_TIMEOUT_MS = Number(process.env.INFLUX_QUERY_TIMEOUT_MS || 60000);
const DATA_SOURCE = process.env.DATA_SOURCE || 'plc';
const MAX_WELL_DEPTH = Number(process.env.MAX_WELL_DEPTH_M || 15000); // sanity clamp (m)
const FRESH_MS = Number(process.env.DATA_FRESH_MS || 5000);          // data older than this = stale

if (!INFLUX_TOKEN) {
    console.error('FATAL: INFLUX_TOKEN env var is required (no hardcoded fallback). Refusing to start.');
    process.exit(1);
}

// Allowed browser origins. Same-origin (served behind nginx) needs no entry;
// set CORS_ORIGIN (comma-separated) only for cross-origin dev access.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigin = CORS_ORIGINS.length ? CORS_ORIGINS : false;

const app = express();
app.set('trust proxy', 1); // behind nginx
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true } });

app.use(helmet());
app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Unauthenticated health checks (used by the Docker healthcheck / probes).
app.get('/', (req, res) => res.send('ROM-II Backend is running'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Require a valid JWT on the Socket.io handshake before any telemetry streams.
io.use(auth.socketAuth);
io.on('connection', (socket) => {
    socket.emit('rig_data', latestRigData);            // prime newly-connected clients
    socket.emit('dashboard_layout_update', getDashboardConfig());
    socket.emit('alarms', alarms.snapshot());          // prime the alarm banner/list
    socket.emit('sync_status', sync.getStatus());      // prime the edge-sync page
    socket.emit('etp_status', etp.getStatus());
});

// Start the store-and-forward sync agent + ETP 2.0 publisher (outbound only).
sync.start(io);
etp.start(io);

// InfluxDB Query Client
const queryApi = new InfluxDB({
    url: INFLUX_URL,
    token: INFLUX_TOKEN,
    timeout: INFLUX_QUERY_TIMEOUT_MS
}).getQueryApi(INFLUX_ORG);

// --- Atomic JSON persistence (temp file + rename; off the hot loop) -------
const writeJsonAtomic = async (file, obj) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, file);
};
const readJsonSync = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file)); } catch { return fallback; }
};

// --- Drilling Physics Engine ---
const DRILLING_STATE_FILE = path.join(DATA_DIR, 'drilling_state.json');
let drillingState = {
    stringWeight: 0,     // tonnes-force (tare/string weight captured at zero-WOB)
    totalDepth: 304.8,   // m (seed = 1000 ft)
    bitDepth: 0,         // m
    lastBlockPosition: 0 // ft (block position is in feet)
};

// Reject NaN/negative/absurd depths; bound to a configured maximum well depth.
function clampDepth(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_WELL_DEPTH);
}

// Load state from disk if present, then clamp any out-of-range persisted values.
{
    const saved = readJsonSync(DRILLING_STATE_FILE, null);
    if (saved) drillingState = { ...drillingState, ...saved };
    drillingState.bitDepth = clampDepth(drillingState.bitDepth);
    drillingState.totalDepth = clampDepth(drillingState.totalDepth);
}

// Persistence is decoupled from the 1 Hz poll loop: mark dirty, flush async.
let drillingDirty = false;
const markDrillingDirty = () => { drillingDirty = true; };
const flushDrillingState = async () => {
    if (!drillingDirty) return;
    drillingDirty = false;
    try { await writeJsonAtomic(DRILLING_STATE_FILE, drillingState); }
    catch (e) { console.error('Failed to persist drilling state:', e.message); drillingDirty = true; }
};

// --- PLC / S7 Configuration API ---
// GET: any authenticated user may view the current device config.
app.get('/api/config/plc', auth.requireAuth, (req, res) => {
    res.json(getModbusConfig());
});

// POST: admin-only. Validates the payload (stops TOML/config injection),
// regenerates the managed section of telegraf.conf, and lets Telegraf
// hot-reload it via `--watch-config`. No Docker socket / restart involved.
app.post('/api/config/plc', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try {
        const config = validate.validatePlcConfig(req.body);
        await saveModbusConfig(config);

        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const startMarker = '# PLC_CONFIG_START';
        const endMarker = '# PLC_CONFIG_END';
        const startIndex = content.indexOf(startMarker);
        const endIndex = content.indexOf(endMarker);
        if (startIndex === -1 || endIndex === -1) {
            throw new Error('Telegraf configuration file is missing PLC_CONFIG markers.');
        }
        const newSection = generateTelegrafConfig(config);
        const before = content.substring(0, startIndex + startMarker.length);
        const after = content.substring(endIndex);
        fs.writeFileSync(CONFIG_PATH, `${before}\n${newSection}\n${after}`);

        res.json({ success: true, message: 'Configuration saved. Telegraf will hot-reload automatically.' });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('Error saving PLC config:', err);
        res.status(status).json({ success: false, error: err.message });
    }
});

// Physics loop (runs on each data update). All weights are in tonnes-force
// (consistent with the PLC "Weight on Hook -Ton" tag); depths are in metres.
const updatePhysics = (rigData) => {
    const currentHookLoad = Number(rigData.drawworks?.hook_load) || 0;
    const currentBlockPos = Number(rigData.drawworks?.block_position) || 0;

    // Prefer PLC-supplied depth as source of truth. 0 is a VALID reading
    // (bit at surface), so test for finiteness, not truthiness.
    const plcBitDepth = rigData.drilling?.bit_depth;
    const plcHoleDepth = rigData.drilling?.hole_depth;
    const hasPlcBit = Number.isFinite(plcBitDepth);
    const hasPlcHole = Number.isFinite(plcHoleDepth);

    if (hasPlcBit) drillingState.bitDepth = clampDepth(plcBitDepth);
    if (hasPlcHole) drillingState.totalDepth = clampDepth(plcHoleDepth);

    // WOB = string/tare weight currently NOT carried by the hook (tonnes-force).
    const wob = Math.max(0, drillingState.stringWeight - currentHookLoad);

    // Local dead-reckoning fallback ONLY when the PLC isn't supplying bit depth.
    if (!hasPlcBit) {
        const deltaBlock = drillingState.lastBlockPosition - currentBlockPos; // +ve = moving down (ft)
        const deltaBlockMeters = deltaBlock * 0.3048;
        const newBitDepth = clampDepth(drillingState.bitDepth + deltaBlockMeters);

        const WOB_THRESHOLD = 1.0; // tonnes-force; on-bottom (drilling) threshold
        if (wob > WOB_THRESHOLD) {
            drillingState.bitDepth = newBitDepth;
            if (drillingState.bitDepth > drillingState.totalDepth) {
                drillingState.totalDepth = clampDepth(drillingState.bitDepth);
            }
        } else {
            drillingState.bitDepth = Math.min(newBitDepth, drillingState.totalDepth);
        }
    }

    drillingState.lastBlockPosition = currentBlockPos;
    markDrillingDirty();

    return {
        wob: Number(wob.toFixed(1)),
        bit_depth: Number(drillingState.bitDepth.toFixed(2)),
        hole_depth: Number(drillingState.totalDepth.toFixed(2))
    };
};

// --- APIs for Calibration (operator or admin) ---
app.post('/api/drilling/zero-wob', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const stringWeight = validate.num(req.body.currentHookLoad, 'currentHookLoad', { min: 0, max: 5000 });
        drillingState.stringWeight = stringWeight;
        markDrillingDirty();
        maintenance.logCalibration({ type: 'Weight Indicator (Zero-WOB)', asset: 'drawworks', value: `${stringWeight} t tare`, by: req.user.username });
        res.json({ success: true, stringWeight });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.post('/api/drilling/set-depth', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const { bitDepth, holeDepth } = req.body;
        if (bitDepth !== undefined) drillingState.bitDepth = clampDepth(validate.num(bitDepth, 'bitDepth', { min: 0, max: MAX_WELL_DEPTH }));
        if (holeDepth !== undefined) drillingState.totalDepth = clampDepth(validate.num(holeDepth, 'holeDepth', { min: 0, max: MAX_WELL_DEPTH }));
        markDrillingDirty();
        maintenance.logCalibration({ type: 'Depth / Block Encoder (Set-Depth)', asset: 'drawworks', value: `bit ${drillingState.bitDepth?.toFixed?.(1) ?? '—'} m`, by: req.user.username });
        res.json({ success: true, state: drillingState });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.get('/api/drilling/state', auth.requireAuth, (req, res) => {
    res.json(drillingState);
});

// --- Main Socket & Data Loop ---

// Telegraf config + device-config persistence paths.
const CONFIG_PATH = process.env.TELEGRAF_CONFIG_PATH || path.join(DATA_DIR, 'telegraf', 'telegraf.conf');
const DB_PATH = path.join(DATA_DIR, 'plc_config.json');

const getModbusConfig = () => readJsonSync(DB_PATH, { slaves: [] });
const saveModbusConfig = (config) => writeJsonAtomic(DB_PATH, config);
const getS7ScaleMap = () => {
    const scaleMap = new Map();
    const config = getModbusConfig();
    (config.slaves || []).forEach(slave => {
        if ((slave.protocol || 'modbus') !== 's7comm') return;
        (slave.metrics || []).forEach(metric => {
            (metric.fields || []).forEach(field => {
                const scale = field.scale === undefined || field.scale === null || field.scale === ''
                    ? 1
                    : Number(field.scale);
                if (field.name && Number.isFinite(scale)) scaleMap.set(field.name, scale);
            });
        });
    });
    return scaleMap;
};
const applyS7Scale = (fieldName, value, scaleMap) => {
    const scale = scaleMap.get(fieldName);
    const numericValue = Number(value);
    if (scale === undefined || scale === 1 || !Number.isFinite(scale) || !Number.isFinite(numericValue)) {
        return value;
    }
    return numericValue * scale;
};

// Map Modbus fields to application categories
// Map S7 field names to application categories
const { FIELD_MAP } = require('./lib/fieldmap');

// Measurements polled for the live view (S7comm writes under "AHWR";
// app-level measurements support mock/Modbus sources). Shared with /api/history.
const LIVE_MEASUREMENTS = ['drawworks', 'engine', 'mudpump', 'wellcontrol', 'wellhead', 'safety', 'opcua_demo', 'modbus', 'AHWR', 'fluid', 'drilling', 'hpu', 'htd', 'acs', 'cat_engine', 'cwk', 'pct'];

const HISTORY_METRICS = new Set(edrCatalog.categories.flatMap(category =>
    category.fields.map(field => `${category.id}.${field.id}`)
));

const RAW_FIELDS_BY_METRIC = new Map();
Object.entries(FIELD_MAP).forEach(([rawField, mapped]) => {
    const metric = `${mapped.meas}.${mapped.field}`;
    HISTORY_METRICS.add(metric);
    if (!RAW_FIELDS_BY_METRIC.has(metric)) RAW_FIELDS_BY_METRIC.set(metric, []);
    RAW_FIELDS_BY_METRIC.get(metric).push(rawField);
});

const fluxString = (value) => JSON.stringify(String(value));

const getFluxDurationMs = (range) => {
    const match = /^-(\d+)(ns|us|ms|s|m|h|d|w|mo|y)$/.exec(range || '');
    if (!match) return null;
    const value = Number(match[1]);
    const unitMs = {
        ns: 1 / 1e6,
        us: 1 / 1e3,
        ms: 1,
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        mo: 30 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000
    };
    return value * unitMs[match[2]];
};

const getHistoryWindowPeriod = (durationMs) => {
    if (durationMs <= 60 * 1000) return '1s';
    if (durationMs <= 5 * 60 * 1000) return '2s';
    if (durationMs <= 15 * 60 * 1000) return '5s';
    if (durationMs <= 30 * 60 * 1000) return '10s';
    if (durationMs <= 60 * 60 * 1000) return '30s';
    if (durationMs <= 2 * 60 * 60 * 1000) return '1m';
    if (durationMs <= 4 * 60 * 60 * 1000) return '2m';
    if (durationMs <= 12 * 60 * 60 * 1000) return '5m';
    if (durationMs <= 24 * 60 * 60 * 1000) return '15m';
    if (durationMs <= 3 * 24 * 60 * 60 * 1000) return '30m';
    if (durationMs <= 7 * 24 * 60 * 60 * 1000) return '1h';
    if (durationMs <= 30 * 24 * 60 * 60 * 1000) return '6h';
    return '24h';
};

const buildHistoryMetricFilter = (metrics) => {
    if (metrics.length === 0) return '';
    const selectors = new Set();
    metrics.forEach(metric => {
        const separator = metric.indexOf('.');
        const measurement = metric.slice(0, separator);
        const field = metric.slice(separator + 1);
        selectors.add(`(r["_measurement"] == ${fluxString(measurement)} and r["_field"] == ${fluxString(field)})`);
        (RAW_FIELDS_BY_METRIC.get(metric) || []).forEach(rawField => {
            selectors.add(`r["_field"] == ${fluxString(rawField)}`);
        });
    });
    return `|> filter(fn: (r) => ${Array.from(selectors).join(' or ')})`;
};

let lastDataAt = 0; // epoch ms of the last tick that returned sensor data

const queryData = async () => {
    const measurementFilter = LIVE_MEASUREMENTS.map(m => `r["_measurement"] == "${m}"`).join(' or ');
    const s7ScaleMap = getS7ScaleMap();
    const fluxQuery = `
    from(bucket: "${INFLUX_BUCKET}")
      |> range(start: -10s)
      |> filter(fn: (r) => ${measurementFilter})
      |> last()
  `;

    try {
        const data = {};
        await new Promise((resolve, reject) => {
            queryApi.queryRows(fluxQuery, {
                next(row, tableMeta) {
                    const o = tableMeta.toObject(row);
                    let meas = o._measurement;
                    let f = o._field;
                    const value = applyS7Scale(f, o._value, s7ScaleMap);
                    if (FIELD_MAP[f]) { meas = FIELD_MAP[f].meas; f = FIELD_MAP[f].field; }
                    if (!data[meas]) data[meas] = {};
                    data[meas][f] = value;
                },
                error(error) { reject(error); },
                complete() { resolve(); },
            });
        });

        const hasSensorData = !!(data.drawworks || data.engine || data.mudpump || data.drilling || data.AHWR);
        const now = Date.now();
        if (hasSensorData) lastDataAt = now;
        const stale = (now - lastDataAt) > FRESH_MS;

        if (hasSensorData) {
            const physicsData = updatePhysics(data);
            const plcWob = data.drilling ? data.drilling.wob : undefined;
            if (data.drawworks?.block_position !== undefined) {
                data.acs = {
                    ...(data.acs || {}),
                    block_position: data.drawworks.block_position
                };
            }
            // Depth always comes from the clamped physics state (which itself
            // prefers PLC depth). WOB prefers the real PLC measurement when present.
            data.drilling = {
                ...(data.drilling || {}),            // keep PLC rop, rpm, torque, operation_mode, ...
                bit_depth: physicsData.bit_depth,
                hole_depth: physicsData.hole_depth,
                wob: Number.isFinite(plcWob) ? plcWob : physicsData.wob
            };
        } else {
            // No live feed: do NOT fabricate zeros. Show last-known depth and
            // let _meta.stale tell the UI the values are not live.
            data.drilling = {
                ...(data.drilling || {}),
                bit_depth: Number(drillingState.bitDepth.toFixed(2)),
                hole_depth: Number(drillingState.totalDepth.toFixed(2))
            };
        }

        // Well control / BOP: present ONLY when a real source exists. Never
        // coalesce safety-critical ram/pressure signals to a benign false/0 state.
        const wc = data.wellcontrol;
        if (wc && Object.keys(wc).length > 0) {
            data.well_control = {
                available: true,
                annular_pressure: wc.annular_pressure ?? null,
                manifold_pressure: wc.manifold_pressure ?? null,
                accumulator_pressure: wc.accumulator_pressure ?? null,
                annular_open: wc.annular_open ?? null,
                annular_close: wc.annular_close ?? null,
                pipe_ram_open: wc.pipe_ram_open ?? null,
                pipe_ram_close: wc.pipe_ram_close ?? null,
                blind_ram_open: wc.blind_ram_open ?? null,
                blind_ram_close: wc.blind_ram_close ?? null,
                shear_ram_open: wc.shear_ram_open ?? null
            };
        } else {
            data.well_control = { available: false };
        }
        delete data.wellcontrol;

        data._meta = {
            ts: new Date(now).toISOString(),
            source: hasSensorData ? DATA_SOURCE : 'none',
            stale,
            age_ms: lastDataAt ? (now - lastDataAt) : null,
            connected: hasSensorData
        };

        // --- Workover layer: activity/NPT, torque-turn, alarms ---
        if (hasSensorData) {
            data._activity = workover.updateActivity(data, now);
            const tt = workover.updateTorqueTurn(data, now);
            if (tt.connectionMade) io.emit('connection_made', tt.connectionMade);
            data._torqueturn = workover.getTorqueTurnLive();
            const al = alarms.evaluate(data, now);
            data._alarms = al.counts;
            if (al.changed) io.emit('alarms', al);
            maintenance.updateHours(data, now);
            data._efficiency = efficiency.update(data, now, { jointMade: !!tt.connectionMade });
            // Store-and-forward: queue telemetry + events for sync to central
            sync.enqueueTelemetry(data, now);
            if (al.changed) sync.enqueueEvent('alarm', al.counts, now);
            if (tt.connectionMade) sync.enqueueEvent('connection', tt.connectionMade, now);
        } else {
            data._activity = workover.getCurrent();
            data._alarms = alarms.snapshot().counts;
            data._efficiency = efficiency.compute(data);
        }

        latestRigData = data;
        io.emit('rig_data', data);
    } catch (err) {
        console.error('Error querying InfluxDB:', err.message);
    }
};

// Global cache for the latest data
let latestRigData = {};

// API: Get Latest Rig Data
app.get('/api/rig/latest', auth.requireAuth, (req, res) => {
    res.json(latestRigData);
});

// Self-scheduling poll loop with an in-flight guard so a slow Influx query
// can never let invocations overlap and stack up on shared mutable state.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
let pollTimer = null;
let pollStopped = false;
const scheduleNextPoll = () => {
    if (pollStopped) return;
    pollTimer = setTimeout(async () => {
        try { await queryData(); } finally { scheduleNextPoll(); }
    }, POLL_INTERVAL_MS);
};

// API: Get Historical Data
// API: Get Historical Data
app.get('/api/history', auth.requireAuth, async (req, res) => {
    const { range, start, stop, metrics } = req.query;

    // Validate time inputs before they are interpolated into the Flux query
    // (prevents Flux injection). Allow relative durations and RFC3339 instants only.
    if (start !== undefined || stop !== undefined) {
        if (!validate.isFluxInstant(start) || !validate.isFluxInstant(stop)) {
            return res.status(400).json({ error: 'Invalid start/stop (use RFC3339 timestamps)' });
        }
    } else if (range !== undefined && !validate.isFluxRange(range)) {
        return res.status(400).json({ error: 'Invalid range (use a relative duration like -1h, -7d)' });
    }

    const requestedMetrics = typeof metrics === 'string'
        ? [...new Set(metrics.split(',').map(metric => metric.trim()).filter(Boolean))]
        : [];
    if (requestedMetrics.length > 64 || requestedMetrics.some(metric => !HISTORY_METRICS.has(metric))) {
        return res.status(400).json({ error: 'Invalid history metrics' });
    }

    // Build range filter
    let rangeFilter = '';
    let durationMs;

    if (start && stop) {
        rangeFilter = `|> range(start: ${start}, stop: ${stop})`;
        durationMs = new Date(stop).getTime() - new Date(start).getTime();
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return res.status(400).json({ error: 'History stop time must be after start time' });
        }
    } else {
        rangeFilter = `|> range(start: ${range || '-30s'})`;
        durationMs = getFluxDurationMs(range || '-30s');
    }
    const windowPeriod = getHistoryWindowPeriod(durationMs || 30 * 1000);
    const metricFilter = buildHistoryMetricFilter(requestedMetrics);

    // Determine if we need date in the time label
    const needsDate = range?.includes('24h') || range?.includes('d') || range?.includes('mo') || (start && stop);

    // Same measurement set as the live view (crucially includes "AHWR", under
    // which all S7comm/PLC fields are written) so equipment history isn't empty.
    const measurementFilter = LIVE_MEASUREMENTS.map(m => `r["_measurement"] == "${m}"`).join(' or ');
    const s7ScaleMap = getS7ScaleMap();

    const fluxQuery = `
    import "types"
    from(bucket: "${INFLUX_BUCKET}")
      ${rangeFilter}
      |> filter(fn: (r) => ${measurementFilter})
      ${metricFilter}
      |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int") or types.isType(v: r._value, type: "uint"))
      |> aggregateWindow(every: ${windowPeriod}, fn: last, createEmpty: false)
      |> yield(name: "last")
  `;

    try {
        const history = [];
        await new Promise((resolve, reject) => {
            queryApi.queryRows(fluxQuery, {
                next(row, tableMeta) {
                    const o = tableMeta.toObject(row);
                    let meas = o._measurement;
                    let f = o._field;
                    const value = applyS7Scale(f, o._value, s7ScaleMap);

                    if (FIELD_MAP[f]) {
                        meas = FIELD_MAP[f].meas;
                        f = FIELD_MAP[f].field;
                    }

                    history.push({
                        time: o._time,
                        measurement: meas,
                        field: f,
                        value
                    });
                },
                error(error) {
                    console.error(error);
                    reject(error);
                },
                complete() {
                    resolve();
                }
            });
        });

        // Group by timestamp for the chart
        const grouped = {};
        history.forEach(pt => {
            const t = new Date(pt.time).getTime(); // Use numeric timestamp as key
            if (!grouped[t]) {
                const d = new Date(pt.time);
                let label;
                if (needsDate) {
                    label = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
                } else {
                    label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                }
                grouped[t] = { name: label, timestamp: t };
            }
            grouped[t][`${pt.measurement}.${pt.field}`] = pt.value;
        });

        // Sort by numeric timestamp (not string)
        res.json(Object.values(grouped).sort((a, b) => a.timestamp - b.timestamp));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Modbus Configuration API

// Helper: Generate Telegraf TOML
const generateTelegrafConfig = (config) => {
    let toml = '';

    // Slaves are now treated as "Devices" which can be Modbus or S7comm
    config.slaves.forEach(slave => {
        const protocol = slave.protocol || 'modbus';

        if (protocol === 'modbus') {
            toml += `[[inputs.modbus]]\n`;
            toml += `  name = "${slave.name}"\n`;
            toml += `  slave_id = ${slave.slaveId || 1}\n`;
            toml += `  timeout = "1s"\n`;
            toml += `  controller = "tcp://${slave.ip}:${slave.port || 502}"\n`;
            toml += `  configuration_type = "register"\n`;
            toml += `  optimization = "none"\n\n`;

            // Discrete Inputs
            const discretes = slave.registers.filter(r => r.type === 'discrete_input' && r.address !== null && r.address !== undefined && r.address !== "");
            if (discretes.length > 0) {
                toml += `  discrete_inputs = [\n`;
                discretes.forEach(r => {
                    toml += `    { name = "${r.name}", address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }

            // Coils
            const coils = slave.registers.filter(r => r.type === 'coil' && r.address !== null && r.address !== undefined && r.address !== "");
            if (coils.length > 0) {
                toml += `  coils = [\n`;
                coils.forEach(r => {
                    toml += `    { name = "${r.name}", address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }

            // Holding Registers
            const holding = slave.registers.filter(r => (r.type === 'holding_register' || r.type === 'input_register') && r.address !== null && r.address !== undefined && r.address !== "");
            if (holding.length > 0) {
                toml += `  holding_registers = [\n`;
                holding.forEach(r => {
                    let scaleVal = r.scale !== undefined && r.scale !== null && r.scale !== "" ? Number(r.scale) : 1.0;
                    let scaleStr = Number.isInteger(scaleVal) ? scaleVal.toFixed(1) : String(scaleVal);
                    const byteOrder = (r.dataType === 'INT16' || r.dataType === 'UINT16') ? 'AB' : 'ABCD';
                    toml += `    { name = "${r.name}", byte_order = "${byteOrder}", data_type = "${r.dataType}", scale = ${scaleStr}, address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }
        } else if (protocol === 's7comm') {
            toml += `[[inputs.s7comm]]\n`;
            toml += `  server = "${slave.ip}:${slave.port || 102}"\n`;
            toml += `  rack = ${slave.rack || 0}\n`;
            toml += `  slot = ${slave.slot || 0}\n`;

            // S7comm uses metrics which group fields together
            if (slave.metrics && slave.metrics.length > 0) {
                slave.metrics.forEach(metric => {
                    toml += `  [[inputs.s7comm.metric]]\n`;
                    toml += `    name = "${metric.name || 'AHWR'}"\n`;
                    toml += `    fields = [\n`;
                    metric.fields.forEach(f => {
                        toml += `      {name="${f.name}", address="${f.address}"},\n`;
                    });
                    toml += `    ]\n`;
                    if (metric.tags) {
                        toml += `    [inputs.s7comm.metric.tags]\n`;
                        Object.entries(metric.tags).forEach(([k, v]) => {
                            toml += `      ${k} = "${v}"\n`;
                        });
                    }
                });
            }
        }
        toml += `\n`;
    });
    return toml;
};

// Redundant endpoints removed (consolidated to /api/config/plc)

// --- User Management ---
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = [];

const saveUsers = () => writeJsonAtomic(USERS_FILE, users);

// Load users; migrate any legacy plaintext passwords to bcrypt hashes; seed the
// initial admin from env (ADMIN_USERNAME / ADMIN_PASSWORD) when no store exists.
const loadUsers = () => {
    const saved = readJsonSync(USERS_FILE, null);
    if (Array.isArray(saved) && saved.length) {
        let migrated = false;
        users = saved.map(u => {
            if (u.password && !auth.isHashed(u.password)) {
                migrated = true;
                return { ...u, password: auth.hashPassword(u.password) };
            }
            return u;
        });
        if (migrated) { saveUsers(); console.log('Migrated legacy plaintext passwords to bcrypt hashes.'); }
        return;
    }
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) {
        console.error('FATAL: no users.json present and ADMIN_PASSWORD env is not set; cannot seed initial admin.');
        process.exit(1);
    }
    users = [{ id: 1, username: adminUser, password: auth.hashPassword(adminPass), role: 'admin', status: 'active' }];
    saveUsers();
    console.log(`Seeded initial admin user "${adminUser}" from environment.`);
};

loadUsers();

const sanitizeUser = ({ password, ...u }) => u;
const activeAdminCount = () => users.filter(u => u.role === 'admin' && u.status !== 'inactive').length;

// Just-in-time provisioning for a directory (LDAP/AD) user. Mirrors the AD
// account into the local store so roles/status/audit work. An admin can lock a
// role locally (roleLocked) or deactivate the account to block sign-in.
const upsertLdapUser = async (dir) => {
    let u = users.find(x => x.username.toLowerCase() === dir.username.toLowerCase());
    if (u) {
        if (u.status === 'inactive') return null; // locally disabled -> blocked
        if (!u.roleLocked) u.role = dir.role;      // refresh role from directory groups
        u.displayName = dir.displayName;
        u.source = 'ldap';
    } else {
        u = { id: Date.now(), username: dir.username, displayName: dir.displayName, role: dir.role, status: 'active', source: 'ldap' };
        users.push(u);
    }
    await saveUsers();
    return u;
};

// API: List Users (admin)
app.get('/api/users', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    res.json(users.map(sanitizeUser));
});

// API: Add User (admin)
app.post('/api/users', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { username, password, role } = req.body;
    if (!validate.USERNAME_RE.test(String(username || ''))) {
        return res.status(400).json({ error: 'Username must be 3-40 chars [A-Za-z0-9_.-]' });
    }
    if (!password || String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const newRole = role || 'operator';
    if (!validate.ROLES.includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }
    const newUser = { id: Date.now(), username, password: auth.hashPassword(password), role: newRole, status: 'active' };
    users.push(newUser);
    await saveUsers();
    res.json({ success: true, user: sanitizeUser(newUser) });
});

// API: Update User (admin)
app.put('/api/users/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { username, password, role, status } = req.body;
    const index = users.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'User not found' });

    if (username !== undefined) {
        if (!validate.USERNAME_RE.test(String(username))) return res.status(400).json({ error: 'Invalid username' });
        users[index].username = username;
    }
    if (password !== undefined && password !== '') {
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        users[index].password = auth.hashPassword(password);
    }
    // Guard: never let the last active admin be demoted or deactivated.
    const wouldDropAdmin = (role && role !== 'admin') || (status === 'inactive');
    if (users[index].role === 'admin' && wouldDropAdmin && activeAdminCount() <= 1) {
        return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
    }
    if (role !== undefined) {
        if (!validate.ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
        users[index].role = role;
    }
    if (status !== undefined) users[index].status = status;
    await saveUsers();
    res.json({ success: true, user: sanitizeUser(users[index]) });
});

// API: Delete User (admin)
app.delete('/api/users/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const target = users.find(u => u.id == id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && activeAdminCount() <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active admin' });
    }
    users = users.filter(u => u.id != id);
    await saveUsers();
    res.json({ success: true });
});

// --- Dashboard Persistence ---
const DASHBOARD_FULL_CONFIG_FILE = path.join(DATA_DIR, 'dashboard_layout.json');
const DASHBOARD_AUDIT_FILE = path.join(DATA_DIR, 'dashboard_layout_audit.json');
const DASHBOARD_AUDIT_LIMIT = 500;

const EDR_STRIP_LIMITS = { min: 1, max: 6 };
const EDR_PEN_LIMITS = { min: 1, max: 4 };
const EDR_COLOR_RE = /^#[0-9a-f]{6}$/i;
const EDR_METRICS = edrCatalog.categories.flatMap(category =>
    category.fields.map(field => ({
        ...field,
        value: `${category.id}.${field.id}`,
        category: category.id,
        categoryLabel: category.label
    }))
);
const EDR_METRIC_BY_VALUE = new Map(EDR_METRICS.map(metric => [metric.value, metric]));
const DEFAULT_EDR_CONFIG = edrCatalog.defaultLayout;

// Default Layout (Fallback)
const DEFAULT_DASHBOARD_CONFIG = {
    gauges: [
        { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
        { id: 'd2', label: 'SPP', dataKey: 'SPP-Bar', min: 0, max: 5000, unit: 'psi', color: '#fbbf24', gridWidth: 3, size: 160, majorTicks: 5, minorTicks: 4 },
        { id: 'd6', label: 'HTD RPM', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', gridWidth: 3, size: 160 },
    ],
    sideStats: [
        { key: 'pump_pressure', label: 'SPP', unit: 'Bar', min: 0, max: 500 },
        { key: 'torque', label: 'Drill String Torque', unit: 'daN·m', min: 0, max: 20000 }
    ],
    _meta: { version: 1, updatedAt: null, updatedBy: 'system', updatedByRole: 'system' },
    edr: DEFAULT_EDR_CONFIG,
    units: { wob: 'tonnes', depth: 'm' },
    wellInfo: { well: 'WELL-001', rig: 'RIG-ALPHA' },
    bottomStats: [
        {
            id: 'p1',
            title: 'DRILLING PARAMETERS',
            params: [
                { id: 'p1_1', label: 'FLOW IN', dataKey: 'flow_in', unit: 'Lt/min' },
                { id: 'p1_2', label: 'FLOW OUT', dataKey: 'flow_out', unit: '%' },
                { id: 'p1_3', label: 'ROP', dataKey: 'rop', unit: 'm/h' },
                { id: 'p1_4', label: 'SPP', dataKey: 'pump_pressure', unit: 'Bar' },
                { id: 'p1_5', label: 'SPM', dataKey: 'spm', unit: 'SPM' }
            ]
        },
        {
            id: 'p2',
            title: 'HTD STATUS',
            params: [
                { id: 'p2_1', label: 'IBOP', dataKey: 'ibop_status', unit: '' },
                { id: 'p2_2', label: 'ELEVATOR', dataKey: 'elevator_status', unit: '' },
                { id: 'p2_3', label: 'BREAK', dataKey: 'brake_status', unit: '' },
                { id: 'p2_4', label: 'SPEED', dataKey: 'vertical_speed', unit: 'm/s' },
                { id: 'p2_5', label: 'LINK TILT', dataKey: 'tilt_status', unit: '' }
            ]
        },
        {
            id: 'p3',
            title: 'EQUIPMENT STATUS',
            params: [
                { id: 'p3_1', label: 'HPU', dataKey: 'hpu_status', unit: '' },
                { id: 'p3_2', label: 'HTD', dataKey: 'htd_status', unit: '' },
                { id: 'p3_3', label: 'PCT', dataKey: 'pct_status', unit: '' },
                { id: 'p3_4', label: 'CAT ENGINE', dataKey: 'engine_status', unit: '' },
                { id: 'p3_5', label: 'CWK', dataKey: 'cwk_status', unit: '' }
            ]
        },
        {
            id: 'p4',
            title: 'PCT & CWK',
            params: [
                { id: 'p4_1', label: 'SEQUENCE', dataKey: 'pct_sequence', unit: '' },
                { id: 'p4_2', label: 'SPINNER', dataKey: 'spinner_floating', unit: '' },
                { id: 'p4_3', label: 'CLAMP FORCE', dataKey: 'cwk_clamp_pressure', unit: 'Bar' },
                { id: 'p4_4', label: 'CLAMP', dataKey: 'cwk_clamp_status', unit: '' },
                { id: 'p4_5', label: 'SPINNER TORQUE', dataKey: 'spinner_makeup_torque', unit: 'daN*m' }
            ]
        }
    ]
};

const auditId = () => `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const appendDashboardAudit = async (record) => {
    const audit = readJsonSync(DASHBOARD_AUDIT_FILE, []);
    const rows = Array.isArray(audit) ? audit : [];
    rows.push(record);
    await writeJsonAtomic(DASHBOARD_AUDIT_FILE, rows.slice(-DASHBOARD_AUDIT_LIMIT));
};

const clampInteger = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const numericOrFallback = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeWellInfo = (info = {}) => {
    const fallback = DEFAULT_DASHBOARD_CONFIG.wellInfo;
    const rig = typeof info.rig === 'string' ? info.rig.trim().slice(0, 40) : '';
    const well = typeof info.well === 'string' ? info.well.trim().slice(0, 40) : '';
    return {
        rig: rig || fallback.rig,
        well: well || fallback.well
    };
};

const getDefaultEdrPen = (stripIndex, penIndex) => {
    const strip = DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];
    return strip.pens[penIndex % strip.pens.length] || DEFAULT_EDR_CONFIG.strips[0].pens[0];
};

const sanitizeEdrPen = (pen, stripIndex, penIndex) => {
    const fallback = getDefaultEdrPen(stripIndex, penIndex);
    const source = pen && typeof pen === 'object' ? pen : {};
    const metric = EDR_METRIC_BY_VALUE.has(source.metric) ? source.metric : fallback.metric;
    const meta = EDR_METRIC_BY_VALUE.get(metric);
    const min = numericOrFallback(source.min, fallback.min ?? meta?.defaultMin ?? 0);
    let max = numericOrFallback(source.max, fallback.max ?? meta?.defaultMax ?? 1);
    if (max <= min) max = min + 1;

    return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 40) : `s${stripIndex + 1}p${penIndex + 1}`,
        metric,
        min,
        max,
        color: EDR_COLOR_RE.test(source.color || '') ? source.color : fallback.color
    };
};

const normalizeLegacyEdrStrips = (config) => {
    if (Array.isArray(config?.strips)) return config.strips;
    if (!Array.isArray(config?.tracks)) return [];
    return config.tracks.map((track, stripIndex) => ({
        id: `strip-${stripIndex + 1}`,
        title: `Strip ${stripIndex + 1}`,
        pens: [track.left, track.right].filter(Boolean)
    }));
};

const sanitizeEdrPreset = (preset, index) => {
    const source = preset && typeof preset === 'object' ? preset : {};
    const configSource = source.config && typeof source.config === 'object' ? source.config : source;
    return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 48) : `preset-${index + 1}`,
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 80) : `Preset ${index + 1}`,
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
        createdBy: typeof source.createdBy === 'string' ? source.createdBy.slice(0, 80) : 'unknown',
        config: sanitizeEdrConfig(configSource, { includePresets: false })
    };
};

const sanitizeEdrConfig = (config = {}, options = { includePresets: true }) => {
    const source = config && typeof config === 'object' ? config : {};
    const sourceStrips = normalizeLegacyEdrStrips(source);
    const stripCount = clampInteger(
        source.stripCount ?? sourceStrips.length,
        DEFAULT_EDR_CONFIG.stripCount,
        EDR_STRIP_LIMITS.min,
        EDR_STRIP_LIMITS.max
    );
    const pensPerStrip = clampInteger(
        source.pensPerStrip,
        DEFAULT_EDR_CONFIG.pensPerStrip,
        EDR_PEN_LIMITS.min,
        EDR_PEN_LIMITS.max
    );

    const result = {
        stripCount,
        pensPerStrip,
        strips: Array.from({ length: stripCount }, (_, stripIndex) => {
            const sourceStrip = sourceStrips[stripIndex] || DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];
            return {
                id: typeof sourceStrip.id === 'string' && sourceStrip.id.trim() ? sourceStrip.id.trim().slice(0, 40) : `strip-${stripIndex + 1}`,
                title: typeof sourceStrip.title === 'string' && sourceStrip.title.trim() ? sourceStrip.title.trim().slice(0, 60) : `Strip ${stripIndex + 1}`,
                pens: Array.from({ length: pensPerStrip }, (_, penIndex) => (
                    sanitizeEdrPen(sourceStrip.pens?.[penIndex], stripIndex, penIndex)
                ))
            };
        })
    };
    if (options.includePresets !== false) {
        result.presets = Array.isArray(source.presets)
            ? source.presets.slice(0, 20).map((preset, index) => sanitizeEdrPreset(preset, index))
            : [];
    }
    return result;
};

const getDashboardConfig = () => {
    // Clone the default so we never mutate the shared constant by reference.
    const defaultConfig = JSON.parse(JSON.stringify(DEFAULT_DASHBOARD_CONFIG));
    let config = readJsonSync(DASHBOARD_FULL_CONFIG_FILE, null) || defaultConfig;
    config = { ...defaultConfig, ...config };

    // Migration: Enforce allowed gauges (WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and max 5
    if (config.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque', 'SPP-Bar'];
        config.gauges = config.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);

        // If empty, restore defaults
        if (config.gauges.length === 0) {
            config.gauges = DEFAULT_DASHBOARD_CONFIG.gauges;
        }
    }

    // Migration: Ensure units are 'm' for depth
    if (config.units && config.units.depth === 'ft') {
        config.units.depth = 'm';
    }

    const version = Number(config._meta?.version);
    config._meta = {
        version: Number.isFinite(version) && version > 0 ? version : 1,
        updatedAt: config._meta?.updatedAt || null,
        updatedBy: config._meta?.updatedBy || 'system',
        updatedByRole: config._meta?.updatedByRole || 'system'
    };
    config.edr = sanitizeEdrConfig(config.edr);
    config.wellInfo = sanitizeWellInfo(config.wellInfo);

    return config;
};

const saveDashboardConfig = (config) => writeJsonAtomic(DASHBOARD_FULL_CONFIG_FILE, config);

// API: Get Dashboard Layout (any authenticated user)
app.get('/api/dashboard/layout', auth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.json(getDashboardConfig());
});

// API: Save Dashboard Layout (admin)
app.post('/api/dashboard/layout', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const incomingConfig = { ...(req.body || {}) };
    delete incomingConfig._meta;
    const existingConfig = getDashboardConfig();
    const changedSections = Object.keys(incomingConfig);

    // Migration: Sanitize incoming gauges (Allow WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and limit to 5
    if (incomingConfig.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque', 'SPP-Bar'];
        incomingConfig.gauges = incomingConfig.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);
    }

    if (incomingConfig.edr) {
        incomingConfig.edr = sanitizeEdrConfig(incomingConfig.edr);
    }

    if (incomingConfig.wellInfo) {
        incomingConfig.wellInfo = sanitizeWellInfo(incomingConfig.wellInfo);
    }

    // Merge existing config with incoming updates
    const mergedConfig = {
        ...existingConfig,
        ...incomingConfig
    };
    mergedConfig.edr = sanitizeEdrConfig(mergedConfig.edr);
    mergedConfig._meta = {
        version: (Number(existingConfig._meta?.version) || 1) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user?.username || 'unknown',
        updatedByRole: req.user?.role || 'unknown'
    };

    await saveDashboardConfig(mergedConfig);
    await appendDashboardAudit({
        id: auditId(),
        ts: mergedConfig._meta.updatedAt,
        version: mergedConfig._meta.version,
        by: mergedConfig._meta.updatedBy,
        role: mergedConfig._meta.updatedByRole,
        sections: changedSections,
        summary: {
            edr: incomingConfig.edr ? {
                stripCount: mergedConfig.edr.stripCount,
                pensPerStrip: mergedConfig.edr.pensPerStrip,
                metrics: mergedConfig.edr.strips.flatMap(strip => strip.pens.map(pen => pen.metric))
            } : undefined,
            wellInfo: incomingConfig.wellInfo || undefined
        }
    });
    // Real-time broadcast
    io.emit('dashboard_layout_update', mergedConfig);
    res.json({ success: true, config: mergedConfig });
});

// API: Dashboard layout audit (admin)
app.get('/api/dashboard/audit', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    const section = typeof req.query.section === 'string' ? req.query.section : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const audit = readJsonSync(DASHBOARD_AUDIT_FILE, []);
    const rows = Array.isArray(audit) ? audit : [];
    const filtered = section ? rows.filter(row => row.sections?.includes(section)) : rows;
    res.json({ events: filtered.slice(-limit).reverse() });
});

// --- Workover: Activity / NPT ---
app.get('/api/activity/current', auth.requireAuth, (req, res) => res.json(workover.getCurrent() || {}));
app.get('/api/activity/codes', auth.requireAuth, (req, res) => res.json(workover.getCodes()));
app.get('/api/activity/log', auth.requireAuth, (req, res) => res.json(workover.getLog(req.query.date)));
app.post('/api/activity/set', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const { code, npt } = req.body || {};
        res.json({ success: true, current: workover.setActivity(code, npt) });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Workover: Alarm management ---
app.get('/api/alarms', auth.requireAuth, (req, res) => res.json(alarms.getActive()));
app.get('/api/alarms/history', auth.requireAuth, (req, res) => res.json(alarms.getHistory(Number(req.query.limit) || 200)));
app.post('/api/alarms/ack-all', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const acknowledged = alarms.ackAll(req.user.username);
    const snap = alarms.snapshot(); io.emit('alarms', snap);
    res.json({ success: true, acknowledged, ...snap });
});
app.post('/api/alarms/:id/ack', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const ok = alarms.ack(req.params.id, req.user.username);
    const snap = alarms.snapshot(); io.emit('alarms', snap);
    res.json({ success: ok, ...snap });
});
app.get('/api/alarms/config', auth.requireAuth, (req, res) => res.json(alarms.getConfig()));
app.put('/api/alarms/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, config: await alarms.setConfig(req.body) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Workover: Torque-turn / connections ---
app.get('/api/connections', auth.requireAuth, (req, res) => res.json(workover.getConnections(req.query.date)));
app.get('/api/torqueturn/current', auth.requireAuth, (req, res) => res.json(workover.getTorqueTurnLive()));

// --- Workover: Daily report ---
app.get('/api/report/daily', auth.requireAuth, (req, res) => res.json(workover.getDailyReport(req.query.date)));
app.get('/api/report/header', auth.requireAuth, (req, res) => res.json(workover.getHeader()));
app.put('/api/report/header', auth.requireAuth, auth.requireRole('admin', 'operator'), async (req, res) => {
    res.json({ success: true, header: await workover.setHeader(req.body || {}) });
});

// --- Sync agent (store-and-forward, outbound only) ---
app.get('/api/sync/status', auth.requireAuth, (req, res) => res.json(sync.getStatus()));
app.get('/api/sync/config', auth.requireAuth, (req, res) => res.json(sync.getConfig()));
app.put('/api/sync/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, config: await sync.setConfig(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/sync/flush', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    await sync.flush(); res.json({ success: true, status: sync.getStatus() });
});

// --- Edge health / data quality ---
app.get('/api/health/edge', auth.requireAuth, (req, res) => res.json(health.getEdgeHealth(latestRigData, sync.getStatus())));

// --- ETP 2.0 publisher (outbound only) ---
app.get('/api/etp/status', auth.requireAuth, (req, res) => res.json(etp.getStatus()));
app.put('/api/etp/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, status: await etp.setConfig(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Hydraulic efficiency & energy (derived, read-only) ---
app.get('/api/efficiency', auth.requireAuth, (req, res) => res.json(efficiency.getFull(latestRigData)));
app.get('/api/efficiency/config', auth.requireAuth, (req, res) => res.json(efficiency.getConfig()));
app.put('/api/efficiency/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, config: await efficiency.setConfig(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- WITSML 1.4.1 export (interoperability, export only) ---
app.get('/api/witsml/well', auth.requireAuth, (req, res) => {
    res.type('application/xml').send(witsml.wells(workover.getHeader()));
});
app.get('/api/witsml/log', auth.requireAuth, (req, res) => {
    const minutes = Math.min(60, Math.max(1, Number(req.query.minutes) || 2));
    res.type('application/xml').send(witsml.logs(workover.getHeader(), sync.getRecent(minutes * 60)));
});

// --- Variables mapping (protocol-aware sources) ---
app.get('/api/variables', auth.requireAuth, (req, res) => res.json(variables.getVariables()));
app.get('/api/variables/source-types', auth.requireAuth, (req, res) => res.json(variables.getSourceTypes()));
app.get('/api/variables/collector-config', auth.requireAuth, (req, res) => res.json(variables.getCollectorConfig()));
app.put('/api/variables', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, variables: await variables.setVariables(req.body) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/variables', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, variable: await variables.addVariable(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.delete('/api/variables/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, deleted: await variables.deleteVariable(req.params.id) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Maintenance & asset health ---
app.get('/api/maintenance/summary', auth.requireAuth, (req, res) => res.json(maintenance.getSummary(latestRigData)));
app.get('/api/maintenance/pm', auth.requireAuth, (req, res) => res.json(maintenance.getPM(latestRigData)));
app.post('/api/maintenance/pm/:id/service', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, task: maintenance.serviceTask(req.params.id, { ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/maintenance/calibrations', auth.requireAuth, (req, res) => res.json(maintenance.getCalibrations(Number(req.query.limit) || 200)));
app.post('/api/maintenance/calibrations', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    res.json({ success: true, record: maintenance.logCalibration({ ...req.body, by: req.user.username }) });
});
app.get('/api/maintenance/downtime', auth.requireAuth, (req, res) => res.json(maintenance.getDowntime(Number(req.query.limit) || 200)));
app.get('/api/maintenance/reason-codes', auth.requireAuth, (req, res) => res.json(maintenance.REASON_CODES));
app.post('/api/maintenance/downtime', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, record: maintenance.logDowntime({ ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/maintenance/downtime/:id/close', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, record: maintenance.closeDowntime(req.params.id, { by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Authentication API ---
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

// Tells the login UI which providers are available (unauthenticated).
app.get('/api/auth/info', (req, res) => res.json(ldap.info()));

// Login supports local accounts and/or Windows-domain (LDAP/AD) accounts,
// selected by AUTH_MODE (local | ldap | both). In 'both', a local account is
// tried first (break-glass admin), then the directory.
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    const mode = (process.env.AUTH_MODE || 'local').toLowerCase();

    // 1) Local authentication.
    if (mode === 'local' || mode === 'both') {
        const local = users.find(u => u.username === username && u.status !== 'inactive');
        if (local && local.password && auth.verifyPassword(password, local.password)) {
            return res.json({ success: true, token: auth.signToken(local), user: sanitizeUser(local) });
        }
        if (mode === 'local') {
            return res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
        }
    }

    // 2) Windows domain (LDAP/Active Directory) authentication.
    if ((mode === 'ldap' || mode === 'both') && ldap.ldapEnabled()) {
        try {
            const dir = await ldap.authenticate(username, password);
            const u = await upsertLdapUser(dir);
            if (!u) return res.status(403).json({ success: false, message: 'Account disabled' });
            return res.json({ success: true, token: auth.signToken(u), user: sanitizeUser(u) });
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Invalid domain credentials' });
        }
    }

    return res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
});

// --- Error handling, startup & graceful shutdown ---------------------------
// Catch-all error middleware so a thrown error in any handler returns JSON
// instead of crashing or leaking a stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('Unhandled error:', err.message);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

server.listen(PORT, () => {
    console.log(`ROM-II backend listening on port ${PORT} (data source: ${DATA_SOURCE})`);
    scheduleNextPoll();
});

// Periodically flush drilling state off the hot loop.
const flushTimer = setInterval(flushDrillingState, Number(process.env.STATE_FLUSH_MS || 5000));

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    pollStopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(flushTimer);
    try { await flushDrillingState(); } catch (e) { /* best effort */ }
    io.close();
    server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref(); // hard cap
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
