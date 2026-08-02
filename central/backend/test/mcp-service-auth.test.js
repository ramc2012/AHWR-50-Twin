'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'central-backend-jwt-secret-for-auth-tests';
process.env.MCP_BACKEND_TOKEN = 'central-backend-mcp-readonly-token-tests';
process.env.AUTH_MODE = 'local';
const auth = require('../lib/auth');

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function invoke(method) {
    return new Promise((resolve) => {
        const req = {
            method,
            headers: { authorization: `Bearer ${process.env.MCP_BACKEND_TOKEN}` },
        };
        const res = responseRecorder();
        let nextCalled = false;
        auth.requireAuth(req, res, () => {
            nextCalled = true;
            resolve({ req, res, nextCalled });
        });
        setImmediate(() => resolve({ req, res, nextCalled }));
    });
}

test('MCP service credential authenticates GET as a viewer', async () => {
    const { req, nextCalled } = await invoke('GET');
    assert.equal(nextCalled, true);
    assert.equal(req.user.username, 'mcp-readonly');
    assert.equal(req.user.role, 'viewer');
    assert.equal(req.authKind, 'mcp-service');
});

test('MCP service credential is rejected before every write method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const { res, nextCalled } = await invoke(method);
        assert.equal(nextCalled, false, method);
        assert.equal(res.statusCode, 403, method);
        assert.match(res.body.error, /read-only/i, method);
    }
});
