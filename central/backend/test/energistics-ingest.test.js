// Ingest of the edge's channel dictionary and well identity (WITSML 2.1 / ETP
// v1.2). Needs a database with init.sql and db/migrations applied:
//   ENERGISTICS_TEST_DB=1 PGHOST=127.0.0.1 PGPORT=25433 PGUSER=crmf_app PGPASSWORD=... PGDATABASE=crmf npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const skip = process.env.ENERGISTICS_TEST_DB ? false : 'set ENERGISTICS_TEST_DB=1 and PG* for a migrated test database';
const RIG = 'AHWR-INGEST-TEST';
const TOKEN = 'ingest-test-token-0123456789';

test('dictionary, extents and run identity from a sync batch', { skip }, async () => {
  const { pool } = require('../lib/db');
  const ids = require('../lib/ids');
  const { ingestBatch } = require('../lib/ingest');
  const wells = require('../lib/wells');
  await pool.query('DELETE FROM channels WHERE rig_id = $1', [RIG]);
  await pool.query('DELETE FROM well_runs WHERE rig_id = $1', [RIG]);
  await pool.query('DELETE FROM telemetry WHERE rig_id = $1', [RIG]);
  await pool.query(`INSERT INTO rigs (rig_id, name, device_token, status) VALUES ($1, $1, $2, 'online')
                    ON CONFLICT (rig_id) DO UPDATE SET device_token = EXCLUDED.device_token, last_seq = NULL`, [RIG, TOKEN]);
  const startedAt = '2026-10-13T06:00:00.000Z';
  const pk = { uuid: 'f001a670-584b-4527-9db5-89bc304b82a5', title: 'standpipe pressure' };
  const batch = {
    seq: 1, deviceId: RIG, schemaVersion: '1.0', createdAt: new Date().toISOString(),
    dictionary: [
      { metric: 'mudpump.pressure', mnemonic: 'SPPA', label: 'Pump Pressure', group: 'Pump', storedUnit: 'bar', uom: 'psi', factor: 14.5037738, dataKind: 'double', propertyKind: pk, unitSource: 'catalog' },
      { metric: 'bad', mnemonic: 'X'.repeat(65), uom: 'psi', propertyKind: pk },             // rejected: mnemonic too long
      { metric: 'other', mnemonic: 'OTH', uom: 'psi', propertyKind: { uuid: 'not-a-uuid', title: 'x' } }, // rejected
    ],
    loggingCompany: 'ONGC',
    channels: [
      { ts: '2026-10-13T06:00:01.000Z', values: { 'mudpump.pressure': 120, well: { name: 'GS-T#1', startedAt } } },
      { ts: '2026-10-13T06:00:02.000Z', values: { 'mudpump.pressure': 121, well: { name: 'GS-T#1', startedAt } } },
    ],
    events: [],
  };
  const r = await ingestBatch({ rigId: RIG, token: TOKEN, schemaVersion: '1.0' }, batch);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.activeWell, { name: 'GS-T#1', startedAt });
  const { rows } = await pool.query('SELECT metric, uuid, uom, factor, property_kind, logging_company, first_ts, last_ts FROM channels WHERE rig_id = $1', [RIG]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, ids.channel(RIG, 'mudpump.pressure'));
  assert.deepEqual([rows[0].uom, Number(rows[0].factor), rows[0].property_kind, rows[0].logging_company], ['psi', 14.5037738, 'standpipe pressure', 'ONGC']);
  assert.equal(rows[0].first_ts.toISOString(), '2026-10-13T06:00:01.000Z');
  assert.equal(rows[0].last_ts.toISOString(), '2026-10-13T06:00:02.000Z');

  await wells.trackRun(RIG, r.activeJob, Date.now(), { startedAt: r.activeWell.startedAt });
  const run = (await pool.query('SELECT well_id, started_at, uuid FROM well_runs WHERE rig_id = $1', [RIG])).rows;
  assert.equal(run.length, 1);
  assert.equal(run[0].started_at.toISOString(), startedAt);
  assert.equal(run[0].uuid, ids.rigUtilization(RIG, 'GS-T#1', startedAt));
  const wb = (await pool.query('SELECT uuid FROM wellbores WHERE well_id = $1', ['GS-T#1'])).rows;
  assert.equal(wb[0].uuid, ids.wellbore('GS-T#1'));
  const rigRow = (await pool.query('SELECT uuid FROM rigs WHERE rig_id = $1', [RIG])).rows[0];
  assert.equal(rigRow.uuid, ids.rig(RIG));
  await pool.end();
});
