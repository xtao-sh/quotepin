import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-origin-test-"));
process.env.REVIEW_APP_DATA = tempDir;
process.env.REVIEW_API_TOKEN = "a".repeat(64);

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const normal = await fetch(`${baseUrl}/api/workspace`);
  assert.equal(normal.status, 401);
  assert.equal(normal.headers.get("access-control-allow-origin"), null);

  const authenticated = await fetch(`${baseUrl}/api/workspace`, {
    headers: { "X-Review-Api-Token": process.env.REVIEW_API_TOKEN }
  });
  assert.equal(authenticated.status, 200);

  const bootstrap = await fetch(`${baseUrl}/?cap=${process.env.REVIEW_API_TOKEN}`, { redirect: "manual" });
  assert.equal(bootstrap.status, 302);
  const cookie = bootstrap.headers.get("set-cookie");
  assert.match(cookie, /review_cap=/);
  const cookieAuthenticated = await fetch(`${baseUrl}/api/workspace`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(cookieAuthenticated.status, 200);

  const hostile = await fetch(`${baseUrl}/api/workspace`, {
    headers: { Origin: "https://attacker.example", "X-Review-Api-Token": process.env.REVIEW_API_TOKEN }
  });
  assert.equal(hostile.status, 403);
  assert.deepEqual(await hostile.json(), { ok: false, error: "origin_forbidden" });
  assert.equal(hostile.headers.get("access-control-allow-origin"), null);

  const rebound = await requestJson(port, "/api/workspace", {
    Host: `attacker.example:${port}`,
    Origin: `http://attacker.example:${port}`
  });
  assert.equal(rebound.status, 403);
  assert.deepEqual(rebound.body, { ok: false, error: "host_forbidden" });

  const mismatchedLocalOrigin = await fetch(`${baseUrl}/api/workspace`, {
    headers: {
      Origin: `http://localhost:${port}`
    }
  });
  assert.equal(mismatchedLocalOrigin.status, 403);

  const sameOrigin = await fetch(`${baseUrl}/api/workspace`, {
    headers: { Origin: baseUrl, "X-Review-Api-Token": process.env.REVIEW_API_TOKEN }
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get("x-content-type-options"), "nosniff");
  assert.equal(sameOrigin.headers.get("x-frame-options"), "DENY");

  const diagnostics = await fetch(`${baseUrl}/api/diagnostics`, {
    headers: { "X-Review-Api-Token": process.env.REVIEW_API_TOKEN }
  }).then((response) => response.json());
  assert.equal(diagnostics.apiCapabilityEnabled, true);
  assert.equal(JSON.stringify(diagnostics).includes(process.env.REVIEW_API_TOKEN), false);
  assert.equal(typeof diagnostics.tools.mcp, "boolean");

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(typeof health.storeId, "string");
  assert.equal(health.storeId.length, 24);
  assert.equal("store" in health, false);

  console.log("security-origin.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function requestJson(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once("error", reject);
    request.end();
  });
}
