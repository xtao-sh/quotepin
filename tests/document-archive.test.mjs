import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Archiving is the step between "still working on this" and "delete it": the document stops being
// treated as live, and nothing about it is lost. What separates it from deletion is precisely what
// this checks — the file, the annotations and the version history all survive.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-archive-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-archive-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const sourcePath = path.join(workDir, "lecture.txt");
  fs.writeFileSync(sourcePath, "第一章 回归介绍\n第二节 数据类型\n");
  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "计量经济学", path: workDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "p" })).document;
  assert.ok(!document.archivedAt, "刚导入的文档不该是归档状态");

  await putJson(`${baseUrl}/api/documents/${document.id}/pages/1/annotations`, {
    annotations: [{ id: "a1", type: "note", text: "这段要改写", createdAt: 1, updatedAt: 1 }],
    updatedAt: Date.now(),
    expectedRevision: 0
  });

  // Something that must not be swept away with the caches: the converted PDF an Office document is
  // rendered from lives in the same place and cannot be regenerated without reimporting.
  const renderDir = path.join(tempDir, "renders", document.id);
  for (const name of ["previews", "text", "converted"]) fs.mkdirSync(path.join(renderDir, name), { recursive: true });
  fs.writeFileSync(path.join(renderDir, "previews", "page-1-180.jpg"), Buffer.alloc(4096));
  fs.writeFileSync(path.join(renderDir, "text", "page-1.json"), JSON.stringify({ words: [] }));
  fs.writeFileSync(path.join(renderDir, "converted", "lecture.pdf"), Buffer.alloc(2048));

  const archived = await postJson(`${baseUrl}/api/documents/${document.id}/archive`, { archived: true });
  assert.ok(archived.document.archivedAt > 0, "归档后应当记下时间");

  // The caches go, and the app says how much that freed.
  assert.equal(fs.existsSync(path.join(renderDir, "previews")), false, "页面预览应当被清掉");
  assert.equal(fs.existsSync(path.join(renderDir, "text")), false, "文字缓存应当被清掉");
  assert.ok(archived.reclaimedBytes >= 4096, `应当报出回收的字节数，实得 ${archived.reclaimedBytes}`);

  // The converted PDF stays. Deleting it would leave an Office document unopenable.
  assert.equal(fs.existsSync(path.join(renderDir, "converted", "lecture.pdf")), true, "转换后的 PDF 不能跟着缓存一起删");

  // Nothing that carries the user's work is touched.
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  const stored = workspace.documents.find((item) => item.id === document.id);
  assert.ok(stored, "归档不是删除，文档应当还在工作区里");
  assert.equal(workspace.annotations[`${document.id}:1`].length, 1, "批注应当原样保留");
  assert.ok(fs.existsSync(stored.sourcePath), "App 保存的文件副本应当还在");
  assert.ok(fs.existsSync(sourcePath), "你自己的原文件当然更不该被动");

  // An archived document is finished with, so a newer source file is no longer worth reporting.
  fs.writeFileSync(sourcePath, "第一章 回归介绍（改过）\n第二节 数据类型\n新增一节\n");
  const afterEdit = (await getJson(`${baseUrl}/api/workspace`)).documents.find((item) => item.id === document.id);
  assert.notEqual(afterEdit.hasNewerSource, true, "归档文档不该再报「有新版本」");

  // Nor is it a duplicate worth cleaning up.
  const twin = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "p" })).document;
  assert.notEqual(twin.id, document.id);
  const groups = (await getJson(`${baseUrl}/api/documents/duplicates`)).groups;
  assert.deepEqual(groups, [], "归档的那份不该再被算作重复");

  // And it comes back.
  const restored = await postJson(`${baseUrl}/api/documents/${document.id}/archive`, { archived: false });
  assert.equal(Number(restored.document.archivedAt || 0), 0, "取消归档应当清掉标记");
  assert.equal(restored.reclaimedBytes, 0, "取消归档不删任何东西");
  const backAgain = (await getJson(`${baseUrl}/api/documents/duplicates`)).groups;
  assert.equal(backAgain.length, 1, "恢复之后重复检测重新看见它");

  // Archiving twice is not an error and does not re-report space it did not free.
  await postJson(`${baseUrl}/api/documents/${document.id}/archive`, { archived: true });
  const again = await postJson(`${baseUrl}/api/documents/${document.id}/archive`, { archived: true });
  assert.equal(again.reclaimedBytes, 0);
  assert.equal(await postError(`${baseUrl}/api/documents/missing/archive`, { archived: true }), "document_not_found");

  console.log("document-archive.test.mjs passed");
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

async function send(url, method, body) {
  return fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postJson(url, body) {
  const response = await send(url, "POST", body);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function putJson(url, body) {
  const response = await send(url, "PUT", body);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postError(url, body) {
  const response = await send(url, "POST", body);
  assert.equal(response.ok, false, `本该被拒绝：${url}`);
  return (await response.json()).error;
}
