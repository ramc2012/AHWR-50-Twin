import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BACKEND_TOKEN = "edge-oauth-readonly-backend-token-for-tests";
let issuerServer;
let mcp;
let issuer;
let baseUrl;
let publicUrl;
let mcpPort;
let privateKey;
let childLog = "";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function token({ audience = publicUrl, scope = "mcp:tools" } = {}) {
  return new SignJWT({ scope, client_id: "oauth-test-client" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function post(accessToken) {
  return fetch(publicUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  issuerServer = http.createServer((req, res) => {
    if (req.url !== "/jwks") {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] }));
  });
  const issuerPort = await listen(issuerServer);
  issuer = `http://127.0.0.1:${issuerPort}`;

  const reservation = http.createServer();
  mcpPort = await listen(reservation);
  reservation.close();
  await once(reservation, "close");
  baseUrl = `http://127.0.0.1:${mcpPort}`;
  publicUrl = `${baseUrl}/mcp`;

  mcp = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(mcpPort),
      BACKEND_URL: "http://127.0.0.1:9",
      MCP_BACKEND_TOKEN: BACKEND_TOKEN,
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_URL: publicUrl,
      MCP_OAUTH_ISSUER: issuer,
      MCP_OAUTH_AUDIENCE: publicUrl,
      MCP_OAUTH_JWKS_URL: `${issuer}/jwks`,
      MCP_OAUTH_SCOPES: "mcp:tools",
      MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      MCP_RATE_LIMIT_PER_MINUTE: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mcp.stdout.on("data", (chunk) => { childLog += chunk; });
  mcp.stderr.on("data", (chunk) => { childLog += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(25);
  }
  throw new Error(`OAuth MCP server did not start:\n${childLog}`);
});

after(async () => {
  if (mcp && mcp.exitCode === null) {
    mcp.kill("SIGTERM");
    await once(mcp, "exit");
  }
  if (issuerServer) {
    issuerServer.close();
    await once(issuerServer, "close");
  }
});

test("publishes OAuth protected-resource metadata", async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, publicUrl);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.deepEqual(metadata.scopes_supported, ["mcp:tools"]);
});

test("challenges missing credentials with protected-resource metadata", async () => {
  const response = await fetch(publicUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /resource_metadata=/);
});

test("validates OAuth issuer, audience, and required scope", async () => {
  const valid = await post(await token());
  assert.equal(valid.status, 200, childLog);
  const payload = await valid.json();
  assert.equal(payload.result.tools.length, 9);

  const wrongAudience = await post(await token({ audience: "https://wrong.example" }));
  assert.equal(wrongAudience.status, 401);

  const missingScope = await post(await token({ scope: "profile" }));
  assert.equal(missingScope.status, 401);
});
