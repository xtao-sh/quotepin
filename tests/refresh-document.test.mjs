import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-refresh-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");

const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixtureDir = path.join(tempDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sourceImagePath = path.join(fixtureDir, "review-page.jpg");
  const firstMtime = Date.now() - 30000;
  const secondMtime = Date.now() + 5000;
  const thirdMtime = Date.now() + 10000;
  fs.writeFileSync(sourceImagePath, tinyJpeg());
  fs.utimesSync(sourceImagePath, new Date(firstMtime), new Date(firstMtime));

  await postJson(`${baseUrl}/api/projects`, { id: "p-refresh", name: "刷新测试" });
  const importResult = await postJson(`${baseUrl}/api/documents/import-path`, {
    path: sourceImagePath,
    projectId: "p-refresh"
  });
  const document = importResult.document;
  assert.equal(document.originalPath, sourceImagePath);
  assert.equal(document.sourceFileName, "review-page.jpg");
  assert.ok(Math.abs(document.sourceModifiedAt - firstMtime) < 1000);

  const renamed = await patchJson(`${baseUrl}/api/documents/${document.id}`, { name: "自定义显示名称" });
  assert.equal(renamed.document.name, "自定义显示名称");

  await putJson(`${baseUrl}/api/documents/${document.id}/pages/1/annotations`, {
    annotations: [{
        id: "a-refresh",
        type: "pin",
        tag: "todo",
        text: "刷新后默认应该保留",
        x: 50,
        y: 50,
        createdAt: Date.now()
      }],
    updatedAt: Date.now()
  });
  await patchJson(`${baseUrl}/api/documents/${document.id}`, { annotationsNeedReview: true });

  fs.utimesSync(sourceImagePath, new Date(secondMtime), new Date(secondMtime));
  const newerInfo = await getJson(`${baseUrl}/api/documents/${document.id}/source-info`);
  assert.equal(newerInfo.sourceTracked, true);
  assert.equal(newerInfo.sourceMissing, false);
  assert.equal(newerInfo.hasNewerSource, false, "touching an unchanged source must not create a false new-version alert");
  assert.ok(Math.abs(newerInfo.sourceModifiedAt - secondMtime) < 1000);

  const refreshResult = await postJson(`${baseUrl}/api/documents/${document.id}/refresh`, { clearAnnotations: false });
  assert.equal(refreshResult.document.id, document.id);
  assert.equal(refreshResult.document.name, "自定义显示名称");
  assert.equal(refreshResult.document.sourceFileName, "review-page.jpg");
  assert.equal(refreshResult.document.type, "image");
  assert.equal(refreshResult.document.ext, "JPG");
  assert.equal(refreshResult.document.originalPath, sourceImagePath);
  assert.equal(refreshResult.clearedAnnotations, false);
  assert.equal(refreshResult.contentChanged, false);
  assert.equal(refreshResult.previousPageCount, 1);
  assert.equal(refreshResult.document.annotationsNeedReview, true);
  assert.equal(refreshResult.sourceInfo.hasNewerSource, false);
  assert.equal(fs.existsSync(refreshResult.document.sourcePath), true);

  const afterRefresh = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterRefresh.annotations[`${document.id}:1`].length, 1);

  const reboundSourcePath = path.join(fixtureDir, "rebound-page.jpg");
  fs.writeFileSync(reboundSourcePath, Buffer.concat([tinyJpeg(), Buffer.from("version-2")]));
  fs.utimesSync(reboundSourcePath, new Date(thirdMtime), new Date(thirdMtime));
  const reboundResult = await postJson(`${baseUrl}/api/documents/${document.id}/refresh`, {
    path: reboundSourcePath,
    clearAnnotations: false
  });
  assert.equal(reboundResult.document.id, document.id);
  assert.equal(reboundResult.document.originalPath, reboundSourcePath);
  assert.equal(reboundResult.document.name, "自定义显示名称");
  assert.equal(reboundResult.document.sourceFileName, "rebound-page.jpg");
  assert.equal(reboundResult.document.type, "image");
  assert.equal(reboundResult.clearedAnnotations, false);
  assert.equal(reboundResult.document.annotationsNeedReview, true);

  const afterRebound = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterRebound.annotations[`${document.id}:1`].length, 1);

  const selectedVersion = new FormData();
  selectedVersion.append("file", new Blob([Buffer.concat([tinyJpeg(), Buffer.from("selected-version")])], { type: "image/jpeg" }), "selected-version.jpg");
  selectedVersion.append("clearAnnotations", "false");
  const selectedResult = await postForm(`${baseUrl}/api/documents/${document.id}/refresh`, selectedVersion);
  assert.equal(selectedResult.document.originalPath, reboundSourcePath);
  assert.equal(selectedResult.contentChanged, true);
  assert.ok(selectedResult.document.versions.length >= 2);
  const firstVersion = selectedResult.document.versions.find((version) => version.contentHash === document.contentHash);
  assert.ok(firstVersion);
  const restoredVersion = await postJson(`${baseUrl}/api/documents/${document.id}/versions/${firstVersion.id}/restore`, {});
  assert.equal(restoredVersion.document.contentHash, document.contentHash);
  assert.equal(restoredVersion.document.originalPath, reboundSourcePath);
  assert.ok(restoredVersion.document.versions.some((version) => version.contentHash === selectedResult.document.contentHash));

  const fourthMtime = Date.now() + 15000;
  fs.utimesSync(reboundSourcePath, new Date(fourthMtime), new Date(fourthMtime));
  const clearResult = await postJson(`${baseUrl}/api/documents/${document.id}/refresh`, { clearAnnotations: true });
  assert.equal(clearResult.document.id, document.id);
  assert.equal(clearResult.clearedAnnotations, true);
  assert.equal(clearResult.document.annotationsNeedReview, false);

  const afterClear = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterClear.annotations[`${document.id}:1`], undefined);
  assert.ok(Math.abs(afterClear.documents.find((item) => item.id === document.id).sourceModifiedAt - fourthMtime) < 1000);
  assert.equal(fs.existsSync(sourceImagePath), true);
  assert.equal(fs.existsSync(reboundSourcePath), true);

  const currentDocument = afterClear.documents.find((item) => item.id === document.id);
  const currentAssetPath = currentDocument.sourcePath;
  const brokenPdfPath = path.join(fixtureDir, "broken.pdf");
  fs.writeFileSync(brokenPdfPath, "not a valid pdf");
  const failedRefresh = await postJsonExpectFailure(`${baseUrl}/api/documents/${document.id}/refresh`, {
    path: brokenPdfPath,
    clearAnnotations: false
  });
  assert.equal(failedRefresh.status, 500);
  assert.equal(failedRefresh.json.error, "refresh_failed");

  const afterFailedRefresh = await getJson(`${baseUrl}/api/workspace`);
  const preservedDocument = afterFailedRefresh.documents.find((item) => item.id === document.id);
  assert.equal(preservedDocument.sourcePath, currentAssetPath);
  assert.equal(fs.existsSync(currentAssetPath), true);
  assert.equal(fs.readdirSync(path.join(tempDir, "uploads")).some((file) => file.startsWith(`refresh-${document.id}-`)), false);
  assert.equal(fs.readdirSync(path.join(tempDir, "renders")).some((file) => file.startsWith(`refresh-${document.id}-`)), false);

  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([tinyJpeg()], { type: "image/jpeg" }), "browser-upload.jpg");
  uploadForm.append("projectId", "p-refresh");
  const uploadResult = await postForm(`${baseUrl}/api/documents/upload`, uploadForm);
  assert.equal(uploadResult.document.originalPath, "");

  const untrackedInfo = await getJson(`${baseUrl}/api/documents/${uploadResult.document.id}/source-info`);
  assert.equal(untrackedInfo.sourceTracked, false);
  assert.equal(untrackedInfo.sourceLabel, "未关联原始文件");
  const untrackedRefresh = await postJsonExpectFailure(`${baseUrl}/api/documents/${uploadResult.document.id}/refresh`, { clearAnnotations: false });
  assert.equal(untrackedRefresh.status, 400);
  assert.equal(untrackedRefresh.json.error, "source_untracked");

  const shrinkingTextPath = path.join(fixtureDir, "shrinking.txt");
  fs.writeFileSync(shrinkingTextPath, "第一页内容。".repeat(180) + "第二页内容。".repeat(180));
  const shrinkingDocument = (await postJson(`${baseUrl}/api/documents/import-path`, {
    path: shrinkingTextPath,
    projectId: "p-refresh"
  })).document;
  assert.ok(shrinkingDocument.pageCount > 1);
  const orphanedPage = shrinkingDocument.pageCount;
  const orphanedKey = `${shrinkingDocument.id}:${orphanedPage}`;
  const orphanedAnnotation = {
    id: "a-orphaned-page",
    type: "pin",
    tag: "question",
    text: "页数减少后应归档",
    x: 20,
    y: 30,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await putJson(`${baseUrl}/api/documents/${shrinkingDocument.id}/pages/${orphanedPage}/annotations`, {
    annotations: [orphanedAnnotation],
    updatedAt: Date.now()
  });
  await putJson(`${baseUrl}/api/documents/${shrinkingDocument.id}/pages/${orphanedPage}/history`, {
    history: [{ id: "h-orphaned-page", action: "snapshot", label: "旧页", ts: Date.now(), snapshot: [orphanedAnnotation] }]
  });
  fs.writeFileSync(shrinkingTextPath, "新版只有一页。".repeat(20));
  const shrinkingRefresh = await postJson(`${baseUrl}/api/documents/${shrinkingDocument.id}/refresh`, { clearAnnotations: false });
  assert.equal(shrinkingRefresh.document.pageCount, 1);
  assert.equal(shrinkingRefresh.orphanedPages.annotationCount, 1);
  assert.equal(shrinkingRefresh.orphanedPages.historyCount, 1);
  assert.equal(fs.existsSync(shrinkingRefresh.orphanedPages.archivePath), true);
  const afterShrink = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterShrink.annotations[orphanedKey], undefined);
  assert.equal(afterShrink.history[orphanedKey], undefined);
  assert.equal(afterShrink.annotationRevisions[orphanedKey], undefined);
  assert.equal(afterShrink.historyRevisions[orphanedKey], undefined);
  assert.equal(afterShrink.reviewThreads[orphanedAnnotation.id], undefined);
  const validBackup = await fetch(`${baseUrl}/api/backup/full`);
  assert.equal(validBackup.status, 200);
  assert.equal(Buffer.from(await validBackup.arrayBuffer()).subarray(0, 2).toString(), "PK");

  console.log("refresh-document.test.mjs passed");
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

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postForm(url, body) {
  const response = await fetch(url, { method: "POST", body });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postJsonExpectFailure(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVEAEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAAB9A//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64"
  );
}
