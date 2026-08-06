'use strict';
// /ingest pre-authorization gate: an unknown caller must be rejected BEFORE any
// request body is read or inflated (gzip-bomb hardening). No database is needed —
// PGPORT points at a dead port on purpose, which exercises the "device-token
// lookup failed => stay closed" path.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INGEST_TOKEN = 'unit-test-global-ingest-token';
process.env.ALLOW_OPEN_INGEST = '';
process.env.PGHOST = '127.0.0.1';
process.env.PGPORT = '1';
const ingest = require('../lib/ingest');

test('the configured global token pre-authorizes', async () => {
    assert.equal(await ingest.preAuthorize('unit-test-global-ingest-token'), true);
});

test('a missing bearer token is rejected', async () => {
    assert.equal(await ingest.preAuthorize(null), false);
    assert.equal(await ingest.preAuthorize(''), false);
});

test('an unknown token is rejected even when the device-token lookup fails', async () => {
    assert.equal(await ingest.preAuthorize('not-the-token'), false);
});

test('a token of a different length is rejected without throwing', async () => {
    assert.equal(await ingest.preAuthorize('short'), false);
    assert.equal(await ingest.preAuthorize('unit-test-global-ingest-token-and-then-some'), false);
});

test('invalidateTokenCache is callable and idempotent', () => {
    ingest.invalidateTokenCache();
    ingest.invalidateTokenCache();
});
