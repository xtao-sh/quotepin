import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-import-test-"));
// Outside the data directory, where a user's own documents live: importing a file from inside the
// app's own data directory is refused, since that would copy a copy.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-import-work-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");

const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sourceImagePath = path.join(fixtureDir, "review-page.jpg");
  fs.writeFileSync(sourceImagePath, tinyJpeg());

  const projectResult = await postJson(`${baseUrl}/api/projects`, {
    id: "p-import",
    name: "导入删除测试",
    path: fixtureDir
  });
  assert.equal(projectResult.project.id, "p-import");

  // The import field takes whatever a person pasted. Each of these shapes has to resolve to the same
  // file, and each is what you actually get from Finder, a drag into a text field, a drag into
  // Terminal, or a shell prompt.
  const spacedPath = path.join(fixtureDir, "review page copy.jpg");
  fs.writeFileSync(spacedPath, tinyJpeg());
  for (const [label, supplied] of [
    ["file:// URL", pathToFileURL(spacedPath).href],
    ["双引号包裹", `"${spacedPath}"`],
    ["单引号包裹", `'${spacedPath}'`],
    ["转义空格", spacedPath.replaceAll(" ", "\\ ")]
  ]) {
    const shape = await postJson(`${baseUrl}/api/documents/import-path`, { path: supplied, projectId: "p-import" });
    assert.equal(shape.document.originalPath, spacedPath, `${label} 没有解析到原始路径`);
    await deleteJson(`${baseUrl}/api/documents/${shape.document.id}`);
  }

  // A path inside the app's own data directory would make a copy of a copy, and the new document
  // would "track" a file the app rewrites underneath it.
  const managedCopy = await postJson(`${baseUrl}/api/documents/import-path`, { path: spacedPath, projectId: "p-import" });
  const managedRejection = await fetch(`${baseUrl}/api/documents/import-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: managedCopy.document.sourcePath, projectId: "p-import" })
  });
  assert.equal(managedRejection.status, 400);
  assert.equal((await managedRejection.json()).error, "invalid_path");
  await deleteJson(`${baseUrl}/api/documents/${managedCopy.document.id}`);

  // A path that does not exist reports so, rather than failing somewhere deeper.
  const missing = await fetch(`${baseUrl}/api/documents/import-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path.join(fixtureDir, "根本没有这个文件.pdf"), projectId: "p-import" })
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "missing_path");

  const importResult = await postJson(`${baseUrl}/api/documents/import-path`, {
    path: sourceImagePath,
    projectId: "p-import"
  });
  const document = importResult.document;
  assert.equal(document.type, "image");
  assert.equal(document.renderMode, "raster");
  assert.equal(document.pageCount, 1);
  assert.equal(document.pages[0].sourceUrl.startsWith("/api/uploads/"), true);
  assert.equal(fs.existsSync(document.sourcePath), true);
  assert.equal(fs.existsSync(sourceImagePath), true);

  const renderDir = path.join(tempDir, "renders", document.id);
  fs.mkdirSync(renderDir, { recursive: true });
  fs.writeFileSync(path.join(renderDir, "page-1.jpg"), tinyJpeg());

  const workspace = await getJson(`${baseUrl}/api/workspace`);
  const project = workspace.projects.find((item) => item.id === "p-import");
  assert.deepEqual(project.docIds, [document.id]);

  await putJson(`${baseUrl}/api/documents/${document.id}/pages/1/annotations`, {
    annotations: [{
        id: "a-import",
        type: "pin",
        tag: "todo",
        text: "删除文档时这条批注也应该移除",
        x: 50,
        y: 50,
        createdAt: Date.now()
      }],
    updatedAt: Date.now()
  });
  await putJson(`${baseUrl}/api/documents/${document.id}/pages/1/history`, {
    history: [{ id: "h-import", action: "create", label: "新增批注", ts: Date.now() }]
  });

  await deleteJson(`${baseUrl}/api/documents/${document.id}`);

  const afterDelete = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterDelete.documents.some((item) => item.id === document.id), false);
  assert.equal(afterDelete.projects.find((item) => item.id === "p-import").docIds.includes(document.id), false);
  assert.equal(Object.keys(afterDelete.annotations).some((key) => key.startsWith(`${document.id}:`)), false);
  assert.equal(Object.keys(afterDelete.history).some((key) => key.startsWith(`${document.id}:`)), false);
  assert.equal(fs.existsSync(document.sourcePath), false);
  assert.equal(fs.existsSync(renderDir), false);
  assert.equal(fs.existsSync(sourceImagePath), true);

  await postJson(`${baseUrl}/api/projects`, {
    id: "p-project-delete",
    name: "项目删除测试",
    path: fixtureDir
  });
  const secondSourceImagePath = path.join(fixtureDir, "project-page.jpg");
  fs.writeFileSync(secondSourceImagePath, tinyJpeg());
  const secondImport = await postJson(`${baseUrl}/api/documents/import-path`, {
    path: secondSourceImagePath,
    projectId: "p-project-delete"
  });
  const secondDocument = secondImport.document;
  const secondRenderDir = path.join(tempDir, "renders", secondDocument.id);
  fs.mkdirSync(secondRenderDir, { recursive: true });
  fs.writeFileSync(path.join(secondRenderDir, "page-1.jpg"), tinyJpeg());

  await deleteJson(`${baseUrl}/api/projects/p-project-delete`);

  const afterProjectDelete = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterProjectDelete.projects.some((item) => item.id === "p-project-delete"), false);
  assert.equal(afterProjectDelete.documents.some((item) => item.id === secondDocument.id), false);
  assert.equal(fs.existsSync(secondDocument.sourcePath), false);
  assert.equal(fs.existsSync(secondRenderDir), false);
  assert.equal(fs.existsSync(secondSourceImagePath), true);

  console.log("import-delete.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
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

async function deleteJson(url) {
  const response = await fetch(url, { method: "DELETE" });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVEAEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAAB9A//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64"
  );
}
