import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Refreshing a document re-anchors its annotations, which moves each page's revision. If the refresh
// response does not say what the new revisions are, a client that echoes revisions has no way to
// learn them — and every annotation made on the refreshed document conflicts.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-refresh-rev-test-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-refresh-rev-work-"));
process.env.REVIEW_APP_DATA = tempDir;
delete process.env.REVIEW_API_TOKEN;

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // A PDF, because that is the path re-anchoring actually runs on: it locates the quote in the
  // extracted text layer, which a plain text document does not have.
  const sourcePath = path.join(workDir, "plan.pdf");
  writePdf(sourcePath, ["1 Background", "Penetration will double within two years.", "Supply chains follow."]);

  await postJson(`${baseUrl}/api/projects`, { id: "p", name: "刷新", path: workDir });
  const document = (await postJson(`${baseUrl}/api/documents/import-path`, { path: sourcePath, projectId: "p" })).document;
  const pageUrl = `${baseUrl}/api/documents/${document.id}/pages/1/annotations`;

  const annotation = {
    id: "a1",
    type: "text",
    tag: "todo",
    quote: "Penetration will double within two years.",
    anchor: { exact: "Penetration will double within two years.", prefix: "1 Background ", suffix: " Supply chains follow." },
    rects: [{ x: 10, y: 20, w: 30, h: 3 }],
    x: 10,
    y: 20,
    w: 30,
    h: 3,
    text: "补一个数据来源。",
    createdAt: 1,
    updatedAt: 1
  };
  const saved = await putJson(pageUrl, { annotations: [annotation], updatedAt: Date.now(), expectedRevision: 0 });
  assert.ok(saved.revision > 0);

  // The source changes and the user hits refresh.
  // The sentence the annotation points at is untouched; only the text around it changes.
  writePdf(sourcePath, ["1 Background (revised)", "Penetration will double within two years.", "Supply chains and services follow."]);
  const refreshed = await postJson(`${baseUrl}/api/documents/${document.id}/refresh`, {});
  assert.equal(refreshed.contentChanged, true, "刷新没有识别出内容变化");

  // The response has to carry the revisions that go with the annotations it returns, or a client
  // that echoes revisions is left guessing.
  assert.ok(refreshed.annotationRevisions, "刷新响应没有返回页面 revision");
  const pageKey = `${document.id}:1`;
  const revisionAfterRefresh = Number(refreshed.annotationRevisions[pageKey] || 0);
  assert.ok(revisionAfterRefresh > 0, "刷新响应里这一页没有 revision");

  // And it must be the revision the server actually holds.
  const workspace = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(revisionAfterRefresh, Number(workspace.annotationRevisions[pageKey]), "返回的 revision 与服务端不一致");

  // Annotating the refreshed document with that revision succeeds. This is the case that used to
  // conflict every single time.
  const afterRefresh = await putJson(pageUrl, {
    annotations: [...refreshed.annotationPages[pageKey], { ...annotation, id: "a2", text: "这一段也要改。" }],
    updatedAt: Date.now(),
    expectedRevision: revisionAfterRefresh
  });
  assert.equal(afterRefresh.annotations.length, 2, "在刷新后的文档上新增批注失败");

  // Re-anchored annotations are recorded against the new content, so nothing downstream should still
  // describe them as belonging to the previous version.
  const reanchored = refreshed.annotationPages[pageKey].find((item) => item.id === "a1");
  assert.ok(reanchored, "刷新后原批注不见了");
  assert.equal(reanchored.anchorStatus, "matched", "批注没有重新锚定到新内容");
  assert.equal(
    reanchored.anchoredRevision,
    refreshed.document.contentHash,
    "批注仍然记着旧版文档的内容哈希，导出时会被当成旧版批注"
  );


  // Re-anchoring must also refresh the text stored around the quote. The export builds 原文 from
  // anchor.prefix/suffix, so keeping the previous version's wording there tells the AI the
  // annotation belongs to a document that no longer reads that way.
  assert.ok(
    !reanchored.anchor.prefix.includes("1 Background") || reanchored.anchor.prefix.includes("revised"),
    `前文仍是旧版内容：${JSON.stringify(reanchored.anchor.prefix)}`
  );
  assert.match(reanchored.anchor.suffix, /services/, `后文仍是旧版内容：${JSON.stringify(reanchored.anchor.suffix)}`);

  // Restoring an earlier version re-anchors the same way, so it owes the client the same answer.
  const versions = (await getJson(`${baseUrl}/api/workspace`)).documents.find((item) => item.id === document.id).versions || [];
  assert.ok(versions.length > 0, "刷新后没有留下可恢复的版本");
  const restored = await postJson(`${baseUrl}/api/documents/${document.id}/versions/${versions[0].id}/restore`, {});
  assert.ok(restored.annotationRevisions, "版本恢复响应没有返回页面 revision");
  const revisionAfterRestore = Number(restored.annotationRevisions[pageKey] || 0);
  assert.equal(
    revisionAfterRestore,
    Number((await getJson(`${baseUrl}/api/workspace`)).annotationRevisions[pageKey]),
    "版本恢复返回的 revision 与服务端不一致"
  );
  const afterRestore = await putJson(pageUrl, {
    annotations: restored.annotationPages[pageKey],
    updatedAt: Date.now(),
    expectedRevision: revisionAfterRestore
  });
  assert.ok(afterRestore.revision > revisionAfterRestore, "在恢复后的文档上批注失败");

  console.log("refresh-revision.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

function writePdf(target, lines) {
  const body = lines.map((line, index) => `BT /F1 14 Tf 72 ${720 - index * 28} Td (${line}) Tj ET`).join("\n");
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
