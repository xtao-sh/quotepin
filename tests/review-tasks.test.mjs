import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-task-test-"));
// The user's documents live outside the app's data directory; allowedPaths deliberately never names
// anything inside it, so the fixtures have to sit where real ones would.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-task-work-"));
process.env.REVIEW_APP_DATA = tempDir;
process.env.REVIEW_API_TOKEN = "b".repeat(64);

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const firstPath = path.join(workDir, "first.jpg");
  const secondPath = path.join(workDir, "second.jpg");
  fs.writeFileSync(firstPath, tinyJpeg());
  fs.writeFileSync(secondPath, tinyJpeg());
  await request("/api/projects", "POST", { id: "p-tasks", name: "多文档项目", path: workDir });
  const first = (await request("/api/documents/import-path", "POST", { path: firstPath, projectId: "p-tasks" })).document;
  const second = (await request("/api/documents/import-path", "POST", { path: secondPath, projectId: "p-tasks" })).document;
  await addAnnotation(first.id, "a-first", "重写第一篇文档的结论。");
  await addAnnotation(second.id, "a-second", "补充第二篇文档的数据来源。");

  const created = await request("/api/review/tasks", "POST", { scope: "document", documentId: first.id });
  const task = created.task;
  assert.match(task.id, /^REV-\d{8}-[A-F0-9]{6}$/);
  assert.equal(task.scope, "document");
  assert.deepEqual(task.documentIds, [first.id]);
  assert.equal(task.items.length, 1);
  assert.equal(task.items[0].annotation.text, "重写第一篇文档的结论。");
  assert.deepEqual(task.allowedPaths, [firstPath]);
  assert.equal(task.documents[0].workingArtifactPath, firstPath);
  assert.notEqual(task.allowedPaths.includes(tempDir), true);
  assert.equal(task.allowedPaths.every((entry) => !entry.startsWith(tempDir)), true, "allowedPaths 指向了数据目录");
  assert.equal(fs.existsSync(task.documents[0].snapshotArtifactPath), true);
  assert.equal(fs.existsSync(task.checklistPath), true);
  assert.equal(fs.existsSync(task.directoryPath), true);
  assert.ok(task.storageBytes > 0);
  assert.equal(task.documentRevisions[first.id], first.contentHash);
  const taskIntegration = await request(`/api/integrations/ai?taskId=${encodeURIComponent(task.id)}`);
  const taskEnv = taskIntegration.mcp.jsonConfig.mcpServers[taskIntegration.mcp.serverName].env;
  assert.equal("REVIEW_API_TOKEN" in taskEnv, false);
  assert.doesNotMatch(taskIntegration.mcp.codexCommand, /REVIEW_API_TOKEN/);
  assert.doesNotMatch(taskIntegration.mcp.claudeCommand, /REVIEW_API_TOKEN/);
  assert.match(taskIntegration.mcp.codexRemoveCommand, new RegExp(taskIntegration.mcp.serverName));
  const invalidIntegration = await requestFailure("/api/integrations/ai?taskId=REV-20990101-FFFFFF");
  assert.equal(invalidIntegration.status, 404);
  const deniedTask = await fetch(`${baseUrl}/api/review/tasks/${task.id}`, {
    headers: { "X-Review-Task-Id": task.id, "X-Review-Task-Token": "0".repeat(64) }
  });
  assert.equal(deniedTask.status, 401);
  const authorizedTask = await fetch(`${baseUrl}/api/review/tasks/${task.id}`, {
    headers: { "X-Review-Task-Id": task.id, "X-Review-Task-Token": taskEnv.REVIEW_TASK_TOKEN }
  });
  assert.equal(authorizedTask.ok, true);
  const taskTokenWorkspace = await fetch(`${baseUrl}/api/workspace`, {
    headers: { "X-Review-Task-Id": task.id, "X-Review-Task-Token": taskEnv.REVIEW_TASK_TOKEN }
  });
  assert.equal(taskTokenWorkspace.status, 401);
  const checklist = fs.readFileSync(task.checklistPath, "utf8");
  assert.match(checklist, new RegExp(task.id));
  assert.match(checklist, /重写第一篇文档的结论/);

  await request("/api/review/context", "PUT", { documentId: second.id });
  const isolated = (await request(`/api/review/tasks/${task.id}`)).task;
  assert.equal(isolated.documentIds[0], first.id);
  assert.equal(isolated.items[0].sourceThreadId, "a-first");

  const replied = await request(`/api/review/tasks/${task.id}/items/${task.items[0].id}/messages`, "POST", {
    role: "assistant",
    author: "Codex",
    body: "已重写结论并补上限制条件。",
    status: "addressed",
    expectedRevision: task.items[0].revision,
    change: { summary: "重写结论", file: "paper.tex" }
  });
  assert.equal(replied.item.status, "addressed");
  assert.equal(replied.item.messages.length, 1);
  const liveThread = await request("/api/review/threads/a-first");
  assert.equal(liveThread.thread.messages[0].body, "已重写结论并补上限制条件。");

  fs.appendFileSync(firstPath, Buffer.from("new-document-version"));
  const refreshed = await request(`/api/documents/${first.id}/refresh`, "POST", { clearAnnotations: false });
  assert.notEqual(refreshed.document.contentHash, task.documentRevisions[first.id]);
  const staleReply = await request(`/api/review/tasks/${task.id}/items/${task.items[0].id}/messages`, "POST", {
    role: "assistant",
    author: "Codex",
    body: "这条回复只应保存在旧任务，不应写回新版文档。",
    status: "addressed",
    expectedRevision: replied.item.revision
  });
  assert.equal(staleReply.stale, true);
  assert.equal(staleReply.mirrored, false);
  const liveAfterStaleReply = await request("/api/review/threads/a-first");
  assert.equal(liveAfterStaleReply.thread.messages.length, 1);

  const projectTask = (await request("/api/review/tasks", "POST", { scope: "project", projectId: "p-tasks" })).task;
  assert.equal(projectTask.scope, "project");
  assert.deepEqual(new Set(projectTask.documentIds), new Set([first.id, second.id]));
  assert.equal(projectTask.items.length, 2);

  const projectFirstItem = projectTask.items.find((item) => item.sourceThreadId === "a-first");
  const frozenProjectMessages = projectFirstItem.messages.length;
  const frozenProjectStatus = projectFirstItem.status;
  await request("/api/review/threads/a-first/messages", "POST", {
    role: "human",
    author: "用户",
    body: "这是实时线程的新意见，不应改写已有任务快照。",
    status: "open"
  });
  await request("/api/review/threads/a-first", "PATCH", { status: "needs_human" });
  const projectAfterLiveUpdate = (await request(`/api/review/tasks/${projectTask.id}`)).task;
  const projectItemAfterLiveUpdate = projectAfterLiveUpdate.items.find((item) => item.sourceThreadId === "a-first");
  assert.equal(projectItemAfterLiveUpdate.messages.length, frozenProjectMessages);
  assert.equal(projectItemAfterLiveUpdate.status, frozenProjectStatus);

  const taskConflict = await request(`/api/review/tasks/${projectTask.id}/items/${projectFirstItem.id}/messages`, "POST", {
    role: "assistant",
    author: "Codex",
    body: "这条旧快照回复必须进入待合并状态。",
    status: "addressed",
    expectedRevision: projectFirstItem.revision
  });
  assert.equal(taskConflict.stale, true);
  assert.equal(taskConflict.mirrored, false);
  assert.equal(taskConflict.staleReason, "thread_changed");
  assert.equal(taskConflict.item.syncStatus, "pending_conflict");
  const projectMessagesAfterConflict = taskConflict.item.messages.length;
  const liveAfterTaskConflict = await request("/api/review/threads/a-first");
  assert.equal(liveAfterTaskConflict.thread.messages.some((message) => message.body === "这条旧快照回复必须进入待合并状态。"), false);

  const projectSecondItem = projectTask.items.find((item) => item.sourceThreadId === "a-second");
  await request(`/api/documents/${second.id}/pages/1/annotations`, "DELETE");
  const deletedAnnotationConflict = await request(`/api/review/tasks/${projectTask.id}/items/${projectSecondItem.id}/messages`, "POST", {
    role: "assistant",
    author: "Codex",
    body: "来源批注已删除，这条回复只能留在任务中。",
    status: "addressed",
    expectedRevision: projectSecondItem.revision
  });
  assert.equal(deletedAnnotationConflict.stale, true);
  assert.equal(deletedAnnotationConflict.mirrored, false);
  assert.equal(deletedAnnotationConflict.staleReason, "annotation_missing");

  await request(`/api/review/tasks/${task.id}/items/${task.items[0].id}/messages`, "POST", {
    role: "assistant",
    author: "Codex",
    body: "这是仅属于第一个任务的补充记录。",
    status: "addressed",
    expectedRevision: staleReply.item.revision
  });
  const projectAfterOtherTaskUpdate = (await request(`/api/review/tasks/${projectTask.id}`)).task;
  assert.equal(projectAfterOtherTaskUpdate.items.find((item) => item.sourceThreadId === "a-first").messages.length, projectMessagesAfterConflict);

  await request(`/api/documents/${first.id}`, "DELETE");
  const afterDelete = (await request(`/api/review/tasks/${task.id}`)).task;
  assert.equal(afterDelete.items[0].annotation.text, "重写第一篇文档的结论。");
  assert.equal(fs.existsSync(afterDelete.documents[0].snapshotArtifactPath), true);

  const workspace = await request("/api/workspace");
  assert.equal(workspace.reviewTasks.length, 2);
  assert.equal(workspace.reviewTasks.some((item) => item.id === task.id), true);

  const taskDirectory = afterDelete.directoryPath;
  const deletedTask = await request(`/api/review/tasks/${task.id}`, "DELETE");
  assert.equal(deletedTask.taskId, task.id);
  assert.ok(deletedTask.releasedBytes > 0);
  assert.equal(fs.existsSync(taskDirectory), false);
  const missingTask = await requestFailure(`/api/review/tasks/${task.id}`);
  assert.equal(missingTask.status, 404);

  const projectTaskDirectory = projectTask.directoryPath;
  const cascadedDelete = await request(`/api/documents/${second.id}?taskPolicy=delete`, "DELETE");
  assert.deepEqual(cascadedDelete.deletedTaskIds, [projectTask.id]);
  assert.equal(fs.existsSync(projectTaskDirectory), false);
  const finalWorkspace = await request("/api/workspace");
  assert.equal(finalWorkspace.reviewTasks.length, 0);
  console.log("review-tasks.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function addAnnotation(documentId, annotationId, text) {
  const now = Date.now();
  await request(`/api/documents/${documentId}/pages/1/annotations`, "PUT", {
    updatedAt: now,
    annotations: [{ id: annotationId, type: "pin", x: 20, y: 30, text, tag: "question", createdAt: now, updatedAt: now }]
  });
}

async function request(url, method = "GET", body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      "X-Review-Api-Token": process.env.REVIEW_API_TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function requestFailure(url, method = "GET", body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      "X-Review-Api-Token": process.env.REVIEW_API_TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json() };
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVEAEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAAB9A//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64"
  );
}
