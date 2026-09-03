import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unzipper from "unzipper";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-full-backup-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");
const { inspectFullBackup, recoverInterruptedFullRestore } = await import("../server/backup.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixturePath = path.join(tempDir, "fixture.jpg");
  fs.writeFileSync(fixturePath, tinyJpeg());
  await request("/api/projects", "POST", { id: "p-backup", name: "完整备份测试", path: "本地工作区" });
  const imported = await request("/api/documents/import-path", "POST", { path: fixturePath, projectId: "p-backup" });
  const document = imported.document;
  const annotation = { id: "a-backup", type: "pin", x: 42, y: 35, text: "必须随备份恢复", createdAt: Date.now(), updatedAt: Date.now() };
  const history = [{ id: "h-backup", action: "snapshot", label: "完整快照", ts: Date.now(), snapshot: [annotation] }];
  await request(`/api/documents/${document.id}/pages/1/annotations`, "PUT", { annotations: [annotation], updatedAt: Date.now() });
  await request(`/api/documents/${document.id}/pages/1/history`, "PUT", { history });
  fs.appendFileSync(fixturePath, Buffer.from("new-version"));
  const refreshed = await request(`/api/documents/${document.id}/refresh`, "POST", { clearAnnotations: false });
  assert.equal(refreshed.document.versions.length, 1);
  const savedVersion = refreshed.document.versions[0];
  const reviewTask = (await request("/api/review/tasks", "POST", { scope: "document", documentId: document.id })).task;

  const storedWorkspace = JSON.parse(fs.readFileSync(path.join(tempDir, "workspace.json"), "utf8"));
  assert.throws(
    () => inspectFullBackup({ dataDir: tempDir, workspace: storedWorkspace, maxSourceBytes: 1 }),
    (error) => error.code === "backup_too_large" && /删除不再需要的审阅任务快照/.test(error.message)
  );

  const backupResponse = await fetch(`${baseUrl}/api/backup/full`);
  assert.equal(backupResponse.status, 200);
  assert.equal(backupResponse.headers.get("content-type"), "application/zip");
  assert.match(backupResponse.headers.get("content-disposition"), /\.reviewbackup/);
  const backupBuffer = Buffer.from(await backupResponse.arrayBuffer());
  assert.equal(backupBuffer.subarray(0, 2).toString(), "PK");
  const archive = await unzipper.Open.buffer(backupBuffer);
  const archivePaths = archive.files.map((entry) => entry.path);
  assert.ok(archivePaths.includes("manifest.json"));
  assert.ok(archivePaths.includes("workspace.json"));
  assert.ok(archivePaths.some((entry) => entry.startsWith(`uploads/${document.id}.`)));
  assert.ok(archivePaths.some((entry) => entry.startsWith(`versions/${document.id}/${savedVersion.id}/`)));
  assert.ok(archivePaths.includes(`review-tasks/${reviewTask.id}/REVIEW_CHECKLIST.md`));
  assert.ok(archivePaths.some((entry) => entry.startsWith(`review-tasks/${reviewTask.id}/artifacts/`)));

  await request(`/api/review/tasks/${reviewTask.id}`, "PATCH", { status: "archived" });
  await request(`/api/documents/${document.id}`, "DELETE");
  assert.equal(fs.existsSync(document.sourcePath), false);

  const restoreForm = new FormData();
  restoreForm.append("backup", new Blob([backupBuffer], { type: "application/zip" }), "workspace.reviewbackup");
  const restoreResponse = await fetch(`${baseUrl}/api/backup/full/restore`, { method: "POST", body: restoreForm });
  const restoreResult = await restoreResponse.json();
  assert.equal(restoreResponse.status, 200, JSON.stringify(restoreResult));
  const restoredDocument = restoreResult.workspace.documents.find((item) => item.id === document.id);
  assert.ok(restoredDocument);
  assert.equal(restoredDocument.originalPath, "");
  assert.equal(fs.existsSync(restoredDocument.sourcePath), true);
  assert.equal(restoredDocument.versions[0].id, savedVersion.id);
  assert.equal(fs.existsSync(path.join(tempDir, restoredDocument.versions[0].relativePath)), true);
  assert.deepEqual(restoreResult.workspace.annotations[`${document.id}:1`], [annotation]);
  assert.deepEqual(restoreResult.workspace.history[`${document.id}:1`], history);
  assert.ok(restoreResult.workspace.annotationRevisions[`${document.id}:1`] > 0);
  assert.ok(restoreResult.workspace.historyRevisions[`${document.id}:1`] > 0);
  const restoredTask = restoreResult.workspace.reviewTasks.find((item) => item.id === reviewTask.id);
  assert.ok(restoredTask);
  assert.equal(restoredTask.status, "ready");
  assert.equal(fs.existsSync(restoredTask.checklistPath), true);
  assert.equal(fs.existsSync(restoreResult.automaticBackup), true);

  const invalidForm = new FormData();
  invalidForm.append("backup", new Blob([Buffer.from("not-a-zip")]), "broken.reviewbackup");
  const invalidResponse = await fetch(`${baseUrl}/api/backup/full/restore`, { method: "POST", body: invalidForm });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error, "invalid_archive");
  const afterFailure = await request("/api/workspace");
  assert.ok(afterFailure.documents.some((item) => item.id === document.id));

  const oldRestore = await requestFailure("/api/backup/restore", "POST", { workspace: afterFailure });
  assert.equal(oldRestore.status, 410);
  assert.equal(oldRestore.json.error, "index_restore_removed");

  const recoveryDir = path.join(tempDir, "restore-recovery-fixture");
  const rollbackDir = path.join(recoveryDir, ".restore-rollback-test");
  const stagingDir = path.join(recoveryDir, ".restore-staging-test");
  fs.mkdirSync(path.join(recoveryDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(rollbackDir, "uploads"), { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(recoveryDir, "uploads", "state.txt"), "incoming");
  fs.writeFileSync(path.join(rollbackDir, "uploads", "state.txt"), "previous");
  fs.writeFileSync(path.join(recoveryDir, "workspace.json"), '{"state":"incoming"}\n');
  fs.writeFileSync(path.join(rollbackDir, "workspace.json"), '{"state":"previous"}\n');
  fs.writeFileSync(path.join(recoveryDir, ".restore-transaction.json"), `${JSON.stringify({
    version: 1,
    phase: "prepared",
    stagingDir,
    rollbackDir,
    workspaceExisted: true,
    directories: [{ name: "uploads", originalExisted: true }]
  })}\n`);
  const recovered = recoverInterruptedFullRestore(recoveryDir);
  assert.equal(recovered.recovered, true);
  assert.equal(fs.readFileSync(path.join(recoveryDir, "uploads", "state.txt"), "utf8"), "previous");
  assert.equal(JSON.parse(fs.readFileSync(path.join(recoveryDir, "workspace.json"), "utf8")).state, "previous");
  assert.equal(fs.existsSync(path.join(recoveryDir, ".restore-transaction.json")), false);

  console.log("full-backup.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function request(url, method = "GET", body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function requestFailure(url, method, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVEAEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAAB9A//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64"
  );
}
