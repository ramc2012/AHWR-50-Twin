'use strict';
// Operator Advisor — on-prem process intelligence for the edge twin.
//
//  • Auto-discovers numeric telemetry signals each tick and flags statistical anomalies
//    (EWMA baseline + z-score), rate-of-change spikes and frozen/flatline sensors.
//  • Adds workover-specific RULES: overpull / stuck-pipe, tight hole (torque), pump /
//    circulation (washout vs pack-off), efficiency droop.
//  • Recalls similar past situations and raises EARLY WARNINGS from the operator progress
//    log (lib/progresslog) — the "learn from what the operator recorded" loop.
//  • Narrates guidance via a LOCAL open-model LLM (lib/llm) when available, else a
//    deterministic rule-based summary. Everything runs on-site; no external calls.
//
// update(data, now) is SYNCHRONOUS and cheap (stats + rules) — safe to call every tick.
// The LLM is only touched on-demand by guidance()/ask(), so the tick is never blocked.
const llm = require('./llm');
const plog = require('./progresslog');

// Numeric leaves are auto-discovered from these domain sub-objects of rig_data.
const DOMAINS = ['drawworks', 'htd', 'hpu', 'pct', 'mudpump', 'well_control', 'drilling', 'acs', 'engine', 'cwk'];
const A = Number(process.env.ADVISOR_EWMA_ALPHA || 0.06);   // EWMA smoothing (~N=32)
const WARMUP = 30;                                          // samples before flagging
const RING = 24;                                            // recent-sample window

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const get = (o, d) => d.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const labelOf = (path) => path.split('.').map((s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).join(' · ');
const SEV_RANK = { critical: 4, warning: 3, watch: 2, info: 1 };

function* leaves(data) {
    for (const dom of DOMAINS) {
        const obj = data[dom];
        if (!obj || typeof obj !== 'object') continue;
        for (const [k, v] of Object.entries(obj)) {
            const n = num(v);
            if (n != null) yield [`${dom}.${k}`, n];
        }
    }
}

const stats = new Map(); // path -> { ewma, ewmvar, n, last, prev, ring:[], histMin, histMax }
let state = { updatedAt: null, advisories: [], earlyWarnings: [], signals: [] };

function track(path, x) {
    let s = stats.get(path);
    if (!s) { s = { ewma: x, ewmvar: 0, n: 1, last: x, prev: x, ring: [x], histMin: x, histMax: x }; stats.set(path, s); return s; }
    s.prev = s.last; s.last = x;
    const diff = x - s.ewma;
    s.ewma += A * diff;
    s.ewmvar = (1 - A) * (s.ewmvar + A * diff * diff);
    s.n += 1;
    s.ring.push(x); if (s.ring.length > RING) s.ring.shift();
    if (x < s.histMin) s.histMin = x;
    if (x > s.histMax) s.histMax = x;
    return s;
}
const zOf = (s) => { const sd = Math.sqrt(s.ewmvar); return sd > 1e-9 ? (s.last - s.ewma) / sd : 0; };

function sevFromZ(z) {
    const a = Math.abs(z);
    if (a >= 6) return 'critical';
    if (a >= 4) return 'warning';
    if (a >= 3) return 'watch';
    return null;
}

// ---- Workover-specific named rules (guarded by signal presence) ------------------
function namedRules(data) {
    const out = [];
    const sig = (p) => { const s = stats.get(p); return s && s.n > WARMUP ? s : null; };
    const activity = (data?._activity?.label || data?._activity?.code || '').toUpperCase();
    const tripping = /RIH|POOH|TRIP|PULL|RUN/.test(activity);

    // Overpull / stuck-pipe: hookload well above its running baseline (esp. while tripping).
    const hl = sig('drawworks.hook_load');
    if (hl && hl.ewma > 0) {
        const excess = (hl.last - hl.ewma) / hl.ewma;
        if (excess > 0.12 && hl.last > hl.prev) {
            out.push({
                kind: 'overpull', signal: 'drawworks.hook_load', unit: 't',
                value: round(hl.last), baseline: round(hl.ewma),
                severity: excess > 0.22 ? 'critical' : 'warning',
                title: 'Overpull / pack-off risk',
                detail: `Hookload ${round(hl.last)} t is ${pct(excess)} above the ~${round(hl.ewma)} t running baseline${tripping ? ' while tripping' : ''}.`,
                suggestion: 'Stop pulling, work the pipe up/down, and circulate before further overpull — possible pack-off or differential sticking.',
            });
        }
    }
    // Tight hole: rotary / make-up torque trending high.
    // Rotary torque only — make-up torque legitimately peaks on every connection (it's
    // tracked by the torque-turn feature), so the instantaneous value is not flagged here.
    for (const [p, lbl, sug] of [
        ['htd.torque', 'Rotary torque', 'Reduce WOB/RPM, circulate bottoms-up and ream the tight interval; watch for stuck pipe.'],
    ]) {
        const s = sig(p);
        if (s && s.ewma > 0) {
            const excess = (s.last - s.ewma) / s.ewma;
            if (excess > 0.18 && s.last > s.prev) {
                out.push({
                    kind: 'tight_hole', signal: p, unit: 'daN·m', value: round(s.last), baseline: round(s.ewma),
                    severity: excess > 0.30 ? 'critical' : 'warning',
                    title: `${lbl} trending high`,
                    detail: `${lbl} ${round(s.last)} is ${pct(excess)} above the ~${round(s.ewma)} baseline.`,
                    suggestion: sug,
                });
            }
        }
    }
    // Pump / circulation: pressure deviates while pump rate is steady → pack-off vs washout.
    const pp = sig('mudpump.pressure'); const spm = stats.get('mudpump.spm');
    if (pp && pp.ewma > 0) {
        const steadyRate = !spm || Math.abs(zOf(spm)) < 2;
        const z = zOf(pp);
        if (steadyRate && z > 3) {
            out.push({
                kind: 'pump_packoff', signal: 'mudpump.pressure', unit: 'bar', value: round(pp.last), baseline: round(pp.ewma),
                severity: z > 5 ? 'critical' : 'warning',
                title: 'Standpipe pressure rising at steady rate',
                detail: `Pump pressure ${round(pp.last)} bar vs ~${round(pp.ewma)} bar with pump rate steady — possible plugging / pack-off.`,
                suggestion: 'Check for bit/nozzle plugging or cuttings pack-off; consider reducing rate and circulating clean.',
            });
        } else if (steadyRate && z < -3) {
            out.push({
                kind: 'pump_washout', signal: 'mudpump.pressure', unit: 'bar', value: round(pp.last), baseline: round(pp.ewma),
                severity: z < -5 ? 'critical' : 'warning',
                title: 'Standpipe pressure dropping at steady rate',
                detail: `Pump pressure ${round(pp.last)} bar vs ~${round(pp.ewma)} bar with pump rate steady — possible washout / lost returns.`,
                suggestion: 'Inspect for a string/BHA washout or losses; verify returns and pit levels.',
            });
        }
    }
    // Efficiency droop: a measured circuit efficiency that is low.
    const circuits = data?._efficiency?.circuits || [];
    for (const c of circuits) {
        const e = num(c.efficiency);
        if (e != null && e < 40) {
            out.push({
                kind: 'efficiency', signal: `efficiency.${c.id}`, unit: '%', value: round(e), baseline: null,
                severity: e < 25 ? 'warning' : 'watch',
                title: `${c.label || c.id} efficiency low`,
                detail: `Measured circuit efficiency ${round(e)} % — check pump/relief condition and load.`,
                suggestion: 'Inspect the hydraulic circuit (pump wear, relief bypass, filter Δp) for the affected function.',
            });
        }
    }
    return out;
}

// ---- Statistical layer over auto-discovered signals -------------------------------
function statRules(coveredPaths) {
    const out = [];
    for (const [path, s] of stats.entries()) {
        if (coveredPaths.has(path) || s.n <= WARMUP) continue;
        const z = zOf(s);
        const sev = sevFromZ(z);
        // Frozen sensor: a normally-variable signal that has stopped moving.
        const ringRange = Math.max(...s.ring) - Math.min(...s.ring);
        const histRange = s.histMax - s.histMin;
        const isCounter = /hour|hrs|runtime|total|count|odo|life|cycles/i.test(path); // monotonic counters aren't "frozen"
        if (!isCounter && s.ring.length >= RING && ringRange < 1e-6 && histRange > 1e-3) {
            out.push({
                kind: 'flatline', signal: path, unit: '', value: round(s.last), baseline: round(s.ewma), severity: 'watch',
                title: `${labelOf(path)} frozen`,
                detail: `${labelOf(path)} has not moved for ${s.ring.length} samples though it normally varies — possible stuck/failed sensor.`,
                suggestion: 'Verify the transmitter / tag is live; a frozen reading can mask a real process change.',
            });
        } else if (sev) {
            out.push({
                kind: 'anomaly', signal: path, unit: '', value: round(s.last), baseline: round(s.ewma), severity: sev,
                title: `${labelOf(path)} ${z > 0 ? 'high' : 'low'} (anomaly)`,
                detail: `${labelOf(path)} = ${round(s.last)} is ${Math.abs(z).toFixed(1)}σ ${z > 0 ? 'above' : 'below'} its ~${round(s.ewma)} baseline.`,
                suggestion: 'Investigate the deviation against the current operation.',
            });
        }
    }
    return out;
}

function topSignals(limit = 8) {
    return [...stats.entries()]
        .filter(([, s]) => s.n > 5)
        .map(([path, s]) => ({ path, label: labelOf(path), value: round(s.last), baseline: round(s.ewma), z: round(zOf(s), 2), trend: s.last > s.prev ? 'up' : (s.last < s.prev ? 'down' : 'flat') }))
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, limit);
}

function update(data, nowMs) {
    if (!data || data?._meta?.connected === false) { state = { ...state, updatedAt: new Date(nowMs).toISOString() }; return state; }
    for (const [path, x] of leaves(data)) track(path, x);

    const named = namedRules(data);
    const covered = new Set(named.map((a) => a.signal));
    const advisories = [...named, ...statRules(covered)]
        .map((a) => ({ id: `${a.kind}:${a.signal}`, ts: new Date(nowMs).toISOString(), ...a }))
        .sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]))
        .slice(0, 8);

    const earlyWarnings = plog.predict(data, 3).map((p) => ({
        id: `ew:${p.event.id}`,
        title: `Conditions resemble a past ${p.event.category} event`,
        detail: `Now looks ${p.similarity}% like "${p.event.title}" logged ${(p.event.ts || '').slice(0, 16).replace('T', ' ')}${p.event.note ? ` — ${p.event.note.slice(0, 120)}` : ''}.`,
        basedOn: { event: p.event.title, date: p.event.ts, outcome: p.event.severity, category: p.event.category },
        confidence: p.similarity,
    }));

    state = { updatedAt: new Date(nowMs).toISOString(), advisories, earlyWarnings, signals: topSignals() };
    return state;
}

const getState = () => ({ ...state, llm: llm.status() });

// ---- Guidance (LLM-narrated, cached) + Q&A ---------------------------------------
const SYSTEM = 'You are an on-site process advisor for the operator of an AHWR hydraulic workover rig. '
    + 'Be concise, specific and safety-first. Use ONLY the data provided — never invent values. '
    + 'Give a 2-3 sentence situational read, then 2-4 short, actionable bullet recommendations.';

function contextText(data) {
    const s = getState();
    const lines = [];
    const act = data?._activity?.label || data?._activity?.code;
    if (act) lines.push(`Current activity: ${act}`);
    if (s.signals.length) lines.push('Key signals (value / baseline / z): ' + s.signals.slice(0, 6).map((x) => `${x.label}=${x.value}(~${x.baseline}, ${x.z}σ)`).join('; '));
    if (s.advisories.length) lines.push('Active advisories:\n' + s.advisories.map((a) => `- [${a.severity}] ${a.title}: ${a.detail}`).join('\n'));
    else lines.push('No active advisories — process within normal bounds.');
    if (s.earlyWarnings.length) lines.push('Early warnings:\n' + s.earlyWarnings.map((e) => `- ${e.detail}`).join('\n'));
    const similar = plog.findSimilar(data, '', 3);
    if (similar.length) lines.push('Similar past log entries (operator memory):\n' + similar.map((e) => `- ${(e.ts || '').slice(0, 16)} [${e.category}/${e.severity}] ${e.title}: ${(e.note || '').slice(0, 160)}`).join('\n'));
    return lines.join('\n');
}

// Deterministic fallback when no model is reachable.
function ruleNarrative(data) {
    const s = getState();
    const recs = [];
    let head;
    if (!s.advisories.length) {
        head = 'Process is within normal statistical bounds; no active anomalies. Continue the current operation and keep logging events.';
    } else {
        const top = s.advisories[0];
        head = `${s.advisories.length} active advisor${s.advisories.length > 1 ? 'ies' : 'y'}; highest is "${top.title}" (${top.severity}). ${top.detail}`;
        for (const a of s.advisories.slice(0, 4)) recs.push(`${a.title} — ${a.suggestion}`);
    }
    for (const e of s.earlyWarnings) recs.push(`Predictive: ${e.detail}`);
    return { source: 'rules', model: null, narrative: head, recommendations: recs };
}

let guidanceCache = { at: 0, key: '', value: null };
async function guidance(data, { force = false } = {}) {
    const s = getState();
    const key = JSON.stringify(s.advisories.map((a) => a.id)) + JSON.stringify(s.earlyWarnings.map((e) => e.id));
    const fresh = guidanceCache.value && guidanceCache.key === key && (Date.now() - guidanceCache.at) < 30000;
    if (fresh && !force) return guidanceCache.value;

    let value = ruleNarrative(data);
    if (llm.config.enabled) {
        const r = await llm.chat([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Telemetry & context:\n${contextText(data)}\n\nGive your situational read and recommendations.` },
        ]);
        if (r.ok) value = { source: 'llm', model: llm.config.model, narrative: r.text, recommendations: [] };
        else value = { ...ruleNarrative(data), llmError: r.err };
    }
    guidanceCache = { at: Date.now(), key, value };
    return value;
}

async function ask(question, data) {
    const q = String(question || '').slice(0, 1000);
    if (llm.config.enabled) {
        const r = await llm.chat([
            { role: 'system', content: SYSTEM + ' Answer the operator\'s question directly using the data.' },
            { role: 'user', content: `Telemetry & context:\n${contextText(data)}\n\nOperator question: ${q}` },
        ], { maxTokens: 400 });
        if (r.ok) return { source: 'llm', model: llm.config.model, answer: r.text };
    }
    // Fallback: stitch advisories + similar log entries into a direct answer.
    const s = getState();
    const similar = plog.findSimilar(data, q, 3);
    const parts = [];
    if (s.advisories.length) parts.push(`Active now: ${s.advisories.map((a) => a.title).join(', ')}.`);
    else parts.push('No active advisories right now.');
    if (similar.length) parts.push('Related past entries: ' + similar.map((e) => `"${e.title}" (${(e.ts || '').slice(0, 10)})`).join('; ') + '.');
    parts.push('Enable a local model (LLM_ENABLED) for conversational answers; this is the rule-based fallback.');
    return { source: 'rules', model: null, answer: parts.join(' ') };
}

function round(v, d = 1) { const m = 10 ** d; return v == null ? null : Math.round(v * m) / m; }
function pct(x) { return `${Math.round(x * 100)}%`; }

module.exports = { update, getState, guidance, ask, contextText };
