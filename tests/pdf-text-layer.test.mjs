import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-pdf-text-test-"));
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
  const pdfPath = path.join(fixtureDir, "selectable.pdf");
  fs.writeFileSync(pdfPath, minimalPdf());

  await postJson(`${baseUrl}/api/projects`, { id: "p-text", name: "文字层测试" });
  const importResult = await postJson(`${baseUrl}/api/documents/import-path`, {
    path: pdfPath,
    projectId: "p-text"
  });

  const document = importResult.document;
  assert.equal(document.type, "pdf");
  assert.equal(document.renderMode, "pdf");
  assert.equal(document.pageCount, 1);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].orientation, "portrait");
  assert.ok(document.pages[0].aspectRatio > 0.7 && document.pages[0].aspectRatio < 0.8);
  assert.equal(document.pages[0].imageUrl, undefined);
  assert.equal(fs.readdirSync(path.join(tempDir, "renders", document.id)).some((file) => /^page-\d+\.jpg$/.test(file)), false);
  const textLayer = await getJson(`${baseUrl}/api/documents/${document.id}/pages/1/text`);
  assert.ok(textLayer.words.length >= 8);

  // The text cache is keyed by content revision. It used to be keyed by document id alone, so a
  // background analysis of the previous file could land in the refreshed document's cache — and
  // pdfTextLayer only re-extracts when the file is absent, so it never healed.
  const textRoot = path.join(tempDir, "renders", document.id, "text");
  const revisions = fs.readdirSync(textRoot).filter((entry) => fs.statSync(path.join(textRoot, entry)).isDirectory());
  assert.equal(revisions.length >= 1, true, "文字缓存没有按内容版本分级");
  assert.equal(revisions.includes(document.contentHash.slice(0, 32)), true, "缓存目录名不是当前内容版本");
  assert.equal(
    fs.readdirSync(textRoot).some((entry) => /^page-\d+\.json$/.test(entry)),
    false,
    "仍在往未分级的路径写文字缓存"
  );

  // A writer holding the previous revision cannot reach the current cache.
  const staleDirectory = path.join(textRoot, "0".repeat(32));
  fs.mkdirSync(staleDirectory, { recursive: true });
  fs.writeFileSync(path.join(staleDirectory, "page-1.json"), JSON.stringify({ text: "旧文档留下的内容", words: [], lines: [] }));
  const afterStale = await getJson(`${baseUrl}/api/documents/${document.id}/pages/1/text`);
  assert.doesNotMatch(afterStale.text, /旧文档留下的内容/, "旧版本的缓存污染了当前文字层");
  assert.match(textLayer.words.map((word) => word.text).join(" "), /1 Introduction/);
  assert.ok(textLayer.words.every((word) => word.x >= 0 && word.y >= 0 && word.w > 0 && word.h > 0));
  assert.ok(textLayer.lines.length >= 3);
  const ocrFallback = await postJson(`${baseUrl}/api/documents/${document.id}/pages/1/ocr`, {});
  assert.ok(ocrFallback.layer.words.length >= 8);
  assert.match(ocrFallback.layer.text, /Introduction/);
  assert.deepEqual(document.outline.map((item) => ({ type: item.type, level: item.level, title: item.title, page: item.page })), [
    { type: "section", level: 1, title: "1 Introduction", page: 1 },
    { type: "figure", level: 3, title: "Figure 1: Test figure", page: 1 }
  ]);

  const outlinePdfPath = path.join(fixtureDir, "native-outline.pdf");
  writeOutlinePdf(outlinePdfPath);
  const outlineImport = await postJson(`${baseUrl}/api/documents/import-path`, {
    path: outlinePdfPath,
    projectId: "p-text"
  });
  assert.deepEqual(outlineImport.document.outline.map((item) => ({ title: item.title, page: item.page, level: item.level })), [
    { title: "Native Bookmark One", page: 1, level: 1 },
    { title: "Nested Bookmark", page: 2, level: 2 }
  ]);

  const columnsPdfPath = path.join(fixtureDir, "columns.pdf");
  fs.writeFileSync(columnsPdfPath, columnPdf());
  const columnsImport = await postJson(`${baseUrl}/api/documents/import-path`, {
    path: columnsPdfPath,
    projectId: "p-text"
  });
  const columnsText = await getJson(`${baseUrl}/api/documents/${columnsImport.document.id}/pages/1/text`);
  const columnLines = columnsText.lines.map((line) => line.text);
  assert.equal(columnLines.some((line) => line.includes("Left column") && line.includes("Right column")), false);
  assert.equal(columnLines.some((line) => line.includes("Left column")), true);
  assert.equal(columnLines.some((line) => line.includes("Right column")), true);

  const previewResponse = await fetch(`${baseUrl}/api/documents/${document.id}/pages/1/preview?dpi=120`);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("content-type"), "image/jpeg");
  const preview = Buffer.from(await previewResponse.arrayBuffer());
  assert.equal(preview[0], 0xff);
  assert.equal(preview[1], 0xd8);
  assert.equal(fs.existsSync(path.join(tempDir, "renders", document.id, "previews", "page-1-120.jpg")), true);

  const sourceResponse = await fetch(`${baseUrl}/api/documents/${document.id}/source`);
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers.get("content-type"), "application/pdf");

  const anchored = await postJson(`${baseUrl}/api/review/threads`, {
    documentId: document.id,
    page: 1,
    annotation: {
      id: "a-reanchor",
      type: "text",
      quote: "Body text for selection",
      anchor: {
        exact: "Body text for selection",
        prefix: "1 Introduction",
        suffix: "Figure 1 Test figure"
      },
      text: "刷新后仍应定位",
      tag: "todo"
    }
  });
  const originalY = anchored.annotation.y;
  fs.writeFileSync(pdfPath, movedTextPdf());
  const refreshed = await postJson(`${baseUrl}/api/documents/${document.id}/refresh`, { clearAnnotations: false });
  assert.equal(refreshed.reanchorResult.matchedCount, 1);
  assert.equal(refreshed.reanchorResult.unmatchedCount, 0);
  const reanchored = refreshed.annotationPages[`${document.id}:1`].find((item) => item.id === "a-reanchor");
  assert.equal(reanchored.anchorStatus, "matched");
  assert.notEqual(reanchored.y, originalY);

  console.log("pdf-text-layer.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeOutlinePdf(filePath) {
  const script = `
from pypdf import PdfWriter
writer = PdfWriter()
writer.add_blank_page(width=612, height=792)
writer.add_blank_page(width=612, height=792)
parent = writer.add_outline_item("Native Bookmark One", 0)
writer.add_outline_item("Nested Bookmark", 1, parent=parent)
with open(r"${filePath}", "wb") as f:
    writer.write(f)
`;
  execFileSync("python3", ["-c", script]);
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

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

function minimalPdf() {
  const stream = "BT /F1 18 Tf 72 720 Td (1 Introduction) Tj 0 -36 Td (Body text for selection) Tj 0 -36 Td (Figure 1: Test figure) Tj ET";
  return pdfWithStream(stream);
}

function columnPdf() {
  return pdfWithStream("BT /F1 18 Tf 72 720 Td (Left column) Tj ET BT /F1 18 Tf 400 720 Td (Right column) Tj ET");
}

function movedTextPdf() {
  return pdfWithStream("BT /F1 18 Tf 72 640 Td (1 Introduction) Tj 0 -54 Td (Body text for selection) Tj 0 -54 Td (Figure 1: Test figure) Tj ET");
}

function pdfWithStream(stream) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}
