import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Archiving an annotation rewrites the page, so it moves the page's revision the same way saving
// does. A client that echoes revisions has to learn the new one from the archive response: the
// broadcast that also carries it is skipped while the page is dirty, which is exactly the case when
// someone deletes an annotation and immediately makes another one on the same page. Without this,
// that next annotation conflicts with nothing at all and the user is asked to resolve it.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-archive-rev-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-archive-rev-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const sourcePath = path.join(workDir, "slides.txt");
  fs.writeFileSync(sourcePath, "第一章 回归介绍\n第二节 数据类型\n");
  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "演示项目", path: workDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "p" })).document;
  const pageUrl = `${baseUrl}/api/documents/${document.id}/pages/1/annotations`;

  const note = (id, text) => ({ id, type: "note", text, createdAt: 1, updatedAt: 1 });
  const first = await putJson(pageUrl, { annotations: [note("a1", "第一条"), note("a2", "第二条")], updatedAt: Date.now(), expectedRevision: 0 });
  const revisionAfterSave = first.revision;
  assert.ok(revisionAfterSave > 0);

  // Delete one of them.
  const archived = await postJson(`${baseUrl}/api/documents/${document.id}/pages/1/annotations/a2/archive`, {});
  assert.equal(archived.annotations.length, 1, "归档后这一页应当只剩一条批注");

  // The response has to say what the page's revision became, or the client has nothing to echo.
  assert.ok(archived.annotationRevision, "归档响应没有返回新的页面 revision");
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(
    Number(archived.annotationRevision),
    Number(workspace.annotationRevisions[`${document.id}:1`]),
    "归档响应报出的 revision 与服务端实际持有的不一致"
  );
  assert.notEqual(Number(archived.annotationRevision), Number(revisionAfterSave), "归档确实推进了这一页的 revision");

  // A client that kept the revision it had before archiving now conflicts on its next annotation —
  // which is the bug this guards, reproduced from the server's side.
  const stale = await fetch(pageUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations: [note("a1", "第一条"), note("a3", "新写的")], updatedAt: Date.now(), expectedRevision: revisionAfterSave })
  });
  assert.equal(stale.status, 409, "拿归档前的 revision 保存，本该冲突");
  assert.equal((await stale.json()).error, "annotation_conflict");

  // Echoing what the archive reported goes through, and nothing was asked of the user.
  const accepted = await putJson(pageUrl, {
    annotations: [note("a1", "第一条"), note("a3", "新写的")],
    updatedAt: Date.now(),
    expectedRevision: archived.annotationRevision
  });
  assert.equal(accepted.annotations.length, 2, "采纳归档返回的 revision 后应当保存成功");

  console.log("archive-revision.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function putJson(url, body) {
  const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}
