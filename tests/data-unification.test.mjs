import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDataDirectoryLock } from "../server/data-dir.js";
import { mergeLegacyDataDirectory } from "../server/data-migration.js";
import { createStore } from "../server/store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-data-merge-test-"));
const sourceDir = path.join(root, "legacy-web");
const targetDir = path.join(root, "desktop-data");

try {
  fs.mkdirSync(path.join(sourceDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "uploads"), { recursive: true });
  const shared = Buffer.from("same-document-content");
  fs.writeFileSync(path.join(sourceDir, "uploads", "source-shared.pdf"), shared);
  fs.writeFileSync(path.join(targetDir, "uploads", "target-shared.pdf"), shared);
  fs.writeFileSync(path.join(sourceDir, "uploads", "source-unique.txt"), "unique-document-content");

  fs.writeFileSync(path.join(targetDir, "workspace.json"), JSON.stringify({
    projects: [{ id: "p1", name: "我的批注项目", path: "本地工作区", docIds: ["target-shared"] }],
    documents: [{ id: "target-shared", projectId: "p1", name: "共同文档.pdf", type: "pdf", ext: "PDF", pageCount: 1, pages: [{ title: "第一页" }], sourcePath: path.join(targetDir, "uploads", "target-shared.pdf") }],
    annotations: {},
    history: {}
  }));
  fs.writeFileSync(path.join(sourceDir, "workspace.json"), JSON.stringify({
    projects: [{ id: "p1", name: "我的批注项目", path: "本地工作区", docIds: ["source-shared", "source-unique"] }],
    documents: [
      { id: "source-shared", projectId: "p1", name: "共同文档.pdf", type: "pdf", ext: "PDF", pageCount: 1, pages: [{ title: "第一页" }], sourcePath: path.join(sourceDir, "uploads", "source-shared.pdf") },
      { id: "source-unique", projectId: "p1", name: "单独文档.txt", type: "markdown", ext: "TXT", pageCount: 1, pages: [{ title: "单独文档", text: "内容" }], sourcePath: path.join(sourceDir, "uploads", "source-unique.txt") }
    ],
    annotations: { "source-shared:1": [{ id: "a-merged", type: "note", text: "来自网页版", createdAt: 10 }] },
    history: { "source-shared:1": [{ id: "h-merged", action: "snapshot", label: "网页版快照", ts: 20, snapshot: [] }] }
  }));

  const lock = acquireDataDirectoryLock(targetDir, 4517);
  assert.throws(() => acquireDataDirectoryLock(targetDir, 4520), (error) => error.code === "DATA_DIR_LOCKED");
  const store = createStore(targetDir);
  const result = mergeLegacyDataDirectory({ sourceDir, targetDir, store });
  assert.equal(result.changed, true);
  assert.equal(result.documentMap["source-shared"], "target-shared");
  const workspace = store.getWorkspace();
  assert.equal(workspace.documents.filter((item) => item.name === "共同文档.pdf").length, 1);
  assert.deepEqual(workspace.annotations["target-shared:1"].map((item) => item.id), ["a-merged"]);
  assert.deepEqual(workspace.history["target-shared:1"].map((item) => item.id), ["h-merged"]);
  const unique = workspace.documents.find((item) => item.name === "单独文档.txt");
  assert.ok(unique);
  assert.equal(fs.existsSync(unique.sourcePath), true);
  assert.ok(workspace.projects.find((item) => item.id === "p1").docIds.includes(unique.id));
  assert.equal(fs.existsSync(result.snapshotDir), true);

  const second = mergeLegacyDataDirectory({ sourceDir, targetDir, store });
  assert.equal(second.alreadyMerged, true);
  lock.release();
  const nextLock = acquireDataDirectoryLock(targetDir, 4520);
  nextLock.release();

  console.log("data-unification.test.mjs passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
