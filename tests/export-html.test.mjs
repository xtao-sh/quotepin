import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");

const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const pdfPath = path.join(tempDir, "测试文档.pdf");
  writeTwoPagePdf(pdfPath);
  await postJson(`${baseUrl}/api/projects`, { id: "p-test", name: "HTML 导出测试", path: tempDir });
  const imported = await postJson(`${baseUrl}/api/documents/import-path`, { path: pdfPath, projectId: "p-test" });
  const document = imported.document;
  await putJson(`${baseUrl}/api/documents/${document.id}/pages/1/annotations`, {
    annotations: [{
      id: "a-test",
      type: "pin",
      text: "这里需要补充说明",
      tag: "todo",
      x: 50,
      y: 40,
      createdAt: Date.now()
    }],
    updatedAt: Date.now()
  });

  const payload = {
    project: { id: "p-test", name: "HTML 导出测试", path: tempDir },
    document: { id: document.id, name: "测试文档.pdf", type: "pdf", renderMode: "pdf", pageCount: 2, sourcePath: document.sourcePath },
    scope: "doc",
    exportedAt: new Date().toISOString(),
    pages: [{
      index: 1,
      title: "第一页",
      previewUrl: `/api/documents/${document.id}/pages/1/preview`,
      annotations: [{
        id: "a-test",
        type: "pin",
        tag: "todo",
        text: "这里需要补充说明",
        locationLabel: "中中",
        position: { x: 50, y: 40 },
        createdAt: new Date().toISOString(),
        review: {
          status: "addressed",
          messages: [{ role: "assistant", author: "Codex", body: "已补充来源说明", change: { summary: "补写来源段落" } }]
        }
      }]
    }]
  };

  const htmlExport = await postJson(`${baseUrl}/api/export/review-html`, payload);
  assert.equal(htmlExport.ok, true);
  assert.equal(htmlExport.fileName, "测试文档-document.html");
  assert.match(htmlExport.html, /^<!doctype html>/);
  assert.equal((htmlExport.html.match(/<section class="slide/g) || []).length, 2);
  assert.match(htmlExport.html, /data:image\/jpeg;base64,/);
  assert.match(htmlExport.html, /这里需要补充说明/);
  assert.match(htmlExport.html, /已补充来源说明/);
  assert.match(htmlExport.html, /补写来源段落/);
  assert.match(htmlExport.html, /复制修改清单/);
  assert.match(htmlExport.html, /第 2 页/);

  const aiRevision = await postJson(`${baseUrl}/api/revision-checklist`, payload);
  assert.equal(aiRevision.ok, true);
  assert.equal(aiRevision.generator, "local-checklist");
  assert.deepEqual(aiRevision.actions[0], {
    page: 1,
    pageTitle: "第一页",
    target: "pin",
    location: "中中",
    change: "这里需要补充说明",
    priority: "high"
  });

  console.log("export-html.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
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

function writeTwoPagePdf(filePath) {
  const script = `
from pypdf import PdfWriter
writer = PdfWriter()
writer.add_blank_page(width=612, height=792)
writer.add_blank_page(width=612, height=792)
with open(r"${filePath}", "wb") as handle:
    writer.write(handle)
`;
  execFileSync("python3", ["-c", script]);
}
