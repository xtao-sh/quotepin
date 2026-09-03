import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadRemoteDocument, isRemoteAddressForbidden, parseRemoteDocumentUrl } from "../server/remote-import.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-remote-import-test-"));
process.env.REVIEW_APP_DATA = path.join(tempDir, "workspace");

const fileServer = http.createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/document" });
    res.end();
    return;
  }
  if (req.url === "/large") {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "2048" });
    res.end(Buffer.alloc(2048, 65));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": "attachment; filename*=UTF-8''review%20notes.txt"
  });
  res.end("remote document content");
});
await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
const filePort = fileServer.address().port;

try {
  assert.equal(parseRemoteDocumentUrl("https://example.com/document.pdf").protocol, "https:");
  assert.throws(() => parseRemoteDocumentUrl("file:///tmp/document.pdf"), (error) => error.code === "invalid_remote_url");
  assert.throws(() => parseRemoteDocumentUrl("https://user:pass@example.com/file.pdf"), (error) => error.code === "invalid_remote_url");

  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.5", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isRemoteAddressForbidden(address), true, `${address} should be blocked`);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
    assert.equal(isRemoteAddressForbidden(address), false, `${address} should be allowed`);
  }

  const destination = path.join(tempDir, "downloaded.txt");
  const result = await downloadRemoteDocument({
    url: `http://127.0.0.1:${filePort}/redirect`,
    destination,
    maxBytes: 1024,
    allowPrivate: true
  });
  assert.equal(result.fileName, "review notes.txt");
  assert.equal(result.mime, "text/plain");
  assert.equal(fs.readFileSync(destination, "utf8"), "remote document content");
  assert.equal(result.finalUrl.endsWith("/document"), true);

  await assert.rejects(
    downloadRemoteDocument({
      url: `http://127.0.0.1:${filePort}/document`,
      destination: path.join(tempDir, "blocked.txt"),
      maxBytes: 1024
    }),
    (error) => error.code === "remote_address_forbidden" && error.statusCode === 403
  );

  await assert.rejects(
    downloadRemoteDocument({
      url: `http://127.0.0.1:${filePort}/large`,
      destination: path.join(tempDir, "large.txt"),
      maxBytes: 1024,
      allowPrivate: true
    }),
    (error) => error.code === "file_too_large" && error.statusCode === 413
  );

  // The SSRF guard itself: every case above runs with allowPrivate: true so the loopback fixture
  // works, which means nothing exercised the classifier or the per-hop revalidation.
  for (const address of [
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "192.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "fd00::1", "fc00::1",
    "fe80::1", "ff02::1", "2001:db8::1", "2002::1", "64:ff9b::1",
    "not-an-ip", "", null
  ]) {
    assert.equal(isRemoteAddressForbidden(address), true, `${address} 应当被拒绝`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(isRemoteAddressForbidden(address), false, `${address} 不应被拒绝`);
  }

  // Only http(s) may be fetched at all.
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "gopher://example.com"]) {
    assert.throws(() => parseRemoteDocumentUrl(url), (error) => error.code === "invalid_remote_url", `${url} 应当被拒绝`);
  }

  // A redirect is revalidated: with the guard on, a hop into a private address is refused rather
  // than followed. (Both hops are loopback here, so this asserts the guard is active on the path.)
  await assert.rejects(
    downloadRemoteDocument({
      url: `http://127.0.0.1:${filePort}/redirect`,
      destination: path.join(tempDir, "blocked.txt"),
      maxBytes: 1024
    }),
    (error) => error.code === "remote_address_forbidden" && error.statusCode === 403
  );
  assert.equal(fs.existsSync(path.join(tempDir, "blocked.txt")), false, "被拒绝的下载留下了文件");

  const { startServer } = await import("../server/index.js");
  const appServer = startServer(0);
  const appPort = await new Promise((resolve) => appServer.on("listening", () => resolve(appServer.address().port)));
  const baseUrl = `http://127.0.0.1:${appPort}`;
  try {
    await postJson(baseUrl, "/api/projects", { id: "p-remote", name: "远程导入测试" });
    const invalid = await postJsonFailure(baseUrl, "/api/documents/import-url", { url: "ftp://example.com/file.pdf", projectId: "p-remote" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, "invalid_remote_url");
    const privateTarget = await postJsonFailure(baseUrl, "/api/documents/import-url", { url: `http://127.0.0.1:${filePort}/document`, projectId: "p-remote" });
    assert.equal(privateTarget.status, 403);
    assert.equal(privateTarget.json.error, "remote_address_forbidden");
  } finally {
    await new Promise((resolve) => appServer.close(resolve));
  }

  console.log("remote-import.test.mjs passed");
} finally {
  await new Promise((resolve) => fileServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function postJson(baseUrl, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postJsonFailure(baseUrl, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}
