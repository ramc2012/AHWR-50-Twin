'use strict';
// Admin-editable Active Directory / LDAP settings (DC information-request sheet
// D8-D17). That sheet marks AD "needed at commissioning, not at installation" —
// env vars in secrets.env only seed the boot-time default; an admin can then turn
// AD on, or edit the group-to-role mapping, from Settings > Authentication with NO
// redeploy, no VM access and no container restart: ldap.reload() (called from
// setAuthSettings below) makes the change take effect on the very next login
// attempt. Persisted in the same app_settings key/value table lib/settings.js uses.
const { query } = require('./db');
const ldap = require('./ldap');

const KEY = 'auth';
const MODES = ['local', 'ldap', 'both'];
const ROLES = ['admin', 'operator', 'viewer'];

// Env-seeded defaults — the exact fields ldap.js's boot-time cfg already reads
// from process.env, so a fresh install behaves identically whether or not
// anyone has ever opened the Settings page.
function envDefaults() {
    return {
        mode: (process.env.AUTH_MODE || 'local').toLowerCase(),
        url: process.env.LDAP_URL || '',
        bindDN: process.env.LDAP_BIND_DN || '',
        bindPassword: process.env.LDAP_BIND_PASSWORD || '',
        searchBase: process.env.LDAP_SEARCH_BASE || '',
        searchFilter: process.env.LDAP_SEARCH_FILTER || '',
        domain: process.env.LDAP_DOMAIN || '',
        defaultRole: (process.env.LDAP_DEFAULT_ROLE || 'viewer').toLowerCase(),
        roleAdmin: process.env.LDAP_ROLE_ADMIN || '',
        roleOperator: process.env.LDAP_ROLE_OPERATOR || '',
        roleViewer: process.env.LDAP_ROLE_VIEWER || '',
        startTLS: /^(1|true|yes)$/i.test(process.env.LDAP_STARTTLS || ''),
        tlsRejectUnauthorized: !/^(0|false|no)$/i.test(process.env.LDAP_TLS_REJECT_UNAUTHORIZED || ''),
    };
}

const clean = (s, max = 300) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

function sanitize(v, fallback) {
    return {
        mode: MODES.includes(String(v.mode || '').toLowerCase()) ? String(v.mode).toLowerCase() : fallback.mode,
        url: clean(v.url, 200),
        bindDN: clean(v.bindDN, 300),
        bindPassword: typeof v.bindPassword === 'string' ? v.bindPassword : fallback.bindPassword,
        searchBase: clean(v.searchBase, 300),
        searchFilter: clean(v.searchFilter, 400),
        domain: clean(v.domain, 200),
        defaultRole: ROLES.includes(String(v.defaultRole || '').toLowerCase()) ? String(v.defaultRole).toLowerCase() : fallback.defaultRole,
        roleAdmin: clean(v.roleAdmin, 300),
        roleOperator: clean(v.roleOperator, 300),
        roleViewer: clean(v.roleViewer, 300),
        startTLS: !!v.startTLS,
        tlsRejectUnauthorized: v.tlsRejectUnauthorized !== false,
    };
}

async function getRaw() {
    let stored = null;
    try {
        const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
        if (rows[0] && rows[0].value && typeof rows[0].value === 'object') stored = rows[0].value;
    } catch { /* table not present yet / DB hiccup -> fall back to env defaults */ }
    return { ...envDefaults(), ...(stored || {}) };
}

// Public shape: the bind password is write-only and never round-trips to the
// browser — the Settings page can show "configured" without ever receiving the
// secret it would otherwise just send straight back on the next save.
function redact(full) {
    const { bindPassword, ...rest } = full;
    return { ...rest, bindPasswordSet: !!bindPassword };
}

async function getAuthSettings() { return redact(await getRaw()); }

async function setAuthSettings(patch, actor) {
    const current = await getRaw();
    const p = patch || {};
    // A blank/omitted bindPassword in the PATCH means "leave it as-is" (the field
    // is write-only, so there is nothing for the UI to send back unmodified).
    const incoming = { ...p };
    if (!incoming.bindPassword) delete incoming.bindPassword;
    const next = sanitize({ ...current, ...incoming }, current);

    await query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [KEY, JSON.stringify(next), actor || 'system']);

    const changed = Object.keys(next).filter((k) => k !== 'bindPassword' && next[k] !== current[k]);
    if ('bindPassword' in incoming) changed.push('bindPassword');
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'settings.update', KEY, { changed }]).catch(() => {});

    ldap.reload(next); // live — no restart
    return redact(next);
}

// Seed the defaults row at boot if app_settings has no 'auth' entry yet (mirrors
// lib/settings.js's seedDefaults), and make sure ldap.js is pointed at whatever
// ends up persisted (a prior install's saved settings, or the fresh env seed).
async function seedDefaults() {
    try {
        await query(
            `INSERT INTO app_settings (key, value, updated_by)
             VALUES ($1, $2::jsonb, 'system')
             ON CONFLICT (key) DO NOTHING`,
            [KEY, JSON.stringify(envDefaults())]);
        ldap.reload(await getRaw());
    } catch (e) {
        console.warn('[authSettings] seedDefaults skipped:', e.message);
    }
}

module.exports = { getAuthSettings, setAuthSettings, seedDefaults };
