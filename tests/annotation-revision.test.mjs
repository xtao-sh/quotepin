import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The page concurrency token used to be the client's own Date.now(): a client could always win by
// naming a later moment, and a same-millisecond write slipped through the strict >. Echoing the
// server-issued revision means only a client that has seen the current state may write over it.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-revision-test-"));
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
  const notePath = path.join(fixtureDir, "文稿.txt");
  fs.writeFileSync(notePath, "正文。", "utf8");

  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "并发", path: fixtureDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: notePath, projectId: "p" })).document;
  const pageUrl = `${baseUrl}/api/documents/${document.id}/pages/1/annotations`;

  const userAnnotation = (id, text) => ({ id, type: "note", text, createdAt: 1, updatedAt: 1 });

  // First write: no revision exists yet, so echoing 0 is what a fresh client knows.
  const first = await putJson(pageUrl, {
    annotations: [userAnnotation("u-1", "用户的第一条批注")],
    updatedAt: Date.now(),
    expectedRevision: 0
  });
  assert.equal(first.annotations.length, 1);
  const revisionAfterFirst = first.revision;
  assert.ok(revisionAfterFirst > 0);

  // The exact scenario from the audit: an AI writes to the page while the user has pending edits.
  await postJson(`${baseUrl}/api/review/threads`, {
    documentId: document.id,
    page: 1,
    comment: "AI 的意见，必须保住。",
    annotation: { id: "ai-1", type: "note", text: "AI 的意见，必须保住。" }
  });

  // The user's client never merged that change, so it still holds the older revision. Its flush
  // must be refused rather than quietly replacing the page.
  const stale = await fetch(pageUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annotations: [userAnnotation("u-1", "用户的第一条批注"), userAnnotation("u-2", "用户又写了一条")],
      // A later timestamp used to be enough to win.
      updatedAt: Date.now() + 60_000,
      expectedRevision: revisionAfterFirst
    })
  });
  assert.equal(stale.status, 409, "过期 revision 的写入没有被拒绝");
  const conflict = await stale.json();
  assert.equal(conflict.error, "annotation_conflict");
  assert.equal(conflict.annotations.some((item) => item.id === "ai-1"), true, "冲突响应里应当带回 AI 的批注");

  // The AI annotation is still there.
  const afterConflict = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterConflict.annotations[`${document.id}:1`].some((item) => item.id === "ai-1"), true);

  // Echoing the revision the conflict reported is how "keep local" proceeds deliberately.
  const resolved = await putJson(pageUrl, {
    annotations: [userAnnotation("u-1", "用户的第一条批注"), userAnnotation("u-2", "用户又写了一条")],
    updatedAt: Date.now(),
    expectedRevision: conflict.revision
  });
  assert.deepEqual(resolved.annotations.map((item) => item.id), ["u-1", "u-2"]);

  // A same-millisecond write no longer slips through: the revision, not the clock, decides.
  const now = Date.now();
  const sameMoment = await fetch(pageUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annotations: [userAnnotation("u-3", "同一毫秒的写入")],
      updatedAt: now,
      expectedRevision: revisionAfterFirst
    })
  });
  assert.equal(sameMoment.status, 409);

  // A client that has never seen the page sends 0. That is correct for a page nobody has written,
  // and must conflict for one that already exists — this is the case that used to fall back to the
  // timestamp comparison and let the client win.
  const unseenPage = await fetch(`${baseUrl}/api/documents/${document.id}/pages/1/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annotations: [userAnnotation("u-9", "没看过这一页就来写")],
      updatedAt: Date.now() + 120_000,
      expectedRevision: 0
    })
  });
  assert.equal(unseenPage.status, 409, "未见过该页的客户端仍然写成功了");

  // A malformed revision is refused rather than treated as "no revision supplied".
  const malformed = await fetch(pageUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations: [], updatedAt: Date.now(), expectedRevision: "不是数字" })
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid_annotation_revision");

  console.log("annotation-revision.test.mjs passed");
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

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}
