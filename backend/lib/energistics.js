'use strict';
// The twin edge's Energistics view (WITSML 2.1 / ETP v1.2) without a TimescaleDB
// historian: channels from the EDR catalog, the PLC field map and the PLC config
// (bit addresses are flags); objects from the well registry; channel data from the
// sync agent's in-memory window of recent snapshots (lib/sync.js getRecent).
// Store-mode ETP can therefore resume at most RECENT_MAX snapshots back; the
// AHWR-150 EDGE (TimescaleDB) resumes from its full historian.
const ids = require('./ids');
const w21 = require('./witsml21');
const channelLib = require('./channels');

const BIT_ADDRESS_RE = /\.X\d+\.\d+$/i;
const BOP_BOOLEAN_RE = /^bop\.[a-z_]+_(open|close)$/;

let ctx = {
    getRigId: () => process.env.DEVICE_ID || 'AHWR-50-EDGE',
    getWells: () => [],
    getRecent: () => [],
    getPlcConfig: () => ({ slaves: [] }),
    catalog: { categories: [] },
    fieldMap: {},
};
let dictionary = new Map();
let dictionaryKey = '';
const configure = (opts = {}) => { ctx = { ...ctx, ...opts }; };
const rigId = () => ctx.getRigId();
const loggingCompany = () => process.env.WITSML_LOGGING_COMPANY || rigId();
const iso = (t) => (t ? new Date(t).toISOString() : null);

/** PLC tags -> metrics ("<meas>.<field>" when mapped, else "<group>.<tag>") and bit flags. */
function plcMapping(plcConfig) {
    const entries = new Map();
    const bits = new Set();
    for (const slave of (plcConfig && plcConfig.slaves) || []) {
        const fields = slave.protocol === 's7comm'
            ? (slave.metrics || []).flatMap((m) => (m.fields || []).map((f) => ({ raw: f.name, group: m.name || 'AHWR', bit: BIT_ADDRESS_RE.test(String(f.address || '')) })))
            : (slave.registers || []).map((r) => ({ raw: r.name, group: slave.name || 'modbus', bit: r.type === 'coil' || r.type === 'discrete_input' }));
        for (const f of fields) {
            if (entries.has(f.raw)) continue;
            const m = ctx.fieldMap[f.raw];
            const metric = m ? `${m.meas}.${m.field}` : `${f.group}.${f.raw}`;
            entries.set(f.raw, { metric, bit: f.bit });
            if (f.bit) bits.add(metric);
        }
    }
    return { entries, bits };
}

/** The channel dictionary (rebuilt when the rig id or PLC config changes). */
function getDictionary() {
    const plc = ctx.getPlcConfig();
    const key = `${rigId()}|${JSON.stringify(plc)}`;
    if (key !== dictionaryKey) {
        const mapping = plcMapping(plc);
        dictionary = channelLib.buildDictionary({
            rigId: rigId(),
            rows: channelLib.tagRows({ catalog: ctx.catalog, fieldMap: ctx.fieldMap, mapping }),
            isBoolean: (m) => mapping.bits.has(m) || BOP_BOOLEAN_RE.test(m),
        });
        dictionaryKey = key;
    }
    return dictionary;
}

/** Stored points in (afterMs, uptoMs] from the in-memory window, oldest first. */
function readTelemetry(afterMs, uptoMs, limit) {
    const out = [];
    for (const snap of ctx.getRecent(100000)) {
        const t = Date.parse(snap.ts);
        if (!(t > afterMs && t <= uptoMs)) continue;
        for (const [metric, value] of Object.entries(snap.values || {})) {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            out.push({ ts: new Date(t), metric, value });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

/** Dictionary entries with their extents in the in-memory window. */
function channelEntries() {
    const first = new Map(); const last = new Map();
    for (const snap of ctx.getRecent(100000)) {
        for (const metric of Object.keys(snap.values || {})) {
            if (!first.has(metric)) first.set(metric, snap.ts);
            last.set(metric, snap.ts);
        }
    }
    return [...getDictionary().values()].map((c) => ({ ...c, firstTs: iso(first.get(c.metric)), lastTs: iso(last.get(c.metric)) }));
}

const runs = () => ctx.getWells().filter((w) => w.startedAt)
    .map((w) => ({ wellId: w.name, startedAt: iso(w.startedAt), endedAt: iso(w.completedAt), well: w }));

function runExtent(run, entries) {
    let start = null; let end = null;
    const from = Date.parse(run.startedAt); const to = run.endedAt ? Date.parse(run.endedAt) : Infinity;
    for (const c of entries) {
        if (c.firstTs && Date.parse(c.firstTs) >= from && (!start || c.firstTs < start)) start = c.firstTs;
        if (c.lastTs && Date.parse(c.lastTs) <= to && (!end || c.lastTs > end)) end = c.lastTs;
    }
    return { start, end };
}

/** Every data object the edge publishes (same descriptors as AHWR-150 EDGE lib/energistics.js). */
async function listObjects() {
    const rig = rigId();
    const entries = channelEntries();
    const dict = new Map(entries.map((c) => [c.metric, c]));
    const company = loggingCompany();
    const out = [];
    const runList = runs();
    const companies = new Set([company, ...runList.map((r) => r.well.operator).filter(Boolean)]);
    out.push({ type: 'witsml21.Rig', uuid: ids.rig(rig), title: rig, lastChanged: null, targets: [], xml: async () => w21.rig(rig, {}) });
    for (const name of companies) {
        out.push({ type: 'eml23.BusinessAssociate', uuid: ids.businessAssociate(name), title: name, lastChanged: null, targets: [], xml: async () => w21.businessAssociate(name) });
    }
    for (const pk of channelLib.propertyKindsUsed(dict)) {
        out.push({ type: 'eml23.PropertyKind', uuid: pk.uuid, title: pk.title, lastChanged: null, targets: [], xml: async () => w21.propertyKind(pk) });
    }
    for (const c of entries) {
        out.push({ type: 'witsml21.Channel', uuid: c.uuid, title: c.label || c.metric, metric: c.metric, lastChanged: c.lastTs, targets: [],
            xml: async () => w21.channel(c, { rigId: rig, loggingCompany: company }) });
    }
    const seen = new Set();
    for (const r of runList) {
        if (!seen.has(r.wellId)) {
            seen.add(r.wellId);
            out.push({ type: 'witsml21.Well', uuid: ids.well(r.wellId), title: r.wellId, lastChanged: r.well.completedAt || r.well.startedAt, targets: [], xml: async () => w21.well(r.well, { rigId: rig }) });
            out.push({ type: 'witsml21.Wellbore', uuid: ids.wellbore(r.wellId), title: r.wellId, lastChanged: r.well.startedAt, targets: [], xml: async () => w21.wellbore(r.well, { rigId: rig }) });
        }
        out.push({ type: 'witsml21.RigUtilization', uuid: ids.rigUtilization(rig, r.wellId, r.startedAt), title: `${rig} on ${r.wellId}`, lastChanged: r.endedAt || r.startedAt, targets: [],
            xml: async () => w21.rigUtilization(r, { rigId: rig }) });
        out.push({ type: 'witsml21.Log', uuid: ids.log(rig, r.wellId, r.startedAt), title: `${r.wellId} ${rig} real-time log`, lastChanged: r.endedAt || r.startedAt, targets: [],
            xml: async () => w21.log(r, entries, { rigId: rig, loggingCompany: company, ...runExtent(r, entries) }) });
        out.push({ type: 'witsml21.ChannelSet', uuid: ids.channelSet(rig, r.wellId, r.startedAt), title: `${r.wellId} ${rig}`, lastChanged: r.endedAt || r.startedAt, targets: [],
            xml: async () => w21.channelSet(r, entries, { rigId: rig, loggingCompany: company, ...runExtent(r, entries) }) });
    }
    return out;
}

/** Wide rows of the in-memory window for a ChannelSet export: [{ time, [metric]: stored }]. */
function recentRows(maxRows) {
    return ctx.getRecent(maxRows).map((s) => ({ time: s.ts, ...s.values }));
}

module.exports = { configure, rigId, getDictionary, readTelemetry, channelEntries, runs, runExtent, listObjects, recentRows, loggingCompany };
