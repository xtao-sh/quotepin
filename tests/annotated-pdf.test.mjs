import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-pdf-export-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const sourcePath = path.join(tempDir, "source.pdf");
  fs.writeFileSync(sourcePath, minimalPdf(["Page one", "Page two", "Page three"]));
  await request("/api/projects", "POST", { id: "p-pdf-export", name: "批注 PDF 测试" });
  const imported = await request("/api/documents/import-path", "POST", { path: sourcePath, projectId: "p-pdf-export" });
  const documentId = imported.document.id;
  const now = Date.now();
  const annotations = [
    { id: "a-note", type: "note", text: "这一页需要整体调整。", tag: "todo", createdAt: now, updatedAt: now },
    { id: "a-pin", type: "pin", x: 28, y: 22, text: "修改标题。", tag: "question", createdAt: now, updatedAt: now },
    { id: "a-text", type: "text", x: 12, y: 30, w: 52, h: 4, rects: [{ x: 12, y: 30, w: 52, h: 4 }], quote: "Body text for selection", text: "改写这句话。", tag: "resolved", createdAt: now, updatedAt: now }
  ];
  await request(`/api/documents/${documentId}/pages/2/annotations`, "PUT", { annotations, updatedAt: now });

  const annotatedPath = await exportPdf("annotated");
  assert.match(pdfInfo(annotatedPath), /^Pages:\s+2$/m);
  assert.match(pdfPageText(annotatedPath, 1), /Page two/);

  const allPagesPath = await exportPdf("all");
  assert.match(pdfInfo(allPagesPath), /^Pages:\s+4$/m);
  assert.match(pdfPageText(allPagesPath, 1), /Page one/);
  assert.match(pdfPageText(allPagesPath, 2), /Page two/);
  assert.match(pdfPageText(allPagesPath, 4), /Page three/);

  console.log("annotated-pdf.test.mjs passed");

  async function exportPdf(pageMode) {
    const response = await fetch(`${baseUrl}/api/export/annotated-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, scope: "doc", page: 1, pageMode })
    });
    if (response.status !== 200) assert.fail(await response.text());
    assert.match(response.headers.get("content-type"), /application\/pdf/);
    const output = Buffer.from(await response.arrayBuffer());
    assert.equal(output.subarray(0, 4).toString(), "%PDF");
    const outputPath = path.join(tempDir, `${pageMode}.pdf`);
    fs.writeFileSync(outputPath, output);
    return outputPath;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function request(url, method = "GET", body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

function pdfInfo(filePath) {
  return execFileSync("pdfinfo", [filePath], { encoding: "utf8" });
}

function pdfPageText(filePath, page) {
  return execFileSync("pdftotext", ["-f", String(page), "-l", String(page), filePath, "-"], { encoding: "utf8" });
}

function minimalPdf(pageLabels) {
  const pageCount = pageLabels.length;
  const fontObject = 3 + pageCount * 2;
  const pageObjects = pageLabels.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects.map((object) => `${object} 0 R`).join(" ")}] /Count ${pageCount} >>`
  ];
  for (const [index, label] of pageLabels.entries()) {
    const contentObject = 4 + index * 2;
    const stream = `BT /F1 18 Tf 72 720 Td (${label}) Tj 0 -36 Td (Body text for selection) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}
