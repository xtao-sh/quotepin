import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import unzipper from "unzipper";

// A .reviewbackup carries its own manifest, so its checksums always agree with whatever the archive
// contains: hashing the workspace proves nothing about where its paths point. These tests take a
// genuine backup, rewrite the paths inside it the way an attacker would, and re-manifest it.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-restore-paths-test-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-outside-"));
const secretPath = path.join(outsideDir, "id_rsa");
fs.writeFileSync(secretPath, "这是数据目录之外的私密文件。", "utf8");

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixtureDir = path.join(tempDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const notePath = path.join(fixtureDir, "报告.txt");
  fs.writeFileSync(notePath, "正文第一段。", "utf8");

  await postJson(`${baseUrl}/api/projects`, { id: "p1", name: "项目", path: fixtureDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: notePath, projectId: "p1" })).document;
  await postJson(`${baseUrl}/api/review/threads`, {
    documentId: document.id,
    page: 1,
    comment: "复核这一段。",
    annotation: { id: "ai-backup", type: "note", text: "复核这一段。" }
  });
  await postJson(`${baseUrl}/api/review/tasks`, { scope: "document", documentId: document.id });

  const genuine = await readBackup();
  assert.ok(genuine.workspace.documents.length >= 1);
  assert.equal(Object.keys(genuine.workspace.reviewTasks).length, 1);

  // Every path an attacker could usefully point somewhere else.
  const tampered = {
    "absolute-source": (workspace) => { workspace.documents[0].sourcePath = secretPath; },
    "absolute-converted": (workspace) => { workspace.documents[0].convertedPdfPath = secretPath; },
    "traversal-source": (workspace) => { workspace.documents[0].sourcePath = "data:uploads/../../../../etc/passwd"; },
    "version-escape": (workspace) => {
      workspace.documents[0].versions = [{ id: "v1", relativePath: "../../../etc/passwd", createdAt: 1, size: 1 }];
    }
  };

  for (const [label, mutate] of Object.entries(tampered)) {
    const workspace = structuredClone(genuine.workspace);
    mutate(workspace);
    const response = await restore(await packBackup(workspace, genuine.entries));
    const body = await response.json();
    assert.equal(response.ok, false, `[${label}] 构造的备份被接受了：${JSON.stringify(body)}`);
    // Traversal is caught by the archive-path guard; an absolute path outside the data directory
    // must be caught by the workspace path guard, not merely reported as a missing managed asset.
    assert.equal(
      ["invalid_workspace", "invalid_archive_path"].includes(body.error),
      true,
      `[${label}] 拒绝原因意外：${body.error}（missing_backup_asset 说明路径约束没生效）`
    );
  }

  const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, "workspace.json"), "utf8"));
  assert.equal(
    (onDisk.documents || []).some((item) => item.sourcePath === secretPath),
    false,
    "被拒绝的备份仍然把外部路径写进了工作区"
  );

  // A task's allowedPaths and projectRootPath are the permissions handed to a coding agent. A
  // restored file must not get to nominate them, even when everything else about it is valid.
  const nominated = structuredClone(genuine.workspace);
  const taskId = Object.keys(nominated.reviewTasks)[0];
  nominated.reviewTasks[taskId].projectRootPath = "/opt/not-a-real-path/keys";
  nominated.reviewTasks[taskId].allowedPaths = ["/opt/not-a-real-path/keys", "/etc"];
  nominated.reviewTasks[taskId].accessToken = "f".repeat(64);
  nominated.documents[0].workingArtifactPath = "/opt/not-a-real-path/id_rsa";

  const accepted = await restore(await packBackup(nominated, genuine.entries));
  assert.equal(accepted.ok, true, await accepted.clone().text());

  const restored = JSON.parse(fs.readFileSync(path.join(tempDir, "workspace.json"), "utf8"));
  const task = restored.reviewTasks[taskId];
  assert.deepEqual(task.allowedPaths, [], "恢复后的任务仍然携带备份指定的 allowedPaths");
  assert.equal(task.projectRootPath, "", "恢复后的任务仍然携带备份指定的 projectRootPath");
  assert.equal(task.accessToken, "", "恢复后的任务仍然携带备份里的令牌");
  assert.equal(restored.documents[0].workingArtifactPath, "", "恢复后的文档仍然携带备份指定的工作路径");

  console.log("backup-restore-paths.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
}

async function readBackup() {
  const response = await fetch(`${baseUrl}/api/backup/full`);
  assert.equal(response.ok, true, "无法生成基准备份");
  const buffer = Buffer.from(await response.arrayBuffer());
  const directory = await unzipper.Open.buffer(buffer);
  const entries = [];
  let workspace = null;
  for (const file of directory.files) {
    if (file.type !== "File") continue;
    if (file.path === "manifest.json") continue;
    const content = await file.buffer();
    if (file.path === "workspace.json") {
      workspace = JSON.parse(content.toString("utf8"));
      continue;
    }
    entries.push({ path: file.path, content });
  }
  assert.ok(workspace, "备份里没有 workspace.json");
  return { workspace, entries };
}

async function packBackup(workspace, entries) {
  const archivePath = path.join(tempDir, `crafted-${crypto.randomBytes(4).toString("hex")}.reviewbackup`);
  const workspaceBuffer = Buffer.from(`${JSON.stringify(workspace, null, 2)}\n`);
  const files = [record("workspace.json", workspaceBuffer), ...entries.map((entry) => record(entry.path, entry.content))];
  const manifest = {
    format: "review-annotation-backup",
    version: 2,
    appVersion: "0.6.0",
    createdAt: new Date(0).toISOString(),
    files
  };
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.once("close", resolve);
    archive.once("error", reject);
    archive.pipe(output);
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "manifest.json" });
    archive.append(workspaceBuffer, { name: "workspace.json" });
    for (const entry of entries) archive.append(entry.content, { name: entry.path });
    archive.finalize();
  });
  return archivePath;
}

function record(entryPath, buffer) {
  return { path: entryPath, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

async function restore(archivePath) {
  const form = new FormData();
  form.append("backup", new Blob([fs.readFileSync(archivePath)], { type: "application/zip" }), "crafted.reviewbackup");
  return fetch(`${baseUrl}/api/backup/full/restore`, { method: "POST", body: form });
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
