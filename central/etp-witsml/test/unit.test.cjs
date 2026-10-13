// Unit tests that need no database: codec, URIs, identifiers, WITSML 2.1 output
// and the capabilities record.
const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../lib/etp12/codec');
const uri = require('../lib/etp12/uri');
const ids = require('../lib/ids');
const w21 = require('../lib/witsml21');

test('codec round-trips store, subscribe and load messages; exceptions in any protocol', () => {
  const g = codec.decode(codec.encode(4, 'GetDataObjects', { uris: { 1: 'eml:///witsml21.Well(ac4bd46e-6433-5549-aa26-cf099ca794de)' }, format: 'xml' }, { messageId: 2 }));
  assert.deepEqual([g.protocol, g.name, g.header.messageType], [4, 'GetDataObjects', 1]);
  const o = codec.decode(codec.encode(22, 'OpenChannels', { uris: { a: 'eml:///witsml21.Channel(fd264b1f-bd76-5603-bc01-4d82c09d9c63)' } }, { messageId: 4 }));
  assert.equal(o.name, 'OpenChannels');
  const pe = codec.decode(codec.encode(21, 'ProtocolException', { error: null, errors: { a: { message: 'x', code: 11 } } }, { messageId: 5, correlationId: 4 }));
  assert.deepEqual([pe.protocol, pe.name, pe.body.errors.a.code], [21, 'ProtocolException', 11]);
});

test('identifiers match the edge (RFC 4122 v5 in the AHWR namespace)', () => {
  assert.equal(ids.NAMESPACE, '0c778a8a-d94f-55c2-9951-37777e6d4d11');
  assert.equal(ids.channel('AHWR-50-III', 'drawworks.hook_load'), 'fd264b1f-bd76-5603-bc01-4d82c09d9c63');
  assert.equal(ids.well('GS-11#4'), 'ac4bd46e-6433-5549-aa26-cf099ca794de');
  assert.equal(uri.parse(uri.object('witsml21.Well', ids.well('GS-11#4'))).uuid, ids.well('GS-11#4'));
});

test('capabilities record encodes (binary and Avro JSON)', () => {
  const { serverCapabilities } = require('../lib/etpServer');
  const t = codec.records.ServerCapabilities;
  const caps = serverCapabilities();
  assert.deepEqual(t.fromBuffer(t.toBuffer(caps)).supportedEncodings, ['binary']);
  assert.ok(JSON.parse(t.toString(caps)).supportedProtocols.some((p) => p.protocol === 22));
});

test('WITSML 2.1 rig object names the CRMF application', () => {
  w21.setApplication('CRMF ETP/WITSML test');
  assert.match(w21.rig('AHWR-50-III', { creation: '2026-01-01T00:00:00Z' }), /<eml:Format>CRMF ETP\/WITSML test<\/eml:Format>/);
});
