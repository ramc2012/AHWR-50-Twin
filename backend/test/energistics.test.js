// The twin's memory-backed Energistics view (lib/energistics.js): channel
// dictionary from the catalog, field map and PLC config; data from recent
// snapshots; WITSML 2.1 objects of a started well (validated against the
// official schemas when WITSML21_XSD_DIR is set).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const energistics = require('../lib/energistics');
const ids = require('../lib/ids');

const T0 = Date.parse('2026-10-13T08:00:00Z');
const recent = [0, 1, 2].map((i) => ({
  ts: new Date(T0 + i * 1000).toISOString(),
  values: { 'mudpump.pressure': 100 + i, 'hpu.fan1_groupfault': 0, 'AHWR.Extra Tag-bar': 5, well: { name: 'GS-11#4' } },
}));
energistics.configure({
  getRigId: () => 'AHWR-TWIN', getRecent: () => recent,
  getWells: () => [{ id: 'w1', name: 'GS-11#4', operator: 'ONGC', field: 'Ankleshwar', status: 'active', startedAt: '2026-10-13T07:00:00.000Z' }],
  getPlcConfig: () => ({ slaves: [{ protocol: 's7comm', metrics: [{ name: 'AHWR', fields: [
    { name: 'SPP-Bar', address: 'DB3191.R72' }, { name: 'Fan1 GroupFault', address: 'DB119.X10.0' }, { name: 'Extra Tag-bar', address: 'DB1.R4' },
  ] }] }] }),
  catalog: { categories: [{ id: 'mudpump', label: 'Mud Pump', fields: [{ id: 'pressure', label: 'Pump Pressure', unit: 'bar' }] }] },
  fieldMap: { 'SPP-Bar': { meas: 'mudpump', field: 'pressure' }, 'Fan1 GroupFault': { meas: 'hpu', field: 'fan1_groupfault' } },
});

test('dictionary: catalog units, PLC bits are flags, units written in tag names', () => {
  const d = energistics.getDictionary();
  assert.deepEqual([d.get('mudpump.pressure').uom, d.get('mudpump.pressure').propertyKind.title], ['psi', 'standpipe pressure']);
  assert.deepEqual([d.get('hpu.fan1_groupfault').uom, d.get('hpu.fan1_groupfault').unitSource], ['Euc', 'plc-bit']);
  assert.deepEqual([d.get('AHWR.Extra Tag-bar').uom, d.get('AHWR.Extra Tag-bar').unitSource], ['bar', 'label']);
  assert.equal(d.get('mudpump.pressure').uuid, ids.channel('AHWR-TWIN', 'mudpump.pressure'));
});

test('readTelemetry: points in (after, upto], numbers only', () => {
  const rows = energistics.readTelemetry(T0, T0 + 2000, 100);
  assert.deepEqual([...new Set(rows.map((r) => r.ts.getTime()))], [T0 + 1000, T0 + 2000]);
  assert.ok(rows.every((r) => typeof r.value === 'number'));
  assert.equal(energistics.readTelemetry(0, Infinity, 2).length, 2);
});

test('objects of a started well; all valid WITSML 2.1 / eml 2.3 (WITSML21_XSD_DIR)', async () => {
  const list = await energistics.listObjects();
  const types = new Set(list.map((o) => o.type));
  for (const t of ['witsml21.Rig', 'witsml21.Well', 'witsml21.Wellbore', 'witsml21.RigUtilization', 'witsml21.Log', 'witsml21.ChannelSet', 'witsml21.Channel', 'eml23.PropertyKind', 'eml23.BusinessAssociate']) {
    assert.ok(types.has(t), t);
  }
  const dir = process.env.WITSML21_XSD_DIR;
  if (!dir) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-w21-'));
  for (const o of list) {
    const f = path.join(tmp, `${o.uuid}.xml`);
    fs.writeFileSync(f, await o.xml());
    const xsd = o.type.startsWith('eml23') ? 'common/v2.3/xsd_schemas/EmlAllObjects.xsd' : 'witsml/v2.1/xsd_schemas/WitsmlAllObjects.xsd';
    execFileSync('xmllint', ['--noout', '--schema', path.join(dir, xsd), f], { stdio: 'pipe' });
  }
});
