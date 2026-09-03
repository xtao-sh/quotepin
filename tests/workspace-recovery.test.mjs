import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-recovery-test-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const historyDir = path.join(tempDir, "backups", "workspace-history");
fs.mkdirSync(historyDir, { recursive: true });

function snapshot(stamp, annotationCount) {
  const annotations = Array.from({ length: annotationCount }, (_, index) => ({
    id: `a-${stamp}-${index}`,
    type: "pin",
    x: 10,
    y: 10,
    text: "批注",
    createdAt: 1,
    updatedAt: 1
  }));
  fs.writeFileSync(path.join(historyDir, `workspace-${stamp}.json`), JSON.stringify({
    schemaVersion: 2,
    projects: [{ id: "p1", name: "项目", docIds: ["d1"], updated: 1 }],
    documents: [{ id: "d1", projectId: "p1", name: "报告.pdf", ext: "pdf", type: "pdf", renderMode: "pdf", pageCount: 12, updated: 1 }],
    annotations: { "d1:1": annotations },
    history: {},
    reviewThreads: {},
    reviewTasks: {},
    annotationRevisions: {},
    historyRevisions: {},
    exports: []
  }));
}

snapshot("2026-08-26T09-00-00-000Z", 4);
snapshot("2026-08-26T10-00-00-000Z", 8);
snapshot("2026-08-26T11-00-00-000Z", 12);

const storePath = path.join(tempDir, "workspace.json");
const corruptContent = "{ this is not valid json";
fs.writeFileSync(storePath, corruptContent);

const { startServer } = await import("../server/index.js");
// A workspace the app cannot read is exactly when the user needs the app; it must still boot.
const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const health = await getJson(`${baseUrl}/api/health`);
  assert.equal(health.recovery.code, "WORKSPACE_CORRUPT");

  // Everything that needs the workspace is refused while recovery is pending.
  const blocked = await fetch(`${baseUrl}/api/workspace`);
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, "workspace_recovery_required");

  const recovery = await getJson(`${baseUrl}/api/recovery`);
  assert.equal(recovery.active, true);
  assert.equal(recovery.snapshots.length, 3);
  assert.equal(recovery.snapshots.every((item) => item.usable), true);
  // Newest first, dated from the snapshot name rather than the file's mtime.
  assert.deepEqual(
    recovery.snapshots.map((item) => new Date(item.takenAt).toISOString()),
    ["2026-08-26T11:00:00.000Z", "2026-08-26T10:00:00.000Z", "2026-08-26T09:00:00.000Z"]
  );
  assert.deepEqual(recovery.snapshots.map((item) => item.annotationCount), [12, 8, 4]);

  // The unreadable file is preserved, and the message does not paste an absolute path at the user.
  assert.equal(fs.existsSync(recovery.preservedPath), true);
  assert.equal(fs.readFileSync(recovery.preservedPath, "utf8"), corruptContent);
  assert.doesNotMatch(recovery.detail, /\//);

  // Restoring an older snapshot restores exactly that one, not simply the newest.
  const restored = await postJson(`${baseUrl}/api/recovery/restore`, { snapshot: "workspace-2026-08-26T10-00-00-000Z.json" });
  assert.equal(restored.restored.name, "workspace-2026-08-26T10-00-00-000Z.json");
  assert.equal(restored.workspace.annotations["d1:1"].length, 8);

  // Recovery is over: the workspace routes work again without restarting the process.
  const afterRecovery = await getJson(`${baseUrl}/api/recovery`);
  assert.equal(afterRecovery.active, false);
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(workspace.documents.length, 1);
  assert.equal(workspace.annotations["d1:1"].length, 8);

  // Restoring again with nothing broken is refused rather than silently rolling the user back.
  const noop = await fetch(`${baseUrl}/api/recovery/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot: "workspace-2026-08-26T09-00-00-000Z.json" })
  });
  assert.equal(noop.status, 409);
  assert.equal((await noop.json()).error, "recovery_not_active");

  console.log("workspace-recovery.test.mjs passed");
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
