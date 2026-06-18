'use strict';
// Central ingestion (proposal §6.3). Accepts store-and-forward batches from the
// rig-edge sync agent (backend/lib/sync.js) in their native contract:
//
//   { seq, deviceId, schemaVersion, createdAt,
//     channels: [{ ts, values: { "measurement.field": number } }],
//     events:   [{ ts, type, payload }] }
//
// Writes telemetry to the TimescaleDB hypertable, events/connections to their
// tables, refreshes the last-value cache, and recomputes the per-rig
// data-quality health score. MONITORING-ONLY: nothing is ever sent back to a rig.
const { pool, query } = require('./db');
const { EXPECTED_METRICS } = require('./tags');
const { computeHealth } = require('./fleet');

const GLOBAL_INGEST_TOKEN = process.env.INGEST_TOKEN || '';
// Open-demo escape hatch (audit #1): only honoured in non-production and never
// in production. When no device_token and no INGEST_TOKEN are configured, ingest
// stays FAIL-CLOSED unless this is explicitly set.
const ALLOW_OPEN_INGEST =
    process.env.ALLOW_OPEN_INGEST === 'true' && process.env.NODE_ENV !== 'production';

// Reserved key inside rig_latest.values that carries a per-tag last-seen map
// ({ metric: tsIso }) so fleet.getRig can surface per-field staleness (audit #22)
// without a schema change to rig_latest.
const TS_KEY = '__ts';

// Coerce an untrusted timestamp to a canonical ISO instant, or null if unusable
// (audit #11/#32). Accepts ISO strings and epoch-ms numbers; compares numerically.
function coerceTsIso(raw) {
    if (raw == null) return null;
    let ms;
    if (typeof raw === 'number') ms = raw;
    else ms = Date.parse(String(raw));
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}

// Numeric instant for a snapshot (NaN-safe), used to pick the latest snapshot.
function tsMillis(raw) {
    if (raw == null) return NaN;
    if (typeof raw === 'number') return raw;
    return Date.parse(String(raw));
}

// Auto-register an unknown device as a pending rig so onboarding is visible in
// the governance workspace (proposal §6.1 "adoption progress per rig"). Only
// called for already-authorized devices (audit #1).
async function ensureRig(client, rigId, token, schemaVersion) {
    const { rows } = await client.query(
        'SELECT rig_id, device_token, last_seq FROM rigs WHERE rig_id = $1', [rigId]);
    if (rows.length) return { ...rows[0], _new: false };
    await client.query(
        `INSERT INTO rigs (rig_id, name, status, device_token, schema_version, field)
         VALUES ($1, $2, 'pending', $3, $4, 'Ankleshwar')
         ON CONFLICT (rig_id) DO NOTHING`,
        [rigId, rigId, token || null, schemaVersion || null]
    );
    await client.query('INSERT INTO deployment_status (rig_id, gate, commissioning) VALUES ($1, $2, $3) ON CONFLICT (rig_id) DO NOTHING',
        [rigId, 'discovery', 'in_progress']);
    return { rig_id: rigId, device_token: token || null, last_seq: null, _new: true };
}

// Fail-closed authorization (audit #1). Accept a batch ONLY if the bearer token
// matches a per-rig device_token OR the global INGEST_TOKEN. If neither is
// configured anywhere, REJECT unless ALLOW_OPEN_INGEST is set (and not prod).
function authorize(rig, token) {
    if (rig && rig.device_token) return token === rig.device_token;
    if (GLOBAL_INGEST_TOKEN) return token === GLOBAL_INGEST_TOKEN;
    return ALLOW_OPEN_INGEST; // fail-closed by default; open only when explicitly allowed
}

// Decide whether this device is allowed to ingest WITHOUT auto-registering an
// unknown rig first (audit #1: only auto-register authorized devices). When a
// device_token has been provisioned for an existing rig, that wins; otherwise we
// fall back to the global INGEST_TOKEN / open-demo policy.
function authorizeKnown(rig, token) {
    if (rig && rig.device_token) return token === rig.device_token;
    if (GLOBAL_INGEST_TOKEN) return token === GLOBAL_INGEST_TOKEN;
    return ALLOW_OPEN_INGEST;
}

// Bulk-insert telemetry rows with a single UNNEST'd statement. Idempotent on
// replay via ON CONFLICT DO NOTHING keyed on (rig_id, metric, ts) — the SCHEMA
// agent provides the matching unique index (audit #4).
async function insertTelemetry(client, rigId, channels) {
    const ts = [], metric = [], value = [];
    for (const snap of channels) {
        if (!snap || !snap.values) continue;
        // Bad/missing channel ts -> use now() (skip-bad-channel semantics: we keep
        // the channel but stamp it now rather than failing the batch). (audit #11)
        const t = coerceTsIso(snap.ts) || new Date().toISOString();
        for (const [m, v] of Object.entries(snap.values)) {
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            ts.push(t); metric.push(m); value.push(n);
        }
    }
    if (!ts.length) return 0;
    await client.query(
        `INSERT INTO telemetry (ts, rig_id, metric, value)
         SELECT u.ts, $2, u.metric, u.value
         FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)
         ON CONFLICT (rig_id, metric, ts) DO NOTHING`,
        [ts, rigId, metric, value]
    );
    return ts.length;
}

// Latest snapshot wins; merge over the existing cache so a partial batch never
// wipes previously-seen tags. Compares ts NUMERICALLY (audit #32).
function latestSnapshot(channels) {
    let best = null, bestMs = -Infinity;
    for (const snap of channels || []) {
        if (!snap || !snap.values) continue;
        const ms = tsMillis(snap.ts);
        const m = Number.isFinite(ms) ? ms : -Infinity;
        if (!best || m >= bestMs) { best = snap; bestMs = m; }
    }
    return best;
}

async function processEvents(client, rigId, events) {
    let alarmCounts = null;
    let activity = null;
    for (const ev of events || []) {
        if (!ev || !ev.type) continue;
        const ts = coerceTsIso(ev.ts) || new Date().toISOString();
        // Idempotent on replay (audit #4): a dedup unique index on
        // (rig_id, ts, type, payload) lets a re-sent batch insert nothing twice.
        await client.query(
            `INSERT INTO events (ts, rig_id, type, payload) VALUES ($1,$2,$3,$4)
             ON CONFLICT DO NOTHING`,
            [ts, rigId, ev.type, ev.payload || {}]);
        if (ev.type === 'alarm') {
            alarmCounts = ev.payload || {};
        } else if (ev.type === 'connection') {
            const p = ev.payload || {};
            await client.query(
                `INSERT INTO connections (ts, rig_id, peak_torque, result, joint, payload)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT DO NOTHING`,
                [ts, rigId, p.peakTorque ?? p.peak_torque ?? null, p.result || null,
                 p.joint ?? p.jointCount ?? null, p]
            );
        } else if (ev.type === 'activity') {
            activity = ev.payload || {};
        }
    }
    return { alarmCounts, activity };
}

// Cheap provenance audit on rig auto-registration / accepted ingest (audit #14).
// Sampled: only on first-register (registered=true) so the trail records the
// device/rigId/seq binding without one row per batch. Never throws into ingest.
async function auditProvenance(client, { rigId, token, seq, registered }) {
    if (!registered) return;
    try {
        const device = token ? `token:${String(token).slice(0, 6)}…` : 'anonymous';
        await client.query(
            'INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
            ['ingest', 'rig.autoregister', rigId, { device, rigId, seq: seq ?? null }]);
    } catch { /* never block ingest on audit */ }
}

// Main entry. `rigId`/`token` are extracted from headers/body by the caller.
async function ingestBatch({ rigId, token, schemaVersion }, batch) {
    rigId = batch.deviceId || rigId;
    if (!rigId) return { ok: false, code: 400, error: 'missing deviceId' };

    // Coerce seq to a safe integer or null up front (audit #11) — never bind a
    // raw untrusted value into the BIGINT last_seq column.
    const seq = Number.isSafeInteger(Number(batch.seq)) ? Number(batch.seq) : null;

    const channels = Array.isArray(batch.channels) ? batch.channels : [];
    const events = Array.isArray(batch.events) ? batch.events : [];

    const client = await pool.connect();
    let points = 0;
    let registered = false;
    let alarmTransition = null;   // rising-edge info for the notification dispatcher
    let activeJob = null;         // job/well this batch is working (for well-run tracking)
    try {
        await client.query('BEGIN');

        // Look up the rig WITHOUT creating it, so an unauthorized unknown device
        // cannot auto-enroll a fake rig (audit #1).
        const { rows: existing } = await client.query(
            `SELECT rig_id, device_token, last_seq, alarm_active, alarm_p1, alarm_highest, active_job
             FROM rigs WHERE rig_id = $1`, [rigId]);
        let rig = existing[0] || null;

        if (!authorizeKnown(rig, token)) {
            await client.query('ROLLBACK').catch(() => {});
            return { ok: false, code: 401, error: 'unauthorized device' };
        }

        // Authorized: now it is safe to auto-register an unknown device.
        if (!rig) {
            const r = await ensureRig(client, rigId, token, schemaVersion || batch.schemaVersion);
            rig = r;
            registered = !!r._new;
        }

        // Replay idempotency fast-path (audit #4): reject batches whose seq is not
        // newer than the last accepted seq, read in this same transaction. A null
        // incoming seq is treated as always-accept (legacy/uncounted senders).
        const lastSeq = rig && rig.last_seq != null ? Number(rig.last_seq) : null;
        if (seq != null && lastSeq != null && seq <= lastSeq) {
            await client.query('ROLLBACK').catch(() => {});
            return { ok: true, rigId, points: 0, events: 0, seq, duplicate: true };
        }

        points = await insertTelemetry(client, rigId, channels);

        const snap = latestSnapshot(channels);
        if (snap) {
            // Per-tag last-seen map (audit #22): stamp each metric with this
            // snapshot's ts under the reserved __ts key, merged into the cache.
            const snapTsIso = coerceTsIso(snap.ts) || new Date().toISOString();
            const tsMap = {};
            for (const m of Object.keys(snap.values)) tsMap[m] = snapTsIso;
            // Insert values already carrying the reserved __ts map so per-tag age is
            // available from the very first batch (audit #22); on conflict, merge
            // both the values and the __ts map so a frozen tag keeps its old ts.
            const insertValues = { ...snap.values, [TS_KEY]: tsMap };
            await client.query(
                `INSERT INTO rig_latest (rig_id, ts, values)
                 VALUES ($1, $2, $3::jsonb)
                 ON CONFLICT (rig_id) DO UPDATE
                   SET ts = EXCLUDED.ts,
                       values = (rig_latest.values || EXCLUDED.values)
                                 || jsonb_build_object($4::text,
                                      COALESCE(rig_latest.values->$4, '{}'::jsonb) || $5::jsonb)`,
                [rigId, snapTsIso, JSON.stringify(insertValues), TS_KEY, JSON.stringify(tsMap)]
            );
        }

        const { alarmCounts, activity } = await processEvents(client, rigId, events);

        // Alarm rising-edge (for notifications, dispatched post-commit by the caller).
        if (alarmCounts) {
            alarmTransition = {
                prev: {
                    active: Number(rig && rig.alarm_active) || 0,
                    p1: Number(rig && rig.alarm_p1) || 0,
                    highest: (rig && rig.alarm_highest) || null,
                },
                next: {
                    active: alarmCounts.active ?? 0, p1: alarmCounts.p1 ?? 0,
                    p2: alarmCounts.p2 ?? 0, p3: alarmCounts.p3 ?? 0,
                    highest: alarmCounts.highest ?? null,
                },
            };
        }

        // --- Data-quality health (proposal §6.1 data quality monitor) ---
        const latestMs = snap ? tsMillis(snap.ts) : NaN;
        const createdMs = tsMillis(batch.createdAt);
        const latestTs = Number.isFinite(latestMs) ? latestMs
            : (Number.isFinite(createdMs) ? createdMs : Date.now());
        const presentMetrics = snap ? Object.keys(snap.values) : [];
        const health = computeHealth({ latestTs, presentMetrics });

        // Compose rollup update (only overwrite alarm/activity when this batch carried them).
        const sets = [
            'last_data_at = $2', 'last_seq = $3', 'schema_version = $4',
            'sync_lag_sec = $5', 'health_score = $6', 'metric_count = $7',
            'status = $8', 'updated_at = now()',
        ];
        // last_seq only advances (never regress on an out-of-order legacy null).
        const newLastSeq = seq != null ? seq : (lastSeq != null ? lastSeq : null);
        const vals = [rigId, new Date(latestTs).toISOString(), newLastSeq,
            batch.schemaVersion || null, health.syncLagSec, health.score,
            presentMetrics.length, health.status];
        let i = vals.length;
        if (alarmCounts) {
            sets.push(`alarm_active = $${++i}`); vals.push(alarmCounts.active ?? 0);
            sets.push(`alarm_unack = $${++i}`);  vals.push(alarmCounts.unack ?? 0);
            sets.push(`alarm_p1 = $${++i}`);     vals.push(alarmCounts.p1 ?? 0);
            sets.push(`alarm_p2 = $${++i}`);     vals.push(alarmCounts.p2 ?? 0);
            sets.push(`alarm_p3 = $${++i}`);     vals.push(alarmCounts.p3 ?? 0);
            sets.push(`alarm_highest = $${++i}`); vals.push(alarmCounts.highest ?? null);
        }
        if (activity) {
            if (activity.phase || activity.activity) { sets.push(`active_activity = $${++i}`); vals.push(activity.phase || activity.activity); }
            if (activity.job) { sets.push(`active_job = $${++i}`); vals.push(activity.job); activeJob = String(activity.job); }
        }
        // Resolve the job for well-run tracking: the activity payload's job wins;
        // otherwise fall back to whatever active_job the rig already has on record.
        if (!activeJob) {
            activeJob = (rig && rig.active_job) ? String(rig.active_job) : null;
        }
        await client.query(`UPDATE rigs SET ${sets.join(', ')} WHERE rig_id = $1`, vals);

        await auditProvenance(client, { rigId, token, seq, registered });

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // Surface a tagged error so server.js can log full detail server-side and
        // return a generic message to the untrusted caller (audit #11).
        return { ok: false, code: 500, error: 'ingest failed', detail: e.message };
    } finally {
        client.release();
    }

    return { ok: true, rigId, points, events: events.length, seq, alarmTransition, activeJob };
}

module.exports = { ingestBatch, EXPECTED_METRICS };
