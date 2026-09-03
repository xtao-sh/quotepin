import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A group sits above projects and holds nothing else — no documents, no working directory. That is
// what lets it exist before it has members and be deleted without endangering any of them.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-groups-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-groups-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // A group can be created empty, which is the point: the shelf goes up before anything is put on it.
  const teaching = (await postJson(`${baseUrl}/api/groups`, { id: "teaching", name: "Teaching" })).group;
  assert.equal(teaching.name, "Teaching");
  assert.equal(teaching.collapsed, false);
  await postJson(`${baseUrl}/api/groups`, { id: "research", name: "研究" });
  assert.equal(await postError(`${baseUrl}/api/groups`, { id: "teaching", name: "重复" }), "group_exists");

  // Projects join a group at creation or later.
  await postJson(`${baseUrl}/api/projects`, { id: "marketing", name: "示例课程", path: workDir, groupId: "teaching" });
  await postJson(`${baseUrl}/api/projects`, { id: "metrics", name: "测试课程", path: workDir });
  await patchJson(`${baseUrl}/api/projects/metrics`, { groupId: "teaching" });
  assert.deepEqual(await groupOf(["marketing", "metrics"]), ["teaching", "teaching"]);

  // A group that does not exist is refused rather than stored and later ignored.
  assert.equal(await postError(`${baseUrl}/api/projects`, { id: "stray", name: "无处安放", groupId: "nope" }), "group_not_found");
  assert.equal(await patchError(`${baseUrl}/api/projects/metrics`, { groupId: "nope" }), "group_not_found");

  // A sub-project is placed by its parent. Giving it a group of its own would file the same project
  // in two places in the sidebar, so it is refused — and creating one with a group silently drops it.
  const slides = (await postJson(`${baseUrl}/api/projects`, { id: "slides", name: "资料", parentId: "marketing", groupId: "research" })).project;
  assert.equal(slides.parentId, "marketing");
  assert.equal(slides.groupId, "", "子项目不该自己带分组");
  assert.equal(await patchError(`${baseUrl}/api/projects/slides`, { groupId: "research" }), "project_child_cannot_group");

  // Renaming and collapsing.
  const renamed = (await patchJson(`${baseUrl}/api/groups/teaching`, { name: "教学", collapsed: true })).group;
  assert.equal(renamed.name, "教学");
  assert.equal(renamed.collapsed, true);
  assert.equal(await patchError(`${baseUrl}/api/groups/nope`, { name: "x" }), "group_not_found");

  // Order is whatever the caller asks for, and it survives a restart because it is the stored order
  // rather than a sort.
  await postJson(`${baseUrl}/api/groups`, { id: "admin", name: "行政" });
  assert.deepEqual(await groupIds(), ["teaching", "research", "admin"], "新建的分组排在最后");
  assert.deepEqual((await postJson(`${baseUrl}/api/groups/reorder`, { orderedIds: ["admin", "teaching", "research"] })).groups.map((group) => group.id), ["admin", "teaching", "research"]);
  assert.deepEqual(await groupIds(), ["admin", "teaching", "research"]);

  // A client working from a stale list should get a different order, never a group listed twice or
  // dropped: repeats are honoured once, unknown ids ignored, and anything left out keeps its place
  // at the end.
  assert.deepEqual(
    (await postJson(`${baseUrl}/api/groups/reorder`, { orderedIds: ["research", "research", "ghost", "admin"] })).groups.map((group) => group.id),
    ["research", "admin", "teaching"]
  );
  assert.deepEqual(await groupIds(), ["research", "admin", "teaching"]);
  assert.deepEqual((await postJson(`${baseUrl}/api/groups/reorder`, { orderedIds: [] })).groups.map((group) => group.id), ["research", "admin", "teaching"], "空列表不该改变任何顺序");
  assert.equal(await postError(`${baseUrl}/api/groups/reorder`, { orderedIds: "teaching" }), "invalid_group_order");
  assert.equal(await postError(`${baseUrl}/api/groups/reorder`, {}), "invalid_group_order");

  // Put the order back so the rest of the test reads in the order it was written.
  await postJson(`${baseUrl}/api/groups/reorder`, { orderedIds: ["teaching", "research", "admin"] });

  // A document filed in a grouped project is reachable and unaffected by any of this.
  const sourcePath = path.join(workDir, "outline.txt");
  fs.writeFileSync(sourcePath, "课程大纲\n");
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "marketing" })).document;

  // Deleting a group releases its projects rather than deleting them — and with them, their files.
  const removed = await fetch(`${baseUrl}/api/groups/teaching`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const after = await getJson(`${baseUrl}/api/workspace`);
  assert.ok(!after.groups.some((group) => group.id === "teaching"), "分组应当已经删除");
  assert.deepEqual(await groupOf(["marketing", "metrics"]), ["", ""], "成员项目应当回到未分组，而不是被删掉");
  assert.ok(after.projects.some((project) => project.id === "marketing"), "项目不该跟着分组一起消失");
  assert.ok(after.documents.some((item) => item.id === document.id), "文档更不该");
  assert.equal((await fetch(`${baseUrl}/api/groups/teaching`, { method: "DELETE" })).status, 404);

  // A project naming a group that is no longer there reads as ungrouped rather than disappearing
  // from the sidebar. Written into a store of its own, because no route can produce that state.
  {
    const strayDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-groups-stray-"));
    fs.writeFileSync(path.join(strayDir, "workspace.json"), JSON.stringify({
      workspace: {
        groups: [{ id: "kept", name: "留下的" }],
        projects: [
          { id: "a", name: "指向健在的分组", groupId: "kept", docIds: [] },
          { id: "b", name: "指向已删除的分组", groupId: "vanished", docIds: [] }
        ],
        documents: []
      }
    }));
    const { createStore } = await import("../server/store.js");
    const fresh = createStore(strayDir).getWorkspace();
    assert.equal(fresh.projects.find((item) => item.id === "a").groupId, "kept");
    assert.equal(fresh.projects.find((item) => item.id === "b").groupId, "", "指向已删除分组的项目应当读作未分组");
    assert.ok(fresh.projects.some((item) => item.id === "b"), "而不是从工作区里消失");
    fs.rmSync(strayDir, { recursive: true, force: true });
  }

  console.log("project-groups.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function groupIds() {
  return (await getJson(`${baseUrl}/api/workspace`)).groups.map((group) => group.id);
}

async function groupOf(projectIds) {
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  return projectIds.map((id) => workspace.projects.find((project) => project.id === id)?.groupId ?? null);
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

async function patchJson(url, body) {
  const response = await send(url, "PATCH", body);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postError(url, body) {
  const response = await send(url, "POST", body);
  assert.equal(response.ok, false, `本该被拒绝：${url} ${JSON.stringify(body)}`);
  return (await response.json()).error;
}

async function patchError(url, body) {
  const response = await send(url, "PATCH", body);
  assert.equal(response.ok, false, `本该被拒绝：${url} ${JSON.stringify(body)}`);
  return (await response.json()).error;
}
