// Integration test against a running server with data from a rig edge:
//   ETP_TEST_URL=ws://127.0.0.1:18443 ETP_TEST_JWT_SECRET=<server JWT_SECRET> npm test
// Optional: WITSML21_XSD_DIR (energyml/data of the official schemas) validates
// every object returned by Store GetDataObjects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const codec = require('../lib/etp12/codec');
const { EtpSession } = require('../lib/etp12/session');
const uri = require('../lib/etp12/uri');

const URL_ = process.env.ETP_TEST_URL;
const SECRET = process.env.ETP_TEST_JWT_SECRET;
const skip = !URL_ || !SECRET ? 'set ETP_TEST_URL and ETP_TEST_JWT_SECRET' : false;
const { PROTOCOL: P, VERSION } = codec;

function connect({ auth = `Bearer ${jwt.sign({ username: 'it-viewer', role: 'viewer' }, SECRET || 'x')}`, protocols = [[3, 'store'], [4, 'store'], [21, 'store'], [2, 'store']] } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_, codec.SUBPROTOCOL, { headers: { authorization: auth, 'etp-encoding': 'binary' } });
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
    ws.on('open', async () => {
      const s = new EtpSession(ws, { side: 'client' });
      try {
        const r = await s.request(P.Core, 'RequestSession', {
          applicationName: 'integration test', applicationVersion: '1', clientInstanceId: Buffer.alloc(16, 7),
          requestedProtocols: protocols.map(([protocol, role]) => ({ protocol, protocolVersion: VERSION, role, protocolCapabilities: {} })),
          supportedDataObjects: [], supportedCompression: [], supportedFormats: ['xml'],
          currentDateTime: Date.now() * 1000, earliestRetainedChangeTime: 0, serverAuthorizationRequired: false, endpointCapabilities: {},
        });
        resolve({ s, open: r.parts[0].body });
      } catch (e) { reject(e); }
    });
  });
}
const getResources = (s, u, { scope = 'self', depth = 1, types = [], edges = false, count = false } = {}) => s.request(P.Discovery, 'GetResources', {
  context: { uri: u, depth, dataObjectTypes: types, navigableEdges: 'Primary', includeSecondaryTargets: false, includeSecondarySources: false },
  scope, countObjects: count, storeLastWriteFilter: null, activeStatusFilter: null, includeEdges: edges,
});
const resourcesOf = (r) => r.parts.filter((m) => m.name === 'GetResourcesResponse').flatMap((m) => m.body.resources);

test('capabilities document: binary Avro ServerCapabilities and GetVersions', { skip }, async () => {
  const base = URL_.replace(/^ws/, 'http');
  const get = (q) => new Promise((resolve, reject) => http.get(`${base}/.well-known/etp-server-capabilities${q}`, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
  }).on('error', reject));
  const v = await get('?GetVersions=true');
  assert.deepEqual(JSON.parse(v.body), ['etp12.energistics.org']);
  const caps = codec.records.ServerCapabilities.fromBuffer((await get('')).body);
  assert.deepEqual(caps.supportedEncodings, ['binary']);
  assert.ok(caps.supportedProtocols.some((p) => p.protocol === 22 && p.role === 'store'));
  assert.ok(caps.supportedDataObjects.some((d) => d.qualifiedType === 'witsml21.Channel'));
});

test('authorization: anonymous refused; a viewer cannot load data (no ChannelDataLoad)', { skip }, async () => {
  await assert.rejects(connect({ auth: '' }), (e) => e.status === 401);
  const { s, open } = await connect({ protocols: [[3, 'store'], [22, 'store']] });
  assert.deepEqual(open.supportedProtocols.map((p) => p.protocol), [3]);
  s.close();
});

let channelUri; let setUri; let wellUri;
test('discovery: dataspace listing and the well graph', { skip }, async () => {
  const { s } = await connect();
  const wells = resourcesOf(await getResources(s, 'eml:///', { types: ['witsml21.Well'] }));
  assert.ok(wells.length >= 1);
  wellUri = wells.find((w) => w.name.includes('GS-11')).uri;
  const below = resourcesOf(await getResources(s, wellUri, { scope: 'sources', depth: 2, count: true }));
  const types = new Set(below.map((r) => uri.parse(r.uri).type));
  for (const t of ['witsml21.Wellbore', 'witsml21.Log', 'witsml21.ChannelSet', 'witsml21.RigUtilization']) assert.ok(types.has(t), t);
  setUri = below.find((r) => r.uri.includes('ChannelSet')).uri;
  const chans = resourcesOf(await getResources(s, setUri, { scope: 'sources', depth: 1, types: ['witsml21.Channel'] }));
  assert.ok(chans.length > 500, `channels of the set: ${chans.length}`);
  channelUri = chans.find((c) => /Pump Pressure/.test(c.name)).uri;
  const withEdges = await getResources(s, wellUri, { scope: 'sources', depth: 1, edges: true });
  const edges = withEdges.parts.filter((m) => m.name === 'GetResourcesEdgesResponse').flatMap((m) => m.body.edges);
  assert.ok(edges.some((e) => e.targetUri === wellUri && e.sourceUri.includes('Wellbore')));
  await assert.rejects(getResources(s, 'eml:///witsml21.Well(00000000-0000-0000-0000-000000000000)'), (e) => e.etpCode === 11);
  await assert.rejects(getResources(s, 'eml://bad'), (e) => e.etpCode === 9);
  s.close();
});

test('store: GetDataObjects returns WITSML 2.1 XML; unknown keys get map errors', { skip }, async () => {
  const { s } = await connect();
  const uris = { 1: wellUri, 2: setUri, 3: channelUri, 4: 'eml:///eml23.PropertyKind(f001a670-584b-4527-9db5-89bc304b82a5)', 5: 'eml:///witsml21.Well(00000000-0000-0000-0000-000000000000)' };
  const r = await s.request(P.Store, 'GetDataObjects', { uris, format: 'xml' });
  const objs = r.parts.flatMap((m) => Object.entries(m.body.dataObjects));
  assert.deepEqual(objs.map(([k]) => k).sort(), ['1', '2', '3', '4']);
  assert.equal(r.errors['5'].code, 11);
  const xml = Object.fromEntries(objs.map(([k, o]) => [k, Buffer.from(o.data).toString('utf8')]));
  assert.match(xml['3'], /<witsml:Uom>psi<\/witsml:Uom>/);
  assert.match(xml['3'], /<eml:Title>standpipe pressure<\/eml:Title>/);
  const dir = process.env.WITSML21_XSD_DIR;
  if (dir) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'etp-it-'));
    for (const [k, x] of Object.entries(xml)) {
      const f = path.join(tmp, `${k}.xml`);
      fs.writeFileSync(f, x);
      const xsd = k === '4' ? 'common/v2.3/xsd_schemas/EmlAllObjects.xsd' : 'witsml/v2.1/xsd_schemas/WitsmlAllObjects.xsd';
      execFileSync('xmllint', ['--noout', '--schema', path.join(dir, xsd), f], { stdio: 'pipe' });
    }
  }
  s.close();
});

test('channel subscribe: metadata (psi, PWLS), ranges, live data, unsubscribe', { skip }, async () => {
  const { s } = await connect();
  const meta = (await s.request(P.ChannelSubscribe, 'GetChannelMetadata', { uris: { a: channelUri } })).parts[0].body.metadata.a;
  assert.equal(meta.uom, 'psi');
  assert.equal(meta.channelClassUri, 'eml:///eml23.PropertyKind(f001a670-584b-4527-9db5-89bc304b82a5)');
  const end = codec.indexOf(meta.indexes[0].interval.endIndex);
  assert.ok(end > (Date.now() - 120000) * 1000, 'channel has recent data');
  const ranges = await s.request(P.ChannelSubscribe, 'GetRanges', { requestUuid: Buffer.alloc(16, 3), channelRanges: [{ channelIds: [meta.id], interval: { startIndex: codec.indexValue(end / 1000 - 10000), endIndex: { item: { long: end } }, uom: 'us', depthDatum: '' }, secondaryIntervals: [] }] });
  const points = ranges.parts.flatMap((m) => m.body.data);
  assert.ok(points.length >= 9 && points.length <= 11, `points in 10 s: ${points.length}`);
  assert.ok(points.every((p) => p.value.item.double > 500), 'standpipe pressure in psi');
  const live = [];
  s.on('message', (m) => { if (m.name === 'ChannelData') live.push(...m.body.data); });
  const sub = await s.request(P.ChannelSubscribe, 'SubscribeChannels', { channels: { a: { channelId: meta.id, startIndex: { item: null }, dataChanges: true, requestLatestIndexCount: { int: 3 } } } });
  assert.deepEqual(Object.keys(sub.parts[0].body.success), ['a']);
  const t0 = Date.now();
  while (live.length < 6 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
  assert.ok(live.length >= 6, `latest 3 + live points: ${live.length}`);
  const times = live.map((d) => codec.indexOf(d.indexes[0]));
  times.forEach((t, i) => { if (i) assert.ok(t > times[i - 1], 'increasing, no repeats'); });
  const stop = await s.request(P.ChannelSubscribe, 'UnsubscribeChannels', { channelIds: { a: meta.id } });
  assert.equal(stop.parts[0].name, 'SubscriptionsStopped');
  s.close();
});

test('channel data frame: metadata and a 5-second frame of the run', { skip }, async () => {
  const { s } = await connect();
  const fm = (await s.request(P.ChannelDataFrame, 'GetFrameMetadata', { uri: setUri, includeAllChannelSecondaryIndexes: false })).parts[0].body;
  assert.ok(fm.channels.length > 500);
  const end = codec.indexOf(fm.indexes[0].interval.endIndex);
  const r = await s.request(P.ChannelDataFrame, 'GetFrame', {
    uri: setUri, includeAllChannelSecondaryIndexes: false, requestUuid: Buffer.alloc(16, 9), requestedSecondaryIntervals: [],
    requestedInterval: { startIndex: { item: { long: end - 5000000 } }, endIndex: { item: { long: end } }, uom: 'us', depthDatum: '' },
  });
  assert.equal(r.parts[0].name, 'GetFrameResponseHeader');
  assert.equal(r.parts[0].body.channelUris.length, fm.channels.length);
  const rows = r.parts.filter((m) => m.name === 'GetFrameResponseRows').flatMap((m) => m.body.frame);
  assert.ok(rows.length >= 4 && rows.length <= 6, `rows in 5 s: ${rows.length}`);
  assert.ok(rows.every((row) => row.points.length === fm.channels.length));
  s.close();
});
