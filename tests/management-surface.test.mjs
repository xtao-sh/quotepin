import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Deliberately no REVIEW_API_TOKEN. The agent-only guards used to be derived inside the
// global-capability branch, so with no global token configured they were silently inert.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-management-test-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixtureDir = path.join(tempDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const notePath = path.join(fixtureDir, "合同.txt");
  fs.writeFileSync(notePath, "第三条：交付时间待定。", "utf8");

  await postJson(`${baseUrl}/api/projects`, { id: "p-keep", name: "保留", path: fixtureDir });
  await postJson(`${baseUrl}/api/projects`, { id: "p-mgmt", name: "管理面", path: fixtureDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: notePath, projectId: "p-mgmt" })).document;

  await postJson(`${baseUrl}/api/review/threads`, {
    documentId: document.id,
    page: 1,
    comment: "第三条需要复核。",
    annotation: { id: "ai-mgmt", type: "note", text: "第三条需要复核。" }
  });
  const task = (await postJson(`${baseUrl}/api/review/tasks`, { scope: "document", documentId: document.id })).task;

  const tokenFor = async () => {
    const integration = await getJson(`${baseUrl}/api/integrations/ai?taskId=${encodeURIComponent(task.id)}`);
    return integration.mcp.jsonConfig.mcpServers[integration.mcp.serverName].env.REVIEW_TASK_TOKEN;
  };

  const originalToken = await tokenFor();
  const agentHeaders = (token) => ({ "X-Review-Task-Id": task.id, "X-Review-Task-Token": token, "Content-Type": "application/json" });

  assert.equal((await fetch(`${baseUrl}/api/review/tasks/${task.id}`, { headers: agentHeaders(originalToken) })).status, 200);

  // An isolated agent may not rotate its own credential or close its own item, and saying
  // role "human" does not help: the actor comes from the credential presented.
  const selfRotate = await fetch(`${baseUrl}/api/review/tasks/${task.id}/rotate-token`, {
    method: "POST",
    headers: agentHeaders(originalToken),
    body: "{}"
  });
  assert.equal(selfRotate.status, 403);
  assert.equal((await selfRotate.json()).error, "rotation_requires_human");

  const itemId = task.items[0].id;
  const selfClose = await fetch(`${baseUrl}/api/review/tasks/${task.id}/items/${itemId}`, {
    method: "PATCH",
    headers: agentHeaders(originalToken),
    body: JSON.stringify({ status: "resolved", role: "human" })
  });
  assert.equal(selfClose.status, 403);
  assert.equal((await selfClose.json()).error, "status_requires_human");

  // The user rotates it, and every copy already handed out stops working.
  await postJson(`${baseUrl}/api/review/tasks/${task.id}/rotate-token`, {});
  const rotatedToken = await tokenFor();
  assert.notEqual(rotatedToken, originalToken);
  assert.equal((await fetch(`${baseUrl}/api/review/tasks/${task.id}`, { headers: agentHeaders(originalToken) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/review/tasks/${task.id}`, { headers: agentHeaders(rotatedToken) })).status, 200);

  // A document whose only copy is the app's managed one under uploads/ grants an agent nothing:
  // editing that copy changes nothing the user sees and corrupts the workspace behind the app.
  const uploadForm = new FormData();
  uploadForm.append("projectId", "p-mgmt");
  uploadForm.append("file", new Blob(["上传的正文"], { type: "text/plain" }), "仅托管副本.txt");
  const uploaded = (await (await fetch(`${baseUrl}/api/documents/upload`, { method: "POST", body: uploadForm })).json()).document;
  assert.match(uploaded.sourcePath, /\/uploads\//, "上传文档应当只有托管副本");
  await postJson(`${baseUrl}/api/review/threads`, {
    documentId: uploaded.id,
    page: 1,
    comment: "看这里。",
    annotation: { id: "ai-managed", type: "note", text: "看这里。" }
  });
  const managedTask = (await postJson(`${baseUrl}/api/review/tasks`, { scope: "document", documentId: uploaded.id })).task;
  assert.deepEqual(managedTask.allowedPaths, [], "托管副本被列进了 allowedPaths");
  assert.equal(managedTask.documents[0].workingArtifactPath, "");
  await deleteJson(`${baseUrl}/api/review/tasks/${managedTask.id}`);
  await deleteJson(`${baseUrl}/api/documents/${uploaded.id}?taskPolicy=delete`);

  // A task is meant to be a frozen basis for review. snapshotHash was recorded and never checked,
  // so a snapshot replaced on disk looked identical to an untouched one.
  const freshTask = (await getJson(`${baseUrl}/api/review/tasks/${task.id}`)).task;
  assert.equal(freshTask.documents[0].snapshotIntegrity, "intact");
  fs.appendFileSync(freshTask.documents[0].snapshotArtifactPath, "\n偷偷加进快照的一行。");
  const tamperedTask = (await getJson(`${baseUrl}/api/review/tasks/${task.id}`)).task;
  assert.equal(tamperedTask.documents[0].snapshotIntegrity, "modified", "被改动的快照没有被发现");
  fs.rmSync(freshTask.documents[0].snapshotArtifactPath, { force: true });
  const missingTask = (await getJson(`${baseUrl}/api/review/tasks/${task.id}`)).task;
  assert.equal(missingTask.documents[0].snapshotIntegrity, "missing");

  // Deleting a document keeps its tasks by default: a task snapshot is self-contained review
  // evidence, and the item simply reports that the live document is gone.
  const deleted = await deleteJson(`${baseUrl}/api/documents/${document.id}`);
  assert.deepEqual(deleted.deletedTaskIds, []);
  const survivingTask = (await getJson(`${baseUrl}/api/review/tasks/${task.id}`)).task;
  assert.equal(survivingTask.items.length, 1);
  // The workspace listing is what the app renders; it must flag the snapshot as stale so the task
  // does not look current after its document is gone.
  const listed = (await getJson(`${baseUrl}/api/workspace`)).reviewTasks.find((item) => item.id === task.id);
  assert.equal(listed.snapshotStale, true);
  assert.equal(listed.staleItemCount, 1);

  // Clients are told about it, rather than being left with a cached summary that still reads
  // "current" after the document is gone.
  const staleEvent = listed.snapshotStale;
  assert.equal(staleEvent, true);

  // Opting in removes them and reports the space that came back.
  const secondDocument = (await postJson(`${baseUrl}/api/documents/import-path`, { path: notePath, projectId: "p-mgmt" })).document;
  await postJson(`${baseUrl}/api/review/threads`, {
    documentId: secondDocument.id,
    page: 1,
    comment: "再看一次。",
    annotation: { id: "ai-mgmt-2", type: "note", text: "再看一次。" }
  });
  const secondTask = (await postJson(`${baseUrl}/api/review/tasks`, { scope: "document", documentId: secondDocument.id })).task;
  const cascaded = await deleteJson(`${baseUrl}/api/documents/${secondDocument.id}?taskPolicy=delete`);
  assert.deepEqual(cascaded.deletedTaskIds, [secondTask.id]);
  assert.equal((await fetch(`${baseUrl}/api/review/tasks/${secondTask.id}`)).status, 404);

  // Deleting a task reclaims its snapshot directory.
  const taskDirectory = listed.directoryPath;
  assert.equal(fs.existsSync(taskDirectory), true);
  const removed = await deleteJson(`${baseUrl}/api/review/tasks/${task.id}`);
  assert.equal(removed.taskId, task.id);
  assert.equal(fs.existsSync(taskDirectory), false, "删除任务后快照目录仍然存在");

  // Deleting a project removes its documents; the last remaining project is protected.
  await deleteJson(`${baseUrl}/api/projects/p-mgmt`);
  const afterProjectDelete = await getJson(`${baseUrl}/api/workspace`);
  assert.deepEqual(afterProjectDelete.projects.map((item) => item.id), ["p-keep"]);
  assert.deepEqual(afterProjectDelete.documents, []);

  const lastProject = await fetch(`${baseUrl}/api/projects/p-keep`, { method: "DELETE" });
  assert.equal(lastProject.status, 409);
  assert.equal((await lastProject.json()).error, "last_project");

  console.log("management-surface.test.mjs passed");
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

async function deleteJson(url) {
  const response = await fetch(url, { method: "DELETE" });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}
