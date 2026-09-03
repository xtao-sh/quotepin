import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-input-limit-test-"));
process.env.REVIEW_APP_DATA = tempDir;
process.env.REVIEW_MAX_DOCUMENT_BYTES = "1024";

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  await request("/api/projects", "POST", { id: "p-limit", name: "文件限制测试" });
  const oversizedPath = path.join(tempDir, "oversized.txt");
  fs.writeFileSync(oversizedPath, Buffer.alloc(2048, 65));

  const pathResponse = await requestFailure("/api/documents/import-path", "POST", { path: oversizedPath, projectId: "p-limit" });
  assert.equal(pathResponse.status, 413);
  assert.equal(pathResponse.json.error, "file_too_large");

  const unsupportedPath = path.join(tempDir, "archive.zip");
  fs.writeFileSync(unsupportedPath, Buffer.from("not-a-document"));
  const unsupportedResponse = await requestFailure("/api/documents/import-path", "POST", { path: unsupportedPath, projectId: "p-limit" });
  assert.equal(unsupportedResponse.status, 415);
  assert.equal(unsupportedResponse.json.error, "unsupported_document_type");

  const form = new FormData();
  form.append("projectId", "p-limit");
  form.append("file", new Blob([Buffer.alloc(2048, 66)]), "oversized.txt");
  const uploadResponse = await fetch(`${baseUrl}/api/documents/upload`, { method: "POST", body: form });
  assert.equal(uploadResponse.status, 413);
  assert.equal((await uploadResponse.json()).error, "file_too_large");

  console.log("input-limits.test.mjs passed");
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

async function requestFailure(url, method, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}
