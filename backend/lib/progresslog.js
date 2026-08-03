'use strict';
// Operator Progress Log — the structured event journal the operator keeps during a tour
// (NPT, equipment changes, observations, well-control events, handover…). Each entry
// auto-captures a compact TELEMETRY SNAPSHOT + numeric SIGNATURE at the moment it is
// logged. This is the labelled-data spine the advisor learns from: similar past
// situations are recalled (RAG) and the pre-event signatures power early warnings.
// Persisted atomically to progress_log.json under DATA_DIR. Edge-local; no egress.
const { readJson, writeJson } = require('./persist');

const FILE = 'progress_log.json';
const CATEGORIES = ['operation', 'npt', 'equipment', 'well-control', 'hse', 'observation', 'handover'];
const SEVERITIES = ['info', 'minor', 'major', 'critical'];

// Signals that form a situation "signature" (dotted paths into rig_data). Missing
// signals are skipped, so this works with mock telemetry or any real PLC tag set.
const SIG_PATHS = [
    ['drawworks.hook_load', 'Hookload', 't'],
    ['htd.torque', 'Rotary torque', 'daN·m'],
    ['htd.rpm', 'Rotary RPM', 'rpm'],
    ['pct.makeup_torque', 'Make-up torque', 'daN·m'],
    ['mudpump.pressure', 'Pump pressure', 'bar'],
    ['mudpump.spm', 'Pump SPM', 'spm'],
    ['mudpump.flow_in', 'Flow in', 'lpm'],
    ['well_control.annular_pressure', 'Annular pressure', 'bar'],
    ['well_control.accumulator_pressure', 'Accumulator', 'bar'],
    ['drilling.bit_depth', 'Bit depth', 'm'],
    ['drilling.block_height', 'Block height', 'm'],
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v
    : (v != null && Number.isFinite(Number(v)) ? Number(v) : null));
const get = (o, dotted) => dotted.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

// Stable, slow-moving signals used for SITUATION matching (RAG + early-warning). Volatile
// per-connection signals (make-up torque) are intentionally excluded so the signature
// describes the operating situation, not transient spikes. snapshot() still shows all.
const SIGNATURE_PATHS = [
    'drawworks.hook_load', 'mudpump.pressure', 'mudpump.spm', 'mudpump.flow_in',
    'well_control.annular_pressure', 'well_control.accumulator_pressure',
    'drilling.bit_depth', 'drilling.block_height',
];
// Compact numeric signature { path: value } from a rig_data object.
function signature(data) {
    const sig = {};
    for (const p of SIGNATURE_PATHS) { const v = num(get(data, p)); if (v != null) sig[p] = v; }
    return sig;
}
// Human-readable snapshot for display + LLM context.
function snapshot(data) {
    const signals = [];
    for (const [p, label, unit] of SIG_PATHS) {
        const v = num(get(data, p));
        if (v != null) signals.push({ path: p, label, value: Math.round(v * 100) / 100, unit });
    }
    return {
        signals,
        activity: data?._activity?.label || data?._activity?.code || null,
        alarms: data?._alarms || null,
        source: data?._meta?.source || null,
        ts: data?._meta?.ts || new Date().toISOString(),
    };
}

let log = null;
const load = () => (log || (log = readJson(FILE, []) || []));
let seq = 0;
const newId = (ms) => `pl-${ms}-${(seq = (seq + 1) % 100000)}`;

function list({ date, category, limit } = {}) {
    let rows = [...load()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
    if (category) rows = rows.filter((r) => r.category === category);
    if (date) rows = rows.filter((r) => (r.ts || '').slice(0, 10) === date);
    if (limit) rows = rows.slice(0, Number(limit));
    return rows;
}
const getOne = (id) => load().find((r) => r.id === id) || null;

async function add(entry, data) {
    const ts = new Date().toISOString();
    const e = {
        id: newId(Date.parse(ts)),
        ts,
        type: String(entry.type || 'event').slice(0, 40),
        category: CATEGORIES.includes(entry.category) ? entry.category : 'observation',
        severity: SEVERITIES.includes(entry.severity) ? entry.severity : 'info',
        title: String(entry.title || '').slice(0, 200),
        note: String(entry.note || '').slice(0, 4000),
        author: String(entry.author || 'operator').slice(0, 80),
        tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 12).map((t) => String(t).slice(0, 40)) : [],
        snapshot: snapshot(data || {}),
        signature: signature(data || {}),
    };
    load().unshift(e);
    await writeJson(FILE, log);
    return e;
}
async function update(id, patch) {
    const e = getOne(id);
    if (!e) return null;
    for (const k of ['type', 'category', 'severity', 'title', 'note', 'tags']) if (k in patch) e[k] = patch[k];
    e.editedAt = new Date().toISOString();
    await writeJson(FILE, log);
    return e;
}
async function remove(id) {
    const i = load().findIndex((r) => r.id === id);
    if (i < 0) return false;
    log.splice(i, 1);
    await writeJson(FILE, log);
    return true;
}

// --- RAG / learning ------------------------------------------------------------
// Scale-free distance over shared signals (relative diff so units don't dominate).
function distance(a, b) {
    const keys = Object.keys(a).filter((k) => k in b);
    if (!keys.length) return Infinity;
    let s = 0;
    for (const k of keys) {
        const denom = Math.max(1e-6, Math.abs(a[k]) + Math.abs(b[k]));
        const d = (a[k] - b[k]) / denom;
        s += d * d;
    }
    return Math.sqrt(s / keys.length);
}
// Recall past entries whose situation resembles `data` (+ optional free text) — for RAG.
function findSimilar(data, text, k = 3) {
    const sig = signature(data || {});
    const words = String(text || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    return load()
        .map((e) => {
            const sd = distance(sig, e.signature || {});
            const kw = words.length
                ? words.filter((w) => `${e.title} ${e.note}`.toLowerCase().includes(w)).length / words.length
                : 0;
            const score = (Number.isFinite(sd) ? 1 / (1 + sd) : 0) * 0.7 + kw * 0.3;
            return { e, score, sd };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((x) => ({ ...x.e, _similarity: Number.isFinite(x.sd) ? Math.round((1 - Math.min(1, x.sd)) * 100) : null }));
}
// Early-warning: past events with a real OUTCOME (major/critical or NPT) whose signature
// is close to the situation NOW — "conditions resemble <event> which preceded <outcome>".
function predict(data, k = 3) {
    const sig = signature(data || {});
    if (!Object.keys(sig).length) return [];
    return load()
        .filter((e) => ['major', 'critical'].includes(e.severity) || e.category === 'npt')
        .map((e) => ({ e, sd: distance(sig, e.signature || {}) }))
        .filter((x) => Number.isFinite(x.sd) && x.sd < 0.22)
        .sort((a, b) => a.sd - b.sd)
        .slice(0, k)
        .map((x) => ({ event: x.e, similarity: Math.round((1 - x.sd) * 100) }));
}

module.exports = {
    CATEGORIES, SEVERITIES, SIG_PATHS,
    signature, snapshot, list, get: getOne, add, update, remove, findSimilar, predict,
};
