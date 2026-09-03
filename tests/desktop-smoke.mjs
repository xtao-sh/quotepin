import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import apiVersionHelpers from "../server/api-version.cjs";

const { API_VERSION } = apiVersionHelpers;

const appPath = path.resolve(process.env.DESKTOP_APP_PATH || "release/mac-arm64/批注工作台.app/Contents/MacOS/批注工作台");
assert.equal(fs.existsSync(appPath), true, `Desktop app executable not found: ${appPath}`);

// This runs against whatever was packaged last, which is easy to forget: a stale bundle passes while
// the current source is broken. Refuse to report on a build older than the code it claims to cover.
const packagedAt = fs.statSync(appPath).mtimeMs;
const newestSource = ["server", "electron", "mcp", "src", "package.json"]
  .flatMap((entry) => newestMtime(path.resolve(entry)))
  .reduce((newest, value) => Math.max(newest, value), 0);
assert.equal(
  packagedAt >= newestSource,
  true,
  `打包产物比源码旧（${new Date(packagedAt).toISOString()} < ${new Date(newestSource).toISOString()}）。先运行 npm run desktop:pack。`
);

function newestMtime(target) {
  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) return [stats.mtimeMs];
  return fs.readdirSync(target).flatMap((name) => newestMtime(path.join(target, name)));
}

const port = 4620 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-desktop-smoke-"));
const rendererReportPath = path.join(dataDir, "renderer-smoke.json");
// A packaged app has no bundled Python: inside the bundle there is no .venv to find, so the
// document dependencies have to be supplied the documented way. Passing PYTHON also exercises the
// rule that an explicit override is authoritative rather than a hint.
const repoPython = process.env.PYTHON || path.resolve(".venv/bin/python3");
if (!process.env.PYTHON) {
  assert.equal(fs.existsSync(repoPython), true, `缺少 ${repoPython}，请先按 README 安装 Python 依赖，或设置 PYTHON 指向可用的解释器`);
}

const child = spawn(appPath, [], {
  env: {
    ...process.env,
    PYTHON: repoPython,
    REVIEW_DESKTOP_PORT: String(port),
    REVIEW_APP_DATA: dataDir,
    REVIEW_DESKTOP_SMOKE_REPORT: rendererReportPath
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const health = await waitForJson(`http://127.0.0.1:${port}/api/health`, 30000);
  assert.equal(health.ok, true);
  assert.equal(health.service, "review-annotation-api");
  assert.ok(Number(health.apiVersion) >= API_VERSION);
  assert.equal(typeof health.storeId, "string");
  assert.equal("store" in health, false);
  assert.equal(health.tools?.outline, true);
  assert.equal(health.tools?.pdfExport, true);
  assert.equal("apiToken" in health, false);
  const rendererReport = await waitForJsonFile(rendererReportPath, 30000);
  assert.equal(rendererReport.rootChildCount > 0, true);
  assert.equal(rendererReport.appShell, true);
  assert.equal(rendererReport.primaryViewReady, true);
  assert.match(rendererReport.bodyText, /批注|文档|项目/);

  const apiToken = fs.readFileSync(path.join(dataDir, ".api-capability"), "utf8").trim();
  assert.match(apiToken, /^[a-f0-9]{64}$/);
  const integrationResponse = await fetch(`http://127.0.0.1:${port}/api/integrations/ai`, {
    headers: { "X-Review-Api-Token": apiToken }
  });
  const integration = await integrationResponse.json();
  assert.equal(integrationResponse.ok, true);
  assert.equal(integration.mcp.available, true);
  assert.equal(fs.existsSync(integration.mcp.entryPath), true);
  assert.match(integration.mcp.entryPath, /app\.asar\.unpacked.+dist-mcp.+review-annotation-server\.mjs$/);
  assert.equal(integration.mcp.apiUrl, `http://127.0.0.1:${port}`);

  const hostileResponse = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
    headers: { Origin: "https://attacker.example" }
  });
  assert.equal(hostileResponse.status, 403);

  const reboundResponse = await requestJson(port, "/api/workspace", {
    Host: `attacker.example:${port}`,
    Origin: `http://attacker.example:${port}`
  });
  assert.equal(reboundResponse.status, 403);
  assert.deepEqual(reboundResponse.body, { ok: false, error: "host_forbidden" });

  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const html = await pageResponse.text();
  assert.equal(pageResponse.ok, true);
  assert.match(html, /<div id="root"><\/div>/);

  console.log("desktop-smoke.test.mjs passed");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Desktop app exited early with code ${child.exitCode}\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}\n${output}`);
}

async function waitForJsonFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Desktop app exited before rendering\n${output}`);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for renderer report: ${filePath}\n${output}`);
}

function requestJson(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once("error", reject);
    request.end();
  });
}
