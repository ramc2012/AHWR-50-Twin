'use strict';
// Data and objects a rig edge sends over ETP (an authenticated edge, its own rig
// only):
//   - channel data (ChannelDataLoad / ChannelStreaming): stored in telemetry in
//     the STORED unit (value / factor), skipping points already received
//     through /ingest (unique index on rig_id, metric, ts);
//   - WITSML 2.1 objects (Store PutDataObjects): Channel, Well, Wellbore,
//     RigUtilization, Rig, BusinessAssociate; recorded in channels, wells,
//     wellbores, well_runs, business_associates. Log, ChannelSet and the
//     standard PWLS PropertyKinds are derived here and accepted unchanged.
const { pool } = require('./db');
const ids = require('./ids');
const PWLS = require('./propertyKinds.json');
const { fromMicros } = require('./etp12/codec');

const KINDS = new Set(Object.values(PWLS.kinds).map((k) => k.uuid));
const bad = (code, message) => Object.assign(new Error(message), { etpCode: code });
const E = { EINVALID_OBJECT: 14, EREQUEST_DENIED: 6, EDATAOBJECTTYPE_NOTSUPPORTED: 16 };

// ---- Minimal XML reading (objects in the form lib/witsml21.js writes) ----------------
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** Text of the first <prefix:Name> element (any prefix), or null. */
function text(xml, name) {
    const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`).exec(xml);
    return m ? unesc(m[1]).trim() : null;
}
/** A DataObjectReference child: { uuid, type, title } or null. */
function ref(xml, name) {
    const m = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
    if (!m) return null;
    return { uuid: (text(m[1], 'Uuid') || '').toLowerCase(), type: text(m[1], 'QualifiedType'), title: text(m[1], 'Title') };
}
const rootUuid = (xml) => { const m = /\buuid="([0-9a-fA-F-]{36})"/.exec(xml); return m ? m[1].toLowerCase() : null; };
const citationTitle = (xml) => { const m = /<(?:\w+:)?Citation>([\s\S]*?)<\/(?:\w+:)?Citation>/.exec(xml); return m ? text(m[1], 'Title') : null; };

// ---- Objects -------------------------------------------------------------------------
/**
 * Record one object an edge put.
 * @param rigId   the authenticated edge's rig
 * @param type    qualified type from the URI (e.g. witsml21.Channel)
 * @param uuid    uuid from the URI
 * @param xml     the object
 * @param custom  Resource.customData as plain values ({ metric, storedUnit, factor, unitSource })
 */
async function putObject(rigId, type, uuid, xml, custom = {}) {
    if (rootUuid(xml) !== uuid) throw bad(E.EINVALID_OBJECT, 'the uuid in the object does not match the URI');
    switch (type) {
        case 'witsml21.Channel': {
            const metric = String(custom.metric || '');
            if (!metric || ids.channel(rigId, metric) !== uuid) throw bad(E.EREQUEST_DENIED, `channel ${uuid} is not a channel of rig ${rigId}`);
            const pk = ref(xml, 'ChannelPropertyKind');
            const company = ref(xml, 'LoggingCompany');
            const mnemonic = text(xml, 'Mnemonic');
            const uom = text(xml, 'Uom');
            if (!pk || !mnemonic || !uom) throw bad(E.EINVALID_OBJECT, 'Channel without Mnemonic, Uom or ChannelPropertyKind');
            await pool.query(
                `INSERT INTO channels (rig_id, metric, uuid, mnemonic, label, group_name, stored_unit, uom, factor, data_kind,
                                       property_kind_uuid, property_kind, unit_source, logging_company)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT (rig_id, metric) DO UPDATE SET
                   uuid = EXCLUDED.uuid, mnemonic = EXCLUDED.mnemonic, label = EXCLUDED.label,
                   stored_unit = EXCLUDED.stored_unit, uom = EXCLUDED.uom, factor = EXCLUDED.factor,
                   data_kind = EXCLUDED.data_kind, property_kind_uuid = EXCLUDED.property_kind_uuid,
                   property_kind = EXCLUDED.property_kind, unit_source = EXCLUDED.unit_source,
                   logging_company = EXCLUDED.logging_company, updated_at = now()`,
                [rigId, metric, uuid, mnemonic, citationTitle(xml), metric.split('.')[0], custom.storedUnit || null, uom,
                    Number(custom.factor) || 1, text(xml, 'DataKind') || 'double', pk.uuid, pk.title || '',
                    custom.unitSource || null, company ? company.title : rigId]);
            return;
        }
        case 'witsml21.Well': {
            const wellId = citationTitle(xml);
            if (!wellId || ids.well(wellId) !== uuid) throw bad(E.EINVALID_OBJECT, 'Well uuid does not match its name');
            const operator = ref(xml, 'Operator');
            await pool.query(
                `INSERT INTO wells (well_id, name, uwi, well_type, status, field, operator, spud_date, uuid)
                 VALUES ($1, $1, $2, 'workover', 'workover', $3, $4, $5, $6)
                 ON CONFLICT (well_id) DO UPDATE SET
                   uwi = COALESCE(EXCLUDED.uwi, wells.uwi), field = COALESCE(EXCLUDED.field, wells.field),
                   operator = COALESCE(EXCLUDED.operator, wells.operator),
                   spud_date = COALESCE(EXCLUDED.spud_date, wells.spud_date), uuid = EXCLUDED.uuid, updated_at = now()`,
                [wellId, text(xml, 'NumGovt'), text(xml, 'Field'), operator ? operator.title : null,
                    text(xml, 'DTimSpud') ? text(xml, 'DTimSpud').slice(0, 10) : null, uuid]);
            if (operator) await putCompany(operator.title);
            return;
        }
        case 'witsml21.Wellbore': {
            const well = ref(xml, 'Well');
            if (!well || ids.wellbore(well.title) !== uuid) throw bad(E.EINVALID_OBJECT, 'Wellbore uuid does not match its well');
            await pool.query(`INSERT INTO wellbores (uuid, well_id, name, number) VALUES ($1, $2, $2, '1') ON CONFLICT (uuid) DO NOTHING`,
                [uuid, well.title]);
            return;
        }
        case 'witsml21.RigUtilization': {
            const rig = ref(xml, 'Rig');
            const wellbore = ref(xml, 'Wellbore');
            const start = text(xml, 'StartOperationTime');
            const end = text(xml, 'EndOperationTime');
            if (!rig || rig.uuid !== ids.rig(rigId)) throw bad(E.EREQUEST_DENIED, `rig utilization of another rig than ${rigId}`);
            if (!wellbore || !start || ids.rigUtilization(rigId, wellbore.title, start) !== uuid) throw bad(E.EINVALID_OBJECT, 'RigUtilization uuid does not match its rig, wellbore and start');
            const wellId = wellbore.title;
            await pool.query(`INSERT INTO wells (well_id, name, well_type, status, uuid) VALUES ($1, $1, 'workover', 'workover', $2)
                              ON CONFLICT (well_id) DO NOTHING`, [wellId, ids.well(wellId)]);
            const found = await pool.query('SELECT id FROM well_runs WHERE uuid = $1', [uuid]);
            if (found.rows[0]) {
                await pool.query('UPDATE well_runs SET ended_at = $2 WHERE id = $1', [found.rows[0].id, end || null]);
            } else {
                // The same run may already be open from /ingest without its uuid: adopt it.
                const open = await pool.query(
                    `SELECT id FROM well_runs WHERE rig_id = $1 AND well_id = $2 AND uuid IS NULL
                      AND abs(extract(epoch FROM started_at - $3::timestamptz)) < 86400 ORDER BY started_at DESC LIMIT 1`,
                    [rigId, wellId, start]);
                if (open.rows[0]) {
                    await pool.query('UPDATE well_runs SET uuid = $2, started_at = $3, ended_at = $4 WHERE id = $1',
                        [open.rows[0].id, uuid, start, end || null]);
                } else {
                    await pool.query('INSERT INTO well_runs (well_id, rig_id, job_no, started_at, ended_at, uuid) VALUES ($1,$2,$1,$3,$4,$5)',
                        [wellId, rigId, start, end || null, uuid]);
                }
            }
            if (!end) await pool.query('UPDATE wells SET current_rig_id = $2, updated_at = now() WHERE well_id = $1', [wellId, rigId]);
            return;
        }
        case 'witsml21.Rig':
            if (uuid !== ids.rig(rigId)) throw bad(E.EREQUEST_DENIED, `rig object of another rig than ${rigId}`);
            await pool.query('UPDATE rigs SET uuid = $2 WHERE rig_id = $1', [rigId, uuid]);
            return;
        case 'eml23.BusinessAssociate': {
            const name = text(xml, 'Name') || citationTitle(xml);
            if (!name || ids.businessAssociate(name) !== uuid) throw bad(E.EINVALID_OBJECT, 'BusinessAssociate uuid does not match its name');
            await putCompany(name);
            return;
        }
        case 'eml23.PropertyKind':
            if (!KINDS.has(uuid)) throw bad(E.EREQUEST_DENIED, 'only Energistics PWLS property kinds are accepted');
            return;
        case 'witsml21.Log':
        case 'witsml21.ChannelSet':
            return;   // derived from the rig's runs and channels
        default:
            throw bad(E.EDATAOBJECTTYPE_NOTSUPPORTED, `${type} is not supported`);
    }
}

async function putCompany(name) {
    await pool.query('INSERT INTO business_associates (uuid, name) VALUES ($1, $2) ON CONFLICT (uuid) DO NOTHING',
        [ids.businessAssociate(name), name]);
}

// ---- Channel data ------------------------------------------------------------------------
/**
 * Store points of one rig: [{ metric, factor, ts (micros), value (presented) }].
 * @returns number of points newly stored
 */
async function storePoints(rigId, points) {
    if (!points.length) return 0;
    const ts = []; const metric = []; const value = [];
    // A fixed order (time, metric) keeps row locks in the same order as /ingest's.
    points = points.slice().sort((a, b) => (a.ts - b.ts) || (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
    for (const p of points) {
        const v = Number(p.value);
        if (!Number.isFinite(v)) continue;
        ts.push(fromMicros(p.ts).toISOString());
        metric.push(p.metric);
        value.push(v / (p.factor || 1));
    }
    if (!ts.length) return 0;
    const r = await pool.query(
        `INSERT INTO telemetry (ts, rig_id, metric, value)
         SELECT u.ts, $2, u.metric, u.value FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)
         ON CONFLICT DO NOTHING`, [ts, rigId, metric, value]);
    // Channel extents and rig freshness.
    const extent = new Map();
    for (let i = 0; i < ts.length; i++) {
        const e = extent.get(metric[i]) || { min: ts[i], max: ts[i] };
        if (ts[i] < e.min) e.min = ts[i];
        if (ts[i] > e.max) e.max = ts[i];
        extent.set(metric[i], e);
    }
    const ms = [...extent.keys()].sort();   // same lock order for every writer
    await pool.query(
        `UPDATE channels c SET first_ts = LEAST(COALESCE(c.first_ts, u.min), u.min), last_ts = GREATEST(COALESCE(c.last_ts, u.max), u.max)
           FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[]) AS u(metric, min, max)
          WHERE c.rig_id = $1 AND c.metric = u.metric`,
        [rigId, ms, ms.map((m) => extent.get(m).min), ms.map((m) => extent.get(m).max)]);
    const latest = ts.reduce((a, b) => (b > a ? b : a));
    await pool.query('UPDATE rigs SET last_data_at = GREATEST(COALESCE(last_data_at, $2::timestamptz), $2::timestamptz) WHERE rig_id = $1', [rigId, latest]);
    return r.rowCount;
}

module.exports = { putObject, storePoints, text, ref, rootUuid };
