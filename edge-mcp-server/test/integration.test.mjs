import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const API_KEY = "edge-client-key-for-integration-tests";
const BACKEND_TOKEN = "edge-readonly-backend-token-for-tests-0001";
let backend;
let mcp;
let backendPort;
let mcpPort;
let childLog = "";

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function backendPayload(pathname) {
  if (pathname === "/api/alarms/config") {
    return [{ key: "pressure-hi", dataKey: "mudpump.pressure", enabled: true }];
  }
  if (pathname === "/api/history") {
    return Array.from({ length: 1200 }, (_, index) => ({
      ts: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
      metric: "drilling.rop",
      value: index,
    }));
  }
  if (pathname === "/api/health/edge") return { ok: true, stale: false };
  return { ok: true };
}

async function post(body, headers = {}) {
  return fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  backend = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${BACKEND_TOKEN}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(backendPayload(new URL(req.url, "http://backend").pathname)));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  backendPort = backend.address().port;
  mcpPort = await freePort();
  mcp = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(mcpPort),
      BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      MCP_BACKEND_TOKEN: BACKEND_TOKEN,
      MCP_API_KEY: API_KEY,
      MCP_API_KEY_ID: "edge-test-client",
      MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      MCP_RATE_LIMIT_PER_MINUTE: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mcp.stdout.on("data", (chunk) => { childLog += chunk; });
  mcp.stderr.on("data", (chunk) => { childLog += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/health`);
      if (response.ok) return;
    } catch {}
    await delay(25);
  }
  throw new Error(`MCP server did not start:\n${childLog}`);
});

after(async () => {
  if (mcp && mcp.exitCode === null) {
    mcp.kill("SIGTERM");
    await once(mcp, "exit");
  }
  if (backend) {
    backend.close();
    await once(backend, "close");
  }
});

test("requires authentication and advertises a bearer challenge", async () => {
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /^Bearer /);
});

test("rejects unapproved browser origins", async () => {
  const response = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { origin: "https://attacker.example" },
  );
  assert.equal(response.status, 403);
});

test("handles concurrent stateless requests without transport collisions", async () => {
  const responses = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    post({ jsonrpc: "2.0", id: 100 + index, method: "tools/list", params: {} })));
  assert.deepEqual(responses.map((response) => response.status), Array(16).fill(200), childLog);
  const payloads = await Promise.all(responses.map((response) => response.json()));
  assert.ok(payloads.every((payload) => payload.result.tools.length === 9), childLog);
});

test("wraps array results in protocol-valid structuredContent", async () => {
  const response = await post({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "edge_get_alarm_config", arguments: {} },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.isError, undefined);
  assert.ok(Array.isArray(payload.result.structuredContent.data));
});

test("bounds large structured results instead of retaining the full payload", async () => {
  const response = await post({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "edge_get_history",
      arguments: { metrics: "drilling.rop", range: "-1h" },
    },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.structuredContent.truncated, true);
  assert.equal("preview" in payload.result.structuredContent, false);
  assert.ok(payload.result.content[0].text.length < 26_000);
});
