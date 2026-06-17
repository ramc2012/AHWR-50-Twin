'use strict';
// =====================================================================
// CRMF — Centralised Rig Monitoring Facility — backend
// Ingestion endpoint (edge store-and-forward) + fleet portal API + live updates.
//
// MONITORING-ONLY: this service only ever RECEIVES data from rig-edge systems.
// There is no path from here back to any rig or PLC, by design.
//
// API VERSIONING (audit #30): the fleet API is mounted at BOTH /api (the
// existing, unversioned default — kept working) and /api/v1 (the versioned alias
// external integrators should target). Both prefixes share the exact same
// handlers; bump to /api/v2 alongside /api when a breaking change lands.
// =====================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { waitForDb, query, pool } = require('./lib/db');
const { seedAll } = require('./lib/seed');
const auth = require('./lib/auth');
const fleet = require('./lib/fleet');
const gov = require('./lib/governance');
const maint = require('./lib/maintenance');
const users = require('./lib/users');
const audit = require('./lib/audit');
const { ingestBatch } = require('./lib/ingest');
const { TAGS } = require('./lib/tags');
const metrics = require('./lib/metrics');
const kafka = require('./lib/kafka');
const notify = require('./lib/notify');

const PORT = Number(process.env.PORT || 6000);
const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false'; // default ON
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';           // optional bearer guard (#15)
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 10_000);

// --------------------------------------------------------------------
// CORS allowlist (audit #16): default CLOSED. Only origins in CORS_ORIGIN
// (comma-separated) are allowed. In dev (NODE_ENV !== 'production') a missing
// CORS_ORIGIN falls back to reflecting localhost origins only — never '|| true'.
// --------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === 'production';
const CORS_ALLOWLIST = (process.env.CORS_ORIGIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
    // Non-browser clients (no Origin header) are always allowed (e.g. the edge,
    // curl, server-to-server). The allowlist only constrains browser origins.
    if (!origin) return true;
    if (CORS_ALLOWLIST.length) return CORS_ALLOWLIST.includes(origin);
    if (!IS_PROD) return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return false; // prod with no allowlist => closed
}

const corsOptions = {
    origin(origin, cb) {
        if (isAllowedOrigin(origin)) return cb(null, true);
        return cb(null, false); // deny without throwing (no CORS headers added)
    },
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin(origin, cb) { cb(null, isAllowedOrigin(origin)); },
    },
});
io.use(auth.socketAuth);
io.on('connection', (socket) => {
    fleet.getFleetSummary().then((s) => socket.emit('fleet_summary', s)).catch(() => {});
});

// --------------------------------------------------------------------
// INGEST — accepts gzipped store-and-forward batches from the edge sync agent.
// Body is read raw (optionally gzip) and parsed here; same contract as the edge
// publisher in backend/lib/sync.js. Generous limit + lenient rate limit (rigs only).
// --------------------------------------------------------------------
const ingestLimiter = rateLimit({ windowMs: 60_000, max: 6000, standardHeaders: true, legacyHeaders: false });

// body-parser auto-inflates Content-Encoding: gzip (the edge sets it). The magic-byte
// fallback covers any client whose body still arrives gzipped.
app.post('/ingest', ingestLimiter, express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const elapsedSec = () => Number(process.hrtime.bigint() - startedAt) / 1e9;
    try {
        let buf = req.body;
        if (Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            try { buf = zlib.gunzipSync(buf); } catch { metrics.observeIngest({ ok: false, durationSec: elapsedSec() }); return res.status(400).json({ error: 'bad gzip' }); }
        }
        let batch;
        try { batch = JSON.parse(buf.toString('utf8')); } catch { metrics.observeIngest({ ok: false, durationSec: elapsedSec() }); return res.status(400).json({ error: 'bad json' }); }

        const rigId = batch.deviceId || req.headers['x-device-id'] || null;
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        const schemaVersion = req.headers['x-schema-version'] || batch.schemaVersion;

        const result = await ingestBatch({ rigId, token, schemaVersion }, batch);
        if (!result.ok) {
            metrics.observeIngest({ ok: false, durationSec: elapsedSec() });
            // Never echo raw PG errors to the untrusted caller (audit #11); log
            // full detail server-side. result.error is already a generic message.
            if (result.code === 500 && result.detail) {
                console.error('[ingest] server error:', result.detail);
            }
            return res.status(result.code || 400).json({ error: result.error });
        }

        metrics.observeIngest({ ok: true, durationSec: elapsedSec(), points: result.points, events: result.events });

        // Fan out to Kafka (no-op unless KAFKA_ENABLED; never throws into this path).
        kafka.publishBatch(result.rigId, batch);
        if (Array.isArray(batch.events)) {
            for (const ev of batch.events) kafka.publishEvent(result.rigId, ev);
        }

        // Push a live fleet delta to portal clients (best effort), and dispatch any
        // rising-edge alarm notification (webhook/email; no-op unless NOTIFY_ENABLED).
        fleet.getFleetRow(result.rigId).then((row) => {
            if (row) io.emit('fleet_update', row);
            if (result.alarmTransition) {
                notify.maybeNotify(result.rigId, result.alarmTransition,
                    { name: row && row.name, field: row && row.field });
            }
        }).catch(() => {
            if (result.alarmTransition) notify.maybeNotify(result.rigId, result.alarmTransition, {});
        });
        if (Array.isArray(batch.events) && batch.events.some((e) => e && e.type === 'alarm')) {
            io.emit('alarm_update', { rigId: result.rigId });
        }

        res.json({ ack: true, seq: result.seq, receivedPoints: result.points, receivedEvents: result.events, duplicate: result.duplicate || undefined });
    } catch (e) {
        metrics.observeIngest({ ok: false, durationSec: elapsedSec() });
        console.error('[ingest] unexpected error:', e.message);
        res.status(500).json({ error: 'ingest failed' });
    }
});

// --------------------------------------------------------------------
// Metrics (Prometheus) — default ON; disable with METRICS_ENABLED=false.
// Guarded by METRICS_TOKEN when set (audit #15): a configured token is required
// as a bearer; with no token configured it stays open (document: scrape
// internally in K8s via a ServiceMonitor, never on the public ingress).
// --------------------------------------------------------------------
if (METRICS_ENABLED) {
    app.get('/metrics', async (req, res) => {
        if (METRICS_TOKEN) {
            const hdr = req.headers.authorization || '';
            const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
            if (tok !== METRICS_TOKEN) return res.status(401).end('unauthorized');
        }
        try {
            res.setHeader('Content-Type', metrics.registry.contentType);
            res.end(await metrics.registry.metrics());
        } catch (e) {
            res.status(500).end(e.message);
        }
    });
}

// --------------------------------------------------------------------
// Health / liveness split (audit #10)
//   /livez  -> process liveness, NO DB call (Kubernetes livenessProbe)
//   /healthz-> readiness, SELECT 1   (Kubernetes readinessProbe)
// --------------------------------------------------------------------
app.get('/livez', (_req, res) => res.json({ ok: true }));
app.get('/healthz', async (_req, res) => {
    try { await query('SELECT 1'); res.json({ ok: true, service: 'crmf-backend' }); }
    catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// --------------------------------------------------------------------
// OpenAPI document (audit #30) — auth-exempt, served from the static file.
// --------------------------------------------------------------------
let OPENAPI_DOC = null;
try {
    OPENAPI_DOC = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
} catch (e) {
    console.error('[openapi] failed to load openapi.json:', e.message);
}
const serveOpenapi = (_req, res) => {
    if (!OPENAPI_DOC) return res.status(500).json({ error: 'openapi document unavailable' });
    res.json(OPENAPI_DOC);
};
app.get('/api/openapi.json', serveOpenapi);
app.get('/api/v1/openapi.json', serveOpenapi);

// --------------------------------------------------------------------
// Auth (proposal §6.5)
// --------------------------------------------------------------------
const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
// Stricter, dedicated limiter on login (audit #13): cap brute-force attempts.
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

const jsonBody = express.json({ limit: '1mb' });

// Build the shared API router. Mounted at both /api and /api/v1 (audit #30).
function buildApiRouter() {
    const r = express.Router();
    r.use(apiLimiter, jsonBody);

    // ----- Auth (auth-exempt: login + me handle their own auth) -----
    r.post('/auth/login', loginLimiter, async (req, res) => {
        const { username, password } = req.body || {};
        const result = await auth.login(username, password);
        if (!result) {
            // Audit failed logins (audit #14). Log the attempt; never the password.
            await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                [username || 'unknown', 'login.failed', 'portal', { ip: req.ip }]).catch(() => {});
            console.warn(`[auth] failed login for "${username || 'unknown'}" from ${req.ip}`);
            return res.status(401).json({ error: 'invalid credentials' });
        }
        await query('INSERT INTO audit_log (actor, action, target) VALUES ($1,$2,$3)',
            [username, 'login', 'portal']).catch(() => {});
        res.json(result);
    });
    r.get('/auth/me', auth.requireAuth, (req, res) => res.json({ user: req.user }));

    // ----- Everything below requires auth -----
    r.use(auth.requireAuth);

    // wrap honours e.status (audit #24) instead of always 500.
    const wrap = (fn) => async (req, res) => {
        try { res.json(await fn(req)); }
        catch (e) {
            const status = e.status || 500;
            if (status >= 500) console.error('[api] error:', e.message);
            res.status(status).json({ error: e.message });
        }
    };

    // requireRole that also audits 403 denials (audit #14).
    const requireRoleAudited = (min) => (req, res, next) => {
        if (!req.user || !auth.roleMeets(req.user.role, min)) {
            query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                [req.user?.username || 'unknown', 'rbac.denied', `${req.method} ${req.originalUrl}`, { required: min }]).catch(() => {});
            return res.status(403).json({ error: 'forbidden' });
        }
        next();
    };

    // ----- Fleet -----
    r.get('/fleet', wrap(() => fleet.getFleet()));
    r.get('/fleet/summary', wrap(() => fleet.getFleetSummary()));
    r.get('/rigs/:id', wrap(async (req) => {
        const rig = await fleet.getRig(req.params.id);
        if (!rig) throw Object.assign(new Error('rig not found'), { status: 404 });
        return rig;
    }));
    r.get('/rigs/:id/history', wrap((req) =>
        fleet.getHistory(req.params.id, req.query.metric, req.query.minutes)));
    r.get('/alarms', wrap((req) => fleet.getAlarms({ priority: req.query.priority })));
    r.get('/data-quality', wrap(() => fleet.getDataQuality()));
    r.get('/workover', wrap((req) => gov.getWorkover({ hours: req.query.hours })));

    // ----- Governance & rollout workspace -----
    r.get('/governance', wrap(() => gov.getGovernance()));
    r.patch('/governance/deployment/:rigId', requireRoleAudited('operator'),
        wrap((req) => gov.updateDeployment(req.params.rigId, req.body, req.user.username)));
    r.post('/governance/escalations', requireRoleAudited('operator'),
        wrap((req) => gov.addEscalation(req.body, req.user.username)));
    r.patch('/governance/escalations/:id', requireRoleAudited('operator'),
        wrap((req) => gov.updateEscalation(req.params.id, req.body, req.user.username)));
    r.post('/governance/decisions', requireRoleAudited('operator'),
        wrap((req) => gov.addDecision(req.body, req.user.username)));

    // ----- Maintenance & Reliability (audit #7) -----
    r.get('/maintenance', wrap((req) =>
        maint.listMaintenance({ rigId: req.query.rigId, status: req.query.status })));
    r.get('/maintenance/summary', wrap(() => maint.maintenanceSummary()));
    r.post('/maintenance', requireRoleAudited('operator'),
        wrap((req) => maint.addMaintenance(req.body, req.user.username)));
    r.patch('/maintenance/:id', requireRoleAudited('operator'),
        wrap((req) => maint.updateMaintenance(req.params.id, req.body, req.user.username)));

    // ----- User & Access Management (audit #8, admin-only) -----
    r.get('/users', requireRoleAudited('admin'), wrap(() => users.listUsers()));
    r.post('/users', requireRoleAudited('admin'),
        wrap((req) => users.createUser(req.body, req.user.username)));
    r.patch('/users/:username', requireRoleAudited('admin'),
        wrap((req) => users.updateUser(req.params.username, req.body, req.user.username)));
    r.delete('/users/:username', requireRoleAudited('admin'),
        wrap((req) => users.deleteUser(req.params.username, req.user.username)));

    // ----- Audit trail (audit #2, admin-only, paginated) -----
    r.get('/audit', requireRoleAudited('admin'), wrap((req) =>
        audit.listAudit({
            limit: req.query.limit, offset: req.query.offset,
            action: req.query.action, actor: req.query.actor,
        })));

    // ----- Alarm notifications (webhook/email; proposal §6.1 escalation) -----
    r.get('/notifications', wrap((req) => notify.getNotifications(req.query.limit)));
    r.get('/notifications/channels', wrap(() => notify.getChannels()));
    r.post('/notifications/channels', requireRoleAudited('admin'),
        wrap((req) => notify.addChannel(req.body, req.user.username)));
    r.patch('/notifications/channels/:id', requireRoleAudited('admin'),
        wrap((req) => notify.updateChannel(req.params.id, req.body, req.user.username)));
    r.delete('/notifications/channels/:id', requireRoleAudited('admin'),
        wrap((req) => notify.deleteChannel(req.params.id, req.user.username)));
    r.post('/notifications/channels/:id/test', requireRoleAudited('admin'),
        wrap((req) => notify.sendTest(req.params.id, req.user.username)));

    // ----- Config registry (proposal §6.1) -----
    r.get('/config/tags', wrap(() => TAGS));
    r.get('/config/rigs', wrap(async () => (await query(
        'SELECT rig_id, name, section, field, latitude, longitude, commissioned_at, schema_version FROM rigs ORDER BY rig_id')).rows));

    // ----- Reporting (proposal §6.1) — JSON (period-aware, audit #29) + CSV -----
    r.get('/reports/fleet', wrap((req) => gov.getFleetReportPeriod(req.query.period)));
    r.get('/reports/fleet.csv', async (_req, res) => {
        try {
            const rows = await gov.getFleetReport();
            const cols = ['rig_id', 'name', 'field', 'status', 'health_score', 'metric_count', 'last_data_at', 'active_activity', 'alarm_active', 'alarm_p1', 'gate', 'adoption_pct', 'commissioning'];
            const csv = [cols.join(',')].concat(rows.map((row) => cols.map((c) => {
                const v = row[c] == null ? '' : String(row[c]).replace(/"/g, '""');
                return /[",\n]/.test(v) ? `"${v}"` : v;
            }).join(','))).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="crmf-fleet-report.csv"');
            res.send(csv);
        } catch (e) { console.error('[reports] csv error:', e.message); res.status(500).json({ error: 'report failed' }); }
    });

    return r;
}

// Mount the same router at the unversioned default and the versioned alias.
app.use('/api/v1', buildApiRouter());
app.use('/api', buildApiRouter());

// --------------------------------------------------------------------
// Boot + graceful shutdown (audit #9)
// --------------------------------------------------------------------
let summaryTimer = null;
let sweepTimer = null;
let shuttingDown = false;

async function main() {
    await waitForDb();
    await seedAll();

    // Offline sweeper: flip rigs to offline once their data ages out, push deltas.
    sweepTimer = setInterval(async () => {
        try {
            const flipped = await fleet.sweepOffline();
            for (const id of flipped) {
                const row = await fleet.getFleetRow(id);
                if (row) io.emit('fleet_update', row);
            }
            if (flipped.length) io.emit('fleet_summary', await fleet.getFleetSummary());
        } catch (e) { /* ignore */ }
    }, 15_000);

    // Periodic summary heartbeat so KPI cards stay live even on a quiet fleet.
    // Also mirror the summary into the Prometheus fleet gauges.
    summaryTimer = setInterval(async () => {
        try {
            const summary = await fleet.getFleetSummary();
            io.emit('fleet_summary', summary);
            metrics.setFleetGauges(summary);
        } catch { /* ignore */ }
    }, 10_000);

    // Bring up the optional Kafka producer (no-op unless KAFKA_ENABLED=true).
    await kafka.start().catch((e) => console.error('[kafka] start error:', e.message));

    server.listen(PORT, () => console.log(`CRMF backend listening on :${PORT} (monitoring-only)`));
}

// Graceful shutdown (audit #9): stop timers, drain HTTP, close sockets, flush
// Kafka, end the pg pool, then exit. Bounded by a drain timeout.
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining…`);

    if (sweepTimer) clearInterval(sweepTimer);
    if (summaryTimer) clearInterval(summaryTimer);

    const drainTimer = setTimeout(() => {
        console.error('[shutdown] drain timeout exceeded, forcing exit');
        process.exit(1);
    }, SHUTDOWN_DRAIN_MS);
    drainTimer.unref();

    try {
        await new Promise((resolve) => server.close(resolve)); // stop accepting new connections
        try { io.close(); } catch { /* ignore */ }
        await kafka.stop().catch(() => {});
        await pool.end().catch(() => {});
        clearTimeout(drainTimer);
        console.log('[shutdown] clean exit');
        process.exit(0);
    } catch (e) {
        console.error('[shutdown] error during drain:', e.message);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

main().catch((e) => { console.error('CRMF backend failed to start:', e); process.exit(1); });
