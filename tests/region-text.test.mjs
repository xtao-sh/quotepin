import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reading a selection off the rendered page is the only way to recover a quote from a PDF whose
// font carries no ToUnicode map. The route has to hold up whether or not the machine running it has
// an OCR engine, and it must not read a rectangle nobody asked for.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-region-text-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-region-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const hasTesseract = (() => {
  try {
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const sourcePath = path.join(workDir, "slide.pdf");
  writePdf(sourcePath, ["Marketing Analytics", "Autumn 2026", "Shanghai"]);
  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "区域识别", path: workDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "p" })).document;
  const url = `${baseUrl}/api/documents/${document.id}/pages/1/region-text`;

  // A region is required, and it has to be a region — no rectangles, degenerate rectangles and
  // nonsense all mean the same thing and none of them should start an OCR run.
  for (const body of [{}, { rects: [] }, { rects: [{ x: 1, y: 1, w: 0, h: 4 }] }, { rects: [{ x: "a", y: 1, w: 2, h: 3 }] }]) {
    const response = await post(url, body);
    assert.equal(response.status, 400, `应当拒绝：${JSON.stringify(body)}`);
    assert.equal((await response.json()).error, "invalid_region");
  }

  // Pages that do not exist, and documents that do not exist.
  assert.equal((await post(`${baseUrl}/api/documents/${document.id}/pages/99/region-text`, { rects: [{ x: 1, y: 1, w: 5, h: 5 }] })).status, 400);
  assert.equal((await post(`${baseUrl}/api/documents/missing/pages/1/region-text`, { rects: [{ x: 1, y: 1, w: 5, h: 5 }] })).status, 404);

  const region = { rects: [{ x: 5, y: 8, w: 60, h: 10 }] };
  const response = await post(url, region);
  if (!hasTesseract) {
    // A machine without an OCR engine gets told which tool is missing, not a stack trace.
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, "runtime_tool_missing");
    assert.equal(payload.tool, "tesseract");
    console.log("region-text.test.mjs passed (no tesseract: recovery path skipped)");
  } else {
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.ok(payload.languages, "应当报告用了哪些语言");
    assert.ok(Number.isFinite(payload.confidence));
    // The fixture says "Marketing Analytics" in Helvetica at the top of the page; OCR is allowed to
    // be imperfect, but it has to come back with something from that line rather than nothing.
    assert.match(payload.text, /Marketing|Analytics/i, `识别结果与页面无关：${JSON.stringify(payload.text)}`);
    console.log("region-text.test.mjs passed");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

function writePdf(target, lines) {
  const body = lines.map((line, index) => `BT /F1 28 Tf 60 ${700 - index * 60} Td (${line}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(target, pdf, "latin1");
}

async function post(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postJson(url, body) {
  const response = await post(url, body);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}
