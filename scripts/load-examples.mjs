#!/usr/bin/env node
// 把 examples/ 下的示例工作区载入正在运行的批注工作台。
//
// 示例文件会先被复制到一个你自己的文件夹（默认 ~/Documents/批注工作台示例），再从那里导入。
// 不直接从仓库导入有两个原因：文档会记住它的原始路径，绑到仓库检出目录上没有意义；而且刷新
// 演示需要覆盖源文件，那样会弄脏仓库。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dataDirectoryHelpers from "../server/data-directory.cjs";
import apiVersionHelpers from "../server/api-version.cjs";

const { defaultWorkspaceDataDirectory, workspaceStoreId } = dataDirectoryHelpers;
const { isSupportedApi } = apiVersionHelpers;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "examples");
const filesDir = path.join(examplesDir, "files");
const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "manifest.json"), "utf8"));

const destination = path.resolve(
  process.env.REVIEW_EXAMPLES_DIR || path.join(os.homedir(), "Documents", "批注工作台示例")
);
const dataDir = path.resolve(process.env.REVIEW_APP_DATA || defaultWorkspaceDataDirectory());

function fail(message, hint = "") {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// The capability is read, never created: a token we invent would not match the one the running
// server already holds in memory, and the failure would look like a bug rather than "app not running".
function readCapability() {
  if (process.env.REVIEW_API_TOKEN) return process.env.REVIEW_API_TOKEN.trim();
  const capabilityPath = path.join(dataDir, ".api-capability");
  if (!fs.existsSync(capabilityPath)) {
    fail(
      "找不到本地接口令牌。",
      `应当在 ${capabilityPath}。请先启动批注工作台，或用 REVIEW_APP_DATA 指向正确的数据目录。`
    );
  }
  return fs.readFileSync(capabilityPath, "utf8").trim();
}

const token = readCapability();
const expectedStoreId = workspaceStoreId(path.join(dataDir, "workspace.json"));

// The port is not fixed: 4517 is the dev default, 4520 the desktop one, and Electron falls back to an
// ephemeral port when 4520 is busy. Probing /api/health and matching storeId is the only way to be
// sure we are talking to the instance that owns this data directory.
async function findBaseUrl() {
  const candidates = [
    process.env.REVIEW_API_URL?.replace(/\/+$/, ""),
    "http://127.0.0.1:4517",
    "http://127.0.0.1:4520"
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const health = await response.json();
      if (!isSupportedApi(health)) continue;
      if (health.storeId !== expectedStoreId) continue;
      if (!health.storeId) {
        fail("批注工作台正处在恢复模式，工作区还没有载入。", "请先在应用里从快照恢复，然后重试。");
      }
      return base;
    } catch {
      continue;
    }
  }
  fail(
    "没有找到正在运行的批注工作台。",
    "请先启动应用（或 npm run dev），必要时用 REVIEW_API_URL 指定地址，例如 REVIEW_API_URL=http://127.0.0.1:4530。"
  );
}

const baseUrl = await findBaseUrl();

async function call(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Review-Api-Token": token
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail ? `：${payload.detail}` : "";
    throw new Error(`${method} ${route} 失败（${response.status} ${payload.error || "未知错误"}）${detail}`);
  }
  return payload;
}

// ------------------------------------------------------------------ 复制示例文件
function stageFiles() {
  fs.mkdirSync(destination, { recursive: true });
  const staged = new Map();
  for (const entry of manifest.documents) {
    const source = path.join(filesDir, entry.file);
    if (!fs.existsSync(source)) fail(`示例文件缺失：${entry.file}`, "可以运行 examples/generate.py 重新生成 PDF。");
    const target = path.join(destination, entry.as || entry.file);
    fs.copyFileSync(source, target);
    staged.set(entry.as || entry.file, target);
  }
  return staged;
}

// ------------------------------------------------------------------ 批注定位
// A text annotation needs real rectangles, and the only honest source for them is the document's own
// text layer. Matching a whole line keeps this simple: each line already carries a bounding box in
// page percentages, which is exactly the unit annotations are stored in.
//
// Matching ignores whitespace because the line text is pdftotext's word boxes joined with spaces,
// and where it decides to split a Chinese run is not something a manifest should have to predict.
//
// Only PDFs have this layer. Text-mode documents (.md, .txt, .csv) return no lines at all — their
// selection geometry lives in the rendered DOM, which a seeding script cannot see. Annotations on
// those documents have to be page notes.
const squash = (value) => String(value || "").replace(/\s+/g, "");

async function locateQuote(documentId, page, match) {
  const layer = await call("GET", `/api/documents/${documentId}/pages/${page}/text`);
  const lines = Array.isArray(layer.lines) ? layer.lines : [];
  const wanted = squash(match);
  const line = lines.find((item) => squash(item.text).includes(wanted));
  if (!line) return null;
  return {
    quote: String(line.text || "").trim(),
    rect: { x: round(line.x), y: round(line.y), w: round(line.w), h: round(line.h) }
  };
}

const round = (value) => Math.max(0, Math.min(100, Math.round(Number(value) * 1000) / 1000));

let annotationSeq = 0;
const nextId = () => `ex-${(annotationSeq += 1).toString().padStart(3, "0")}`;

function buildAnnotation(spec, located, stamp) {
  const base = {
    id: nextId(),
    type: spec.type,
    text: spec.text,
    tag: spec.tag || null,
    createdAt: stamp,
    updatedAt: stamp
  };
  if (spec.type === "note") return base;
  if (spec.type === "pin") return { ...base, x: spec.x, y: spec.y };
  if (spec.type === "region") return { ...base, x: spec.x, y: spec.y, w: spec.w, h: spec.h };
  const { quote, rect } = located;
  return {
    ...base,
    quote,
    anchor: { exact: quote },
    anchorStatus: "matched",
    rects: [rect],
    ...rect
  };
}

// ------------------------------------------------------------------ 主流程
console.log(`批注工作台：${baseUrl}`);
console.log(`示例文件夹：${destination}\n`);

const staged = stageFiles();
console.log(`复制了 ${staged.size} 份示例文件`);

for (const group of manifest.groups) {
  await call("POST", "/api/groups", group);
}
console.log(`建立分组 ${manifest.groups.map((g) => g.name).join("、")}`);

// Parents before children: a sub-project whose parent does not exist yet is refused.
for (const project of [...manifest.projects].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0))) {
  await call("POST", "/api/projects", { ...project, path: destination });
}
console.log(`建立项目 ${manifest.projects.length} 个（含 1 个子项目）`);

const documentIds = new Map();
for (const entry of manifest.documents) {
  const name = entry.as || entry.file;
  const result = await call("POST", "/api/documents/import-path", {
    path: staged.get(name),
    projectId: entry.projectId
  });
  documentIds.set(name, result.document.id);
  console.log(`  导入 ${name}`);
}

// Annotations are grouped per page: one PUT carries the whole page, and expectedRevision is 0 because
// none of these pages has ever been written.
const byPage = new Map();
for (const spec of manifest.annotations) {
  const key = `${spec.file} ${spec.page}`;
  if (!byPage.has(key)) byPage.set(key, []);
  byPage.get(key).push(spec);
}

const stamp = Date.now();
let written = 0;
let skipped = 0;
for (const [key, specs] of byPage) {
  const [file, page] = key.split(" ");
  const documentId = documentIds.get(file);
  if (!documentId) continue;
  const annotations = [];
  for (const spec of specs) {
    let located = null;
    if (spec.type === "text") {
      located = await locateQuote(documentId, Number(page), spec.match);
      if (!located) {
        console.warn(`  ! ${file} 第 ${page} 页找不到「${spec.match}」，跳过这条文字批注`);
        skipped += 1;
        continue;
      }
    }
    annotations.push(buildAnnotation(spec, located, stamp));
  }
  if (!annotations.length) continue;
  await call("PUT", `/api/documents/${documentId}/pages/${page}/annotations`, {
    annotations,
    updatedAt: stamp,
    expectedRevision: 0
  });
  written += annotations.length;
}
console.log(`写入批注 ${written} 条${skipped ? `（跳过 ${skipped} 条）` : ""}`);

for (const entry of manifest.documents.filter((item) => item.archived)) {
  const name = entry.as || entry.file;
  await call("POST", `/api/documents/${documentIds.get(name)}/archive`, { archived: true });
  console.log(`归档 ${name}`);
}

// The refresh demo, deliberately left half-done: the newer version is put on disk but NOT refreshed,
// so the app reports 「有新版本」 and you get to click the button yourself and watch the annotations
// re-anchor. Doing the refresh here would ship the result and hide the mechanism.
for (const entry of manifest.documents.filter((item) => item.newerSource)) {
  const name = entry.as || entry.file;
  fs.copyFileSync(path.join(filesDir, entry.newerSource), staged.get(name));
  console.log(`把 ${name} 的源文件换成了第二版（应用里会显示「有新版本」）`);
}

console.log(`
完成。回到批注工作台，你会看到：

  教学
    示例课程            四种批注类型、跨文档矛盾、一份归档的讲义、一张只能点标的图片
      第4讲：抽样与偏差    子项目。这里的讲义有新版本，点刷新看批注怎么重新定位
    待归档收件箱         和示例课程里的大纲是同一份文件，用来试「清理重复文档」
  科研（可折叠）
    课堂参与度文献

先试这三件事：
  1. 打开「第4讲讲义.pdf」，点顶栏的刷新。一条批注会跟着原文移到新的一页，另一条会失配。
  2. 在任意文档里搜「周」或「字以内」，两份文件里对不上的数字会一起出现。
  3. 菜单里选「清理重复文档」，看它怎么说明删掉哪一份会连带删掉多少条批注。

这些文件在 ${destination}，删掉它们不会影响你自己的文档。`);
