'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'edge-backend-jwt-secret-for-auth-tests';
process.env.MCP_BACKEND_TOKEN = 'edge-backend-mcp-readonly-token-for-tests';
const auth = require('../lib/auth');

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test('MCP service credential authenticates GET as a viewer', () => {
    const req = {
        method: 'GET',
        headers: { authorization: `Bearer ${process.env.MCP_BACKEND_TOKEN}` },
    };
    const res = responseRecorder();
    let nextCalled = false;
    auth.requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.username, 'mcp-readonly');
    assert.equal(req.user.role, 'viewer');
    assert.equal(req.authKind, 'mcp-service');
});

test('MCP service credential is rejected before every write method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const req = {
            method,
            headers: { authorization: `Bearer ${process.env.MCP_BACKEND_TOKEN}` },
        };
        const res = responseRecorder();
        let nextCalled = false;
        auth.requireAuth(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false, method);
        assert.equal(res.statusCode, 403, method);
        assert.match(res.body.error, /read-only/i, method);
    }
});
