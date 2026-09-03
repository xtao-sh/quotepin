import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-page-sync-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixturePath = path.join(tempDir, "page.jpg");
  fs.writeFileSync(fixturePath, tinyJpeg());
  await request("/api/projects", "POST", { id: "p-sync", name: "逐页同步测试" });
  const imported = await request("/api/documents/import-path", "POST", { path: fixturePath, projectId: "p-sync" });
  const documentId = imported.document.id;
  const staleUpdatedAt = Date.now();
  const annotation = { id: "a-sync", type: "pin", x: 20, y: 30, text: "逐页保存", createdAt: staleUpdatedAt, updatedAt: staleUpdatedAt };

  const saved = await request(`/api/documents/${documentId}/pages/1/annotations`, "PUT", { annotations: [annotation], updatedAt: staleUpdatedAt });
  assert.deepEqual(saved.annotations, [annotation]);
  const invalidTag = await requestFailure(`/api/documents/${documentId}/pages/1/annotations`, "PUT", {
    annotations: [{ ...annotation, tag: "unexpected" }],
    updatedAt: staleUpdatedAt + 1
  });
  assert.equal(invalidTag.status, 400);
  assert.equal(invalidTag.json.error, "invalid_annotations");

  const newerAnnotation = { ...annotation, text: "来自另一个窗口的新版本", updatedAt: staleUpdatedAt + 10 };
  await request(`/api/documents/${documentId}/pages/1/annotations`, "PUT", { annotations: [newerAnnotation], updatedAt: staleUpdatedAt + 10 });
  const conflicted = await requestFailure(`/api/documents/${documentId}/pages/1/annotations`, "PUT", {
    annotations: [{ ...annotation, text: "过期版本" }],
    updatedAt: staleUpdatedAt + 5
  });
  assert.equal(conflicted.status, 409);
  assert.equal(conflicted.json.error, "annotation_conflict");
  assert.deepEqual(conflicted.json.annotations, [newerAnnotation]);

  const archivedThread = {
    id: annotation.id,
    annotationId: annotation.id,
    documentId,
    page: 1,
    status: "resolved",
    createdBy: "human",
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    revision: staleUpdatedAt,
    messages: [{ id: "m-sync", role: "assistant", author: "AI", body: "已经按意见修改。", createdAt: staleUpdatedAt }]
  };
  const history = [
    {
      id: "h-archive",
      action: "archive",
      label: "归档批注 1",
      ts: Date.now(),
      displayLabel: "1",
      archivedAnnotation: annotation,
      archivedThread
    },
    { id: "h-sync", action: "snapshot", label: "保存快照", ts: Date.now(), snapshot: [annotation] }
  ];
  const historyRevision = Date.now() + 20;
  const savedHistory = await request(`/api/documents/${documentId}/pages/1/history`, "PUT", { history, updatedAt: historyRevision });
  assert.deepEqual(savedHistory.history, history);
  const staleHistory = await requestFailure(`/api/documents/${documentId}/pages/1/history`, "PUT", { history: [], updatedAt: historyRevision - 1 });
  assert.equal(staleHistory.status, 409);
  assert.equal(staleHistory.json.error, "history_conflict");
  let workspace = await request("/api/workspace");
  assert.deepEqual(workspace.annotations[`${documentId}:1`], [newerAnnotation]);
  assert.deepEqual(workspace.history[`${documentId}:1`], history);
  assert.equal(workspace.annotationRevisions[`${documentId}:1`], staleUpdatedAt + 10);
  assert.equal(workspace.historyRevisions[`${documentId}:1`], historyRevision);

  await request(`/api/documents/${documentId}/refresh`, "POST", { clearAnnotations: true });
  const staleWrite = await requestFailure(`/api/documents/${documentId}/pages/1/annotations`, "PUT", {
    annotations: [annotation],
    updatedAt: staleUpdatedAt
  });
  assert.equal(staleWrite.status, 409);
  assert.equal(staleWrite.json.error, "stale_annotations");
  assert.equal(staleWrite.json.documentId, documentId);
  assert.equal(staleWrite.json.page, 1);
  assert.deepEqual(staleWrite.json.annotations, []);
  assert.ok(staleWrite.json.revision > staleUpdatedAt);
  workspace = await request("/api/workspace");
  assert.equal(workspace.annotations[`${documentId}:1`], undefined);
  const archivedAfterRefresh = workspace.history[`${documentId}:1`].find((item) => item.action === "archive" && item.archivedAnnotation?.id === newerAnnotation.id);
  assert.ok(archivedAfterRefresh);
  assert.equal(archivedAfterRefresh.archivedAnnotation.text, newerAnnotation.text);
  assert.ok(workspace.history[`${documentId}:1`].some((item) => item.id === "h-sync"));

  const legacySync = await requestFailure("/api/sync", "POST", { projects: [], documents: [], annotations: {} });
  assert.equal(legacySync.status, 410);
  assert.equal(legacySync.json.error, "legacy_sync_removed");

  const cleared = await request(`/api/documents/${documentId}/pages/1/annotations`, "PUT", { annotations: [], updatedAt: Date.now() + 1 });
  assert.deepEqual(cleared.annotations, []);
  workspace = await request("/api/workspace");
  assert.equal(workspace.annotations[`${documentId}:1`], undefined);

  console.log("annotation-sync.test.mjs passed");
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
