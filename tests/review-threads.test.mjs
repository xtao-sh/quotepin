import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-thread-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;
let eventReader = null;

try {
  const fixturePath = path.join(tempDir, "page.jpg");
  fs.writeFileSync(fixturePath, tinyJpeg());
  await request("/api/projects", "POST", { id: "p-review", name: "人机批注测试" });
  const imported = await request("/api/documents/import-path", "POST", { path: fixturePath, projectId: "p-review" });
  const documentId = imported.document.id;
  const reviewContext = await request("/api/review/context", "PUT", { documentId });
  assert.equal(reviewContext.context.documentId, documentId);
  assert.equal(reviewContext.context.scope, "document");
  const invalidContext = await requestFailure("/api/review/context", "PUT", { documentId: "missing-document" });
  assert.equal(invalidContext.status, 404);
  const createdAt = Date.now();
  const annotation = {
    id: "a-review",
    type: "pin",
    x: 20,
    y: 30,
    text: "这里的论证不够清楚，请重新解释。",
    tag: "question",
    createdAt,
    updatedAt: createdAt
  };
  await request(`/api/documents/${documentId}/pages/1/annotations`, "PUT", { annotations: [annotation], updatedAt: createdAt });

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  assert.equal(eventResponse.ok, true);
  eventReader = eventResponse.body.getReader();
  assert.match(await readUntil(eventReader, "event: connected"), /event: connected/);

  let listed = await request(`/api/review/threads?documentId=${documentId}&actionable=true`);
  assert.equal(listed.total, 1);
  assert.equal(listed.threads[0].id, annotation.id);
  assert.equal(listed.threads[0].status, "open");
  assert.equal(listed.threads[0].revision, 0);
  assert.equal(listed.threads[0].annotation.text, annotation.text);

  const assistantEvent = readUntil(eventReader, "event: review.thread.updated");
  const assistantReply = await request(`/api/review/threads/${annotation.id}/messages`, "POST", {
    role: "assistant",
    author: "Codex",
    body: "已重写对应段落，并补充了识别假设。",
    status: "addressed",
    change: {
      summary: "重写论证段落",
      file: "paper.tex",
      section: "2.1 Identification",
      commit: "abc123"
    },
    expectedRevision: 0
  });
  assert.equal(assistantReply.thread.status, "addressed");
  assert.equal(assistantReply.thread.messages.length, 1);
  assert.equal(assistantReply.thread.messages[0].change.file, "paper.tex");
  assert.match(await assistantEvent, /review\.thread\.updated/);

  const initialRevisionConflict = await requestFailure(`/api/review/threads/${annotation.id}/messages`, "POST", {
    role: "assistant",
    body: "另一名 AI 基于初始版本提交的回复",
    status: "addressed",
    expectedRevision: 0
  });
  assert.equal(initialRevisionConflict.status, 409);
  assert.equal(initialRevisionConflict.json.error, "review_thread_conflict");

  const assistantRevision = assistantReply.thread.revision;
  const humanReply = await request(`/api/review/threads/${annotation.id}/messages`, "POST", {
    role: "human",
    author: "用户",
    body: "这里还需要解释为什么这个假设足够。",
    expectedRevision: assistantRevision
  });
  assert.equal(humanReply.thread.status, "open");
  assert.equal(humanReply.thread.messages.length, 2);

  const conflict = await requestFailure(`/api/review/threads/${annotation.id}/messages`, "POST", {
    role: "assistant",
    body: "基于旧版本的回复",
    status: "addressed",
    expectedRevision: assistantRevision
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, "review_thread_conflict");

  const resolved = await request(`/api/review/threads/${annotation.id}/state`, "PATCH", {
    status: "resolved",
    tag: "resolved",
    expectedRevision: humanReply.thread.revision
  });
  assert.equal(resolved.thread.status, "resolved");
  assert.equal(resolved.annotation.tag, "resolved");
  assert.equal(resolved.annotations.find((item) => item.id === annotation.id).tag, "resolved");
  const stateConflict = await requestFailure(`/api/review/threads/${annotation.id}/state`, "PATCH", {
    status: "open",
    tag: "todo",
    expectedRevision: humanReply.thread.revision
  });
  assert.equal(stateConflict.status, 409);
  assert.equal(stateConflict.json.thread.status, "resolved");

  const aiCreated = await request("/api/review/threads", "POST", {
    documentId,
    page: 1,
    status: "needs_human",
    annotation: {
      id: "ai-review",
      type: "note",
      text: "这一页还缺少稳健性检验说明。",
      tag: "question"
    }
  });
  assert.equal(aiCreated.thread.createdBy, "assistant");
  assert.equal(aiCreated.thread.status, "needs_human");
  assert.equal(aiCreated.annotation.createdBy, "assistant");

  listed = await request(`/api/review/threads?documentId=${documentId}`);
  assert.equal(listed.total, 2);
  const workspace = await request("/api/workspace");
  assert.equal(workspace.reviewContext.documentId, documentId);
  assert.equal(workspace.reviewThreads[annotation.id].messages.length, 2);
  assert.equal(workspace.annotations[`${documentId}:1`].find((item) => item.id === annotation.id).tag, "resolved");
  assert.equal(workspace.reviewThreads[aiCreated.annotation.id].status, "needs_human");

  const archiveEvent = readUntil(eventReader, "event: history.updated");
  const archivedSingle = await request(`/api/documents/${documentId}/pages/1/annotations/${annotation.id}/archive`, "POST");
  assert.equal(archivedSingle.annotations.some((item) => item.id === annotation.id), false);
  assert.equal(archivedSingle.historyRecord.archivedAnnotation.id, annotation.id);
  assert.equal(archivedSingle.historyRecord.archivedThread.messages.length, 2);
  assert.match(await archiveEvent, /history\.updated/);

  const afterSingleArchive = await request("/api/workspace");
  assert.equal(afterSingleArchive.annotations[`${documentId}:1`].some((item) => item.id === annotation.id), false);
  assert.equal(afterSingleArchive.reviewThreads[annotation.id], undefined);
  assert.equal(afterSingleArchive.history[`${documentId}:1`].some((item) => item.archivedAnnotation?.id === annotation.id), true);

  await request(`/api/documents/${documentId}/pages/1/annotations`, "DELETE");
  const clearedWorkspace = await request("/api/workspace");
  assert.deepEqual(clearedWorkspace.reviewThreads, {});
  assert.equal(clearedWorkspace.annotations[`${documentId}:1`], undefined);
  const archived = clearedWorkspace.history[`${documentId}:1`].filter((item) => item.action === "archive");
  assert.equal(archived.length, 2);
  assert.equal(archived.find((item) => item.archivedAnnotation.id === annotation.id).archivedThread.messages.length, 2);
  assert.equal(archived.find((item) => item.archivedAnnotation.id === aiCreated.annotation.id).archivedThread.status, "needs_human");

  console.log("review-threads.test.mjs passed");
} finally {
  await eventReader?.cancel().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function readUntil(reader, needle) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${needle}`)), 2000))
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
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
