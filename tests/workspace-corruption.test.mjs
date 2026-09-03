import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../server/store.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-corrupt-workspace-test-"));
const workspacePath = path.join(tempDir, "workspace.json");
const corruptContent = "{ this is not valid JSON\n";

try {
  fs.writeFileSync(workspacePath, corruptContent);
  let captured;
  assert.throws(() => createStore(tempDir), (error) => {
    captured = error;
    return error.code === "WORKSPACE_CORRUPT";
  });
  assert.equal(fs.readFileSync(workspacePath, "utf8"), corruptContent);
  assert.ok(captured.backupPath.startsWith(path.join(tempDir, "backups")));
  assert.equal(fs.readFileSync(captured.backupPath, "utf8"), corruptContent);
  assert.equal(fs.existsSync(`${workspacePath}.tmp`), false);

  const invalidShape = `${JSON.stringify({ projects: "not-an-array", documents: [] })}\n`;
  fs.writeFileSync(workspacePath, invalidShape);
  let shapeError;
  assert.throws(() => createStore(tempDir), (error) => {
    shapeError = error;
    return error.code === "WORKSPACE_CORRUPT";
  });
  assert.notEqual(shapeError.backupPath, captured.backupPath);
  assert.equal(fs.readFileSync(workspacePath, "utf8"), invalidShape);
  assert.equal(fs.readFileSync(shapeError.backupPath, "utf8"), invalidShape);

  const invalidNestedData = `${JSON.stringify({
    projects: [{ id: "p-corrupt", name: "损坏项目", path: "本地工作区", docIds: [] }],
    documents: [],
    annotations: { "missing-document:1": [{ id: "a-corrupt", type: "pin", x: 10, y: 10 }] },
    history: {},
    reviewThreads: {},
    reviewTasks: {},
    annotationRevisions: {},
    historyRevisions: {},
    exports: []
  })}\n`;
  fs.writeFileSync(workspacePath, invalidNestedData);
  let nestedError;
  assert.throws(() => createStore(tempDir), (error) => {
    nestedError = error;
    return error.code === "WORKSPACE_CORRUPT";
  });
  assert.notEqual(nestedError.backupPath, shapeError.backupPath);
  assert.equal(fs.readFileSync(nestedError.backupPath, "utf8"), invalidNestedData);

  fs.writeFileSync(workspacePath, `${JSON.stringify({
    projects: [{ id: "p-valid", name: "有效项目", path: "本地工作区", docIds: [] }],
    documents: [],
    annotations: {},
    history: {},
    reviewThreads: {},
    reviewTasks: {},
    annotationRevisions: {},
    historyRevisions: {},
    exports: [{
      id: "ex-legacy",
      createdAt: 1,
      payload: { scope: "document", document: { id: "d-old", name: "旧导出.pdf" }, summary: { annotationCount: 12 }, pages: [{ annotations: ["large-payload"] }] }
    }]
  })}\n`);
  const compactedStore = createStore(tempDir);
  assert.equal(compactedStore.getState().exports[0].annotationCount, 12);
  assert.equal(Object.hasOwn(compactedStore.getState().exports[0], "payload"), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(workspacePath, "utf8")).exports[0], "payload"), false);
  console.log("workspace-corruption.test.mjs passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
