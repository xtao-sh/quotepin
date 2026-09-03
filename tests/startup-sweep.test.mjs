import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Only .incoming-documents was ever cleaned at startup, so interrupted uploads and restores, export
// scratch, and per-document directories left by a crash accumulated with no way to reclaim them.
// The sweep must remove exactly the unreferenced ones and nothing that is still in use.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-sweep-test-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const fixtureDir = path.join(tempDir, "fixtures");
fs.mkdirSync(fixtureDir, { recursive: true });
const notePath = path.join(fixtureDir, "在用的.txt");
fs.writeFileSync(notePath, "仍在使用的文档。", "utf8");

const { startServer } = await import("../server/index.js");
let server = startServer(0);
let port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
let baseUrl = `http://127.0.0.1:${port}`;

try {
  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "清扫", path: fixtureDir });
  const live = (await postJson(`${baseUrl}/api/documents/import-path`, { path: notePath, projectId: "p" })).document;
  await postJson(`${baseUrl}/api/review/threads`, {
    documentId: live.id,
    page: 1,
    comment: "保留这条。",
    annotation: { id: "ai-live", type: "note", text: "保留这条。" }
  });
  const liveTask = (await postJson(`${baseUrl}/api/review/tasks`, { scope: "document", documentId: live.id })).task;

  // Directories that belong to live records, so the sweep must leave them alone.
  const liveRender = path.join(tempDir, "renders", live.id);
  const liveVersion = path.join(tempDir, "versions", live.id);
  fs.mkdirSync(liveRender, { recursive: true });
  fs.mkdirSync(liveVersion, { recursive: true });
  fs.writeFileSync(path.join(liveVersion, "v1.bin"), "旧版本");
  assert.equal(fs.existsSync(liveTask.directoryPath), true);

  await new Promise((resolve) => server.close(resolve));

  // Everything a crash could leave behind.
  const orphans = [
    path.join(tempDir, "uploads", "doc-gone.pdf"),
    path.join(tempDir, "renders", "doc-gone"),
    path.join(tempDir, "versions", "doc-gone"),
    path.join(tempDir, "review-tasks", "REV-20200101-GONE01"),
    path.join(tempDir, ".incoming-backups", "half.reviewbackup"),
    path.join(tempDir, ".export-tmp", "scratch.json"),
    path.join(tempDir, ".restore-staging-abc123"),
    path.join(tempDir, ".restore-rollback-abc123")
  ];
  for (const target of orphans) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (target.includes(".") && !target.endsWith("abc123")) fs.writeFileSync(target, "孤儿");
    else fs.mkdirSync(target, { recursive: true });
  }
  for (const target of orphans) assert.equal(fs.existsSync(target), true, `${target} 夹具没建起来`);

  server = startServer(0);
  port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
  baseUrl = `http://127.0.0.1:${port}`;

  for (const target of orphans) {
    assert.equal(fs.existsSync(target), false, `${path.basename(target)} 没有被清扫`);
  }

  // The live records survived, and so did the workspace itself.
  assert.equal(fs.existsSync(liveRender), true, "在用文档的渲染目录被误删");
  assert.equal(fs.existsSync(liveVersion), true, "在用文档的版本目录被误删");
  assert.equal(fs.existsSync(liveTask.directoryPath), true, "在用任务的快照目录被误删");
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  assert.deepEqual(workspace.documents.map((item) => item.id), [live.id]);
  assert.equal(workspace.reviewTasks.length, 1);
  assert.equal(fs.existsSync(live.sourcePath), true, "在用文档的托管副本被误删");

  // A MISSING workspace.json is not an empty workspace. readJson returns {} for it, so the store
  // loads clean and nothing flags a problem — and the sweep would then read "no documents" as
  // "delete everything". This is the case the hourly snapshots exist for.
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(path.join(tempDir, "workspace.json"), { force: true });

  server = startServer(0);
  port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
  baseUrl = `http://127.0.0.1:${port}`;

  assert.equal(fs.existsSync(live.sourcePath), true, "索引丢失后托管副本被删了");
  assert.equal(fs.existsSync(liveRender), true, "索引丢失后渲染目录被删了");
  assert.equal(fs.existsSync(liveVersion), true, "索引丢失后版本目录被删了");
  assert.equal(fs.existsSync(liveTask.directoryPath), true, "索引丢失后任务快照被删了");

  // And the app says so, rather than presenting an empty workspace as normal.
  const recovery = await getJson(`${baseUrl}/api/recovery`);
  assert.equal(recovery.active, true, "索引丢失没有进入恢复模式");
  assert.equal(recovery.code, "WORKSPACE_INDEX_MISSING");
  assert.equal((await fetch(`${baseUrl}/api/workspace`)).status, 503);

  console.log("startup-sweep.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}
