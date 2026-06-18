'use strict';
// Configurable platform settings (proposal §6.5): storage retention, telemetry
// update rate, offline threshold, and the central latency target. Persisted in
// app_settings (key/value JSONB), falling back to compiled defaults. Mutations are
// admin-only at the route layer, audit-logged here, and APPLIED live where possible
// (retention policies on the hypertables; the in-memory offline sweeper threshold).
const { query } = require('./db');
const fleet = require('./fleet');

// Defaults match the contract. retention_days -> 5 years; update_rate is advisory
// (the edge sets its own publish cadence); offline_sec & latency target drive the
// fleet view's online/lag classification.
const DEFAULTS = {
    retention_days: 1825,
    update_rate_sec: 5,
    offline_sec: 120,
    central_latency_target: 30,
};

// Bounds so a fat-fingered PATCH can't disable retention or stall the sweeper.
const BOUNDS = {
    retention_days: [1, 36500],         // up to 100 years
    update_rate_sec: [1, 3600],
    offline_sec: [10, 86400],
    central_latency_target: [1, 3600],
};

const KEY = 'platform';

function clampInt(name, v, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    const [lo, hi] = BOUNDS[name];
    return Math.min(Math.max(n, lo), hi);
}

// Read the merged settings: persisted overrides on top of the defaults.
async function getSettings() {
    let stored = {};
    try {
        const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
        if (rows[0] && rows[0].value && typeof rows[0].value === 'object') stored = rows[0].value;
    } catch { /* table not present yet / DB hiccup -> fall back to defaults */ }
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (stored[k] != null) out[k] = clampInt(k, stored[k], DEFAULTS[k]);
    }
    return out;
}

// Re-apply the TimescaleDB retention policy on the time-series hypertables. Each
// is wrapped independently so one failure (e.g. a hypertable not present yet) does
// not abort the rest. if_not_exists=>false replaces the existing policy in place.
async function applyRetention(days) {
    const interval = `${days} days`;
    for (const tbl of ['telemetry', 'events', 'connections']) {
        try {
            await query(
                "SELECT remove_retention_policy($1, if_not_exists => true)", [tbl]);
            await query(
                "SELECT add_retention_policy($1, ($2)::interval, if_not_exists => false)",
                [tbl, interval]);
        } catch (e) {
            console.warn(`[settings] retention policy on ${tbl} not applied: ${e.message}`);
        }
    }
}

// Persist a subset of settings, audit-log it, and APPLY the side effects. Only
// the four known keys are accepted; everything else is ignored. `actor` is the
// authenticated admin username.
async function setSettings(patch, actor) {
    const p = patch || {};
    const current = await getSettings();
    const next = { ...current };
    const changed = {};

    for (const k of Object.keys(DEFAULTS)) {
        if (k in p && p[k] != null) {
            const v = clampInt(k, p[k], current[k]);
            if (v !== current[k]) changed[k] = v;
            next[k] = v;
        }
    }

    // Upsert the full merged object (so app_settings always holds a complete set).
    await query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [KEY, JSON.stringify(next), actor || 'system']);

    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'settings.update', KEY, changed]).catch(() => {});

    // Apply side effects only for keys that actually changed.
    if ('retention_days' in changed) await applyRetention(changed.retention_days);
    if ('offline_sec' in changed && typeof fleet.setOfflineSec === 'function') {
        fleet.setOfflineSec(changed.offline_sec);
    }

    return next;
}

// Seed the defaults row at boot if app_settings has no platform entry yet, so the
// settings screen renders the real defaults on a brand-new database.
async function seedDefaults() {
    try {
        await query(
            `INSERT INTO app_settings (key, value, updated_by)
             VALUES ($1, $2::jsonb, 'system')
             ON CONFLICT (key) DO NOTHING`,
            [KEY, JSON.stringify(DEFAULTS)]);
        // Bring the live offline threshold in line with whatever is persisted.
        const s = await getSettings();
        if (typeof fleet.setOfflineSec === 'function') fleet.setOfflineSec(s.offline_sec);
    } catch (e) {
        console.warn('[settings] seedDefaults skipped:', e.message);
    }
}

module.exports = { DEFAULTS, getSettings, setSettings, seedDefaults, applyRetention };
