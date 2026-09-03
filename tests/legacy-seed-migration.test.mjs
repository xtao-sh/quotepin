import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../server/store.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-seed-migration-test-"));
const workspacePath = path.join(tempDir, "workspace.json");

try {
  fs.writeFileSync(workspacePath, JSON.stringify({
    projects: [
      { id: "p1", name: "第三季度业务评审", docIds: ["d1", "real-doc"] },
      { id: "p2", name: "产品设计走查", docIds: ["d5"] }
    ],
    documents: [
      { id: "d1", projectId: "p1", name: "Q3-上半场.pdf", pageCount: 12 },
      { id: "d5", projectId: "p2", name: "首页改版稿.pdf", pageCount: 6 },
      { id: "real-doc", projectId: "p1", name: "真实材料.pdf", sourcePath: "/tmp/real.pdf", pages: [{ title: "第一页" }] }
    ],
    annotations: {
      "d1:1": [{ id: "demo-annotation", type: "note", text: "演示" }],
      "real-doc:1": [{ id: "real-annotation", type: "note", text: "保留" }]
    }
  }));

  const store = createStore(tempDir);
  const workspace = store.getWorkspace();
  assert.deepEqual(workspace.documents.map((document) => document.id), ["real-doc"]);
  assert.deepEqual(workspace.projects.map((project) => project.id), ["p1"]);
  assert.deepEqual(workspace.projects[0].docIds, ["real-doc"]);
  assert.equal(workspace.annotations["d1:1"], undefined);
  assert.equal(workspace.annotations["real-doc:1"][0].text, "保留");

  const backupDir = path.join(tempDir, "backups");
  const backups = fs.readdirSync(backupDir).filter((file) => file.startsWith("legacy-seed-"));
  assert.equal(backups.length, 1);
  const archive = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), "utf8"));
  assert.deepEqual(archive.documents.map((document) => document.id).sort(), ["d1", "d5"]);
  assert.equal(archive.annotations["d1:1"][0].text, "演示");

  console.log("legacy-seed-migration.test.mjs passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
