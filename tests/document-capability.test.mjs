import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-doc-capability-test-"));
process.env.REVIEW_APP_DATA = tempDir;
process.env.REVIEW_API_TOKEN = "d".repeat(64);
const appHeaders = { "X-Review-Api-Token": process.env.REVIEW_API_TOKEN, "Content-Type": "application/json" };

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixtureDir = path.join(tempDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const openPath = path.join(fixtureDir, "打开的.txt");
  const otherPath = path.join(fixtureDir, "另一份.txt");
  fs.writeFileSync(openPath, "当前打开这一份的正文。", "utf8");
  fs.writeFileSync(otherPath, "另一份文档的正文，不该被读到。", "utf8");

  await app("POST", "/api/projects", { id: "p", name: "边界", path: fixtureDir });
  const openDoc = (await app("POST", "/api/documents/import-path", { path: openPath, projectId: "p" })).document;
  const otherDoc = (await app("POST", "/api/documents/import-path", { path: otherPath, projectId: "p" })).document;
  await app("PUT", "/api/review/context", { documentId: openDoc.id });

  const integration = await app("GET", "/api/integrations/ai");
  const env = integration.mcp.jsonConfig.mcpServers[integration.mcp.serverName].env;

  // The workspace-wide capability must never leave through an MCP config again.
  assert.equal("REVIEW_API_TOKEN" in env, false, "导出的 MCP 配置仍然包含全局令牌");
  assert.doesNotMatch(integration.mcp.codexCommand, /REVIEW_API_TOKEN/);
  assert.doesNotMatch(integration.mcp.claudeCommand, /REVIEW_API_TOKEN/);
  assert.match(env.REVIEW_DOCUMENT_TOKEN, /^[a-f0-9]{64}$/);
  assert.notEqual(env.REVIEW_DOCUMENT_TOKEN, process.env.REVIEW_API_TOKEN);

  const scoped = { "X-Review-Document-Token": env.REVIEW_DOCUMENT_TOKEN, "Content-Type": "application/json" };
  const status = async (method, endpoint, body) => (await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: scoped,
    body: body ? JSON.stringify(body) : undefined
  })).status;

  // The routes this connection legitimately needs.
  assert.equal(await status("GET", "/api/review/context"), 200);
  assert.equal(await status("GET", "/api/review/document"), 200);
  assert.equal(await status("GET", "/api/review/threads"), 200);
  assert.equal(await status("GET", `/api/documents/${openDoc.id}/pages/1/text`), 200);

  // Everything the workspace token used to unlock along with them.
  for (const [method, endpoint] of [
    ["GET", "/api/workspace"],
    ["GET", "/api/backup"],
    ["GET", "/api/backup/full"],
    ["GET", "/api/diagnostics"],
    ["GET", "/api/integrations/ai"],
    ["GET", "/api/review/tasks"],
    ["POST", "/api/open-data-folder"],
    ["DELETE", `/api/documents/${openDoc.id}`],
    ["PUT", "/api/review/context"]
  ]) {
    assert.equal(await status(method, endpoint), 401, `${method} ${endpoint} 未被拒绝`);
  }

  // "Only the active document" is now the server's rule, not the MCP process's.
  assert.equal(await status("GET", `/api/documents/${otherDoc.id}/pages/1/text`), 403);
  assert.equal(
    await status("POST", "/api/review/threads", {
      documentId: otherDoc.id,
      page: 1,
      comment: "越界",
      annotation: { id: "x-cross", type: "note", text: "越界" }
    }),
    403
  );

  // The listing takes its documentId from the query, so omitting or changing the filter must not
  // widen what this credential can see.
  const listAll = await (await fetch(`${baseUrl}/api/review/threads`, { headers: scoped })).json();
  assert.equal(listAll.threads.every((thread) => thread.documentId === openDoc.id), true, "列表泄露了其他文档的批注");
  const listOther = await (await fetch(`${baseUrl}/api/review/threads?documentId=${otherDoc.id}`, { headers: scoped })).json();
  assert.equal(listOther.threads.every((thread) => thread.documentId === openDoc.id), true, "指定别的文档就能读到它的批注");

  // Nor may it close a thread by claiming to be the reviewer.
  const closeAttempt = await fetch(`${baseUrl}/api/review/threads/x-inside`, {
    method: "PATCH",
    headers: scoped,
    body: JSON.stringify({ status: "resolved", role: "human" })
  });
  assert.equal(closeAttempt.status, 403);
  assert.equal((await closeAttempt.json()).error, "status_requires_human");

  // A thread on the active document works, and the same thread stops being reachable once the
  // app switches to another document.
  const created = await fetch(`${baseUrl}/api/review/threads`, {
    method: "POST",
    headers: scoped,
    body: JSON.stringify({
      documentId: openDoc.id,
      page: 1,
      comment: "这条应当成功。",
      annotation: { id: "x-inside", type: "note", text: "这条应当成功。" }
    })
  });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal(await status("GET", "/api/review/threads/x-inside"), 200);

  await app("PUT", "/api/review/context", { documentId: otherDoc.id });
  assert.equal(await status("GET", "/api/review/threads/x-inside"), 403);
  assert.equal(await status("GET", `/api/documents/${openDoc.id}/pages/1/text`), 403);

  // With no document open at all, the connection has nothing to work on.
  await app("PUT", "/api/review/context", { documentId: "" });
  assert.equal(await status("GET", "/api/review/threads"), 409);

  // Rotating the credential invalidates the copy already handed out.
  const before = env.REVIEW_DOCUMENT_TOKEN;
  await app("PUT", "/api/review/context", { documentId: openDoc.id });
  assert.equal(await status("GET", "/api/review/context"), 200);
  const { rotated } = await app("POST", "/api/review/rotate-document-token", {});
  assert.match(rotated, /^[a-f0-9]{64}$/);
  assert.notEqual(rotated, before);
  assert.equal(await status("GET", "/api/review/context"), 401);

  console.log("document-capability.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function app(method, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: appHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, `${method} ${endpoint} -> ${JSON.stringify(json)}`);
  return json;
}
