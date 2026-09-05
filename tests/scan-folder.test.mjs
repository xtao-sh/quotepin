import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Listing a folder is the cheap half of a batch import, and it has to be honest about two things the
// user is about to act on: which files are already in the workspace, and how much it did not show.
// Importing a path a second time does not merge — it makes a second document — so a wrong "imported"
// flag here turns into duplicates the user has to clean up later.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-scan-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-scan-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;
const scanUrl = `${baseUrl}/api/documents/scan-folder`;

try {
  const lectures = path.join(workDir, "讲义");
  const nested = path.join(lectures, "第二周");
  fs.mkdirSync(nested, { recursive: true });

  writePdf(path.join(lectures, "大纲.pdf"), "Course outline");
  write(path.join(lectures, "日历.csv"), "周次,主题\n1,导论\n");
  write(path.join(lectures, "笔记.md"), "# 笔记\n");
  write(path.join(lectures, "归档.zip"), "not a document");
  write(path.join(lectures, ".DS_Store"), "macOS bookkeeping");
  writePdf(path.join(nested, "第2讲.pdf"), "Week two");

  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "示例课程", path: workDir });

  // A folder that is not there, and one the app keeps its own copies in.
  assert.equal(await postError(scanUrl, { path: path.join(workDir, "不存在") }), "missing_directory");
  assert.equal(await postError(scanUrl, { path: "" }), "missing_directory");
  assert.equal(await postError(scanUrl, { path: path.join(tempDir, "uploads") }), "invalid_directory");

  // The default is the folder itself: what is in front of the user, not everything beneath it.
  const flat = await postJson(scanUrl, { path: lectures });
  assert.deepEqual(flat.files.map((file) => file.name).sort(), ["大纲.pdf", "日历.csv", "笔记.md"]);
  assert.equal(flat.subdirectories, 1, "应当报出有一个下级文件夹，用户才知道还有东西没列");
  assert.equal(flat.recursive, false);

  // Unsupported types and macOS dotfiles never reach the list.
  assert.equal(flat.files.some((file) => file.name === "归档.zip"), false, "不认识的格式不该列出来");
  assert.equal(flat.files.some((file) => file.name.startsWith(".")), false, ".DS_Store 之类不该列出来");

  // Each file carries what the chooser needs to narrow the list down.
  const outline = flat.files.find((file) => file.name === "大纲.pdf");
  assert.equal(outline.kind, "pdf");
  assert.equal(outline.ext, "pdf");
  assert.ok(outline.size > 0);
  assert.ok(outline.modifiedAt > 0);
  assert.equal(outline.imported, false);
  assert.equal(flat.byKind.pdf, 1);
  assert.equal(flat.byKind.data, 1);
  assert.equal(flat.byKind.markdown, 1);

  // Asking for the subtree reaches the nested lecture, and says where it came from.
  const deep = await postJson(scanUrl, { path: lectures, recursive: true });
  const week2 = deep.files.find((file) => file.name === "第2讲.pdf");
  assert.ok(week2, "递归扫描应当找到子文件夹里的文件");
  assert.equal(week2.relativePath, path.join("第二周", "第2讲.pdf"));

  // Once a file is imported, the listing has to say so — and point at the document, so the UI can
  // offer to open it instead of importing it twice.
  const imported = (await postJson(`${baseUrl}/api/documents/import-path`, {
    path: path.join(lectures, "大纲.pdf"),
    projectId: "p"
  })).document;
  const afterImport = await postJson(scanUrl, { path: lectures });
  const outlineAgain = afterImport.files.find((file) => file.name === "大纲.pdf");
  assert.equal(outlineAgain.imported, true, "已经导入的文件必须标出来");
  assert.equal(outlineAgain.documentId, imported.id);
  assert.equal(
    afterImport.files.find((file) => file.name === "笔记.md").imported,
    false,
    "没导入过的不该被误标"
  );

  // An archived document is out of the way, so its file is offered again rather than looking taken.
  await postJson(`${baseUrl}/api/documents/${imported.id}/archive`, { archived: true });
  const afterArchive = await postJson(scanUrl, { path: lectures });
  assert.equal(
    afterArchive.files.find((file) => file.name === "大纲.pdf").imported,
    false,
    "归档的文档不该再让它的源文件显示为已导入"
  );

  // A folder it cannot read is reported rather than silently dropped.
  const locked = path.join(workDir, "锁住的");
  fs.mkdirSync(locked, { recursive: true });
  writePdf(path.join(locked, "隐藏.pdf"), "Hidden");
  fs.chmodSync(locked, 0o000);
  try {
    const guarded = await postJson(scanUrl, { path: workDir, recursive: true });
    assert.ok(guarded.unreadable.length >= 1, "读不了的文件夹应当被报出来，而不是当作空的");
  } finally {
    fs.chmodSync(locked, 0o755);
  }

  console.log("scan-folder.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

function write(target, content) {
  fs.writeFileSync(target, content);
}

// A real, if minimal, PDF: importing runs pdfinfo over it, and a file that merely starts with %PDF
// fails there rather than exercising anything this test is about.
function writePdf(target, line) {
  const body = `BT /F1 24 Tf 60 700 Td (${line}) Tj ET`;
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

async function postError(url, body) {
  const response = await post(url, body);
  assert.equal(response.ok, false, `本该被拒绝：${JSON.stringify(body)}`);
  return (await response.json()).error;
}
