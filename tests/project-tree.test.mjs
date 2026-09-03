import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Sub-projects are one level deep, a document belongs to exactly one project, and its membership is
// recorded in two places that must never disagree.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-project-tree-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-project-tree-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { resolveRevealTarget, startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  await postJson(`${baseUrl}/api/projects`, { id: "course", name: "营销分析", path: workDir });
  const child = (await postJson(`${baseUrl}/api/projects`, { id: "slides", name: "课件", parentId: "course" })).project;
  assert.equal(child.parentId, "course");

  // One level and no more: a grandchild, a project that is its own parent, and a parent that does
  // not exist are all refused rather than quietly flattened.
  assert.equal(await postError(`${baseUrl}/api/projects`, { id: "deep", name: "更深", parentId: "slides" }), "project_nesting_too_deep");
  assert.equal(await postError(`${baseUrl}/api/projects`, { id: "self", name: "自己", parentId: "self" }), "project_parent_self");
  assert.equal(await postError(`${baseUrl}/api/projects`, { id: "orphan", name: "孤儿", parentId: "nobody" }), "project_parent_not_found");

  // A project that already has children cannot become someone else's child, which is the other way
  // a second level could sneak in.
  await postJson(`${baseUrl}/api/projects`, { id: "other", name: "另一门课", path: workDir });
  assert.equal(await patchError(`${baseUrl}/api/projects/course`, { parentId: "other" }), "project_has_children");

  // Import a document into the parent, then move it into the child.
  const sourcePath = path.join(workDir, "plan.txt");
  fs.writeFileSync(sourcePath, "第一章 回归介绍\n");
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "course" })).document;
  assert.equal(document.projectId, "course");
  assert.deepEqual(await docIdsOf("course"), [document.id], "导入后父项目应当持有这个文档");

  const moved = (await postJson(`${baseUrl}/api/documents/${document.id}/move`, { projectId: "slides" })).document;
  assert.equal(moved.projectId, "slides");
  // Both sides of the membership have to move together, or the workspace contradicts itself.
  assert.deepEqual(await docIdsOf("course"), [], "原项目的 docIds 里应当已经没有它");
  assert.deepEqual(await docIdsOf("slides"), [document.id], "目标项目的 docIds 里应当有它");

  // Moving somewhere that does not exist changes nothing.
  assert.equal(await postError(`${baseUrl}/api/documents/${document.id}/move`, { projectId: "nowhere" }), "project_not_found");
  assert.equal(await postError(`${baseUrl}/api/documents/missing/move`, { projectId: "course" }), "document_not_found");
  assert.deepEqual(await docIdsOf("slides"), [document.id], "失败的移动不应当改动任何一边");

  // Moving to where it already is is not an error and not a duplicate.
  await postJson(`${baseUrl}/api/documents/${document.id}/move`, { projectId: "slides" });
  assert.deepEqual(await docIdsOf("slides"), [document.id]);

  // Which file "show in Finder" lands on, checked without opening one: the route hands its answer
  // to the shell, and the shell is not the part that needs testing.
  {
    // The app's own copy lives under the data directory, which is what marks it as a managed asset
    // rather than as something the user filed themselves.
    const copyPath = path.join(tempDir, "uploads", "copy-in-app.txt");
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.writeFileSync(copyPath, "app copy\n");

    // The file the user imported, when it is still where they left it.
    assert.deepEqual(
      resolveRevealTarget({ originalPath: sourcePath, sourcePath: copyPath }),
      { target: sourcePath, reason: "original", recordedPath: sourcePath }
    );

    // Moved or renamed since import: the app's own copy is shown instead, and the answer says where
    // the original used to be so the caller can explain itself.
    const gone = path.join(workDir, "not-here.txt");
    const movedAway = resolveRevealTarget({ originalPath: gone, sourcePath: copyPath });
    assert.equal(movedAway.reason, "original_missing");
    assert.equal(movedAway.target, copyPath);
    assert.equal(movedAway.recordedPath, gone, "要报出原文件本来在哪");

    // Dragged in or downloaded: there never was an original to point at.
    const copyOnly = resolveRevealTarget({ sourcePath: copyPath });
    assert.equal(copyOnly.reason, "copy_only");
    assert.equal(copyOnly.target, copyPath);

    // Nothing left anywhere.
    const nothing = resolveRevealTarget({ originalPath: gone, sourcePath: gone });
    assert.equal(nothing.target, "");
    assert.match(nothing.detail, /原文件已经不在/);
    assert.match(resolveRevealTarget({}).detail, /没有可以定位的本地文件/);

    fs.rmSync(copyPath, { force: true });
  }
  assert.equal(await postError(`${baseUrl}/api/documents/missing/reveal`, {}), "document_not_found");

  // Deleting a parent would take its children's documents with it, so it is refused while any child
  // remains rather than cascading through the subtree.
  assert.equal(await deleteError(`${baseUrl}/api/projects/course`), "project_has_children");
  const afterRefusal = await getJson(`${baseUrl}/api/workspace`);
  assert.ok(afterRefusal.projects.some((item) => item.id === "slides"), "被拒绝的删除不应当动到子项目");
  assert.ok(afterRefusal.documents.some((item) => item.id === document.id), "被拒绝的删除不应当动到文档");

  // Once the child is gone the parent can go too.
  const removeChild = await fetch(`${baseUrl}/api/projects/slides`, { method: "DELETE" });
  assert.equal(removeChild.status, 200);
  const removeParent = await fetch(`${baseUrl}/api/projects/course`, { method: "DELETE" });
  assert.equal(removeParent.status, 200);

  // "The last project" counts the ones at the top level; a lone root cannot be deleted.
  assert.equal(await deleteError(`${baseUrl}/api/projects/other`), "last_project");

  console.log("project-tree.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function docIdsOf(projectId) {
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  return workspace.projects.find((item) => item.id === projectId)?.docIds || [];
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function post(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postJson(url, body) {
  const response = await post(url, body);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postError(url, body) {
  const response = await post(url, body);
  assert.equal(response.ok, false, `本该被拒绝：${url} ${JSON.stringify(body)}`);
  return (await response.json()).error;
}

async function patchError(url, body) {
  const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.ok, false, `本该被拒绝：${url} ${JSON.stringify(body)}`);
  return (await response.json()).error;
}

async function deleteError(url) {
  const response = await fetch(url, { method: "DELETE" });
  assert.equal(response.ok, false, `本该被拒绝：${url}`);
  return (await response.json()).error;
}
