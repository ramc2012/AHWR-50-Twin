'use strict';
// CMF Energistics store: the WITSML 2.1 / eml 2.3 objects of every rig, built
// from the historian (rigs, wells, wellbores, well_runs, channels, telemetry).
//
// Objects and their identifiers (lib/ids.js, identical to the rig edge):
//   Rig per rig; Channel per (rig, metric); per well: Well, Wellbore; per well
//   run (a rig working a well): RigUtilization, Log, ChannelSet; the
//   BusinessAssociates (logging companies, operators) and PWLS PropertyKinds
//   they reference.
// Graph (ETP Discovery): a DataObjectReference holder is the SOURCE of an edge to
// the object it references (the TARGET); a contained object (Channel in a
// ChannelSet, ChannelSet in a Log) is the source and its container the target.
//   primary:   Wellbore->Well, RigUtilization->Wellbore, RigUtilization->Rig,
//              Log->Wellbore, ChannelSet->Wellbore, ChannelSet->Log, Channel->ChannelSet
//   secondary: ->BusinessAssociate, ->PropertyKind, PropertyKind->parent
const { pool } = require('./db');
const ids = require('./ids');
const w21 = require('./witsml21');
const PWLS = require('./propertyKinds.json');
const uri = require('./etp12/uri');

const TYPES = [
    'witsml21.Well', 'witsml21.Wellbore', 'witsml21.Rig', 'witsml21.RigUtilization', 'witsml21.Log',
    'witsml21.ChannelSet', 'witsml21.Channel', 'eml23.BusinessAssociate', 'eml23.PropertyKind',
];
const CACHE_MS = Number(process.env.STORE_CACHE_MS || 10000);
const ACTIVE_MS = 15 * 60 * 1000;
const ms = (t) => (t ? new Date(t).getTime() : 0);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const kindsByUuid = new Map(Object.values(PWLS.kinds).map((k) => [k.uuid, k]));

let snapshot = null;
let loading = null;

async function load() {
    const [rigs, wells, runs, chans] = await Promise.all([
        pool.query('SELECT rig_id, name, created_at, updated_at, last_data_at FROM rigs ORDER BY rig_id'),
        pool.query(`SELECT well_id, name, uwi, field, operator, status, spud_date, total_depth, current_rig_id, created_at, updated_at
                      FROM wells ORDER BY well_id`),
        pool.query(`SELECT id, well_id, rig_id, started_at, ended_at FROM well_runs
                     WHERE rig_id IS NOT NULL AND well_id IS NOT NULL ORDER BY started_at`),
        pool.query(`SELECT rig_id, metric, uuid, mnemonic, label, group_name, stored_unit, uom, factor, data_kind,
                           property_kind_uuid, property_kind, unit_source, logging_company, first_ts, last_ts, created_at, updated_at
                      FROM channels ORDER BY rig_id, metric`),
    ]);
    const nodes = new Map();
    const add = (n) => { nodes.set(n.uuid, n); return n; };
    const s = { nodes, rigs: new Map(), wells: new Map(), channelsByRig: new Map(), runsByRig: new Map(), runsByWell: new Map(), loadedAt: Date.now() };

    const companies = new Map();   // name -> node
    const company = (name) => {
        if (!companies.has(name)) {
            companies.set(name, add({ type: 'eml23.BusinessAssociate', uuid: ids.businessAssociate(name), title: name, name, lastChanged: 0, created: 0 }));
        }
        return companies.get(name);
    };

    for (const r of rigs.rows) {
        const node = add({ type: 'witsml21.Rig', uuid: ids.rig(r.rig_id), title: r.name || r.rig_id, rigId: r.rig_id,
            created: ms(r.created_at), lastChanged: Math.max(ms(r.updated_at), ms(r.last_data_at)), lastData: ms(r.last_data_at) });
        s.rigs.set(r.rig_id, node);
        s.channelsByRig.set(r.rig_id, []);
        s.runsByRig.set(r.rig_id, []);
    }
    for (const c of chans.rows) {
        const entry = {
            rigId: c.rig_id, metric: c.metric, uuid: c.uuid, mnemonic: c.mnemonic, label: c.label, group: c.group_name,
            storedUnit: c.stored_unit, uom: c.uom, factor: Number(c.factor) || 1, dataKind: c.data_kind || 'double',
            propertyKind: { uuid: c.property_kind_uuid, title: c.property_kind }, unitSource: c.unit_source,
            loggingCompany: c.logging_company || c.rig_id,
            firstTs: iso(c.first_ts), lastTs: iso(c.last_ts), createdAt: iso(c.created_at), updatedAt: iso(c.updated_at),
        };
        company(entry.loggingCompany);
        const node = add({ type: 'witsml21.Channel', uuid: c.uuid, title: c.label || c.metric, rigId: c.rig_id, entry,
            created: ms(c.created_at), lastChanged: Math.max(ms(c.updated_at), ms(c.last_ts)), active: Date.now() - ms(c.last_ts) < ACTIVE_MS });
        if (!s.channelsByRig.has(c.rig_id)) s.channelsByRig.set(c.rig_id, []);
        s.channelsByRig.get(c.rig_id).push(node);
    }
    for (const w of wells.rows) {
        if (w.operator) company(w.operator);
        const rec = { name: w.well_id, title: w.name || w.well_id, uwi: w.uwi, field: w.field, operator: w.operator,
            spudDate: w.spud_date, status: w.current_rig_id ? 'active' : 'inactive', createdAt: iso(w.created_at), updatedAt: iso(w.updated_at),
            currentRig: w.current_rig_id };
        const well = add({ type: 'witsml21.Well', uuid: ids.well(w.well_id), title: rec.title, wellId: w.well_id, rec,
            created: ms(w.created_at), lastChanged: ms(w.updated_at), active: !!w.current_rig_id });
        const wellbore = add({ type: 'witsml21.Wellbore', uuid: ids.wellbore(w.well_id), title: rec.title, wellId: w.well_id, rec,
            created: ms(w.created_at), lastChanged: ms(w.updated_at), active: !!w.current_rig_id });
        s.wells.set(w.well_id, { well, wellbore });
        s.runsByWell.set(w.well_id, []);
    }
    for (const r of runs.rows) {
        if (!s.rigs.has(r.rig_id) || !s.wells.has(r.well_id)) continue;
        const run = { rigId: r.rig_id, wellId: r.well_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at) };
        const changed = Math.max(ms(r.ended_at), r.ended_at ? 0 : (s.rigs.get(r.rig_id).lastData || ms(r.started_at)));
        const common = { rigId: r.rig_id, wellId: r.well_id, run, created: ms(r.started_at), lastChanged: changed, active: !r.ended_at };
        const ru = add({ ...common, type: 'witsml21.RigUtilization', uuid: ids.rigUtilization(r.rig_id, r.well_id, run.startedAt), title: `${r.rig_id} on ${r.well_id}` });
        const log = add({ ...common, type: 'witsml21.Log', uuid: ids.log(r.rig_id, r.well_id, run.startedAt), title: `${r.well_id} ${r.rig_id} real-time log` });
        const cs = add({ ...common, type: 'witsml21.ChannelSet', uuid: ids.channelSet(r.rig_id, r.well_id, run.startedAt), title: `${r.well_id} ${r.rig_id} ${run.startedAt.slice(0, 10)}` });
        const bundle = { ru, log, cs, run };
        s.runsByRig.get(r.rig_id).push(bundle);
        s.runsByWell.get(r.well_id).push(bundle);
    }
    // Property kinds referenced by channels, with their ancestors.
    const used = new Set();
    const addKind = (k) => {
        if (!k || used.has(k.uuid)) return;
        used.add(k.uuid);
        add({ type: 'eml23.PropertyKind', uuid: k.uuid, title: k.title, kind: k, created: Date.parse('2016-12-09T17:30:47Z'), lastChanged: Date.parse('2021-11-17T23:35:26Z'), active: true });
        if (k.parent && k.parent.uuid !== k.uuid) addKind(kindsByUuid.get(k.parent.uuid));
    };
    for (const list of s.channelsByRig.values()) for (const n of list) addKind(kindsByUuid.get(n.entry.propertyKind.uuid));
    s.companies = companies;
    return s;
}

/** The current snapshot (cached for STORE_CACHE_MS). */
async function get({ fresh = false } = {}) {
    if (!fresh && snapshot && Date.now() - snapshot.loadedAt < CACHE_MS) return snapshot;
    if (!loading) loading = load().then((s) => { snapshot = s; return s; }).finally(() => { loading = null; });
    return loading;
}
const invalidate = () => { snapshot = null; };

// ---- Graph ------------------------------------------------------------------------
const edge = (node, kind) => (node ? { node, kind } : null);
function targets(s, n) {
    const out = [];
    const companyOf = (name) => s.companies.get(name);
    switch (n.type) {
        case 'witsml21.Wellbore': out.push(edge(s.wells.get(n.wellId).well, 'Primary')); break;
        case 'witsml21.RigUtilization':
            out.push(edge(s.wells.get(n.wellId).wellbore, 'Primary'), edge(s.rigs.get(n.rigId), 'Primary')); break;
        case 'witsml21.Log': {
            const b = s.runsByRig.get(n.rigId).find((x) => x.log === n);
            out.push(edge(s.wells.get(n.wellId).wellbore, 'Primary'), edge(companyOf(loggingCompany(s, n.rigId)), 'Secondary'));
            if (!b) break;
            break;
        }
        case 'witsml21.ChannelSet': {
            const b = s.runsByRig.get(n.rigId).find((x) => x.cs === n);
            out.push(edge(b && b.log, 'Primary'), edge(s.wells.get(n.wellId).wellbore, 'Primary'),
                edge(companyOf(loggingCompany(s, n.rigId)), 'Secondary'));
            break;
        }
        case 'witsml21.Channel':
            for (const b of s.runsByRig.get(n.rigId) || []) out.push(edge(b.cs, 'Primary'));
            out.push(edge(s.nodes.get(n.entry.propertyKind.uuid), 'Secondary'), edge(companyOf(n.entry.loggingCompany), 'Secondary'));
            break;
        case 'witsml21.Well': if (n.rec.operator) out.push(edge(companyOf(n.rec.operator), 'Secondary')); break;
        case 'eml23.PropertyKind':
            if (n.kind.parent && n.kind.parent.uuid !== n.uuid) out.push(edge(s.nodes.get(n.kind.parent.uuid), 'Secondary'));
            break;
        default: break;
    }
    return out.filter(Boolean);
}
function sources(s, n) {
    const out = [];
    switch (n.type) {
        case 'witsml21.Well': out.push(edge(s.wells.get(n.wellId).wellbore, 'Primary')); break;
        case 'witsml21.Wellbore':
            for (const b of s.runsByWell.get(n.wellId) || []) out.push(edge(b.ru, 'Primary'), edge(b.log, 'Primary'), edge(b.cs, 'Primary'));
            break;
        case 'witsml21.Rig': for (const b of s.runsByRig.get(n.rigId) || []) out.push(edge(b.ru, 'Primary')); break;
        case 'witsml21.Log': {
            const b = s.runsByRig.get(n.rigId).find((x) => x.log === n);
            if (b) out.push(edge(b.cs, 'Primary'));
            break;
        }
        case 'witsml21.ChannelSet': for (const c of s.channelsByRig.get(n.rigId) || []) out.push(edge(c, 'Primary')); break;
        case 'eml23.PropertyKind':
            for (const list of s.channelsByRig.values()) for (const c of list) if (c.entry.propertyKind.uuid === n.uuid) out.push(edge(c, 'Secondary'));
            for (const k of s.nodes.values()) if (k.type === 'eml23.PropertyKind' && k.kind.parent.uuid === n.uuid && k.uuid !== n.uuid) out.push(edge(k, 'Secondary'));
            break;
        case 'eml23.BusinessAssociate':
            for (const list of s.channelsByRig.values()) for (const c of list) if (c.entry.loggingCompany === n.name) out.push(edge(c, 'Secondary'));
            for (const [rigId, runList] of s.runsByRig) {
                if (loggingCompany(s, rigId) !== n.name) continue;
                for (const b of runList) out.push(edge(b.log, 'Secondary'), edge(b.cs, 'Secondary'));
            }
            for (const { well } of s.wells.values()) if (well.rec.operator === n.name) out.push(edge(well, 'Secondary'));
            break;
        default: break;
    }
    return out.filter(Boolean);
}
function loggingCompany(s, rigId) {
    const list = s.channelsByRig.get(rigId) || [];
    return list.length ? list[0].entry.loggingCompany : rigId;
}

// ---- Objects (XML) ------------------------------------------------------------------
/** First and last telemetry time of a rig inside a run (null when no data). */
async function runExtent(run) {
    const end = run.endedAt || new Date().toISOString();
    const q = (dir) => pool.query(
        `SELECT ts FROM telemetry WHERE rig_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts ${dir} LIMIT 1`,
        [run.rigId, run.startedAt, end]);
    const [a, b] = await Promise.all([q('ASC'), q('DESC')]);
    return { start: a.rows[0] ? iso(a.rows[0].ts) : null, end: b.rows[0] ? iso(b.rows[0].ts) : null };
}

async function xmlOf(s, n) {
    switch (n.type) {
        case 'witsml21.Rig': return w21.rig(n.rigId, { creation: iso(n.created), lastUpdate: iso(n.lastChanged), active: Date.now() - n.lastData < ACTIVE_MS });
        case 'witsml21.Well': return w21.well(n.rec, { rigId: n.rec.currentRig || 'CRMF' });
        case 'witsml21.Wellbore': return w21.wellbore(n.rec, { rigId: n.rec.currentRig || 'CRMF' });
        case 'witsml21.RigUtilization': return w21.rigUtilization(n.run, { rigId: n.rigId });
        case 'witsml21.Channel': return w21.channel(n.entry, { rigId: n.rigId, loggingCompany: n.entry.loggingCompany });
        case 'witsml21.Log':
        case 'witsml21.ChannelSet': {
            const entries = (s.channelsByRig.get(n.rigId) || []).map((c) => c.entry);
            const opts = { rigId: n.rigId, loggingCompany: loggingCompany(s, n.rigId), ...(await runExtent(n.run)) };
            return n.type === 'witsml21.Log' ? w21.log(n.run, entries, opts) : w21.channelSet(n.run, entries, opts);
        }
        case 'eml23.BusinessAssociate': return w21.businessAssociate(n.name);
        case 'eml23.PropertyKind': return w21.propertyKind(n.kind);
        default: throw new Error(`no XML for ${n.type}`);
    }
}

const uriOf = (n) => uri.object(n.type, n.uuid);
/** ETP Resource record of a node. */
function resource(s, n, { countObjects = false } = {}) {
    const us = (t) => (t ? t * 1000 : 0);
    return {
        uri: uriOf(n), alternateUris: [], name: String(n.title || n.uuid),
        sourceCount: countObjects ? { int: sources(s, n).length } : null,
        targetCount: countObjects ? { int: targets(s, n).length } : null,
        lastChanged: us(n.lastChanged || n.created), storeLastWrite: us(n.lastChanged || n.created), storeCreated: us(n.created),
        activeStatus: n.active === false ? 'Inactive' : 'Active', customData: {},
    };
}

// ---- Channel data ----------------------------------------------------------------------
/**
 * Stored telemetry of channels between two times (inclusive), oldest first.
 * @returns [{ ts (Date), metric, value }]
 */
async function channelRows(rigId, metrics, from, to, limit = 100000) {
    const { rows } = await pool.query(
        `SELECT ts, metric, value FROM telemetry
          WHERE rig_id = $1 AND metric = ANY($2) AND ts >= $3 AND ts <= $4
          ORDER BY ts, metric LIMIT $5`, [rigId, metrics, from, to, limit]);
    return rows;
}

/** Latest `count` points of each channel. */
async function latestRows(rigId, metric, count) {
    const { rows } = await pool.query(
        `SELECT ts, metric, value FROM telemetry WHERE rig_id = $1 AND metric = $2 ORDER BY ts DESC LIMIT $3`,
        [rigId, metric, count]);
    return rows.reverse();
}

module.exports = { TYPES, get, invalidate, targets, sources, xmlOf, resource, uriOf, runExtent, channelRows, latestRows, loggingCompany };
