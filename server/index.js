import { execFile, execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import multer from "multer";
import { MAX_BACKUP_ARCHIVE_BYTES, recoverInterruptedFullRestore, streamFullBackup, restoreFullBackup, validateWorkspace } from "./backup.js";
import { acquireDataDirectoryLock, legacyDataDirectory, loadOrCreateCapability, resolveDataDirectory } from "./data-dir.js";
import dataDirectoryHelpers from "./data-directory.cjs";
import apiVersionHelpers from "./api-version.cjs";
import { mergeLegacyDataDirectory } from "./data-migration.js";
import { downloadRemoteDocument } from "./remote-import.js";
import { createStore, listWorkspaceSnapshots, restoreWorkspaceSnapshot } from "./store.js";
import { findDuplicateDocuments } from "./duplicates.js";
import {
  validAnnotationList,
  validHistoryList,
  validReviewChange,
  validReviewMessage,
  validReviewRole,
  validReviewStatus,
  validReviewTask,
  validReviewTaskStatus
} from "./workspace-validation.js";

const { workspaceStoreId } = dataDirectoryHelpers;
const { API_VERSION } = apiVersionHelpers;

const app = express();
const execFileAsync = promisify(execFile);
const MAX_DOCUMENT_BYTES = Number(process.env.REVIEW_MAX_DOCUMENT_BYTES || 100 * 1024 * 1024);
const MAX_DOCUMENT_VERSIONS = 5;
const PORT = Number(process.env.PORT || 4517);
const ROOT = process.env.REVIEW_APP_ROOT || process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const DATA_DIR = resolveDataDirectory(ROOT);
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RENDER_DIR = path.join(DATA_DIR, "renders");
const DOCUMENT_UPLOAD_DIR = path.join(DATA_DIR, ".incoming-documents");
const BACKUP_UPLOAD_DIR = path.join(DATA_DIR, ".incoming-backups");
const TRANSACTION_DIR = path.join(DATA_DIR, ".transactions");
const upload = multer({
  defParamCharset: "utf8",
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fs.mkdirSync(DOCUMENT_UPLOAD_DIR, { recursive: true });
      callback(null, DOCUMENT_UPLOAD_DIR);
    },
    filename(_req, _file, callback) {
      callback(null, `document-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.upload`);
    }
  }),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 }
});
const PDFTOPPM = resolveExecutable(process.env.PDFTOPPM, ["pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"]);
const PDFINFO = resolveExecutable(process.env.PDFINFO, ["pdfinfo", "/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo"]);
const PDFTOTEXT = resolveExecutable(process.env.PDFTOTEXT, ["pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"]);
const TESSERACT = resolveExecutable(process.env.TESSERACT, ["tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]);
// Defaulting to English alone makes OCR useless on the documents this app is mostly used for, and
// the traineddata a machine actually has is the only thing worth asking for — naming a missing
// language makes tesseract refuse the whole job.
const OCR_LANGUAGES = String(process.env.REVIEW_OCR_LANGS || defaultOcrLanguages());

function installedOcrLanguages() {
  try {
    const { stdout } = spawnSync(TESSERACT, ["--list-langs"], { encoding: "utf8", timeout: 10000 });
    return new Set(String(stdout || "").split(/\r?\n/).map((line) => line.trim()));
  } catch {
    return new Set();
  }
}

function defaultOcrLanguages() {
  const installed = installedOcrLanguages();
  return installed.has("chi_sim") ? "chi_sim+eng" : "eng";
}

// Recovering one selection is a different problem from reading a scanned page, and measurably so:
// on the deck this was built for, chi_sim alone read 示例课程 and 内容概览 correctly while chi_sim+eng
// turned a three-character Chinese name into "Ba)ABe" — offering English lets tesseract read Chinese
// as Latin. chi_sim carries Latin letters and digits of its own, so nothing is lost by leaving eng out.
const REGION_OCR_LANGUAGES = String(process.env.REVIEW_REGION_OCR_LANGS || (installedOcrLanguages().has("chi_sim") ? "chi_sim" : OCR_LANGUAGES));
const SOFFICE = resolveExecutable(process.env.SOFFICE, [
  "soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/opt/homebrew/bin/soffice",
  "/usr/local/bin/soffice"
]);
function configuredRuntimePath(key) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "runtime.json"), "utf8"));
    const value = String(config?.[key] || "").trim();
    return value && fs.existsSync(value) ? value : "";
  } catch {
    return "";
  }
}

let resolvedPythonHasPypdf = null;
let resolvedPythonHasExport = null;
const PYTHON = resolvePythonExecutable(process.env.PYTHON || configuredRuntimePath("python"), [
  path.join(ROOT, ".venv", "bin", "python3"),
  process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, "bin", "python3") : "",
  "python3",
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3"
]);
const PYTHON_OUTLINE_READY = resolvedPythonHasPypdf ?? pythonCanImport(PYTHON, ["pypdf"]);
const PYTHON_EXPORT_READY = resolvedPythonHasExport ?? pythonCanImport(PYTHON, ["pypdf", "reportlab"]);
const PDF_RENDER_DPI = process.env.PDF_RENDER_DPI || "180";
const PDF_JPEG_QUALITY = process.env.PDF_JPEG_QUALITY || "94";
const APP_VERSION = readAppVersion();
let API_TOKEN = String(process.env.REVIEW_API_TOKEN || "");
const SOURCE_HASH_RECHECK_MS = 5 * 60 * 1000;
const MAX_EVENT_HISTORY = 500;
const DEFER_PDF_ANALYSIS_PAGE_COUNT = 40;
const sourceHashProbes = new Map();
const backupUpload = multer({
  defParamCharset: "utf8",
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fs.mkdirSync(BACKUP_UPLOAD_DIR, { recursive: true });
      callback(null, BACKUP_UPLOAD_DIR);
    },
    filename(_req, _file, callback) {
      callback(null, `restore-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}.reviewbackup`);
    }
  }),
  limits: { fileSize: MAX_BACKUP_ARCHIVE_BYTES, files: 1 }
});

let store = null;
// Set when the workspace file cannot be loaded. The server still listens so the user has somewhere
// to recover from; every route that needs the workspace is refused until it clears.
let recoveryMode = null;
let dataDirectoryLock = null;
let activeListener = null;
const eventClients = new Set();
const recentEvents = [];
const documentAnalysisJobs = new Map();
let eventSequence = 0;
let dataSizeCache = { measuredAt: 0, bytes: 0, promise: null };

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
  );

  const host = req.get("host");
  const localHost = parseLoopbackAddress(host);
  if (!localHost) {
    res.status(403).json({ ok: false, error: "host_forbidden" });
    return;
  }

  const origin = req.get("origin");
  if (origin && !sameLoopbackOrigin(origin, localHost)) {
    res.status(403).json({ ok: false, error: "origin_forbidden" });
    return;
  }
  if (API_TOKEN && req.path === "/" && req.method === "GET" && req.query.cap) {
    if (!secureTokenMatch(String(req.query.cap), API_TOKEN)) {
      res.status(403).send("Invalid local app capability.");
      return;
    }
    res.setHeader("Set-Cookie", `review_cap=${API_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    res.redirect("/");
    return;
  }
  if (req.path.startsWith("/api/") && req.get("x-review-task-token")) {
    req.reviewActorIsTaskAgent = true;
  }
  if (req.path.startsWith("/api/") && req.get("x-review-document-token")) {
    req.reviewActorIsDocumentAgent = true;
  }
  if (API_TOKEN && req.path.startsWith("/api/") && req.path !== "/api/health") {
    const supplied = String(req.get("x-review-api-token") || cookieValue(req.get("cookie"), "review_cap") || "");
    if (!secureTokenMatch(supplied, API_TOKEN) && !taskCapabilityAuthorizesRequest(req) && !documentCapabilityAuthorizesRequest(req)) {
      res.status(401).json({ ok: false, error: "api_capability_required" });
      return;
    }
  }
  // The allowlist above is only consulted when a global token is configured. Enforce it for the
  // document credential unconditionally, so a dev server without a global token is not a way past it.
  if (req.reviewActorIsDocumentAgent === true && !documentCapabilityAuthorizesRequest(req)) {
    res.status(403).json({ ok: false, error: "document_capability_denied", detail: "这个连接只能访问当前文档的审阅接口。" });
    return;
  }
  next();
});
const RECOVERY_ALLOWED_PATHS = new Set(["/api/health", "/api/recovery", "/api/recovery/restore", "/api/backup/full/restore", "/api/open-data-folder"]);

app.use((req, res, next) => {
  if (!recoveryMode || !req.path.startsWith("/api/") || RECOVERY_ALLOWED_PATHS.has(req.path)) {
    next();
    return;
  }
  res.status(503).json({ ok: false, error: "workspace_recovery_required", detail: recoveryMode.message });
});

app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => {
  if (req.reviewActorIsDocumentAgent !== true) {
    next();
    return;
  }
  const context = store.getReviewContext();
  if (context?.scope !== "document" || !context.documentId) {
    res.status(409).json({ ok: false, error: "review_scope_unset", detail: "请先在批注工作台中打开要交给 AI 处理的文档。" });
    return;
  }
  const documentMatch = req.path.match(/^\/api\/documents\/([^/]+)\//);
  if (documentMatch && safeDecode(documentMatch[1]) !== context.documentId) {
    res.status(403).json({ ok: false, error: "review_scope_denied", detail: "这个连接只能访问当前打开的文档。" });
    return;
  }
  const threadMatch = req.path.match(/^\/api\/review\/threads\/([^/]+)/);
  if (threadMatch) {
    const thread = store.getReviewThread(safeDecode(threadMatch[1]));
    if (thread && thread.documentId !== context.documentId) {
      res.status(403).json({ ok: false, error: "review_scope_denied", detail: "这条审阅意见不属于当前打开的文档。" });
      return;
    }
  }
  req.reviewScopedDocumentId = context.documentId;
  if (req.method === "POST" && req.path === "/api/review/threads") {
    const target = String(req.body?.documentId || "");
    if (target && target !== context.documentId) {
      res.status(403).json({ ok: false, error: "review_scope_denied", detail: "只能在当前打开的文档上新建审阅意见。" });
      return;
    }
  }
  next();
});

// Uploaded and rendered assets are user content. Serve them as downloads on a locked-down policy so
// an uploaded .html or .svg cannot run as active content on the app's own origin.
const assetStaticOptions = {
  index: false,
  dotfiles: "deny",
  setHeaders(res) {
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
};
app.use("/api/uploads", express.static(UPLOAD_DIR, assetStaticOptions));
app.use("/api/renders", express.static(RENDER_DIR, assetStaticOptions));

function asyncRoute(handler, errorCode) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((error) => {
      console.error(`[review-annotation] ${errorCode}:`, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(500).json({ ok: false, error: errorCode });
    });
  };
}

app.get("/api/health", (req, res) => {
  // Discovery is unauthenticated by necessity, which means anything can claim to be this app on a
  // known port. A challenge lets a client confirm the responder actually holds the workspace
  // capability before handing it anything. HMAC, so the token itself is never disclosed.
  const challenge = String(req.query.challenge || "");
  const boundPort = Number(activeListener?.address()?.port || PORT);
  const proof = API_TOKEN && /^[a-f0-9]{16,128}$/.test(challenge)
    ? crypto.createHmac("sha256", API_TOKEN).update(`${challenge}:${boundPort}`).digest("hex")
    : "";
  res.json({
    ok: true,
    service: "review-annotation-api",
    apiVersion: API_VERSION,
    appVersion: APP_VERSION,
    ...(proof ? { proof } : {}),
    ...(recoveryMode ? { recovery: { code: recoveryMode.code, detail: recoveryMode.message } } : {}),
    storeId: store ? workspaceStoreId(store.path) : "",
    tools: {
      pdf: Boolean(PDFTOPPM && PDFINFO),
      text: Boolean(PDFTOTEXT),
      ocr: Boolean(TESSERACT),
      office: Boolean(SOFFICE),
      outline: PYTHON_OUTLINE_READY,
      pdfExport: PYTHON_EXPORT_READY
    }
  });
});

app.get("/api/recovery", (_req, res) => {
  res.json({
    ok: true,
    active: Boolean(recoveryMode),
    code: recoveryMode?.code || "",
    detail: recoveryMode?.message || "",
    preservedPath: recoveryMode?.backupPath || "",
    dataDirectory: DATA_DIR,
    snapshots: listWorkspaceSnapshots(DATA_DIR)
  });
});

app.post("/api/recovery/restore", (req, res) => {
  if (!recoveryMode) {
    res.status(409).json({ ok: false, error: "recovery_not_active" });
    return;
  }
  if (recoveryMode.code === "WORKSPACE_SCHEMA_TOO_NEW" && req.body?.confirmDowngrade !== true) {
    // Rolling back over intact newer data throws away work; make the caller say so explicitly.
    res.status(409).json({ ok: false, error: "downgrade_confirmation_required", detail: recoveryMode.message });
    return;
  }
  try {
    const restored = restoreWorkspaceSnapshot(DATA_DIR, req.body?.snapshot);
    store = createStore(DATA_DIR);
    recoveryMode = null;
    console.log(`[review-annotation] 工作区已从快照恢复: ${restored.name}`);
    res.json({ ok: true, restored, workspace: store.getWorkspace() });
  } catch (error) {
    res.status(applicationErrorCode(error, "") ? 400 : 500).json({
      ok: false,
      error: applicationErrorCode(error, "recovery_restore_failed"),
      detail: error.message
    });
  }
});

app.get("/api/diagnostics", asyncRoute(async (_req, res) => {
  const workspace = store.getWorkspace();
  const documents = Object.fromEntries(workspace.documents.map((document) => [document.id, document]));
  const unmatchedTextAnnotations = Object.values(workspace.annotations)
    .flat()
    .filter((annotation) => annotation.type === "text" && annotation.anchorStatus === "unmatched").length;
  const staleTaskCount = workspace.reviewTasks.filter((task) =>
    (task.documentIds || []).some((documentId) =>
      task.documentRevisions?.[documentId] &&
      documents[documentId]?.contentHash &&
      task.documentRevisions[documentId] !== documents[documentId].contentHash
    )
  ).length;
  const sourceIssueCount = workspace.documents.filter((document) => {
    const trackedPath = recordedRefreshSourcePath(document);
    return trackedPath && !fs.existsSync(trackedPath);
  }).length;
  const mcpEntry = resolveMcpServerEntry(ROOT);
  const mcpNode = resolveExecutable(process.env.REVIEW_MCP_NODE, ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]);
  const tools = {
    pdfRender: Boolean(PDFTOPPM && PDFINFO),
    pdfText: Boolean(PDFTOTEXT),
    ocr: Boolean(TESSERACT),
    office: Boolean(SOFFICE),
    outline: PYTHON_OUTLINE_READY,
    pdfExport: PYTHON_EXPORT_READY,
    mcp: Boolean(mcpNode && fs.existsSync(mcpEntry))
  };
  const warnings = [
    ...(!tools.pdfRender ? ["缺少 PDF 渲染工具（pdfinfo/pdftoppm）。"] : []),
    ...(!tools.pdfText ? ["缺少 PDF 文字提取工具（pdftotext）。"] : []),
    ...(!tools.mcp ? ["MCP 启动文件或 Node 运行时不可用。"] : []),
    ...(sourceIssueCount ? [`${sourceIssueCount} 份文档的源文件已移动或不可读。`] : []),
    ...(unmatchedTextAnnotations ? [`${unmatchedTextAnnotations} 条文字批注需要重新定位。`] : []),
    ...(staleTaskCount ? [`${staleTaskCount} 个审阅任务使用旧版文档快照。`] : [])
  ];
  const dataBytes = await cachedDirectorySize(DATA_DIR).catch(() => 0);
  res.json({
    ok: true,
    status: warnings.length ? "warning" : "ready",
    appVersion: APP_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    dataDirectory: DATA_DIR,
    dataBytes,
    apiCapabilityEnabled: Boolean(API_TOKEN),
    tools,
    workspace: {
      projectCount: workspace.projects.length,
      documentCount: workspace.documents.length,
      annotationCount: Object.values(workspace.annotations).reduce((count, list) => count + list.length, 0),
      taskCount: workspace.reviewTasks.length,
      sourceIssueCount,
      unmatchedTextAnnotations,
      staleTaskCount
    },
    warnings
  });
}, "diagnostics_failed"));

app.get("/api/integrations/ai", (req, res) => {
  const requestedTaskId = String(req.query.taskId || "");
  const task = requestedTaskId ? store.getReviewTask(requestedTaskId) : null;
  if (requestedTaskId && !task) {
    res.status(404).json({ ok: false, error: "review_task_not_found", detail: "指定的审阅任务不存在或已被删除。" });
    return;
  }
  const taskAccessToken = task ? store.getReviewTaskAccessToken(task.id) : "";
  const serverName = task ? `review-annotation-${task.id.toLowerCase()}` : "review-annotation";
  const entryPath = resolveMcpServerEntry(ROOT);
  const nodePath = resolveExecutable(process.env.REVIEW_MCP_NODE, [
    "node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node"
  ]);
  const command = nodePath || "node";
  const apiUrl = activeApiUrl(req);
  const env = {
    REVIEW_API_URL: apiUrl,
    REVIEW_WORKSPACE_STORE_ID: workspaceStoreId(store.path),
    ...(!task ? { REVIEW_DOCUMENT_TOKEN: store.getDocumentAccessToken() } : {}),
    ...(task ? {
      REVIEW_TASK_ID: task.id,
      REVIEW_TASK_TOKEN: taskAccessToken
    } : {})
  };
  const jsonConfig = {
    mcpServers: {
      [serverName]: {
        type: "stdio",
        command,
        args: [entryPath],
        env
      }
    }
  };

  res.json({
    ok: true,
    mcp: {
      serverName,
      available: fs.existsSync(entryPath),
      runtimeAvailable: Boolean(nodePath),
      minimumNodeVersion: "22.12.0",
      entryPath,
      apiUrl,
      codexCommand: shellCommand([
        "codex", "mcp", "add",
        "--env", `REVIEW_API_URL=${apiUrl}`,
        "--env", `REVIEW_WORKSPACE_STORE_ID=${env.REVIEW_WORKSPACE_STORE_ID}`,
        ...(!task ? ["--env", `REVIEW_DOCUMENT_TOKEN=${env.REVIEW_DOCUMENT_TOKEN}`] : []),
        ...(task ? ["--env", `REVIEW_TASK_ID=${task.id}`, "--env", `REVIEW_TASK_TOKEN=${taskAccessToken}`] : []),
        serverName, "--", command, entryPath
      ]),
      claudeCommand: shellCommand([
        "claude", "mcp", "add",
        "--transport", "stdio",
        "--scope", "user",
        "-e", `REVIEW_API_URL=${apiUrl}`,
        "-e", `REVIEW_WORKSPACE_STORE_ID=${env.REVIEW_WORKSPACE_STORE_ID}`,
        ...(!task ? ["-e", `REVIEW_DOCUMENT_TOKEN=${env.REVIEW_DOCUMENT_TOKEN}`] : []),
        ...(task ? ["-e", `REVIEW_TASK_ID=${task.id}`, "-e", `REVIEW_TASK_TOKEN=${taskAccessToken}`] : []),
        serverName, "--", command, entryPath
      ]),
      codexRemoveCommand: shellCommand(["codex", "mcp", "remove", serverName]),
      claudeRemoveCommand: shellCommand(["claude", "mcp", "remove", "--scope", "user", serverName]),
      jsonConfig,
      codexConfig: [
        `[mcp_servers.${serverName}]`,
        `command = ${JSON.stringify(command)}`,
        `args = [${JSON.stringify(entryPath)}]`,
        `env = ${JSON.stringify(env)}`
      ].join("\n")
      ,
      taskScoped: Boolean(task),
      taskId: task?.id || ""
    }
  });
});

app.use("/api/review/tasks/:taskId", (req, res, next) => {
  const scopedTaskId = String(req.get("x-review-task-id") || "");
  const scopedToken = String(req.get("x-review-task-token") || "");
  if (!scopedTaskId && !scopedToken) {
    next();
    return;
  }
  if (scopedTaskId !== req.params.taskId || !store.authorizeReviewTask(scopedTaskId, scopedToken)) {
    res.status(403).json({ ok: false, error: "review_task_scope_denied" });
    return;
  }
  next();
});

app.get("/api/workspace", (_req, res) => {
  res.json({ ok: true, ...store.getWorkspace() });
});

app.get("/api/review/context", (_req, res) => {
  res.json({ ok: true, context: store.getReviewContext() });
});

app.post("/api/review/rotate-document-token", (req, res) => {
  if (req.reviewActorIsDocumentAgent === true || req.reviewActorIsTaskAgent === true) {
    res.status(403).json({ ok: false, error: "rotation_requires_human" });
    return;
  }
  const rotated = store.rotateDocumentAccessToken();
  res.json({ ok: true, rotated });
});

app.get("/api/review/document", (_req, res) => {
  const context = store.getReviewContext();
  if (context?.scope !== "document" || !context.documentId) {
    res.status(409).json({ ok: false, error: "review_scope_unset" });
    return;
  }
  const document = store.getDocument(context.documentId);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const project = store.getProject(document.projectId);
  res.json({
    ok: true,
    document: {
      id: document.id,
      name: document.name,
      projectId: document.projectId,
      projectName: project?.name || "",
      type: document.type,
      pageCount: document.pageCount,
      reviewArtifactPath: document.originalPath || document.sourcePath || "",
      managedCopyPath: document.sourcePath || "",
      documentRevision: document.contentHash || "",
      sourceModifiedAt: document.sourceModifiedAt || 0,
      refreshedAt: document.refreshedAt || document.updated || 0
    }
  });
});

app.put("/api/review/context", (req, res) => {
  const documentId = String(req.body?.documentId || "");
  const context = store.setReviewContext(documentId);
  if (!context) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  publishEvent("review.context.updated", { context });
  res.json({ ok: true, context });
});

app.get("/api/review/tasks", (req, res) => {
  const statuses = String(req.query.status || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (statuses.some((status) => !validReviewTaskStatus(status))) {
    res.status(400).json({ ok: false, error: "invalid_review_task_status" });
    return;
  }
  const tasks = store.listReviewTasks({
    projectId: String(req.query.projectId || ""),
    documentId: String(req.query.documentId || ""),
    statuses
  });
  res.json({ ok: true, tasks, total: tasks.length });
});

app.post("/api/review/tasks", async (req, res) => {
  try {
    const task = await createReviewTaskSnapshot(req.body || {});
    publishEvent("review.task.created", { task: reviewTaskSummaryPayload(task) });
    res.json({ ok: true, task });
  } catch (error) {
    const status = error.code === "document_not_found" || error.code === "project_not_found" ? 404 :
      error.code === "review_task_exists" ? 409 : 400;
    res.status(status).json({ ok: false, error: applicationErrorCode(error, "review_task_create_failed"), detail: error.message });
  }
});

app.get("/api/review/tasks/:id/checklist", (req, res) => {
  const task = store.getReviewTask(req.params.id);
  if (!task) {
    res.status(404).json({ ok: false, error: "review_task_not_found" });
    return;
  }
  if (!task.checklistPath || !fs.existsSync(task.checklistPath)) {
    res.status(404).json({ ok: false, error: "review_task_checklist_not_found" });
    return;
  }
  res.json({
    ok: true,
    taskId: task.id,
    fileName: `${task.id}-REVIEW_CHECKLIST.md`,
    path: task.checklistPath,
    markdown: fs.readFileSync(task.checklistPath, "utf8")
  });
});

app.get("/api/review/tasks/:id", (req, res) => {
  const task = store.getReviewTask(req.params.id);
  if (!task) {
    res.status(404).json({ ok: false, error: "review_task_not_found" });
    return;
  }
  res.json({ ok: true, task });
});

app.patch("/api/review/tasks/:id", (req, res) => {
  const patch = {};
  if (Object.hasOwn(req.body || {}, "name")) patch.name = safeText(req.body.name, "未命名审阅任务", 500);
  if (Object.hasOwn(req.body || {}, "status")) {
    const status = String(req.body.status || "");
    if (!validReviewTaskStatus(status)) {
      res.status(400).json({ ok: false, error: "invalid_review_task_status" });
      return;
    }
    if (req.reviewActorIsTaskAgent === true && ["completed", "archived"].includes(status)) {
      res.status(403).json({ ok: false, error: "status_requires_human", detail: "只有用户可以结束或归档审阅任务。" });
      return;
    }
    patch.status = status;
  }
  const task = store.patchReviewTask(req.params.id, patch);
  if (!task) {
    res.status(404).json({ ok: false, error: "review_task_not_found" });
    return;
  }
  publishEvent("review.task.updated", { task: reviewTaskSummaryPayload(task) });
  res.json({ ok: true, task });
});

app.post("/api/review/tasks/:id/rotate-token", (req, res) => {
  if (req.reviewActorIsTaskAgent === true) {
    // A task must not be able to rotate its own credential.
    res.status(403).json({ ok: false, error: "rotation_requires_human" });
    return;
  }
  const task = store.getReviewTask(req.params.id);
  if (!task) {
    res.status(404).json({ ok: false, error: "review_task_not_found" });
    return;
  }
  store.rotateReviewTaskAccessToken(task.id);
  const rotated = store.getReviewTask(task.id);
  publishEvent("review.task.updated", { task: reviewTaskSummaryPayload(rotated) });
  res.json({ ok: true, taskId: task.id });
});

app.delete("/api/review/tasks/:id", (req, res) => {
  const task = store.deleteReviewTask(req.params.id);
  if (!task) {
    res.status(404).json({ ok: false, error: "review_task_not_found" });
    return;
  }
  publishEvent("review.task.deleted", { taskId: task.id });
  res.json({ ok: true, taskId: task.id, releasedBytes: Number(task.storageBytes || 0) });
});

app.get("/api/review/tasks/:taskId/items/:itemId", (req, res) => {
  const item = store.getReviewTaskItem(req.params.taskId, req.params.itemId);
  if (!item) {
    res.status(404).json({ ok: false, error: "review_task_item_not_found" });
    return;
  }
  res.json({ ok: true, item });
});

app.post("/api/review/tasks/:taskId/items/:itemId/messages", (req, res) => {
  const body = String(req.body?.body || "").trim();
  const role = String(req.body?.role || "human");
  const status = req.body?.status ? String(req.body.status) : role === "human" ? "open" : "addressed";
  const tag = req.body?.tag ? String(req.body.tag) : "";
  const change = req.body?.change;
  const now = Date.now();
  const message = {
    id: safeEntityId(req.body?.id, `msg-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`),
    role,
    author: safeText(req.body?.author, role === "assistant" ? "AI" : "用户", 120),
    body,
    createdAt: Number(req.body?.createdAt || now),
    ...(change ? { change } : {})
  };
  if (!validReviewRole(role) || !validReviewStatus(status) || (tag && !["todo", "question", "resolved"].includes(tag)) || !validReviewMessage(message) || (change && !validReviewChange(change))) {
    res.status(400).json({ ok: false, error: "invalid_review_task_message" });
    return;
  }
  if (refusesReviewClosure(req, String(req.body?.role || "assistant"), status)) {
    res.status(403).json({ ok: false, error: "status_requires_human", detail: "只有用户可以把审阅项标记为已解决或已拒绝。" });
    return;
  }
  const expectedRevision = optionalRevision(req.body?.expectedRevision);
  if (expectedRevision === null) {
    res.status(400).json({ ok: false, error: "invalid_review_revision" });
    return;
  }
  const result = store.appendReviewTaskMessage(req.params.taskId, req.params.itemId, message, { status, expectedRevision });
  if (!result) {
    res.status(404).json({ ok: false, error: "review_task_item_not_found" });
    return;
  }
  if (result.conflict) {
    res.status(409).json({ ok: false, error: "review_task_item_conflict", task: result.task, item: result.item });
    return;
  }
  publishEvent("review.task.updated", { task: reviewTaskSummaryPayload(result.task), item: result.item });
  if (result.mirrored) publishMirroredThreadEvent(result.item.sourceThreadId);
  res.json({ ok: true, task: result.task, item: result.item, message, mirrored: result.mirrored, stale: result.stale, staleReason: result.staleReason });
});

app.patch("/api/review/tasks/:taskId/items/:itemId", (req, res) => {
  const status = String(req.body?.status || "");
  if (!validReviewStatus(status)) {
    res.status(400).json({ ok: false, error: "invalid_review_status" });
    return;
  }
  if (refusesReviewClosure(req, String(req.body?.role || "assistant"), status)) {
    res.status(403).json({ ok: false, error: "status_requires_human", detail: "只有用户可以把审阅项标记为已解决或已拒绝。" });
    return;
  }
  const expectedRevision = optionalRevision(req.body?.expectedRevision);
  if (expectedRevision === null) {
    res.status(400).json({ ok: false, error: "invalid_review_revision" });
    return;
  }
  const result = store.patchReviewTaskItem(req.params.taskId, req.params.itemId, { status }, expectedRevision);
  if (!result) {
    res.status(404).json({ ok: false, error: "review_task_item_not_found" });
    return;
  }
  if (result.conflict) {
    res.status(409).json({ ok: false, error: "review_task_item_conflict", task: result.task, item: result.item });
    return;
  }
  publishEvent("review.task.updated", { task: reviewTaskSummaryPayload(result.task), item: result.item });
  if (result.mirrored) publishMirroredThreadEvent(result.item.sourceThreadId);
  res.json({ ok: true, task: result.task, item: result.item, mirrored: result.mirrored, stale: result.stale, staleReason: result.staleReason });
});

app.get("/api/events", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 1500\n\n");
  const lastEventId = Number.parseInt(String(req.get("last-event-id") || ""), 10);
  if (Number.isFinite(lastEventId) && lastEventId >= 0) {
    const oldestAvailableId = recentEvents[0]?.id || eventSequence + 1;
    if (lastEventId > eventSequence || lastEventId < oldestAvailableId - 1) {
      res.write(serverEventText({
        type: "review.sync.required",
        data: { type: "review.sync.required", at: Date.now(), reason: "replay_gap" }
      }));
    } else {
      for (const event of recentEvents) {
        if (event.id > lastEventId) res.write(serverEventText(event));
      }
    }
  }
  res.write(serverEventText({
    type: "connected",
    data: { ok: true, at: Date.now(), currentEventId: eventSequence }
  }));
  eventClients.add(res);
  const heartbeat = setInterval(() => res.write(`: keepalive ${Date.now()}\n\n`), 20000);
  req.once("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
});

app.post("/api/sync", (req, res) => {
  res.status(410).json({ ok: false, error: "legacy_sync_removed", detail: "Use the project, document, annotation, and history endpoints." });
});

app.post("/api/documents/upload", upload.single("file"), async (req, res) => {
  const uploadedPath = req.file?.path || "";
  try {
    if (!req.file) {
      res.status(400).json({ ok: false, error: "missing_file" });
      return;
    }
    const projectId = req.body.projectId || "p1";
    if (!store.getProject(projectId)) {
      res.status(404).json({ ok: false, error: "project_not_found" });
      return;
    }

    const document = await ingestFile({
      filePath: uploadedPath,
      originalName: req.file.originalname || "未命名文档",
      mime: req.file.mimetype,
      projectId,
      deferLargeAnalysis: true
    });
    saveDocument(document);
    scheduleDeferredPdfAnalysis(document);
    res.json({ ok: true, document });
  } catch (error) {
    res.status(ingestErrorStatus(error)).json({
      ok: false,
      error: applicationErrorCode(error, "ingest_failed"),
      detail: error.message,
      ...(error.tool ? { tool: error.tool } : {})
    });
  } finally {
    if (uploadedPath) fs.rmSync(uploadedPath, { force: true });
  }
});

app.post("/api/documents/import-path", async (req, res) => {
  try {
    const filePath = resolveLocalImportPath(req.body?.path);
    if (!filePath) {
      res.status(400).json({
        ok: false,
        error: "missing_path",
        detail: "找不到这个文件。请确认路径正确，且文件仍在原位置。"
      });
      return;
    }
    if (isAppOwnedCopy(filePath)) {
      // Importing a copy the app manages would make a copy of a copy, and the new document would
      // "track" a file the app rewrites underneath it. A file the user merely happens to keep inside
      // the data directory is still their own, so only the managed subdirectories are refused.
      res.status(400).json({
        ok: false,
        error: "invalid_path",
        detail: "这个文件是批注工作台自己保管的副本，不能再作为源文件导入。"
      });
      return;
    }
    const projectId = req.body.projectId || "p1";
    if (!store.getProject(projectId)) {
      res.status(404).json({ ok: false, error: "project_not_found" });
      return;
    }
    const fileStat = await fs.promises.stat(filePath);
    if (fileStat.size > MAX_DOCUMENT_BYTES) {
      res.status(413).json({ ok: false, error: "file_too_large", detail: `文件不能超过 ${formatMegabytes(MAX_DOCUMENT_BYTES)} MB。` });
      return;
    }
    const document = await ingestFile({
      filePath,
      originalName: path.basename(filePath),
      mime: "",
      projectId,
      originalPath: filePath,
      deferLargeAnalysis: true
    });
    saveDocument(document);
    scheduleDeferredPdfAnalysis(document);
    res.json({ ok: true, document });
  } catch (error) {
    res.status(ingestErrorStatus(error)).json({
      ok: false,
      error: applicationErrorCode(error, "import_path_failed"),
      detail: error.message,
      ...(error.tool ? { tool: error.tool } : {})
    });
  }
});

app.post("/api/documents/import-url", async (req, res) => {
  const incomingPath = path.join(DOCUMENT_UPLOAD_DIR, `remote-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.download`);
  try {
    const projectId = req.body?.projectId || "p1";
    if (!store.getProject(projectId)) {
      res.status(404).json({ ok: false, error: "project_not_found" });
      return;
    }
    const remote = await downloadRemoteDocument({
      url: req.body?.url,
      destination: incomingPath,
      maxBytes: MAX_DOCUMENT_BYTES,
      timeoutMs: Number(process.env.REVIEW_REMOTE_IMPORT_TIMEOUT_MS || 60_000)
    });
    const ingested = await ingestFile({
      filePath: incomingPath,
      originalName: remote.fileName,
      mime: remote.mime,
      projectId,
      deferLargeAnalysis: true
    });
    const document = {
      ...ingested,
      importUrl: remote.requestedUrl,
      resolvedImportUrl: remote.finalUrl,
      sourceLabel: remote.requestedUrl,
      remoteEtag: remote.etag,
      ...(remote.lastModified ? { sourceModifiedAt: remote.lastModified } : {})
    };
    saveDocument(document);
    scheduleDeferredPdfAnalysis(document);
    res.json({ ok: true, document });
  } catch (error) {
    res.status(ingestErrorStatus(error)).json({
      ok: false,
      error: applicationErrorCode(error, "import_url_failed"),
      detail: error.message,
      ...(error.tool ? { tool: error.tool } : {})
    });
  } finally {
    fs.rmSync(incomingPath, { force: true });
  }
});

app.post("/api/documents/:id/analyze", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (document.renderMode !== "pdf") {
    res.status(409).json({ ok: false, error: "analysis_not_applicable" });
    return;
  }
  if (documentAnalysisJobs.has(document.id)) {
    res.json({ ok: true, document, alreadyRunning: true });
    return;
  }
  const reset = store.patchDocument(document.id, { analysisStatus: "pending", analysisError: "" });
  publishEvent("document.updated", { document: reset });
  scheduleDeferredPdfAnalysis(reset);
  res.json({ ok: true, document: reset });
});

app.get("/api/documents/:id/source-info", async (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  try {
    res.json({ ok: true, ...(await documentSourceInfo(document)) });
  } catch (error) {
    res.status(500).json({ ok: false, error: "source_probe_failed", detail: error.message });
  }
});

app.get("/api/documents/:id/source", (req, res) => {
  const document = store.getDocument(req.params.id);
  const sourcePath = document ? documentPdfPath(document) : "";
  if (!document || !sourcePath || !fs.existsSync(sourcePath)) {
    res.status(404).json({ ok: false, error: "document_source_not_found" });
    return;
  }
  res.type("application/pdf");
  res.sendFile(path.resolve(sourcePath));
});

app.get("/api/documents/:id/pages/:page/text", async (req, res) => {
  const document = store.getDocument(req.params.id);
  const page = Number(req.params.page);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  try {
    res.json({ ok: true, page, ...(await pdfTextLayer(document, page)) });
  } catch (error) {
    res.status(500).json({ ok: false, error: "text_layer_failed", detail: error.message });
  }
});

app.post("/api/documents/:id/pages/:page/ocr", async (req, res) => {
  const document = store.getDocument(req.params.id);
  const page = Number(req.params.page);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  if (!TESSERACT) {
    res.status(503).json({ ok: false, error: "ocr_runtime_missing", detail: "扫描件文字识别需要 Tesseract。" });
    return;
  }
  try {
    const layer = await ocrDocumentPage(document, page);
    const pages = (document.pages || []).map((entry, index) => index === page - 1
      ? {
          ...entry,
          ...(document.type === "image" ? { text: layer.text, words: layer.words, lines: layer.lines } : {}),
          hasTextLayer: Boolean(layer.words.length),
          textLayerSource: layer.words.length ? "ocr" : entry.textLayerSource
        }
      : entry);
    const selectablePageCount = pages.filter((entry) => entry.hasTextLayer).length;
    const updated = store.patchDocument(document.id, {
      pages,
      selectablePageCount,
      textLayerStatus: selectablePageCount === 0 ? "none" : selectablePageCount === Number(document.pageCount || 1) ? "complete" : "partial"
    });
    publishEvent("document.updated", { document: updated });
    res.json({ ok: true, page, layer, document: updated });
  } catch (error) {
    res.status(500).json({ ok: false, error: "ocr_failed", detail: error.message });
  }
});

// When a PDF's text layer decodes to glyph indices, no amount of re-extraction helps: the mapping
// the file would need is simply not in it. The glyphs still draw correctly, so reading the rendered
// page is the only way to recover what a selection actually says.
app.post("/api/documents/:id/pages/:page/region-text", asyncRoute(async (req, res) => {
  const document = store.getDocument(req.params.id);
  const page = Number(req.params.page);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  const rects = Array.isArray(req.body?.rects) ? req.body.rects.slice(0, 200) : [];
  const usable = rects
    .map((rect) => ({ x: Number(rect?.x), y: Number(rect?.y), w: Number(rect?.w), h: Number(rect?.h) }))
    .filter((rect) => [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0);
  if (!usable.length) {
    res.status(400).json({ ok: false, error: "invalid_region" });
    return;
  }
  if (!TESSERACT) {
    res.status(503).json({
      ok: false,
      error: "runtime_tool_missing",
      tool: "tesseract",
      detail: "这份 PDF 的文字层无法解码，读取选中文字需要 Tesseract。"
    });
    return;
  }
  const region = await ocrRegionText(document, page, usable);
  res.json({ ok: true, page, ...region, languages: REGION_OCR_LANGUAGES });
}, "region_text_failed"));

app.get("/api/documents/:id/search", asyncRoute(async (req, res) => {
  const document = store.getDocument(req.params.id);
  const query = String(req.query.q || "").trim().slice(0, 500);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (query.length < 2) {
    res.json({ ok: true, query, matches: [] });
    return;
  }
  const needle = query.toLocaleLowerCase();
  const matches = [];
  let cancelled = false;
  res.once("close", () => {
    if (!res.writableEnded) cancelled = true;
  });
  for (let page = 1; page <= Number(document.pageCount || 1); page += 1) {
    if (cancelled) return;
    const pageData = document.pages?.[page - 1] || {};
    const layer = document.renderMode === "pdf" ? await pdfTextLayer(document, page) : { text: pageData.text || "" };
    const text = String(layer.text || "");
    const index = text.toLocaleLowerCase().indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 70);
    const end = Math.min(text.length, index + query.length + 110);
    matches.push({
      page,
      title: document.titles?.[page - 1] || pageData.title || `第 ${page} 页`,
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`
    });
    if (matches.length >= 200) break;
  }
  if (cancelled) return;
  res.json({ ok: true, query, matches });
}, "search_failed"));

app.get("/api/documents/:id/pages/:page/preview", async (req, res) => {
  const document = store.getDocument(req.params.id);
  const page = Number(req.params.page);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  try {
    const dpi = clampInteger(Number(req.query.dpi || PDF_RENDER_DPI), 96, 240);
    res.type("image/jpeg");
    res.sendFile(await ensurePdfPagePreview(document, page, dpi));
  } catch (error) {
    res.status(500).json({ ok: false, error: "preview_failed", detail: error.message });
  }
});

app.post("/api/projects", (req, res) => {
  const now = Date.now();
  const projectId = safeEntityId(req.body?.id, `p-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`);
  if (store.getProject(projectId)) {
    res.status(409).json({ ok: false, error: "project_exists" });
    return;
  }
  const projectPath = safeText(req.body?.path, "本地工作区", 500);
  if (projectPath !== "本地工作区" && !existingDirectory(projectPath)) {
    res.status(400).json({ ok: false, error: "invalid_project_path", detail: "项目目录不存在或不可读取。" });
    return;
  }
  const parentId = String(req.body?.parentId || "");
  const parentError = parentId ? invalidParentReason(projectId, parentId) : "";
  if (parentError) {
    res.status(400).json({ ok: false, error: parentError });
    return;
  }
  const groupId = String(req.body?.groupId || "");
  if (groupId && !store.getGroup(groupId)) {
    res.status(404).json({ ok: false, error: "group_not_found" });
    return;
  }
  const project = {
    id: projectId,
    parentId,
    // Only a top-level project carries a group; a sub-project belongs wherever its parent does.
    groupId: parentId ? "" : groupId,
    name: safeText(req.body?.name, "新建项目", 160),
    path: projectPath,
    color: safeColor(req.body?.color),
    docIds: [],
    updated: now
  };
  store.upsertProject(project);
  res.json({ ok: true, project });
});

app.patch("/api/projects/:id", (req, res) => {
  const patch = projectPatch(req.body);
  if (Object.hasOwn(patch, "path") && patch.path !== "本地工作区" && !existingDirectory(patch.path)) {
    res.status(400).json({ ok: false, error: "invalid_project_path", detail: "项目目录不存在或不可读取。" });
    return;
  }
  if (Object.hasOwn(patch, "parentId") && patch.parentId) {
    const reason = invalidParentReason(req.params.id, patch.parentId);
    if (reason) {
      res.status(400).json({ ok: false, error: reason });
      return;
    }
  }
  if (Object.hasOwn(patch, "groupId") && patch.groupId) {
    if (!store.getGroup(patch.groupId)) {
      res.status(404).json({ ok: false, error: "group_not_found" });
      return;
    }
    // A sub-project is already placed by its parent. Letting it name a group of its own would put
    // the same project in two places in the sidebar.
    const target = store.getProject(req.params.id);
    const becomesChild = Object.hasOwn(patch, "parentId") ? patch.parentId : target?.parentId;
    if (becomesChild) {
      res.status(400).json({ ok: false, error: "project_child_cannot_group" });
      return;
    }
  }
  const project = store.patchProject(req.params.id, patch);
  if (!project) {
    res.status(404).json({ ok: false, error: "project_not_found" });
    return;
  }
  res.json({ ok: true, project });
});

app.post("/api/groups", (req, res) => {
  const groupId = safeEntityId(req.body?.id, `g-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`);
  if (store.getGroup(groupId)) {
    res.status(409).json({ ok: false, error: "group_exists" });
    return;
  }
  const group = {
    id: groupId,
    name: safeText(req.body?.name, "新建分组", 80),
    color: safeColor(req.body?.color),
    collapsed: false,
    updated: Date.now()
  };
  store.upsertGroup(group);
  res.json({ ok: true, group });
});

app.post("/api/groups/reorder", (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.slice(0, 200).map(String) : null;
  if (!orderedIds) {
    res.status(400).json({ ok: false, error: "invalid_group_order" });
    return;
  }
  res.json({ ok: true, groups: store.reorderGroups(orderedIds) });
});

app.patch("/api/groups/:id", (req, res) => {
  const patch = {};
  if (Object.hasOwn(req.body || {}, "name")) patch.name = safeText(req.body.name, "未命名分组", 80);
  if (Object.hasOwn(req.body || {}, "color")) patch.color = safeColor(req.body.color);
  if (Object.hasOwn(req.body || {}, "collapsed")) patch.collapsed = Boolean(req.body.collapsed);
  const group = store.patchGroup(req.params.id, patch);
  if (!group) {
    res.status(404).json({ ok: false, error: "group_not_found" });
    return;
  }
  res.json({ ok: true, group });
});

// Deleting a group releases its projects instead of taking them with it, so this needs none of the
// confirmations that deleting a project does.
app.delete("/api/groups/:id", (req, res) => {
  if (!store.deleteGroup(req.params.id)) {
    res.status(404).json({ ok: false, error: "group_not_found" });
    return;
  }
  res.json({ ok: true, workspace: store.getWorkspace() });
});

app.delete("/api/projects/:id", (req, res) => {
  const project = store.getProject(req.params.id);
  // Deleting a project takes its documents with it. Doing that to a whole subtree on one click is
  // more than anyone means by "delete this project", so a parent has to be emptied of children
  // first — moving them out or deleting them individually is a decision worth making explicitly.
  if (project && store.childProjects(project.id).length) {
    res.status(409).json({
      ok: false,
      error: "project_has_children",
      detail: "这个项目下面还有子项目。请先移走或删除子项目。"
    });
    return;
  }
  const roots = store.getWorkspace().projects.filter((item) => !item.parentId);
  if (roots.length <= 1 && project && !project.parentId) {
    res.status(409).json({ ok: false, error: "last_project" });
    return;
  }
  const documents = project
    ? store.getWorkspace().documents.filter((document) => (project.docIds || []).includes(document.id))
    : [];
  const deleteTasks = req.query.taskPolicy === "delete";
  const deletedTaskIds = deleteTasks ? store.deleteReviewTasksForDocuments(new Set(documents.map((document) => document.id))) : [];
  if (!store.deleteProject(req.params.id)) {
    res.status(404).json({ ok: false, error: "project_not_found" });
    return;
  }
  for (const document of documents) deleteDocumentAssets(document);
  for (const taskId of deletedTaskIds) publishEvent("review.task.deleted", { taskId });
  publishTasksReferencingDocuments(documents.map((document) => document.id));
  res.json({ ok: true, deletedTaskIds });
});

// The same document imported twice instead of refreshed. Reported rather than acted on: which copy
// to keep is a judgement about which annotations matter, and only the user can make it.
app.get("/api/documents/duplicates", (_req, res) => {
  const workspace = store.getWorkspace();
  const annotationCounts = {};
  for (const [key, list] of Object.entries(workspace.annotations || {})) {
    const documentId = key.slice(0, key.lastIndexOf(":"));
    annotationCounts[documentId] = (annotationCounts[documentId] || 0) + (Array.isArray(list) ? list.length : 0);
  }
  const projectNames = Object.fromEntries(workspace.projects.map((project) => [project.id, project.name]));
  // Archived copies are not clutter in the list any more, so they are not what this is for.
  const live = workspace.documents.filter((item) => !item.archivedAt);
  res.json({ ok: true, groups: findDuplicateDocuments(live, { annotationCounts, projectNames }) });
});

// Archive a document you are done with. It keeps everything and only stops the app treating it as
// live: it drops out of the default list, out of the counts, out of duplicate detection, and out of
// the source-change checks.
app.post("/api/documents/:id/archive", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const archived = Boolean(req.body?.archived);
  const updated = store.setDocumentArchived(document.id, archived);
  // Page images and the extracted text layer are caches: both rebuild on demand the moment the
  // document is opened again, so a document nobody is reading has no reason to hold them.
  const reclaimed = archived ? discardRenderCaches(document.id) : 0;
  publishEvent("document.updated", { document: updated });
  res.json({ ok: true, document: updated, reclaimedBytes: reclaimed });
});

// Only the regenerable parts. A converted PDF lives here too and is the renderable form of an
// Office document — deleting that would leave the document unopenable until it is imported again.
function discardRenderCaches(documentId) {
  let reclaimed = 0;
  for (const name of ["previews", "text"]) {
    const directory = path.join(RENDER_DIR, documentId, name);
    reclaimed += directorySize(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return reclaimed;
}

function directorySize(directory) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        // A file that vanished between listing and measuring is simply not counted.
      }
    }
  }
  return total;
}

app.post("/api/documents/:id/move", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const projectId = String(req.body?.projectId || "");
  if (!store.getProject(projectId)) {
    res.status(404).json({ ok: false, error: "project_not_found" });
    return;
  }
  const moved = store.moveDocument(document.id, projectId);
  publishEvent("document.updated", { document: moved });
  res.json({ ok: true, document: moved });
});

// Which file "show in Finder" should land on. Separated from the route so it can be exercised
// without actually opening a Finder window on whoever is running the tests.
//
// Opening the app's own copy is a different situation depending on why it happened: a document that
// never had a tracked original, and one whose original has since moved, need different things said
// about them.
export function resolveRevealTarget(document) {
  const recordedPath = recordedRefreshSourcePath(document);
  if (recordedPath && fs.existsSync(recordedPath)) {
    return { target: recordedPath, reason: "original", recordedPath };
  }
  const copy = document?.sourcePath;
  if (copy && fs.existsSync(copy)) {
    return { target: copy, reason: recordedPath ? "original_missing" : "copy_only", recordedPath };
  }
  return {
    target: "",
    recordedPath,
    detail: recordedPath
      ? `原文件已经不在 ${recordedPath}，App 内部也没有留下副本。`
      : "这份文档没有可以定位的本地文件。"
  };
}

// Show the file in Finder. The client sends a document id and nothing else: the path comes from
// what the app recorded at import, so no caller can name a directory for the app to open.
app.post("/api/documents/:id/reveal", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  // The file the user knows about is the one they imported, not the copy the app keeps. Only fall
  // back to the copy when the import left no trail — a download, or a file dragged in from
  // somewhere the app never recorded.
  const resolved = resolveRevealTarget(document);
  if (!resolved.target) {
    res.status(404).json({ ok: false, error: "source_file_missing", detail: resolved.detail });
    return;
  }
  try {
    // -R selects the file inside its folder rather than opening the file itself.
    execFileSync("open", ["-R", resolved.target], { stdio: "ignore" });
    res.json({ ok: true, path: resolved.target, reason: resolved.reason, recordedPath: resolved.recordedPath });
  } catch (error) {
    res.status(500).json({ ok: false, error: "reveal_failed", detail: error.message });
  }
});

app.patch("/api/documents/:id", (req, res) => {
  const document = store.patchDocument(req.params.id, documentPatch(req.body));
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  res.json({ ok: true, document });
});

app.put("/api/documents/:id/pages/:page/annotations", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const page = Number(req.params.page);
  const annotations = req.body?.annotations;
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1) || !validAnnotationList(annotations)) {
    res.status(400).json({ ok: false, error: "invalid_annotations" });
    return;
  }
  const clientUpdatedAt = Number(
    req.body?.updatedAt ||
    annotations.reduce((latest, annotation) => Math.max(latest, Number(annotation.updatedAt || annotation.createdAt || 0)), 0) ||
    Date.now()
  );
  if (Number(document.annotationsClearedAt || 0) >= clientUpdatedAt) {
    res.status(409).json({
      ok: false,
      error: "stale_annotations",
      documentId: document.id,
      page,
      revision: Number(document.annotationsClearedAt || 0),
      annotations: []
    });
    return;
  }
  // The concurrency token used to be the client's own Date.now(), so a client could always win by
  // naming a later moment — and a same-millisecond write slipped through the strict >. When the
  // client echoes the revision it was last given, only a client that has actually seen the current
  // state can write over it. The timestamp path stays for callers that send no expectedRevision.
  const expectedRevision = optionalRevision(req.body?.expectedRevision);
  if (expectedRevision === null) {
    res.status(400).json({ ok: false, error: "invalid_annotation_revision" });
    return;
  }
  if (!Number.isFinite(clientUpdatedAt) || clientUpdatedAt <= 0) {
    res.status(400).json({ ok: false, error: "invalid_annotation_revision" });
    return;
  }
  const lastRevision = store.getPageAnnotationRevision(document.id, page);
  const conflicted = expectedRevision === undefined
    ? lastRevision > clientUpdatedAt
    : Number(expectedRevision) !== lastRevision;
  if (conflicted) {
    res.status(409).json({
      ok: false,
      error: "annotation_conflict",
      documentId: document.id,
      page,
      revision: lastRevision,
      annotations: store.getWorkspace().annotations[`${document.id}:${page}`] || []
    });
    return;
  }
  const saved = store.setPageAnnotations(document.id, page, annotations, clientUpdatedAt);
  publishEvent("annotations.updated", { documentId: document.id, page, annotations: saved.annotations, revision: clientUpdatedAt });
  // A vanished annotation that carried a review conversation was archived rather than destroyed.
  // Tell every client, so the record reaches the history panel instead of living only on disk.
  if (saved.archived.length > 0) {
    publishEvent("history.updated", {
      documentId: document.id,
      page,
      history: saved.history,
      revision: store.getPageHistoryRevision(document.id, page)
    });
  }
  res.json({
    ok: true,
    page,
    annotations: saved.annotations,
    revision: clientUpdatedAt,
    savedAt: new Date().toISOString(),
    ...(saved.archived.length > 0 ? { history: saved.history, archivedThreadCount: saved.archived.length } : {})
  });
});

app.post("/api/documents/:id/pages/:page/annotations/:annotationId/archive", (req, res) => {
  const document = store.getDocument(req.params.id);
  const page = Number(req.params.page);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  const result = store.archiveAnnotation(document.id, page, req.params.annotationId);
  if (!result) {
    res.status(404).json({ ok: false, error: "annotation_not_found" });
    return;
  }
  publishEvent("annotations.updated", {
    documentId: document.id,
    page,
    annotations: result.annotations,
    revision: result.annotationRevision
  });
  publishEvent("history.updated", {
    documentId: document.id,
    page,
    history: result.history,
    revision: result.historyRevision
  });
  res.json({ ok: true, page, ...result });
});

app.get("/api/review/threads", (req, res) => {
  const statuses = String(req.query.status || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (statuses.some((status) => !validReviewStatus(status))) {
    res.status(400).json({ ok: false, error: "invalid_review_status" });
    return;
  }
  const page = req.query.page ? Number(req.query.page) : 0;
  if (page && (!Number.isInteger(page) || page < 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  const threads = store.listReviewThreads({
    // A document-scoped caller may only ever see the active document, whatever it asks for.
    documentId: req.reviewScopedDocumentId || String(req.query.documentId || ""),
    page,
    statuses,
    actionableOnly: req.query.actionable === "true"
  });
  res.json({ ok: true, threads, total: threads.length });
});

app.get("/api/review/threads/:id", (req, res) => {
  const thread = store.getReviewThread(req.params.id);
  if (!thread) {
    res.status(404).json({ ok: false, error: "review_thread_not_found" });
    return;
  }
  res.json({ ok: true, thread });
});

app.post("/api/review/threads/:id/messages", (req, res) => {
  const body = String(req.body?.body || "").trim();
  const role = String(req.body?.role || "human");
  const status = req.body?.status ? String(req.body.status) : role === "human" ? "open" : "addressed";
  const tag = req.body?.tag ? String(req.body.tag) : "";
  const change = req.body?.change;
  const now = Date.now();
  const message = {
    id: safeEntityId(req.body?.id, `msg-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`),
    role,
    author: safeText(req.body?.author, role === "assistant" ? "AI" : "用户", 120),
    body,
    createdAt: Number(req.body?.createdAt || now),
    ...(change ? { change } : {})
  };
  if (!validReviewRole(role) || !validReviewStatus(status) || (tag && !["todo", "question", "resolved"].includes(tag)) || !validReviewMessage(message) || (change && !validReviewChange(change))) {
    res.status(400).json({ ok: false, error: "invalid_review_message" });
    return;
  }
  if (refusesReviewClosure(req, String(req.body?.role || "assistant"), status)) {
    res.status(403).json({ ok: false, error: "status_requires_human", detail: "只有用户可以把审阅意见标记为已解决或已拒绝。" });
    return;
  }
  const expectedRevision = optionalRevision(req.body?.expectedRevision);
  if (expectedRevision === null) {
    res.status(400).json({ ok: false, error: "invalid_review_revision" });
    return;
  }
  const result = store.appendReviewMessage(req.params.id, message, {
    status,
    tag,
    expectedRevision
  });
  if (!result) {
    res.status(404).json({ ok: false, error: "review_thread_not_found" });
    return;
  }
  if (result.conflict) {
    res.status(409).json({ ok: false, error: "review_thread_conflict", thread: result.thread });
    return;
  }
  if (tag) {
    publishEvent("annotations.updated", {
      documentId: result.thread.documentId,
      page: result.thread.page,
      annotations: result.annotations,
      revision: result.annotationRevision
    });
  }
  publishEvent("review.thread.updated", { thread: result.thread });
  res.json({ ok: true, thread: result.thread, annotation: result.annotation, annotations: result.annotations, message });
});

app.patch("/api/review/threads/:id", (req, res) => {
  const status = String(req.body?.status || "");
  if (!validReviewStatus(status)) {
    res.status(400).json({ ok: false, error: "invalid_review_status" });
    return;
  }
  if (refusesReviewClosure(req, String(req.body?.role || "assistant"), status)) {
    res.status(403).json({ ok: false, error: "status_requires_human", detail: "只有用户可以把审阅意见标记为已解决或已拒绝。" });
    return;
  }
  const expectedRevision = optionalRevision(req.body?.expectedRevision);
  if (expectedRevision === null) {
    res.status(400).json({ ok: false, error: "invalid_review_revision" });
    return;
  }
  const result = store.patchReviewThread(req.params.id, { status }, expectedRevision);
  if (!result) {
    res.status(404).json({ ok: false, error: "review_thread_not_found" });
    return;
  }
  if (result.conflict) {
    res.status(409).json({ ok: false, error: "review_thread_conflict", thread: result.thread });
    return;
  }
  publishEvent("review.thread.updated", { thread: result.thread });
  res.json({ ok: true, thread: result.thread });
});

app.patch("/api/review/threads/:id/state", (req, res) => {
  const status = String(req.body?.status || "");
  const tag = String(req.body?.tag || "");
  if (!validReviewStatus(status) || !["todo", "question", "resolved"].includes(tag)) {
    res.status(400).json({ ok: false, error: "invalid_review_state" });
    return;
  }
  const expectedRevision = optionalRevision(req.body?.expectedRevision);
  if (expectedRevision === null) {
    res.status(400).json({ ok: false, error: "invalid_review_revision" });
    return;
  }
  const result = store.patchReviewState(req.params.id, { status, tag }, expectedRevision);
  if (!result) {
    res.status(404).json({ ok: false, error: "review_thread_not_found" });
    return;
  }
  if (result.conflict) {
    res.status(409).json({ ok: false, error: "review_thread_conflict", thread: result.thread });
    return;
  }
  publishEvent("annotations.updated", {
    documentId: result.thread.documentId,
    page: result.thread.page,
    annotations: result.annotations,
    revision: result.annotationRevision
  });
  publishEvent("review.thread.updated", { thread: result.thread });
  // Closing a thread can also close the isolated task items cut from it.
  for (const taskId of result.mirroredTaskIds || []) {
    const task = store.getReviewTask(taskId);
    if (task) publishEvent("review.task.updated", { task: reviewTaskSummaryPayload(task) });
  }
  res.json({ ok: true, ...result });
});

app.post("/api/review/threads", asyncRoute(async (req, res) => {
  const document = store.getDocument(req.body?.documentId);
  const page = Number(req.body?.page);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  const now = Date.now();
  const supplied = req.body?.annotation || {};
  const annotation = {
    ...supplied,
    id: safeEntityId(supplied.id, `ai-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`),
    type: String(supplied.type || (supplied.quote ? "text" : "note")),
    text: String(supplied.text || req.body?.comment || "").trim().slice(0, 100000),
    quote: String(supplied.quote || "").trim().slice(0, 100000),
    tag: supplied.tag || "question",
    createdBy: "assistant",
    createdAt: Number(supplied.createdAt || now),
    updatedAt: Number(supplied.updatedAt || now)
  };
  if (store.getReviewThread(annotation.id)) {
    res.status(409).json({ ok: false, error: "annotation_exists" });
    return;
  }
  if (annotation.type === "text" && annotation.quote && !annotation.rects?.length) {
    const rects = findQuoteRects(await pdfTextLayer(document, page), annotation.quote, annotation.anchor);
    if (!rects.length) {
      res.status(409).json({ ok: false, error: "quote_not_found", detail: "选定文字无法在该页文字层中定位，请核对页码和原文。" });
      return;
    }
    Object.assign(annotation, boundsFromRects(rects), { rects });
  }
  if (!validAnnotationList([annotation])) {
    res.status(400).json({ ok: false, error: "invalid_annotation" });
    return;
  }
  const created = store.createReviewAnnotation(document.id, page, annotation, {
    createdBy: "assistant",
    status: validReviewStatus(req.body?.status) && !HUMAN_ONLY_REVIEW_STATUSES.has(req.body.status)
      ? req.body.status
      : "needs_human"
  });
  publishEvent("review.thread.created", { documentId: document.id, page, ...created });
  res.json({ ok: true, ...created });
}, "review_thread_create_failed"));

app.put("/api/documents/:id/pages/:page/history", (req, res) => {
  const document = store.getDocument(req.params.id);
  const page = Number(req.params.page);
  const history = req.body?.history;
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1) || !validHistoryList(history)) {
    res.status(400).json({ ok: false, error: "invalid_history" });
    return;
  }
  const clientUpdatedAt = Number(req.body?.updatedAt || Date.now());
  const lastRevision = store.getPageHistoryRevision(document.id, page);
  if (!Number.isFinite(clientUpdatedAt) || clientUpdatedAt <= 0) {
    res.status(400).json({ ok: false, error: "invalid_history_revision" });
    return;
  }
  if (lastRevision > clientUpdatedAt) {
    res.status(409).json({
      ok: false,
      error: "history_conflict",
      documentId: document.id,
      page,
      revision: lastRevision,
      history: store.getWorkspace().history[`${document.id}:${page}`] || []
    });
    return;
  }
  const saved = store.setPageHistory(document.id, page, history, clientUpdatedAt);
  publishEvent("history.updated", {
    documentId: document.id,
    page,
    history: saved,
    revision: clientUpdatedAt
  });
  res.json({ ok: true, page, history: saved, revision: clientUpdatedAt, savedAt: new Date().toISOString() });
});

app.post("/api/documents/:id/refresh", upload.single("file"), async (req, res) => {
  const stagingId = `refresh-${req.params.id}-${crypto.randomBytes(4).toString("hex")}`;
  const uploadedPath = req.file?.path || "";
  let remoteDownloadPath = "";
  try {
    const document = store.getDocument(req.params.id);
    if (!document) {
      res.status(404).json({ ok: false, error: "document_not_found" });
      return;
    }

    const clearAnnotations = req.body?.clearAnnotations === true || req.body?.clearAnnotations === "true";
    const requestedPath = req.body?.path;
    const recordedPath = recordedRefreshSourcePath(document);
    const trackedPath = trackedRefreshSourcePath(document);
    let remote = null;
    if (!req.file && !requestedPath && !trackedPath && document.importUrl) {
      remoteDownloadPath = path.join(DOCUMENT_UPLOAD_DIR, `remote-refresh-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.download`);
      remote = await downloadRemoteDocument({
        url: document.importUrl,
        destination: remoteDownloadPath,
        maxBytes: MAX_DOCUMENT_BYTES,
        timeoutMs: Number(process.env.REVIEW_REMOTE_IMPORT_TIMEOUT_MS || 60_000)
      });
    }
    if (!req.file && !requestedPath && !trackedPath && !remote) {
      const missingTrackedFile = Boolean(recordedPath);
      res.status(400).json({
        ok: false,
        error: missingTrackedFile ? "source_missing" : "source_untracked",
        detail: missingTrackedFile
          ? "已记录的源文件不存在，请重新设置一次源文件。"
          : "这份文档尚未关联原始文件，请先设置一次源文件；以后即可直接刷新。"
      });
      return;
    }
    const sourcePath = req.file ? "" : remoteDownloadPath || requestedPath || trackedPath;
    if (!req.file && (!sourcePath || !fs.existsSync(sourcePath))) {
      res.status(400).json({ ok: false, error: "source_missing" });
      return;
    }

    if (!req.file) {
      const fileStat = await fs.promises.stat(sourcePath);
      if (!fileStat.isFile()) {
        res.status(400).json({ ok: false, error: "invalid_path" });
        return;
      }
      if (fileStat.size > MAX_DOCUMENT_BYTES) {
        res.status(413).json({ ok: false, error: "file_too_large", detail: `文件不能超过 ${formatMegabytes(MAX_DOCUMENT_BYTES)} MB。` });
        return;
      }
    }
    const originalPath = req.file
      ? (document.originalPath && !isManagedAssetPath(document.originalPath) ? document.originalPath : "")
      : requestedPath || (document.originalPath && !isManagedAssetPath(document.originalPath) ? document.originalPath : "");
    const originalName = req.file?.originalname
      || remote?.fileName
      || path.basename(requestedPath || trackedPath || document.originalPath || "")
      || document.sourceFileName
      || path.basename(sourcePath)
      || document.name;
    const mime = req.file?.mimetype || remote?.mime || "";

    const hadAnnotations = Object.keys(store.getWorkspace().annotations).some((key) => key.startsWith(`${document.id}:`));
    const ingested = await ingestFile({
      id: stagingId,
      filePath: uploadedPath || sourcePath,
      originalName,
      mime,
      projectId: document.projectId,
      originalPath,
      previousDocument: document
    });
    const preserveRemoteSource = Boolean(document.importUrl && !requestedPath && !trackedPath);
    const staged = preserveRemoteSource
      ? {
          ...ingested,
          importUrl: document.importUrl,
          resolvedImportUrl: remote?.finalUrl || document.resolvedImportUrl || document.importUrl,
          sourceLabel: document.importUrl,
          remoteEtag: remote?.etag || document.remoteEtag || "",
          sourceModifiedAt: remote?.lastModified || Number(document.sourceModifiedAt || ingested.sourceModifiedAt || 0)
        }
      : ingested;
    const contentChanged = documentContentChanged(document, staged);
    const reanchorPlacements = contentChanged && hadAnnotations && !clearAnnotations
      ? await buildTextReanchorPlacements(document.id, staged)
      : [];
    const {
      document: refreshed,
      orphanedPages,
      reanchorResult
    } = commitStagedRefresh(document, staged, {
      warnAboutAnnotations: hadAnnotations && !clearAnnotations,
      reanchorPlacements
    });
    let clearedAt = 0;
    if (clearAnnotations) {
      clearedAt = store.clearDocumentAnnotations(document.id);
      publishEvent("annotations.cleared", {
        documentId: document.id,
        scope: "document",
        clearedAt,
        historyPages: documentHistoryPages(document.id)
      });
    }

    res.json({
      ok: true,
      document: refreshed,
      clearedAnnotations: clearAnnotations,
      clearedAt,
      contentChanged,
      previousPageCount: Number(document.pageCount || 1),
      orphanedPages,
      reanchorResult,
      annotationPages: clearAnnotations ? {} : documentAnnotationPages(document.id),
      annotationRevisions: documentAnnotationRevisions(document.id),
      historyPages: documentHistoryPages(document.id),
      reviewThreads: clearAnnotations ? {} : documentReviewThreads(document.id),
      sourceInfo: await documentSourceInfo(refreshed)
    });
  } catch (error) {
    cleanupAssetsForId(stagingId);
    res.status(ingestErrorStatus(error)).json({
      ok: false,
      error: applicationErrorCode(error, "refresh_failed"),
      detail: error.message,
      ...(error.tool ? { tool: error.tool } : {})
    });
  } finally {
    if (uploadedPath) fs.rmSync(uploadedPath, { force: true });
    if (remoteDownloadPath) fs.rmSync(remoteDownloadPath, { force: true });
  }
});

app.post("/api/documents/:id/versions/:versionId/restore", async (req, res) => {
  const stagingId = `restore-${req.params.id}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const document = store.getDocument(req.params.id);
    if (!document) {
      res.status(404).json({ ok: false, error: "document_not_found" });
      return;
    }
    const version = (document.versions || []).find((item) => item.id === req.params.versionId);
    const sourcePath = version ? documentVersionSourcePath(document, version) : "";
    if (!version || !sourcePath || !fs.existsSync(sourcePath)) {
      res.status(404).json({ ok: false, error: "document_version_not_found" });
      return;
    }
    const fileStat = await fs.promises.stat(sourcePath);
    if (!fileStat.isFile() || fileStat.size > MAX_DOCUMENT_BYTES) {
      res.status(400).json({ ok: false, error: "invalid_document_version" });
      return;
    }
    const hadAnnotations = Object.keys(store.getWorkspace().annotations).some((key) => key.startsWith(`${document.id}:`));
    const staged = await ingestFile({
      id: stagingId,
      filePath: sourcePath,
      originalName: version.sourceFileName || `version.${version.ext || document.ext || "pdf"}`,
      mime: "",
      projectId: document.projectId,
      originalPath: recordedRefreshSourcePath(document),
      previousDocument: document
    });
    const reanchorPlacements = hadAnnotations
      ? await buildTextReanchorPlacements(document.id, staged)
      : [];
    const {
      document: restored,
      orphanedPages,
      reanchorResult
    } = commitStagedRefresh(document, staged, {
      warnAboutAnnotations: hadAnnotations,
      reanchorPlacements
    });
    res.json({
      ok: true,
      document: restored,
      contentChanged: true,
      restoredVersionId: version.id,
      previousPageCount: Number(document.pageCount || 1),
      orphanedPages,
      reanchorResult,
      annotationPages: documentAnnotationPages(document.id),
      annotationRevisions: documentAnnotationRevisions(document.id),
      reviewThreads: documentReviewThreads(document.id),
      sourceInfo: await documentSourceInfo(restored)
    });
  } catch (error) {
    cleanupAssetsForId(stagingId);
    res.status(500).json({ ok: false, error: applicationErrorCode(error, "version_restore_failed"), detail: error.message });
  }
});

app.delete("/api/documents/:id/pages/:page/annotations", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const page = Number(req.params.page);
  if (!Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1)) {
    res.status(400).json({ ok: false, error: "invalid_page" });
    return;
  }
  const clearedAt = store.clearPageAnnotations(document.id, page);
  const historyPages = { [`${document.id}:${page}`]: documentHistoryPages(document.id)[`${document.id}:${page}`] || [] };
  publishEvent("annotations.cleared", { documentId: document.id, page, scope: "page", clearedAt, historyPages });
  res.json({ ok: true, scope: "page", page, clearedAt, historyPages });
});

app.delete("/api/documents/:id/annotations", (req, res) => {
  const document = store.getDocument(req.params.id);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const clearedAt = store.clearDocumentAnnotations(document.id);
  const historyPages = documentHistoryPages(document.id);
  publishEvent("annotations.cleared", { documentId: document.id, scope: "document", clearedAt, historyPages });
  res.json({ ok: true, scope: "document", clearedAt, historyPages });
});

app.delete("/api/documents/:id", (req, res) => {
  const document = store.getDocument(req.params.id);
  const deletedTaskIds = document && req.query.taskPolicy === "delete"
    ? store.deleteReviewTasksForDocuments(new Set([document.id]))
    : [];
  if (!store.deleteDocument(req.params.id)) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  deleteDocumentAssets(document);
  for (const taskId of deletedTaskIds) publishEvent("review.task.deleted", { taskId });
  publishTasksReferencingDocuments([document.id]);
  res.json({ ok: true, deletedTaskIds });
});

app.get("/api/backup", (_req, res) => {
  res.json({
    ok: true,
    exportedAt: new Date().toISOString(),
    workspace: store.getWorkspace()
  });
});

app.get("/api/backup/full", async (_req, res) => {
  try {
    await streamFullBackup(res, { dataDir: DATA_DIR, workspace: store.getState(), appVersion: APP_VERSION });
  } catch (error) {
    if (!res.headersSent) res.status(error.code === "backup_too_large" ? 413 : 500).json({
      ok: false,
      error: applicationErrorCode(error, "backup_failed"),
      detail: error.message
    });
    else res.destroy(error);
  }
});

app.post("/api/open-data-folder", (_req, res) => {
  try {
    execFileSync("open", [DATA_DIR], { stdio: "ignore" });
    res.json({ ok: true, path: DATA_DIR });
  } catch (error) {
    res.status(500).json({ ok: false, error: "open_failed", detail: error.message });
  }
});

app.post("/api/backup/restore", (req, res) => {
  res.status(410).json({ ok: false, error: "index_restore_removed", detail: "Restore a complete .reviewbackup archive instead." });
});

app.post("/api/backup/full/restore", backupUpload.single("backup"), async (req, res) => {
  if (!req.file?.path) {
    res.status(400).json({ ok: false, error: "missing_backup" });
    return;
  }
  try {
    const result = await restoreFullBackup({ archivePath: req.file.path, dataDir: DATA_DIR, store, appVersion: APP_VERSION });
    validateWorkspace(store.getState());
    res.json({ ok: true, restoredAt: new Date().toISOString(), workspace: result.workspace, automaticBackup: result.automaticBackup });
  } catch (error) {
    res.status(400).json({ ok: false, error: applicationErrorCode(error, "restore_failed"), detail: error.message });
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
});

app.post("/api/export", (req, res) => {
  const payload = req.body?.payload || req.body || {};
  const exportId = `ex-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const createdAt = Date.now();
  store.insertExport({
    id: exportId,
    createdAt,
    type: "structured",
    action: safeText(req.body?.action, "export", 40),
    format: safeText(req.body?.format, "json", 40),
    scope: safeText(payload.scope, "document", 40),
    documentId: safeText(payload.document?.id, "", 200),
    documentName: safeText(payload.document?.name, "", 500),
    annotationCount: Number(
      payload.summary?.annotationCount
      ?? (payload.pages || []).reduce((sum, page) => sum + (page.annotations || []).length, 0)
    )
  });
  res.json({ ok: true, id: exportId, exportedAt: new Date(createdAt).toISOString(), payload });
});

app.post("/api/export/review-html", async (req, res) => {
  try {
    const payload = req.body || {};
    const scopeName = payload.scope === "doc" ? "document" : `page-${payload.pages?.[0]?.index || "current"}`;
    const fileName = `${safeFileStem(payload.document?.name || "review-annotations")}-${scopeName}.html`;
    const html = await buildStandaloneReviewHtml(payload);
    res.json({ ok: true, fileName, html });
  } catch (error) {
    res.status(500).json({ ok: false, error: "html_export_failed", detail: error.message });
  }
});

app.post("/api/export/annotated-pdf", async (req, res) => {
  if (!PYTHON_EXPORT_READY) {
    res.status(503).json({
      ok: false,
      error: "pdf_export_runtime_missing",
      detail: "批注 PDF 导出需要 Python、pypdf 和 reportlab。请运行 npm run check:runtime。"
    });
    return;
  }
  const document = store.getDocument(req.body?.documentId);
  if (!document) {
    res.status(404).json({ ok: false, error: "document_not_found" });
    return;
  }
  const sourcePath = documentPdfPath(document);
  if (!sourcePath) {
    res.status(400).json({ ok: false, error: "pdf_export_unavailable", detail: "当前文档没有可用于导出的 PDF 源文件。" });
    return;
  }
  const scope = req.body?.scope === "page" ? "page" : "doc";
  const pageMode = req.body?.pageMode === "annotated" ? "annotated" : "all";
  const includeResolved = req.body?.includeResolved === true;
  const currentPage = clampInteger(Number(req.body?.page || 1), 1, Number(document.pageCount || 1));
  const workspace = store.getWorkspace();
  const allPages = Array.from({ length: document.pageCount }, (_, index) => index + 1);
  const meaningfulAnnotations = (page) => {
    let markerNumber = 0;
    return (workspace.annotations[`${document.id}:${page}`] || [])
      .filter((annotation) => annotation.type !== "note" || String(annotation.text || "").trim())
      .map((annotation) => annotation.type === "note" ? { ...annotation, displayLabel: "页" } : { ...annotation, displayLabel: String(++markerNumber) })
      .filter((annotation) => includeResolved || !annotationIsResolved(annotation, workspace.reviewThreads?.[annotation.id]))
      .map((annotation) => ({
        ...annotation,
        reviewStatus: workspace.reviewThreads?.[annotation.id]?.status || (annotation.tag === "resolved" ? "resolved" : "open"),
        reviewMessages: workspace.reviewThreads?.[annotation.id]?.messages || []
      }));
  };
  const annotatedPages = allPages.filter((page) => meaningfulAnnotations(page).length > 0);
  const selectedPages = scope === "page" ? [currentPage] : pageMode === "annotated" ? annotatedPages : allPages;
  if (selectedPages.length === 0) {
    res.status(400).json({ ok: false, error: "no_annotated_pages", detail: "当前文档没有可导出的批注页面。" });
    return;
  }
  const payload = {
    documentName: document.name,
    selectedPages,
    pages: selectedPages.map((page) => ({
      page,
      title: document.titles?.[page - 1] || document.pages?.[page - 1]?.title || `第 ${page} 页`,
      annotations: meaningfulAnnotations(page)
    }))
  };
  const exportId = `pdf-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const exportDir = path.join(DATA_DIR, ".export-tmp");
  const payloadPath = path.join(exportDir, `${exportId}.json`);
  const outputPath = path.join(exportDir, `${exportId}.pdf`);
  try {
    assertExecutable(PYTHON, "python3");
    fs.mkdirSync(exportDir, { recursive: true });
    await fs.promises.writeFile(payloadPath, `${JSON.stringify(payload)}\n`);
    const scriptPath = unpackedPath(path.join(path.dirname(fileURLToPath(import.meta.url)), "annotated-pdf.py"));
    await execFileAsync(PYTHON, [scriptPath, sourcePath, payloadPath, outputPath], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180000
    });
    if (!fs.existsSync(outputPath)) throw new Error("批注 PDF 生成器没有输出文件。");
    const rangeName = scope === "page" ? `page-${currentPage}` : pageMode === "annotated" ? "annotated-pages" : "all-pages";
    const fileName = `${safeFileStem(document.name)}-${rangeName}.pdf`;
    store.insertExport({ id: exportId, createdAt: Date.now(), type: "annotated-pdf", documentId: document.id, scope, pageMode, page: currentPage });
    res.download(outputPath, fileName, () => {
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(outputPath, { force: true });
    });
  } catch (error) {
    fs.rmSync(payloadPath, { force: true });
    fs.rmSync(outputPath, { force: true });
    res.status(500).json({ ok: false, error: "annotated_pdf_failed", detail: error.message });
  }
});

const revisionChecklistHandler = (req, res) => {
  const payload = req.body || {};
  const pages = payload.pages || [];
  const items = pages.flatMap((page) =>
    (page.annotations || []).map((annotation) => ({
      page: page.index,
      pageTitle: page.title || "",
      target: annotation.type,
      location: annotation.locationLabel || "",
      change: annotation.text || "根据该批注调整对应内容",
      priority: annotation.tag === "todo" ? "high" : annotation.tag === "question" ? "medium" : "low"
    }))
  );

  res.json({
    ok: true,
    generator: "local-checklist",
    summary: `已从 ${pages.length} 页、${items.length} 条批注整理出待执行修改清单。`,
    actions: items
  });
};

app.post("/api/revision-checklist", revisionChecklistHandler);
app.post("/api/ai/revision", revisionChecklistHandler);

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ ok: false, error: "file_too_large", detail: `文件不能超过 ${formatMegabytes(MAX_DOCUMENT_BYTES)} MB。` });
    return;
  }
  next(error);
});

async function createReviewTaskSnapshot(input) {
  const scope = input.scope === "project" ? "project" : "document";
  const requestedDocument = scope === "document" ? store.getDocument(String(input.documentId || "")) : null;
  if (scope === "document" && !requestedDocument) throw reviewTaskError("document_not_found", "找不到要建立快照的文档。");
  const projectId = scope === "project" ? String(input.projectId || "") : requestedDocument.projectId;
  const project = store.getProject(projectId);
  if (!project) throw reviewTaskError("project_not_found", "找不到要建立快照的项目。");
  const documents = scope === "document"
    ? [requestedDocument]
    : (project.docIds || []).map((documentId) => store.getDocument(documentId)).filter(Boolean);
  if (documents.length === 0) throw reviewTaskError("review_task_empty", "这个范围内还没有文档。");

  const threads = documents
    .flatMap((document) => store.listReviewThreads({ documentId: document.id, actionableOnly: true }))
    .sort((a, b) => documents.findIndex((document) => document.id === a.documentId) - documents.findIndex((document) => document.id === b.documentId) || Number(a.page) - Number(b.page));
  if (threads.length === 0) throw reviewTaskError("review_task_empty", "这个范围内还没有可执行的批注意见。");

  const taskId = uniqueReviewTaskId();
  const now = Date.now();
  const pageText = new Map();
  for (const thread of threads) {
    const key = `${thread.documentId}:${thread.page}`;
    if (pageText.has(key)) continue;
    const document = documents.find((item) => item.id === thread.documentId);
    try {
      pageText.set(key, (await pdfTextLayer(document, thread.page)).text || "");
    } catch {
      pageText.set(key, document.pages?.[thread.page - 1]?.text || "");
    }
  }

  // allowedPaths is what an agent is told it may edit. The app's own managed copies under uploads/
  // and renders/ are internal assets: editing one changes nothing the user can see and corrupts the
  // workspace behind the app's back. A user file that merely lives elsewhere is still fair game.
  const notManagedAsset = (candidate) => (candidate && !isDataPath(candidate) ? candidate : "");
  const projectRootPath = notManagedAsset(existingDirectory(project.path));
  const documentWorkingPaths = Object.fromEntries(documents.map((document) => {
    const candidate = recordedRefreshSourcePath(document) || document.originalPath || document.sourcePath || "";
    return [document.id, notManagedAsset(existingFile(candidate))];
  }));
  const allowedPaths = scope === "project"
    ? [...new Set([projectRootPath, ...Object.values(documentWorkingPaths)].filter(Boolean))]
    : [...new Set([documentWorkingPaths[requestedDocument.id]].filter(Boolean))];
  const task = {
    id: taskId,
    accessToken: crypto.randomBytes(32).toString("hex"),
    name: safeText(input.name, scope === "project" ? `${project.name} · 项目审阅` : `${requestedDocument.name} · 文档审阅`, 500),
    scope,
    projectId: project.id,
    projectName: project.name,
    projectRootPath,
    allowedPaths,
    documentIds: documents.map((document) => document.id),
    documents: documents.map((document) => ({
      id: document.id,
      name: document.name,
      type: document.type || "file",
      ext: document.ext || "",
      pageCount: Number(document.pageCount || 1),
      documentRevision: document.contentHash || "",
      workingArtifactPath: documentWorkingPaths[document.id] || "",
      managedCopyPath: document.sourcePath || "",
      reviewArtifactPath: documentPdfPath(document) || document.sourcePath || "",
      sourceModifiedAt: Number(document.sourceModifiedAt || 0),
      refreshedAt: Number(document.refreshedAt || document.updated || 0)
    })),
    pageSnapshots: Object.fromEntries(pageText),
    items: threads.map((thread, index) => ({
      id: `${taskId}-I${String(index + 1).padStart(3, "0")}`,
      sourceThreadId: thread.id,
      sourceThreadRevision: Number(thread.revision || 0),
      liveThreadRevision: Number(thread.revision || 0),
      sourceAnnotationHash: reviewAnnotationHash(thread.annotation),
      syncStatus: "synced",
      syncConflict: "",
      documentId: thread.documentId,
      documentName: thread.documentName,
      documentRevision: thread.documentRevision || "",
      page: Number(thread.page),
      pageTitle: thread.pageTitle || `第 ${thread.page} 页`,
      pageSnapshotKey: `${thread.documentId}:${thread.page}`,
      status: validReviewStatus(thread.status) ? thread.status : "open",
      createdBy: thread.createdBy || "human",
      annotation: structuredClone(thread.annotation),
      messages: structuredClone(thread.messages || []),
      createdAt: Number(thread.createdAt || now),
      updatedAt: Number(thread.updatedAt || now),
      revision: Number(thread.revision || 0)
    })),
    status: "ready",
    createdAt: now,
    updatedAt: now,
    revision: now
  };
  if (!validReviewTask(task)) throw reviewTaskError("invalid_review_task", "审阅任务快照数据无效。");
  const sourcePaths = Object.fromEntries(documents.map((document) => [document.id, documentPdfPath(document) || document.sourcePath || ""]));
  const created = store.createReviewTask(task, sourcePaths);
  if (!created) throw reviewTaskError("review_task_exists", "任务 ID 已存在，请重试。");
  return created;
}

function uniqueReviewTaskId() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const taskId = `REV-${stamp}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    if (!store.getReviewTask(taskId)) return taskId;
  }
  throw reviewTaskError("review_task_id_failed", "无法生成唯一任务 ID。");
}

function existingDirectory(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "本地工作区") return "";
  const expanded = raw === "~" || raw.startsWith(`~${path.sep}`) ? path.join(os.homedir(), raw.slice(2)) : raw;
  try {
    return fs.statSync(expanded).isDirectory() ? path.resolve(expanded) : "";
  } catch {
    return "";
  }
}

// The import field accepts whatever a person actually pasted. Finder gives a bare POSIX path,
// dragging a file into a text field gives a file:// URL, dragging into Terminal first escapes the
// spaces, and a shell prompt brings quotes along. Try each shape rather than making the user clean
// it up by hand.
function isAppOwnedCopy(filePath) {
  const resolved = path.resolve(filePath);
  return [UPLOAD_DIR, RENDER_DIR, path.join(DATA_DIR, "versions"), path.join(DATA_DIR, "review-tasks"), path.join(DATA_DIR, "backups")]
    .some((root) => resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`));
}

function resolveLocalImportPath(input) {
  const raw = String(input ?? "").trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim();
  if (!raw) return "";
  const candidates = [];
  if (/^file:\/\//i.test(raw)) {
    try {
      candidates.push(fileURLToPath(raw));
    } catch {
      // Not a URL this platform can turn into a path; the plain forms below still get a chance.
    }
  } else {
    candidates.push(raw);
    // Dragging a file into Terminal produces a path with backslash-escaped spaces.
    if (raw.includes("\\")) candidates.push(raw.replace(/\\(.)/g, "$1"));
  }
  for (const candidate of candidates) {
    const resolved = existingFile(candidate);
    if (resolved) return resolved;
  }
  return "";
}

function existingFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const expanded = raw === "~" || raw.startsWith(`~${path.sep}`) ? path.join(os.homedir(), raw.slice(2)) : raw;
  try {
    return fs.statSync(expanded).isFile() ? path.resolve(expanded) : "";
  } catch {
    return "";
  }
}

function reviewAnnotationHash(annotation) {
  const snapshot = {
    id: annotation?.id || "",
    type: annotation?.type || "",
    tag: annotation?.tag || "",
    text: annotation?.text || "",
    quote: annotation?.quote || "",
    anchor: annotation?.anchor || null,
    anchorStatus: annotation?.anchorStatus || "",
    rects: annotation?.rects || [],
    x: annotation?.x,
    y: annotation?.y,
    w: annotation?.w,
    h: annotation?.h,
    createdAt: Number(annotation?.createdAt || 0),
    updatedAt: Number(annotation?.updatedAt || 0)
  };
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

// Retained tasks become stale the moment their document goes away. Republish the ones that
// reference it so clients stop showing them as current.
function publishTasksReferencingDocuments(documentIds) {
  const ids = new Set(documentIds);
  for (const task of store.getWorkspace().reviewTasks) {
    if ((task.documentIds || []).some((id) => ids.has(id))) publishEvent("review.task.updated", { task });
  }
}

function reviewTaskSummaryPayload(task) {
  const { items, documents, ...summary } = task;
  return {
    ...summary,
    documentNames: documents?.map((document) => document.name) || task.documentNames || [],
    itemCount: items?.length ?? task.itemCount ?? 0,
    completedCount: items?.filter((item) => ["resolved", "rejected"].includes(item.status)).length ?? task.completedCount ?? 0
  };
}

function publishMirroredThreadEvent(annotationId) {
  const thread = store.getReviewThread(annotationId);
  if (thread) publishEvent("review.thread.updated", { thread });
}

function reviewTaskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^\/assets\//, (_req, res) => {
    res.status(404).type("text/plain").send("Asset not found");
  });
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

// Registered last: Express only searches for an error handler in the layers that follow the one
// that failed, so anything declared before the static and SPA routes cannot catch their errors.
app.use((error, _req, res, _next) => {
  const reported = Number(error?.status || error?.statusCode || 0);
  const status = Number.isInteger(reported) && reported >= 400 && reported <= 599 ? reported : 500;
  if (status >= 500) console.error("[review-annotation] 请求处理失败:", error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ ok: false, error: applicationErrorCode(error, status === 500 ? "internal_error" : "invalid_request") });
});

// Exported for tests: the resolution itself runs once at module load, so this is the only way to
// exercise the file's precedence and its failure modes.
export function configuredRuntimePathForTest(key) {
  return configuredRuntimePath(key);
}

export function startServer(port = PORT) {
  if (activeListener) throw new Error("Review annotation API is already running in this process.");
  for (const dir of [DATA_DIR, UPLOAD_DIR, RENDER_DIR, DOCUMENT_UPLOAD_DIR, path.join(DATA_DIR, "review-tasks"), path.join(DATA_DIR, "versions"), path.join(DATA_DIR, ".office-profiles")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dataDirectoryLock = acquireDataDirectoryLock(DATA_DIR, port);
  try {
    recoverInterruptedFullRestore(DATA_DIR);
    recoverInterruptedRefreshTransactions();
    for (const file of fs.readdirSync(DOCUMENT_UPLOAD_DIR)) fs.rmSync(path.join(DOCUMENT_UPLOAD_DIR, file), { recursive: true, force: true });
    const workspaceFileExisted = fs.existsSync(path.join(DATA_DIR, "workspace.json"));
    store = createStore(DATA_DIR);
    if (!workspaceFileExisted && dataDirectoryHoldsAssets()) {
      store = null;
      recoveryMode = {
        code: "WORKSPACE_INDEX_MISSING",
        message: "数据目录里有文档文件，但工作区索引不见了。请从下面的快照恢复，不要直接继续使用，否则这些文件会被当作无人引用的残留。",
        backupPath: ""
      };
      console.error("[review-annotation] 进入恢复模式 (WORKSPACE_INDEX_MISSING)：索引缺失但资产仍在。");
    } else {
      sweepOrphanedAssets();
    }
    const legacyDir = legacyDataDirectory(ROOT);
    const shouldMergeLegacyData = !process.env.REVIEW_APP_DATA || process.env.REVIEW_MERGE_LEGACY_DATA === "1";
    if (shouldMergeLegacyData && fs.existsSync(path.join(legacyDir, "workspace.json")) && path.resolve(legacyDir) !== path.resolve(DATA_DIR)) {
      mergeLegacyDataDirectory({ sourceDir: legacyDir, targetDir: DATA_DIR, store });
    }
  } catch (error) {
    if (error?.code !== "WORKSPACE_CORRUPT" && error?.code !== "WORKSPACE_SCHEMA_TOO_NEW") {
      dataDirectoryLock.release();
      dataDirectoryLock = null;
      store = null;
      throw error;
    }
    store = null;
    recoveryMode = { code: error.code, message: error.message, backupPath: error.backupPath || "" };
    console.error(`[review-annotation] 进入恢复模式 (${error.code}): ${error.message}`);
  }

  if (store) {
    for (const document of store.getWorkspace().documents) {
      if (document.analysisStatus === "pending") scheduleDeferredPdfAnalysis(document);
    }
  }

  const listener = app.listen(port, "127.0.0.1", () => {
    const address = listener.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Review annotation API listening on http://127.0.0.1:${actualPort}`);
    console.log(store ? `Workspace store: ${store.path}` : `Workspace store: 恢复模式（${recoveryMode?.code}）`);
  });
  activeListener = listener;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    dataDirectoryLock?.release();
    dataDirectoryLock = null;
    store = null;
    activeListener = null;
  };
  listener.once("close", cleanup);
  listener.once("error", cleanup);
  return listener;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  API_TOKEN = resolveCommandLineCapability();
  startServer(PORT);
}

function resolveCommandLineCapability() {
  if (API_TOKEN) return API_TOKEN;
  if (process.env.REVIEW_ALLOW_UNAUTHENTICATED === "1") {
    if (!process.env.REVIEW_APP_DATA) {
      console.error("[review-annotation] 拒绝在默认工作区上关闭认证。请用 REVIEW_APP_DATA 指向一个独立的数据目录，或去掉 REVIEW_ALLOW_UNAUTHENTICATED。");
      process.exit(1);
    }
    console.warn("[review-annotation] 已按显式要求关闭本地 API 认证，仅用于开发。");
    return "";
  }
  try {
    const token = loadOrCreateCapability(DATA_DIR);
    console.log(`[review-annotation] 本地 API 已启用能力令牌。浏览器请打开 http://127.0.0.1:${PORT}/?cap=${token}`);
    return token;
  } catch (error) {
    console.error(`[review-annotation] 无法使用数据目录中的 .api-capability：${error.message}。请检查该文件的属主与权限（应为当前用户、0600）。`);
    process.exit(1);
  }
}

async function ingestFile(options) {
  const id = options.id || `doc-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    return await ingestFileUnsafe({ ...options, id });
  } catch (error) {
    cleanupAssetsForId(id);
    throw error;
  }
}

async function ingestFileUnsafe({ id, filePath, originalName, mime, projectId, originalPath = "", previousDocument = null, deferLargeAnalysis = false }) {
  const ext = originalName.includes(".") ? originalName.split(".").pop().toUpperCase() : "FILE";
  const type = classify(mime, ext);
  if (type === "file") {
    const error = new Error(`暂不支持 ${ext === "FILE" ? "没有扩展名" : `.${ext.toLowerCase()}`} 文件。请先转换为 PDF、Office、图片或文本格式。`);
    error.code = "unsupported_document_type";
    throw error;
  }
  const safeBase = `${id}.${ext.toLowerCase()}`;
  const storedPath = path.join(UPLOAD_DIR, safeBase);
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.promises.copyFile(filePath, storedPath);
  const storedInfo = await fs.promises.stat(storedPath);
  const sourceInfo = fileInfo(originalPath || storedPath);
  const now = Date.now();

  const base = {
    id,
    projectId,
    name: originalName,
    sourceFileName: originalName,
    sourceMime: mime || "",
    type,
    ext,
    renderMode: type === "image" || type === "pdf" ? "raster" : "text",
    pageCount: 1,
    pages: [],
    titles: [],
    sourcePath: storedPath,
    originalPath,
    sourceModifiedAt: sourceInfo.modifiedAt,
    sourceSize: storedInfo.size,
    contentHash: await fileSha256Async(storedPath),
    refreshedAt: now,
    updated: now,
    uploadedBytes: storedInfo.size,
    refreshCount: Number(previousDocument?.refreshCount || 0) + (previousDocument ? 1 : 0)
  };

  if (type === "pdf") return { ...base, ...(await renderPdf(id, storedPath, { deferLargeAnalysis, contentHash: base.contentHash })) };
  if (type === "office") {
    const convertedPdfPath = await convertOfficeToPdf(id, storedPath);
    return { ...base, renderMode: "pdf", convertedPdfPath, ...(await renderPdf(id, convertedPdfPath, { deferLargeAnalysis, contentHash: base.contentHash })) };
  }
  if (type === "image") {
    const page = { title: originalName, sourceUrl: `/api/uploads/${safeBase}`, ...imagePageMeta(storedPath) };
    return { ...base, pageCount: 1, pages: [page], titles: [page.title] };
  }
  const text = await fs.promises.readFile(storedPath, "utf8");
  const pages = splitTextPages(text || `${originalName}\n\n该格式没有可提取的文本内容。`, originalName);
  return { ...base, pageCount: pages.length, pages, titles: pages.map((page) => page.title) };
}

async function convertOfficeToPdf(id, inputPath) {
  assertExecutable(SOFFICE, "soffice");
  const outDir = path.join(RENDER_DIR, id, "converted");
  const profileDir = path.join(DATA_DIR, ".office-profiles", `${id}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  try {
    await execFileAsync(SOFFICE, [`-env:UserInstallation=${pathToFileURL(profileDir).href}`, "--headless", "--convert-to", "pdf", "--outdir", outDir, inputPath], {
      timeout: 120000,
      stdio: "pipe"
    });
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  const pdfs = fs.readdirSync(outDir).filter((file) => file.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) throw new Error("Office conversion produced no PDF");
  return path.join(outDir, pdfs[0]);
}

async function renderPdf(id, pdfPath, { deferLargeAnalysis = false, contentHash = "" } = {}) {
  assertExecutable(PDFINFO, "pdfinfo");
  const { stdout: baseInfo } = await execFileAsync(PDFINFO, [pdfPath], { encoding: "utf8", timeout: 30000 });
  const pageCount = Number((baseInfo.match(/^Pages:\s+(\d+)/m) || [])[1] || 1);
  const { stdout: info } = await execFileAsync(PDFINFO, ["-f", "1", "-l", String(pageCount), "-box", pdfPath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60000
  });
  const pageMetadata = pdfPageMetadata(info, pageCount);
  if (deferLargeAnalysis && pageCount >= DEFER_PDF_ANALYSIS_PAGE_COUNT) {
    const pages = Array.from({ length: pageCount }, (_, index) => ({
      title: `第 ${index + 1} 页`,
      ...(pageMetadata[index] || {}),
      hasTextLayer: null,
      textUrl: `/api/documents/${id}/pages/${index + 1}/text`,
      previewUrl: `/api/documents/${id}/pages/${index + 1}/preview`
    }));
    return {
      renderMode: "pdf",
      pageCount,
      pages,
      titles: pages.map((page) => page.title),
      outline: [],
      selectablePageCount: 0,
      textLayerStatus: "pending",
      analysisStatus: "pending"
    };
  }
  const [titles, textLayers] = await Promise.all([extractPdfTitles(pdfPath, pageCount), extractPdfTextLayersChunked(pdfPath, pageCount)]);
  cachePdfTextLayers(id, contentHash, textLayers);
  const analysisPages = Array.from({ length: pageCount }, (_, index) => ({
    title: titles[index] || `第 ${index + 1} 页`,
    ...(pageMetadata[index] || {}),
    ...(textLayers[index] || {})
  }));
  const outline = (await nativePdfOutline(pdfPath, analysisPages)) || buildDocumentOutline(analysisPages);
  const pageTitles = titlesFromOutline(titles, outline, pageCount);
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    title: pageTitles[index] || `第 ${index + 1} 页`,
    ...(pageMetadata[index] || {}),
    hasTextLayer: Boolean(textLayers[index]?.words?.length || String(textLayers[index]?.text || "").trim()),
    textUrl: `/api/documents/${id}/pages/${index + 1}/text`,
    previewUrl: `/api/documents/${id}/pages/${index + 1}/preview`
  }));
  const selectablePageCount = pages.filter((page) => page.hasTextLayer).length;

  return {
    renderMode: "pdf",
    pageCount,
    pages,
    titles: pages.map((page) => page.title),
    outline,
    selectablePageCount,
    textLayerStatus: selectablePageCount === 0 ? "none" : selectablePageCount === pageCount ? "complete" : "partial",
    analysisStatus: "ready"
  };
}

function scheduleDeferredPdfAnalysis(document) {
  if (document?.analysisStatus !== "pending" || documentAnalysisJobs.has(document.id)) return;
  const expectedHash = document.contentHash;
  const job = new Promise((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      const current = store?.getDocument(document.id);
      if (!current || current.contentHash !== expectedHash || current.analysisStatus !== "pending") return;
      const pdfPath = documentPdfPath(current);
      if (!pdfPath) throw new Error("PDF source is unavailable for background analysis.");
      const analysis = await renderPdf(current.id, pdfPath, { contentHash: expectedHash });
      const latest = store?.getDocument(current.id);
      if (!latest || latest.contentHash !== expectedHash) return;
      const updated = store.patchDocument(current.id, analysis);
      publishEvent("document.updated", { document: updated });
    })
    .catch((error) => {
      const current = store?.getDocument(document.id);
      if (!current || current.contentHash !== expectedHash) return;
      const updated = store.patchDocument(document.id, { analysisStatus: "error", analysisError: safeText(error.message, "文档索引失败", 500) });
      publishEvent("document.updated", { document: updated });
    })
    .finally(() => documentAnalysisJobs.delete(document.id))
    .catch((error) => console.error("[review-annotation] 后台文档分析失败:", error));
  documentAnalysisJobs.set(document.id, job);
}

function titlesFromOutline(baseTitles, outline, pageCount) {
  const titles = Array.from({ length: pageCount }, (_, index) => baseTitles[index] || `第 ${index + 1} 页`);
  const candidates = [...(outline || [])]
    .filter((item) => Number.isInteger(Number(item.page)) && Number(item.page) >= 1 && Number(item.page) <= pageCount)
    .filter((item) => !item.type || ["section", "chapter", "figure", "table"].includes(item.type))
    .sort((a, b) => Number(a.page) - Number(b.page) || Number(a.level || 1) - Number(b.level || 1));
  const assigned = new Set();
  for (const item of candidates) {
    const page = Number(item.page);
    if (page === 1 || assigned.has(page)) continue;
    const title = String(item.title || "").replace(/\s+/g, " ").trim();
    if (!title || isBadPdfPageTitle(title)) continue;
    const number = String(item.number || "").trim();
    titles[page - 1] = number && !title.startsWith(number) ? `${number} ${title}` : title;
    assigned.add(page);
  }
  return titles;
}

function pdfPageMetadata(info, pageCount) {
  const metadata = Array.from({ length: pageCount }, () => ({}));
  const pattern = /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/i;
  for (const line of String(info || "").split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const page = Number(match[1]);
    const width = Number(match[2]);
    const height = Number(match[3]);
    if (!metadata[page - 1] || !width || !height) continue;
    const aspectRatio = width / height;
    metadata[page - 1] = {
      width,
      height,
      aspectRatio: Number(aspectRatio.toFixed(5)),
      orientation: aspectRatio > 1 ? "landscape" : "portrait"
    };
  }
  return metadata;
}

function textCacheDirectory(documentId, contentHash) {
  const revision = /^[a-f0-9]{8,}$/.test(String(contentHash || "")) ? String(contentHash).slice(0, 32) : "unversioned";
  return path.join(RENDER_DIR, documentId, "text", revision);
}

function textCachePath(document, page) {
  return path.join(textCacheDirectory(document.id, document.contentHash), `page-${page}.json`);
}

function cachePdfTextLayers(id, contentHash, textLayers) {
  const directory = textCacheDirectory(id, contentHash);
  fs.mkdirSync(directory, { recursive: true });
  for (const [index, layer] of textLayers.entries()) {
    atomicWriteFile(path.join(directory, `page-${index + 1}.json`), `${JSON.stringify(layer)}\n`);
  }
}

async function extractPdfTitles(pdfPath, pageCount) {
  if (!fs.existsSync(PDFTOTEXT)) return [];
  const titles = [];
  for (let page = 1; page <= pageCount; page += 1) {
    if (page > 1) {
      titles.push(`第 ${page} 页`);
      continue;
    }
    try {
      const { stdout: text } = await execFileAsync(PDFTOTEXT, ["-enc", "UTF-8", "-f", String(page), "-l", String(page), pdfPath, "-"], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30000
      });
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const title = (lines[0] || "").slice(0, 60);
      titles.push(title && !isBadPdfPageTitle(title) ? title : `第 ${page} 页`);
    } catch {
      titles.push(`第 ${page} 页`);
    }
  }
  return titles;
}

async function extractPdfTextLayers(pdfPath, firstPage = 0, lastPage = 0) {
  if (!fs.existsSync(PDFTOTEXT)) return [];
  try {
    const pageArgs = firstPage > 0 ? ["-f", String(firstPage), "-l", String(lastPage || firstPage)] : [];
    const { stdout: html } = await execFileAsync(PDFTOTEXT, ["-enc", "UTF-8", "-bbox", ...pageArgs, pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000
    });
    const pages = [];
    const pagePattern = /<page[^>]*width="([^"]+)"[^>]*height="([^"]+)"[^>]*>([\s\S]*?)<\/page>/g;
    let pageMatch;
    while ((pageMatch = pagePattern.exec(html))) {
      const pageWidth = Number(pageMatch[1]);
      const pageHeight = Number(pageMatch[2]);
      const words = [];
      const textParts = [];
      const wordPattern = /<word[^>]*xMin="([^"]+)"[^>]*yMin="([^"]+)"[^>]*xMax="([^"]+)"[^>]*yMax="([^"]+)"[^>]*>([\s\S]*?)<\/word>/g;
      let wordMatch;
      while ((wordMatch = wordPattern.exec(pageMatch[3]))) {
        const value = decodeXml(wordMatch[5]).trim();
        if (!value) continue;
        const xMin = Number(wordMatch[1]);
        const yMin = Number(wordMatch[2]);
        const xMax = Number(wordMatch[3]);
        const yMax = Number(wordMatch[4]);
        words.push({
          text: value,
          x: percent(xMin, pageWidth),
          y: percent(yMin, pageHeight),
          w: percent(xMax - xMin, pageWidth),
          h: percent(yMax - yMin, pageHeight)
        });
        textParts.push(value);
      }
      pages.push({ text: textParts.join(" "), words, lines: groupWordsIntoLines(words) });
    }
    return pages;
  } catch (error) {
    console.warn(`PDF text extraction failed for pages ${firstPage || 1}-${lastPage || "end"}: ${error.message}`);
    return [];
  }
}

async function extractPdfTextLayersChunked(pdfPath, pageCount, chunkSize = 20) {
  const layers = Array.from({ length: pageCount }, () => ({ text: "", words: [], lines: [] }));
  for (let firstPage = 1; firstPage <= pageCount; firstPage += chunkSize) {
    const lastPage = Math.min(pageCount, firstPage + chunkSize - 1);
    const chunk = await extractPdfTextLayers(pdfPath, firstPage, lastPage);
    for (let index = 0; index < chunk.length; index += 1) layers[firstPage - 1 + index] = chunk[index];
  }
  return layers;
}

async function pdfTextLayer(document, page) {
  const cachePath = textCachePath(document, page);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      fs.rmSync(cachePath, { force: true });
    }
  }
  const pdfPath = documentPdfPath(document);
  if (!pdfPath) return storedPageTextLayer(document, page);
  const layer = (await extractPdfTextLayers(pdfPath, page, page))[0] || { text: "", words: [], lines: [] };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(layer)}\n`);
  return layer;
}

function storedPageTextLayer(document, page) {
  const stored = document?.pages?.[page - 1] || {};
  return { text: String(stored.text || ""), words: [], lines: [] };
}

// Read what a selection says by looking at the rendered page rather than at the PDF's text layer.
// Used when the text layer exists but decodes to glyph indices, which no re-extraction can fix.
//
// Matching OCR word boxes against the selection rectangle was the obvious approach and it does not
// survive contact with Chinese: tesseract reports 示例 as one box wide enough to overlap 课 and 程,
// so the boxes cannot be trusted to say which characters the user actually covered. Rendering only
// the selected rectangle and reading that removes the question.
async function ocrRegionText(document, page, rects) {
  assertExecutable(TESSERACT, "tesseract");
  assertExecutable(PDFTOPPM, "pdftoppm");
  const pdfPath = documentPdfPath(document);
  if (!pdfPath) throw new Error("PDF source is unavailable.");
  const size = document.pages?.[page - 1] || {};
  const pageWidth = Number(size.width) || 0;
  const pageHeight = Number(size.height) || 0;
  if (!pageWidth || !pageHeight) throw new Error("Page dimensions are unavailable.");

  // One crop per rectangle: a text selection reports one rectangle per line, so this reads exactly
  // the part of each line the user covered instead of the whole block they span.
  //
  // 300 rather than something higher: tesseract is trained around this resolution and rendering the
  // same slide at 600 turned 示例课程 into 示例课桯.
  const REGION_DPI = 300;
  const MAX_REGIONS = 12;
  const snapped = await snapRectsToWords(document, page, rects);
  const regions = snapped.length > MAX_REGIONS ? [boundsFromRects(snapped)] : snapped;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-region-ocr-"));
  try {
    const pieces = [];
    let confidenceTotal = 0;
    let confidenceCount = 0;
    for (const [index, rect] of regions.entries()) {
      const result = await ocrOneRegion(pdfPath, page, rect, { pageWidth, pageHeight, dpi: REGION_DPI, workDir, index });
      if (result.text) pieces.push(result.text);
      if (Number.isFinite(result.confidence)) {
        confidenceTotal += result.confidence;
        confidenceCount += 1;
      }
    }
    return {
      text: tightenCjkSpacing(pieces.join("\n")),
      confidence: confidenceCount ? Math.round(confidenceTotal / confidenceCount) : 0,
      regions: regions.length
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Tesseract reports Chinese a word or a character at a time and the line assembler separates them
// with spaces, which is right for English and wrong for a script that does not write them.
function tightenCjkSpacing(text) {
  const wide = "[\\u2e80-\\u9fff\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uff60]";
  return String(text || "").replace(new RegExp(`(${wide}) +(?=${wide})`, "gu"), "$1");
}

// A font with no ToUnicode usually has unreliable metrics in the viewer as well: on the slide this
// was built for, the browser laid 示例课程 out 2.8 percentage points narrower than the page really
// is, and cropping to the browser's rectangle sliced the last character in half. The extracted text
// layer is the other way round — its characters are unreadable but its geometry comes straight from
// the page, so it is exactly what the crop should be squared up against.
async function snapRectsToWords(document, page, rects) {
  let layer = null;
  try {
    layer = await pdfTextLayer(document, page);
  } catch {
    return rects;
  }
  const words = Array.isArray(layer?.words) ? layer.words : [];
  if (!words.length) return rects;
  return rects.map((rect) => {
    const touching = words.filter((word) => {
      const overlapX = Math.min(rect.x + rect.w, word.x + word.w) - Math.max(rect.x, word.x);
      const overlapY = Math.min(rect.y + rect.h, word.y + word.h) - Math.max(rect.y, word.y);
      // Half the word's height inside the selection keeps the line above and below out of it, and a
      // third of the narrower box horizontally keeps a word the selection merely brushes out too.
      return overlapY >= word.h * 0.5 && overlapX >= Math.min(rect.w, word.w) * 0.34;
    });
    if (!touching.length) return rect;
    const union = boundsFromRects(touching);
    // Only ever grow, and never by more than half again: a runaway union would read the whole line
    // back when the selection was one word of it.
    const limit = rect.w * 1.5 + rect.h;
    const merged = {
      x: Math.min(rect.x, union.x),
      y: Math.min(rect.y, union.y),
      w: Math.max(rect.x + rect.w, union.x + union.w) - Math.min(rect.x, union.x),
      h: Math.max(rect.y + rect.h, union.y + union.h) - Math.min(rect.y, union.y)
    };
    return merged.w <= limit ? merged : rect;
  });
}

async function ocrOneRegion(pdfPath, page, rect, { pageWidth, pageHeight, dpi, workDir, index }) {
  const pixelsWide = (pageWidth / 72) * dpi;
  const pixelsHigh = (pageHeight / 72) * dpi;
  // Glyphs sit slightly outside the box the viewer draws around them, and a crop that clips an
  // ascender costs more in accuracy than a little extra context costs in precision.
  // Scaled from the line height rather than the selection width: a narrow selection needs the same
  // few pixels of margin as a wide one, and 示例课程 lost its last character to a width-scaled pad.
  const padX = Math.max(8, (Number(rect.h) / 100) * pixelsHigh * 0.3);
  // Kept tight: the rectangle has already been squared up against the text layer's own word boxes,
  // so it covers the glyphs, and reaching further down pulls in whatever rule or underline sits
  // below the line — which tesseract reads as punctuation and appends to the quote.
  const padY = Math.max(6, (Number(rect.h) / 100) * pixelsHigh * 0.1);
  const left = Math.max(0, Math.round((Number(rect.x) / 100) * pixelsWide - padX));
  const top = Math.max(0, Math.round((Number(rect.y) / 100) * pixelsHigh - padY));
  const width = Math.min(Math.round(pixelsWide) - left, Math.round((Number(rect.w) / 100) * pixelsWide + padX * 2));
  const height = Math.min(Math.round(pixelsHigh) - top, Math.round((Number(rect.h) / 100) * pixelsHigh + padY * 2));
  if (width < 4 || height < 4) return { text: "", confidence: NaN };

  const prefix = path.join(workDir, `region-${index}`);
  await execFileAsync(PDFTOPPM, [
    "-png",
    "-f", String(page),
    "-l", String(page),
    "-singlefile",
    "-r", String(dpi),
    "-x", String(left),
    "-y", String(top),
    "-W", String(width),
    "-H", String(height),
    pdfPath,
    prefix
  ], { stdio: "pipe", timeout: 60000 });
  const imagePath = `${prefix}.png`;
  if (!fs.existsSync(imagePath)) return { text: "", confidence: NaN };

  // Which segmentation mode wins depends on what was selected, and tesseract is honest enough about
  // its own confidence to choose between them: on a four-character slide title, reading the crop as
  // one block gave 木例课程 at 63% while reading it as a single word gave 示例课程 at 77%.
  const modes = ["6", "8", "13"];
  let best = { text: "", confidence: NaN };
  for (const psm of modes) {
    const attempt = await readCrop(imagePath, psm);
    if (!attempt.text) continue;
    const better = !(best.confidence >= 0)
      || attempt.confidence > best.confidence
      // Same confidence, more characters read: prefer the one that did not drop part of the line.
      || (attempt.confidence === best.confidence && attempt.text.length > best.text.length);
    if (better) best = attempt;
  }
  return best;
}

async function readCrop(imagePath, psm) {
  const { stdout } = await execFileAsync(TESSERACT, [imagePath, "stdout", "-l", REGION_OCR_LANGUAGES, "--psm", psm, "tsv"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60000
  });
  const words = [];
  let confidenceTotal = 0;
  for (const line of String(stdout || "").split(/\r?\n/).slice(1)) {
    const columns = line.split("\t");
    if (columns.length < 12 || Number(columns[0]) !== 5) continue;
    const text = columns.slice(11).join("\t").trim();
    const confidence = Number(columns[10]);
    if (!text || !(confidence >= 0)) continue;
    words.push(text);
    confidenceTotal += confidence;
  }
  return {
    text: words.join(" ").replace(/\s+/g, " ").trim(),
    confidence: words.length ? confidenceTotal / words.length : NaN
  };
}

async function ocrDocumentPage(document, page) {
  const cachePath = textCachePath(document, page);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (cached.ocr && Array.isArray(cached.words)) return cached;
      if (cached.words?.length) return cached;
    } catch {
      fs.rmSync(cachePath, { force: true });
    }
  }
  const layer = await runTesseract(document, page);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  atomicWriteFile(cachePath, `${JSON.stringify(layer)}\n`);
  return layer;
}

async function runTesseract(document, page) {
  assertExecutable(TESSERACT, "tesseract");
  const imagePath = document.type === "image" && page === 1 && document.sourcePath && fs.existsSync(document.sourcePath)
    ? document.sourcePath
    : await ensurePdfPagePreview(document, page, 220);
  const dimensions = imageDimensions(imagePath);
  if (!dimensions) throw new Error("OCR preview dimensions are unavailable.");
  const { stdout } = await execFileAsync(TESSERACT, [imagePath, "stdout", "-l", OCR_LANGUAGES, "--psm", "3", "tsv"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000
  });
  const words = [];
  for (const line of String(stdout || "").split(/\r?\n/).slice(1)) {
    const columns = line.split("\t");
    if (columns.length < 12 || Number(columns[0]) !== 5) continue;
    const text = columns.slice(11).join("\t").trim();
    const confidence = Number(columns[10]);
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    if (!text || confidence < 0 || width <= 0 || height <= 0) continue;
    words.push({
      text,
      confidence,
      x: percent(left, dimensions.width),
      y: percent(top, dimensions.height),
      w: percent(width, dimensions.width),
      h: percent(height, dimensions.height)
    });
  }
  return {
    text: words.map((word) => word.text).join(" "),
    words,
    lines: groupWordsIntoLines(words),
    ocr: true,
    ocrLanguages: OCR_LANGUAGES,
    createdAt: Date.now()
  };
}

async function ensurePdfPagePreview(document, page, dpi = Number(PDF_RENDER_DPI)) {
  assertExecutable(PDFTOPPM, "pdftoppm");
  const pdfPath = documentPdfPath(document);
  if (!pdfPath) throw new Error("PDF source is unavailable.");
  const previewDir = path.join(RENDER_DIR, document.id, "previews");
  const filePath = path.join(previewDir, `page-${page}-${dpi}.jpg`);
  if (fs.existsSync(filePath)) return path.resolve(filePath);
  fs.mkdirSync(previewDir, { recursive: true });
  const prefix = filePath.slice(0, -4);
  await execFileAsync(PDFTOPPM, [
    "-jpeg",
    "-f", String(page),
    "-l", String(page),
    "-singlefile",
    "-r", String(dpi),
    "-jpegopt", `quality=${PDF_JPEG_QUALITY}`,
    pdfPath,
    prefix
  ], { stdio: "pipe", timeout: 120000 });
  if (!fs.existsSync(filePath)) throw new Error("PDF preview renderer produced no image.");
  return path.resolve(filePath);
}

function groupWordsIntoLines(words) {
  const sorted = [...words].sort((a, b) => {
    const ay = a.y + a.h / 2;
    const by = b.y + b.h / 2;
    if (Math.abs(ay - by) > Math.max(0.8, Math.max(a.h, b.h) * 0.75)) return ay - by;
    return a.x - b.x;
  });
  const lines = [];
  for (const word of sorted) {
    const centerY = word.y + word.h / 2;
    const line = lines.find((item) => Math.abs(centerY - item.centerY) <= Math.max(0.8, Math.max(item.height, word.h) * 0.75));
    if (line) {
      line.words.push(word);
      line.centerY = (line.centerY * (line.words.length - 1) + centerY) / line.words.length;
      line.height = Math.max(line.height, word.h);
      line.x = Math.min(line.x, word.x);
      line.y = Math.min(line.y, word.y);
      line.w = Math.max(line.x + line.w, word.x + word.w) - line.x;
      line.h = Math.max(line.y + line.h, word.y + word.h) - line.y;
    } else {
      lines.push({ centerY, height: word.h, words: [word], x: word.x, y: word.y, w: word.w, h: word.h });
    }
  }
  return lines
    .sort((a, b) => a.centerY - b.centerY)
    .flatMap((line) => splitWordsAtColumnGaps(line.words).map((wordsInLine) => {
      const rect = boundsFromRects(wordsInLine);
      return {
        text: wordsInLine.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h
      };
    }))
    .filter((line) => line.text);
}

function splitWordsAtColumnGaps(words) {
  const sorted = [...words].sort((a, b) => a.x - b.x);
  const segments = [];
  for (const word of sorted) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    const gap = previous ? word.x - (previous.x + previous.w) : 0;
    const threshold = previous ? Math.max(2.5, Math.max(previous.h, word.h) * 2.2) : Infinity;
    if (!segment || gap > threshold) segments.push([word]);
    else segment.push(word);
  }
  return segments;
}

function buildDocumentOutline(pages) {
  const outline = [];
  for (const [pageIndex, page] of pages.entries()) {
    for (const line of page.lines || []) {
      const item = outlineItemFromLine(line, pageIndex + 1);
      if (item) outline.push({ id: `o-${pageIndex + 1}-${outline.length + 1}`, ...item });
    }
  }
  return outline.slice(0, 300);
}

async function nativePdfOutline(pdfPath, pages) {
  if (!PYTHON_OUTLINE_READY) return null;
  try {
    const scriptPath = unpackedPath(path.join(path.dirname(fileURLToPath(import.meta.url)), "pdf-outline.py"));
    const { stdout: output } = await execFileAsync(PYTHON, [scriptPath, pdfPath], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024
    });
    const rows = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const normalized = rows
      .map((row, index) => {
        const page = Math.max(1, Math.min(pages.length || 1, Number(row.page || 1)));
        const rect = outlineRectForPageTitle(pages[page - 1], row.title);
        return {
          id: `o-native-${index + 1}`,
          type: row.type || "section",
          level: Math.max(1, Math.min(4, Number(row.level || 1))),
          title: String(row.title || "").trim(),
          page,
          rect
        };
      })
      .filter((row) => row.title);
    return normalized.length ? normalized.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function outlineRectForPageTitle(page, title) {
  const cleanTitle = normalizeOutlineTitle(title).toLowerCase();
  const exact = (page?.lines || []).find((line) => normalizeOutlineTitle(line.text).toLowerCase() === cleanTitle);
  if (exact) return { x: exact.x, y: exact.y, w: exact.w, h: exact.h };
  const prefix = (page?.lines || []).find((line) => {
    const text = normalizeOutlineTitle(line.text).toLowerCase();
    return text.startsWith(cleanTitle.slice(0, Math.min(cleanTitle.length, 40)));
  });
  if (prefix) return { x: prefix.x, y: prefix.y, w: prefix.w, h: prefix.h };
  return { x: 8, y: 8, w: 84, h: 4 };
}

function unpackedPath(filePath) {
  const unpacked = filePath.replace(".asar", ".asar.unpacked");
  return fs.existsSync(unpacked) ? unpacked : filePath;
}

function outlineItemFromLine(line, pageNumber) {
  const title = normalizeOutlineTitle(line.text);
  if (!title || title.length > 140) return null;

  const figureMatch = title.match(/^(fig(?:ure)?\.?|图)\s*[\d一二三四五六七八九十]+[\s:：.-]+(.+)/i);
  if (figureMatch) return outlineEntry("figure", 3, title, pageNumber, line);

  const tableMatch = title.match(/^(table|表)\s*[\d一二三四五六七八九十]+[\s:：.-]+(.+)/i);
  if (tableMatch) return outlineEntry("table", 3, title, pageNumber, line);

  const numbered = title.match(/^(\d+(?:\.\d+){0,3})\.?\s+(.+)/);
  if (numbered && numbered[2].length >= 3) {
    const hasSubsection = numbered[1].includes(".");
    const topNumber = Number(numbered[1].split(".")[0]);
    if (!hasSubsection && topNumber > 50) return null;
    const headingText = numbered[2].trim();
    if (!hasSubsection && !/^[A-Z][A-Za-z0-9,;:()'’\- ]+$/.test(headingText)) return null;
    if (headingText.length > 90) return null;
    return outlineEntry("section", Math.min(4, numbered[1].split(".").length), title, pageNumber, line);
  }

  if (/^(abstract|introduction|conclusion|conclusions|discussion|methodology|methods?|results?|references|appendix|keywords|摘要|引言|结论|参考文献|附录|关键词)$/i.test(title)) {
    return outlineEntry("section", 1, title, pageNumber, line);
  }

  return null;
}

function outlineEntry(type, level, title, pageNumber, line) {
  return {
    type,
    level,
    title,
    page: pageNumber,
    rect: { x: line.x, y: line.y, w: line.w, h: line.h }
  };
}

function normalizeOutlineTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/-\s+/g, "")
    .trim();
}

function boundsFromRects(rects) {
  const x1 = Math.min(...rects.map((rect) => rect.x));
  const y1 = Math.min(...rects.map((rect) => rect.y));
  const x2 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y2 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {
    x: Number(x1.toFixed(3)),
    y: Number(y1.toFixed(3)),
    w: Number((x2 - x1).toFixed(3)),
    h: Number((y2 - y1).toFixed(3))
  };
}

function findQuoteRects(layer, quote, anchor = {}) {
  return findQuoteMatch(layer, quote, anchor)?.rects || [];
}

async function buildTextReanchorPlacements(documentId, nextDocument) {
  const prefix = `${documentId}:`;
  const annotationEntries = Object.entries(store.getWorkspace().annotations)
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([key, annotations]) => {
      const page = Number(key.slice(prefix.length));
      return annotations
        .filter((annotation) => annotation.type === "text" && String(annotation.quote || "").trim())
        .map((annotation) => ({ annotation, page }));
    });
  if (!annotationEntries.length) return [];

  const pageCount = Number(nextDocument.pageCount || nextDocument.pages?.length || 1);
  const layerCache = new Map();
  const getLayer = async (page) => {
    if (!layerCache.has(page)) layerCache.set(page, await pdfTextLayer(nextDocument, page));
    return layerCache.get(page);
  };
  const placements = [];
  for (const { annotation, page: previousPage } of annotationEntries) {
    let placement = null;
    for (const page of reanchorPageOrder(previousPage, pageCount)) {
      const match = findQuoteMatch(await getLayer(page), annotation.quote, annotation.anchor);
      if (!match?.rects?.length) continue;
      placement = {
        annotationId: annotation.id,
        page,
        patch: {
          anchor: {
            exact: String(annotation.anchor?.exact || annotation.quote || "").slice(0, 100000),
            // Take the refreshed wording when the match reports it; the previous version's
            // surrounding text would otherwise be exported as 原文 for a document that no
            // longer reads that way.
            prefix: String(match.prefix ?? annotation.anchor?.prefix ?? "").slice(-240),
            suffix: String(match.suffix ?? annotation.anchor?.suffix ?? "").slice(0, 240)
          },
          anchorStatus: "matched",
          anchoredRevision: nextDocument.contentHash || "",
          rects: match.rects,
          ...boundsFromRects(match.rects)
        }
      };
      break;
    }
    placements.push(placement || {
      annotationId: annotation.id,
      page: previousPage,
      patch: {
        anchorStatus: "unmatched",
        anchoredRevision: nextDocument.contentHash || ""
      }
    });
  }
  return placements;
}

function reanchorPageOrder(previousPage, pageCount) {
  const ordered = [];
  const add = (page) => {
    if (page >= 1 && page <= pageCount && !ordered.includes(page)) ordered.push(page);
  };
  add(previousPage);
  for (let distance = 1; distance <= 3; distance += 1) {
    add(previousPage - distance);
    add(previousPage + distance);
  }
  for (let page = 1; page <= pageCount; page += 1) add(page);
  return ordered;
}

function findQuoteMatch(layer, quote, anchor = {}) {
  const words = Array.isArray(layer?.words) ? layer.words : [];
  const quoteTokens = String(quote || "").split(/\s+/).map(normalizeQuoteToken).filter(Boolean);
  if (!quoteTokens.length || !words.length) return [];
  const entries = words
    .map((word, index) => ({ word, index, token: normalizeQuoteToken(word.text), original: String(word.text || "") }))
    .filter((entry) => entry.token);
  const prefixTokens = String(anchor?.prefix || "").split(/\s+/).map(normalizeQuoteToken).filter(Boolean);
  const suffixTokens = String(anchor?.suffix || "").split(/\s+/).map(normalizeQuoteToken).filter(Boolean);
  const matches = [];
  for (let start = 0; start < entries.length; start += 1) {
    const end = matchQuoteTokens(entries, start, quoteTokens);
    if (end < 0) continue;
    const score = contextMatchScore(entries, start, end, prefixTokens, suffixTokens);
    const selectedWords = words.slice(entries[start].index, entries[end - 1].index + 1);
    matches.push({
      score,
      start,
      end,
      rects: groupWordsIntoLines(selectedWords).map(({ x, y, w, h }) => ({ x, y, w, h }))
    });
  }
  const best = matches.sort((a, b) => b.score - a.score || a.start - b.start)[0];
  if (!best) return null;
  // The words that now surround the quote. Re-anchoring keeps an annotation pointing at the right
  // sentence, but the text on either side of it may well have been edited too — and that text is
  // what gets exported as 原文. Report the current wording so callers can replace the stale copy.
  return {
    ...best,
    prefix: contextTextBefore(entries, best.start),
    suffix: contextTextAfter(entries, best.end)
  };
}

const ANCHOR_CONTEXT_CHARS = 240;

function contextTextBefore(entries, start) {
  const parts = [];
  let length = 0;
  for (let index = start - 1; index >= 0 && length < ANCHOR_CONTEXT_CHARS; index -= 1) {
    parts.unshift(entries[index].original);
    length += entries[index].original.length + 1;
  }
  return parts.join(" ").slice(-ANCHOR_CONTEXT_CHARS);
}

function contextTextAfter(entries, end) {
  const parts = [];
  let length = 0;
  for (let index = end; index < entries.length && length < ANCHOR_CONTEXT_CHARS; index += 1) {
    parts.push(entries[index].original);
    length += entries[index].original.length + 1;
  }
  return parts.join(" ").slice(0, ANCHOR_CONTEXT_CHARS);
}

function matchQuoteTokens(entries, start, quoteTokens) {
  let entryIndex = start;
  for (const quoteToken of quoteTokens) {
    const entry = entries[entryIndex];
    if (!entry) return -1;
    if (entry.token === quoteToken) {
      entryIndex += 1;
      continue;
    }
    const next = entries[entryIndex + 1];
    if (next && /[-\u00ad]\s*$/u.test(entry.original) && `${entry.token}${next.token}` === quoteToken) {
      entryIndex += 2;
      continue;
    }
    return -1;
  }
  return entryIndex;
}

function contextMatchScore(entries, start, end, prefixTokens, suffixTokens) {
  let score = 0;
  const prefixLimit = Math.min(16, start, prefixTokens.length);
  for (let offset = 1; offset <= prefixLimit; offset += 1) {
    if (entries[start - offset].token !== prefixTokens[prefixTokens.length - offset]) break;
    score += 2;
  }
  const suffixLimit = Math.min(16, entries.length - end, suffixTokens.length);
  for (let offset = 0; offset < suffixLimit; offset += 1) {
    if (entries[end + offset].token !== suffixTokens[offset]) break;
    score += 2;
  }
  if (prefixLimit && score >= prefixLimit * 2) score += 1;
  if (suffixLimit && score >= (prefixLimit + suffixLimit) * 2) score += 1;
  return score;
}

function normalizeQuoteToken(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, "").trim();
}

function documentAnnotationPages(documentId) {
  const prefix = `${documentId}:`;
  return Object.fromEntries(Object.entries(store.getWorkspace().annotations).filter(([key]) => key.startsWith(prefix)));
}

function documentAnnotationRevisions(documentId) {
  const prefix = `${documentId}:`;
  return Object.fromEntries(Object.entries(store.getWorkspace().annotationRevisions).filter(([key]) => key.startsWith(prefix)));
}

function documentHistoryPages(documentId) {
  const prefix = `${documentId}:`;
  return Object.fromEntries(Object.entries(store.getWorkspace().history).filter(([key]) => key.startsWith(prefix)));
}

function documentReviewThreads(documentId) {
  return Object.fromEntries(Object.entries(store.getWorkspace().reviewThreads).filter(([, thread]) => thread.documentId === documentId));
}

function imagePageMeta(filePath) {
  const dimensions = imageDimensions(filePath);
  if (!dimensions) return {};
  const aspectRatio = dimensions.width / dimensions.height;
  return {
    width: dimensions.width,
    height: dimensions.height,
    aspectRatio: Number(aspectRatio.toFixed(5)),
    orientation: aspectRatio > 1 ? "landscape" : "portrait"
  };
}

function imageDimensions(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegDimensions(buffer);
  if (buffer.toString("ascii", 1, 4) === "PNG") return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.toString("ascii", 0, 3) === "GIF") return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  return null;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

async function buildStandaloneReviewHtml(payload) {
  const pages = await expandHtmlPages(payload);
  const annotationCount = pages.reduce((sum, page) => sum + page.annotations.length, 0);
  const title = `${payload.document?.name || "文档"} 批注`;
  const exportText = buildExportText(payload, pages);
  const pageHtml = (await mapWithConcurrency(pages, 3, async (page) => {
    const image = page.previewUrl ? await dataUriForPreviewUrl(page.previewUrl) : "";
    const annotations = page.annotations || [];
    const overlays = annotations.map(annotationOverlayHtml).join("");
    const rows = annotations.length
      ? annotations.map(annotationRowHtml).join("")
      : `<div class="empty">本页暂无批注</div>`;
    const content = image
      ? `<div class="imgwrap"><img src="${image}" alt="${escapeHtml(page.title || `第 ${page.index} 页`)}">${overlays}</div>`
      : `<div class="textpage"><pre>${escapeHtml(page.textExcerpt || "该页没有可嵌入的预览内容。")}</pre></div>`;
    return `<section class="slide ${annotations.length ? "has-note" : ""}">
      <header class="shead"><strong>第 ${page.index} 页</strong><span>${escapeHtml(page.title || "")}</span><em>${annotations.length ? `${annotations.length} 条批注` : "未批注"}</em></header>
      <div class="body">${content}<aside class="side">${rows}</aside></div>
    </section>`;
  })).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--accent:#5b4ce2;--ink:#20242b;--muted:#6f7682;--line:#dfe3ea;--bg:#eef0f3;--gold:#c98116;--green:#1c8a51}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;color:var(--ink);background:var(--bg)}
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;background:#fff;border-bottom:1px solid var(--line)}
.top h1{margin:0;font-size:16px}.top small{color:var(--muted)}.top .spacer{flex:1}.top button{border:0;border-radius:8px;padding:8px 12px;color:#fff;background:var(--accent);font-weight:700;cursor:pointer}
.wrap{max-width:1160px;margin:0 auto;padding:18px 18px 80px}.slide{margin:0 0 18px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff;box-shadow:0 8px 28px rgba(20,24,50,.08)}
.slide.has-note{border-color:rgba(201,129,22,.5)}.shead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}.shead strong{color:var(--accent)}.shead span{flex:1;color:#424852}.shead em{font-style:normal;color:var(--gold);font-size:12px;font-weight:800}
.body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;align-items:start}.imgwrap{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#fff}.imgwrap img{display:block;width:100%}
.textpage{min-height:320px;border:1px solid var(--line);border-radius:8px;background:#fff}.textpage pre{margin:0;padding:18px;white-space:pre-wrap;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.pin{position:absolute;transform:translate(-50%,-50%);min-width:24px;height:24px;padding:0 6px;border-radius:999px;border:2px solid #fff;background:var(--gold);color:#241b05;font-size:12px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.22)}
.region{position:absolute;border:3px solid var(--green);background:rgba(28,138,81,.14);border-radius:6px}.region span{position:absolute;left:6px;top:5px;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:999px;color:#fff;background:var(--green);font-size:12px;font-weight:900}.textmark{position:absolute;border-radius:3px;background:rgba(91,76,226,.25);box-shadow:0 0 0 1px rgba(91,76,226,.28)}
.side{display:grid;gap:8px}.row{border:1px solid #eadbbf;border-radius:8px;padding:9px 10px;background:#fff8ec}.row strong{display:flex;align-items:center;gap:8px;font-size:13px}.row blockquote{margin:7px 0 0;padding:6px 8px;border-left:3px solid var(--accent);color:#414650;background:#fff;font-size:12px;line-height:1.45}.row p{margin:6px 0 0;color:#303640;font-size:13px;line-height:1.5}.reply{margin-top:8px;padding-top:8px;border-top:1px solid #eadbbf}.reply b{font-size:12px;color:var(--accent)}.reply p{margin-top:3px}.reply .change{display:block;margin-top:4px;color:var(--green);font-size:11px}.tag{display:inline-flex;border-radius:999px;padding:2px 7px;color:#5c3b05;background:#f2dfb9;font-size:11px}.empty{padding:14px;color:var(--muted);border:1px dashed var(--line);border-radius:8px;background:#fafbfc}
#exportText{position:fixed;left:-9999px;top:0;width:1px;height:1px}
@media(max-width:880px){.body{grid-template-columns:1fr}.side{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="top"><h1>${escapeHtml(title)}</h1><small>${pages.length} 页 · ${annotationCount} 条批注 · ${escapeHtml(payload.exportedAt || "")}</small><span class="spacer"></span><button id="copyBtn">复制修改清单</button></div>
<main class="wrap">${pageHtml}</main>
<textarea id="exportText" readonly>${escapeHtml(exportText)}</textarea>
<script>
document.getElementById("copyBtn").addEventListener("click", async () => {
  const text = document.getElementById("exportText").value;
  try { await navigator.clipboard.writeText(text); }
  catch { const box = document.getElementById("exportText"); box.select(); document.execCommand("copy"); }
  const button = document.getElementById("copyBtn");
  button.textContent = "已复制";
  setTimeout(() => button.textContent = "复制修改清单", 1400);
});
</script>
</body>
</html>`;
}

async function expandHtmlPages(payload) {
  const annotationPages = new Map((payload.pages || []).map((page) => [Number(page.index), page]));
  const document = payload.document?.id ? store.getDocument(payload.document.id) : null;
  if (!document) return payload.pages || [];

  if (payload.scope !== "doc") {
    return mapWithConcurrency(payload.pages || [], 3, (page) => enrichExportPage(document, Number(page.index), page));
  }

  return mapWithConcurrency(Array.from({ length: document.pageCount || 0 }, (_, index) => index + 1), 3, (pageNumber) => {
    const annotated = annotationPages.get(pageNumber);
    return enrichExportPage(document, pageNumber, {
      index: pageNumber,
      title: annotated?.title,
      previewUrl: annotated?.previewUrl,
      textExcerpt: annotated?.textExcerpt,
      annotations: annotated?.annotations || []
    });
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), list.length) }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichExportPage(document, pageNumber, page) {
  const pageData = document.pages?.[pageNumber - 1] || {};
  const canPreviewPdf = Boolean(documentPdfPath(document));
  const cachedText = canPreviewPdf ? (await pdfTextLayer(document, pageNumber)).text : "";
  return {
    ...page,
    index: pageNumber,
    title: displayPageTitle(document, pageNumber, page.title || document.titles?.[pageNumber - 1] || pageData.title),
    previewUrl: pageData.imageUrl || pageData.sourceUrl || pageData.previewUrl || page.previewUrl || (canPreviewPdf ? `/api/documents/${document.id}/pages/${pageNumber}/preview` : ""),
    textExcerpt: pageData.text || page.textExcerpt || cachedText || ""
  };
}

function displayPageTitle(document, pageNumber, rawTitle) {
  const title = String(rawTitle || "").trim();
  if (document?.type === "pdf") {
    if (pageNumber === 1 && title && !isBadPdfPageTitle(title)) return title;
    return `第 ${pageNumber} 页`;
  }
  return title || `第 ${pageNumber} 页`;
}

function isBadPdfPageTitle(title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (/^\d+$/.test(clean)) return true;
  if (clean.length < 4) return true;
  if (clean.endsWith("-")) return true;
  if (/^[a-z]/.test(clean)) return true;
  return false;
}

function annotationOverlayHtml(annotation, index) {
  const label = escapeHtml(annotation.displayLabel || String(index + 1));
  if (annotation.type === "pin" && annotation.position) {
    return `<span class="pin" style="left:${numberCss(annotation.position.x)}%;top:${numberCss(annotation.position.y)}%">${label}</span>`;
  }
  if (annotation.type === "region" && annotation.rect) {
    const rect = annotation.rect;
    return `<span class="region" style="left:${numberCss(rect.x)}%;top:${numberCss(rect.y)}%;width:${numberCss(rect.w)}%;height:${numberCss(rect.h)}%"><span>${label}</span></span>`;
  }
  if (annotation.type === "text" && annotation.rects?.length) {
    return annotation.rects.map((rect) =>
      `<span class="textmark" style="left:${numberCss(rect.x)}%;top:${numberCss(rect.y)}%;width:${numberCss(rect.w)}%;height:${numberCss(rect.h)}%"></span>`
    ).join("");
  }
  return "";
}

function annotationRowHtml(annotation, index) {
  const label = annotation.locationLabel || (annotation.type === "note" ? "整页" : "");
  const tag = annotation.tag ? `<span class="tag">${escapeHtml(annotation.tag)}</span>` : "";
  const quote = annotation.quote ? `<blockquote>${escapeHtml(annotation.quote)}</blockquote>` : "";
  const messages = (annotation.review?.messages || annotation.reviewMessages || []).map((message) => {
    const evidence = message.change?.summary ? `<small class="change">修改记录：${escapeHtml(message.change.summary)}</small>` : "";
    return `<div class="reply"><b>${escapeHtml(message.author || (message.role === "assistant" ? "AI" : "用户"))}</b><p>${escapeHtml(message.body || "")}</p>${evidence}</div>`;
  }).join("");
  return `<div class="row"><strong>${escapeHtml(annotation.type)} ${escapeHtml(annotation.displayLabel || String(index + 1))} ${tag}<span>${escapeHtml(label)}</span></strong>${quote}<p>${escapeHtml(annotation.text || "请根据该处批注修改对应内容。")}</p>${messages}</div>`;
}

function buildExportText(payload, pages) {
  const lines = [
    `${payload.document?.name || "文档"} 批注清单`,
    `项目：${payload.project?.name || ""}`,
    `原始文件：${payload.document?.sourcePath || payload.document?.name || ""}`,
    ""
  ];
  for (const page of pages) {
    if (!page.annotations?.length) continue;
    lines.push(`第 ${page.index} 页：${page.title || ""}`);
    for (const annotation of page.annotations) {
      const location = annotation.locationLabel ? `（${annotation.locationLabel}）` : "";
      const quote = annotation.quote ? `「${annotation.quote}」 ` : "";
      lines.push(`- ${annotation.type}${location}: ${quote}${annotation.text || "请根据该处批注修改对应内容。"}`);
      for (const message of annotation.review?.messages || annotation.reviewMessages || []) {
        lines.push(`  - ${message.author || (message.role === "assistant" ? "AI" : "用户")}：${message.body || ""}`);
        if (message.change?.summary) lines.push(`    修改记录：${message.change.summary}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function dataUriForPreviewUrl(previewUrl) {
  const normalized = decodeURIComponent(String(previewUrl || "").split("?")[0]);
  const pdfPreview = normalized.match(/^\/api\/documents\/([^/]+)\/pages\/(\d+)\/preview$/);
  let filePath = filePathForPreviewUrl(previewUrl);
  if (pdfPreview) {
    const document = store.getDocument(pdfPreview[1]);
    const page = Number(pdfPreview[2]);
    if (document && page >= 1 && page <= Number(document.pageCount || 1)) filePath = await ensurePdfPagePreview(document, page, Number(PDF_RENDER_DPI));
  }
  if (!filePath || !fs.existsSync(filePath)) return "";
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function filePathForPreviewUrl(previewUrl) {
  const normalized = decodeURIComponent(String(previewUrl || "").split("?")[0]);
  if (normalized.startsWith("/api/renders/")) return safeStaticPath(RENDER_DIR, normalized.slice("/api/renders/".length));
  if (normalized.startsWith("/api/uploads/")) return safeStaticPath(UPLOAD_DIR, normalized.slice("/api/uploads/".length));
  return "";
}

function commitStagedRefresh(previousDocument, stagedDocument, { warnAboutAnnotations = false, reanchorPlacements = [] } = {}) {
  const backupRoot = path.join(DATA_DIR, ".refresh-backups", `${previousDocument.id}-${crypto.randomBytes(4).toString("hex")}`);
  const stagedRenderDir = path.join(RENDER_DIR, stagedDocument.id);
  const finalRenderDir = path.join(RENDER_DIR, previousDocument.id);
  const finalSourcePath = path.join(UPLOAD_DIR, `${previousDocument.id}.${stagedDocument.ext.toLowerCase()}`);
  const backups = [];
  const newPaths = [];
  let storeCommitted = false;
  const previousWorkspaceState = store.getState();
  const journalPath = path.join(TRANSACTION_DIR, `refresh-${previousDocument.id}-${Date.now().toString(36)}.json`);

  try {
    const existingPaths = new Set([
      isDataPath(previousDocument.sourcePath) ? previousDocument.sourcePath : "",
      fs.existsSync(finalSourcePath) ? finalSourcePath : "",
      fs.existsSync(finalRenderDir) ? finalRenderDir : ""
    ].filter(Boolean));

    for (const existingPath of existingPaths) {
      const relative = path.relative(DATA_DIR, path.resolve(existingPath));
      const backupPath = path.join(backupRoot, relative);
      backups.push({ originalPath: existingPath, backupPath });
    }
    fs.mkdirSync(backupRoot, { recursive: true });
    const workspaceSnapshotPath = path.join(backupRoot, "workspace-before.json");
    atomicWriteFile(workspaceSnapshotPath, `${JSON.stringify(previousWorkspaceState, null, 2)}\n`);
    writeRefreshJournal(journalPath, {
      phase: "prepared",
      documentId: previousDocument.id,
      stagedDocumentId: stagedDocument.id,
      backupRoot,
      workspaceSnapshotPath,
      backups,
      finalPaths: [finalSourcePath, finalRenderDir],
      createdAt: Date.now()
    });

    for (const { originalPath: existingPath, backupPath } of backups) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.renameSync(existingPath, backupPath);
    }

    fs.mkdirSync(path.dirname(finalSourcePath), { recursive: true });
    fs.renameSync(stagedDocument.sourcePath, finalSourcePath);
    newPaths.push(finalSourcePath);

    if (fs.existsSync(stagedRenderDir)) {
      fs.mkdirSync(path.dirname(finalRenderDir), { recursive: true });
      fs.renameSync(stagedRenderDir, finalRenderDir);
      newPaths.push(finalRenderDir);
    }

    const stagedUploadUrl = `/api/uploads/${path.basename(stagedDocument.sourcePath)}`;
    const finalUploadUrl = `/api/uploads/${path.basename(finalSourcePath)}`;
    const contentChanged = documentContentChanged(previousDocument, stagedDocument);
    const versions = (contentChanged
      ? snapshotPreviousDocumentVersion(previousDocument, backups, newPaths)
      : (previousDocument.versions || []))
      .filter((version) => !stagedDocument.contentHash || version.contentHash !== stagedDocument.contentHash)
      .slice(0, MAX_DOCUMENT_VERSIONS);
    const refreshed = {
      ...stagedDocument,
      id: previousDocument.id,
      projectId: previousDocument.projectId,
      name: previousDocument.name || stagedDocument.name,
      sourceFileName: stagedDocument.sourceFileName || stagedDocument.name,
      annotationsNeedReview: contentChanged
        ? Boolean(warnAboutAnnotations)
        : Boolean(previousDocument.annotationsNeedReview),
      sourcePath: finalSourcePath,
      versions,
      convertedPdfPath: stagedDocument.convertedPdfPath
        ? stagedDocument.convertedPdfPath.replace(stagedRenderDir, finalRenderDir)
        : "",
      pages: (stagedDocument.pages || []).map((page) => ({
        ...page,
        imageUrl: page.imageUrl?.replace(`/api/renders/${stagedDocument.id}/`, `/api/renders/${previousDocument.id}/`),
        sourceUrl: page.sourceUrl === stagedUploadUrl ? finalUploadUrl : page.sourceUrl,
        textUrl: page.textUrl?.replace(`/api/documents/${stagedDocument.id}/`, `/api/documents/${previousDocument.id}/`),
        previewUrl: page.previewUrl?.replace(`/api/documents/${stagedDocument.id}/`, `/api/documents/${previousDocument.id}/`)
      }))
    };

    saveDocument(refreshed);
    storeCommitted = true;
    const reanchorResult = reanchorPlacements.length
      ? store.reanchorDocumentAnnotations(refreshed.id, reanchorPlacements)
      : null;
    const orphanedPages = store.archiveOutOfRangePages(
      refreshed.id,
      Number(refreshed.pageCount || refreshed.pages?.length || 1),
      Number(previousDocument.pageCount || previousDocument.pages?.length || 1)
    );
    writeRefreshJournal(journalPath, {
      phase: "committed",
      documentId: previousDocument.id,
      stagedDocumentId: stagedDocument.id,
      backupRoot,
      workspaceSnapshotPath,
      backups,
      finalPaths: [finalSourcePath, finalRenderDir],
      createdAt: Date.now()
    });
    cleanupAssetsForId(stagedDocument.id);
    fs.rmSync(backupRoot, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
    pruneDocumentVersions(previousDocument.id, versions);
    return { document: refreshed, orphanedPages, reanchorResult };
  } catch (error) {
    if (storeCommitted) store.replaceWorkspace(previousWorkspaceState);
    for (const newPath of [...newPaths].reverse()) fs.rmSync(newPath, { recursive: true, force: true });
    for (const backup of [...backups].reverse()) {
      if (!fs.existsSync(backup.backupPath)) continue;
      fs.mkdirSync(path.dirname(backup.originalPath), { recursive: true });
      fs.renameSync(backup.backupPath, backup.originalPath);
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
    cleanupAssetsForId(stagedDocument.id);
    throw error;
  }
}

function writeRefreshJournal(journalPath, journal) {
  atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

function recoverInterruptedRefreshTransactions() {
  if (!fs.existsSync(TRANSACTION_DIR)) return;
  for (const name of fs.readdirSync(TRANSACTION_DIR).filter((entry) => entry.startsWith("refresh-") && entry.endsWith(".json"))) {
    const journalPath = path.join(TRANSACTION_DIR, name);
    let journal;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    } catch {
      fs.rmSync(journalPath, { force: true });
      continue;
    }
    const backupRoot = transactionDataPath(journal.backupRoot);
    if (!backupRoot) {
      fs.rmSync(journalPath, { force: true });
      continue;
    }
    if (journal.phase === "committed") {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
      continue;
    }
    const backups = (Array.isArray(journal.backups) ? journal.backups : [])
      .map((entry) => ({ originalPath: transactionDataPath(entry.originalPath), backupPath: transactionDataPath(entry.backupPath) }))
      .filter((entry) => entry.originalPath && entry.backupPath);
    const backedUpPaths = new Set(backups.map((entry) => path.resolve(entry.originalPath || "")));
    for (const rawFinalPath of journal.finalPaths || []) {
      const finalPath = transactionDataPath(rawFinalPath);
      if (finalPath && !backedUpPaths.has(finalPath)) fs.rmSync(finalPath, { recursive: true, force: true });
    }
    for (const backup of [...backups].reverse()) {
      if (!backup.backupPath || !fs.existsSync(backup.backupPath)) continue;
      fs.rmSync(backup.originalPath, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(backup.originalPath), { recursive: true });
      fs.renameSync(backup.backupPath, backup.originalPath);
    }
    const workspaceSnapshotPath = transactionDataPath(journal.workspaceSnapshotPath);
    if (workspaceSnapshotPath && fs.existsSync(workspaceSnapshotPath)) {
      atomicWriteFile(path.join(DATA_DIR, "workspace.json"), fs.readFileSync(workspaceSnapshotPath));
    }
    if (journal.stagedDocumentId) cleanupAssetsForId(journal.stagedDocumentId);
    fs.rmSync(backupRoot, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
  }
}

function transactionDataPath(value) {
  const resolved = value ? path.resolve(String(value)) : "";
  return resolved && isDataPath(resolved) ? resolved : "";
}

function snapshotPreviousDocumentVersion(document, backups, newPaths) {
  const currentVersions = (document.versions || []).filter((version) => {
    const sourcePath = safeStaticPath(DATA_DIR, version.relativePath || "");
    return sourcePath && fs.existsSync(sourcePath);
  });
  const existing = currentVersions.find((version) =>
    document.contentHash && version.contentHash === document.contentHash
  );
  if (existing) return [existing, ...currentVersions.filter((version) => version.id !== existing.id)].slice(0, MAX_DOCUMENT_VERSIONS);

  const sourceBackup = backups.find((backup) =>
    document.sourcePath && path.resolve(backup.originalPath) === path.resolve(document.sourcePath)
  );
  if (!sourceBackup?.backupPath || !fs.existsSync(sourceBackup.backupPath)) return currentVersions.slice(0, MAX_DOCUMENT_VERSIONS);

  const capturedAt = Date.now();
  const versionId = `v-${capturedAt.toString(36)}-${String(document.contentHash || crypto.randomBytes(4).toString("hex")).slice(0, 10)}`;
  const versionDir = path.join(DATA_DIR, "versions", document.id, versionId);
  const extension = String(document.ext || path.extname(document.sourceFileName || "") || "bin").replace(/^\./, "").toLowerCase();
  const versionSourcePath = path.join(versionDir, `source.${extension || "bin"}`);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.copyFileSync(sourceBackup.backupPath, versionSourcePath);
  newPaths.push(versionDir);
  const snapshot = {
    id: versionId,
    contentHash: document.contentHash || "",
    capturedAt,
    sourceModifiedAt: Number(document.sourceModifiedAt || 0),
    pageCount: Number(document.pageCount || 1),
    sourceFileName: document.sourceFileName || document.name,
    ext: extension,
    size: fs.statSync(versionSourcePath).size,
    relativePath: path.relative(DATA_DIR, versionSourcePath)
  };
  return [snapshot, ...currentVersions].slice(0, MAX_DOCUMENT_VERSIONS);
}

function pruneDocumentVersions(documentId, versions) {
  const root = path.join(DATA_DIR, "versions", documentId);
  if (!fs.existsSync(root)) return;
  const retained = new Set((versions || []).map((version) => {
    const resolved = safeStaticPath(DATA_DIR, version.relativePath || "");
    return resolved ? path.dirname(resolved) : "";
  }).filter(Boolean));
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    if (!retained.has(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function cleanupAssetsForId(id) {
  fs.rmSync(path.join(RENDER_DIR, id), { recursive: true, force: true });
  if (!fs.existsSync(UPLOAD_DIR)) return;
  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    if (file === id || file.startsWith(`${id}.`)) {
      fs.rmSync(path.join(UPLOAD_DIR, file), { recursive: true, force: true });
    }
  }
}

function safeStaticPath(rootDir, relativePath) {
  const resolved = path.resolve(rootDir, relativePath);
  const root = path.resolve(rootDir);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
  return "";
}

// Only .incoming-documents was ever cleaned at startup. Everything else — interrupted uploads and
// restores, export scratch, and per-document directories left behind by a crash — accumulated with
// no way for the user to see or reclaim it.
function dataDirectoryHoldsAssets() {
  return [UPLOAD_DIR, RENDER_DIR, path.join(DATA_DIR, "versions"), path.join(DATA_DIR, "review-tasks")]
    .some((directory) => safeReadDir(directory).length > 0);
}

function sweepOrphanedAssets() {
  if (!store) return;
  let reclaimed = 0;
  const removeQuietly = (target) => {
    try {
      const before = fs.existsSync(target) ? 1 : 0;
      fs.rmSync(target, { recursive: true, force: true });
      reclaimed += before;
    } catch {
      // A file we cannot remove must never stop the server from starting.
    }
  };

  for (const scratch of [BACKUP_UPLOAD_DIR, path.join(DATA_DIR, ".export-tmp")]) {
    if (!fs.existsSync(scratch)) continue;
    for (const name of safeReadDir(scratch)) removeQuietly(path.join(scratch, name));
  }

  // Staging and rollback directories are only meaningful while their journal exists; the restore
  // recovery above has already replayed or discarded anything that mattered.
  for (const name of safeReadDir(DATA_DIR)) {
    if (!/^\.(restore-staging|restore-rollback)-/.test(name)) continue;
    removeQuietly(path.join(DATA_DIR, name));
  }

  // recoverInterruptedRefreshTransactions has already replayed anything with a surviving journal, so
  // a refresh backup with no journal left is abandoned. LibreOffice profiles are per-conversion.
  const liveJournals = new Set(safeReadDir(TRANSACTION_DIR));
  for (const name of safeReadDir(path.join(DATA_DIR, ".refresh-backups"))) {
    if ([...liveJournals].some((journal) => journal.includes(name))) continue;
    removeQuietly(path.join(DATA_DIR, ".refresh-backups", name));
  }
  for (const name of safeReadDir(path.join(DATA_DIR, ".office-profiles"))) {
    removeQuietly(path.join(DATA_DIR, ".office-profiles", name));
  }

  const knownDocumentIds = new Set(store.getWorkspace().documents.map((document) => document.id));
  const knownTaskIds = new Set(store.getWorkspace().reviewTasks.map((task) => task.id));
  if (knownDocumentIds.size === 0 && knownTaskIds.size === 0 && dataDirectoryHoldsAssets()) {
    // An empty index next to a directory full of assets is a broken workspace, not a clean one.
    console.warn("[review-annotation] 工作区索引为空但数据目录中仍有文件，已跳过资产清扫。");
    if (reclaimed > 0) console.log(`[review-annotation] 启动清扫移除了 ${reclaimed} 个临时条目。`);
    return;
  }

  // Managed copies are named "<documentId>" or "<documentId>.<ext>", the same shape the store looks
  // for when it resolves one. A crash between persisting a delete and unlinking leaves them behind.
  for (const name of safeReadDir(UPLOAD_DIR)) {
    // Match the store's own rule (findManagedUpload): the file is "<id>" or "<id>.<ext>". Truncating
    // at the first dot instead would orphan the managed copy of any id that contains one.
    const owned = [...knownDocumentIds].some((id) => name === id || name.startsWith(`${id}.`));
    if (owned) continue;
    removeQuietly(path.join(UPLOAD_DIR, name));
  }

  for (const [directory, known] of [
    [RENDER_DIR, knownDocumentIds],
    [path.join(DATA_DIR, "versions"), knownDocumentIds],
    [path.join(DATA_DIR, "review-tasks"), knownTaskIds]
  ]) {
    for (const name of safeReadDir(directory)) {
      if (known.has(name)) continue;
      removeQuietly(path.join(directory, name));
    }
  }

  if (reclaimed > 0) console.log(`[review-annotation] 启动清扫移除了 ${reclaimed} 个无人引用的条目。`);
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function deleteDocumentAssets(document) {
  if (!document?.id) return;
  const candidates = [
    document.sourcePath,
    document.convertedPdfPath,
    path.join(RENDER_DIR, document.id),
    path.join(DATA_DIR, "versions", document.id),
    ...(document.pages || []).flatMap((page) => [
      page.imageUrl ? filePathForPreviewUrl(page.imageUrl) : "",
      page.sourceUrl ? filePathForPreviewUrl(page.sourceUrl) : ""
    ])
  ];

  for (const filePath of [...new Set(candidates.filter(Boolean))]) {
    removeDataPath(filePath);
  }
}

function removeDataPath(filePath) {
  const resolved = path.resolve(filePath);
  const dataRoot = path.resolve(DATA_DIR);
  if (resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

function isDataPath(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const dataRoot = path.resolve(DATA_DIR);
  return resolved === dataRoot || resolved.startsWith(`${dataRoot}${path.sep}`);
}

function isManagedAssetPath(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return [UPLOAD_DIR, RENDER_DIR].some((rootDir) => {
    const root = path.resolve(rootDir);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  });
}

function refreshSourcePath(document) {
  if (document.originalPath && fs.existsSync(document.originalPath)) return document.originalPath;
  if (document.sourcePath && fs.existsSync(document.sourcePath)) return document.sourcePath;
  return "";
}

function trackedRefreshSourcePath(document) {
  const sourcePath = recordedRefreshSourcePath(document);
  return sourcePath && fs.existsSync(sourcePath) ? sourcePath : "";
}

function recordedRefreshSourcePath(document) {
  if (document.originalPath && !isManagedAssetPath(document.originalPath)) return document.originalPath;
  if (document.sourcePath && !isManagedAssetPath(document.sourcePath)) return document.sourcePath;
  return "";
}

function documentVersionSourcePath(document, version) {
  const resolved = safeStaticPath(DATA_DIR, version?.relativePath || "");
  const root = path.resolve(DATA_DIR, "versions", document.id);
  if (!resolved || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) return "";
  return resolved;
}

function documentContentChanged(previousDocument, nextDocument) {
  if (previousDocument.contentHash && nextDocument.contentHash) return previousDocument.contentHash !== nextDocument.contentHash;
  return Boolean(
    Number(previousDocument.sourceSize || previousDocument.uploadedBytes || 0) !== Number(nextDocument.sourceSize || nextDocument.uploadedBytes || 0) ||
    Number(previousDocument.pageCount || 1) !== Number(nextDocument.pageCount || 1)
  );
}

function documentPdfPath(document) {
  if (!document) return "";
  if (document.convertedPdfPath && fs.existsSync(document.convertedPdfPath)) return document.convertedPdfPath;
  if (document.sourcePath && fs.existsSync(document.sourcePath) && String(document.ext || "").toLowerCase() === "pdf") return document.sourcePath;
  const managed = fs.existsSync(UPLOAD_DIR)
    ? fs.readdirSync(UPLOAD_DIR).find((file) => file === document.id || file.startsWith(`${document.id}.`))
    : "";
  const managedPath = managed ? path.join(UPLOAD_DIR, managed) : "";
  if (managedPath && path.extname(managedPath).toLowerCase() === ".pdf") return managedPath;
  return "";
}

async function documentSourceInfo(document) {
  const sourcePath = refreshSourcePath(document);
  const info = fileInfo(sourcePath);
  const trackedPath = recordedRefreshSourcePath(document);
  const trackedInfo = fileInfo(trackedPath);
  const remoteUrl = String(document.importUrl || "").trim();
  const lastRefresh = Number(document.refreshedAt || document.updated || 0);
  const sourceModifiedAt = remoteUrl
    ? Number(document.sourceModifiedAt || info.modifiedAt || 0)
    : info.modifiedAt || Number(document.sourceModifiedAt || 0);
  const knownSourceModifiedAt = Number(document.sourceModifiedAt || 0);
  const sourceHash = trackedPath && trackedInfo.exists
    ? await cachedSourceHash(trackedPath, trackedInfo)
    : "";
  const hashChanged = Boolean(sourceHash && document.contentHash && sourceHash !== document.contentHash);
  const metadataChanged = Boolean(
    trackedPath && trackedInfo.exists && (
      trackedInfo.size !== Number(document.sourceSize || document.uploadedBytes || 0) ||
      (sourceModifiedAt && knownSourceModifiedAt && Math.abs(sourceModifiedAt - knownSourceModifiedAt) > 1000)
    )
  );
  return {
    sourcePath,
    sourceLabel: trackedPath || remoteUrl || "未关联原始文件",
    sourceTracked: Boolean(trackedPath || remoteUrl),
    sourceRemote: Boolean(remoteUrl),
    sourceMissing: Boolean(trackedPath && !trackedInfo.exists),
    sourceReadable: Boolean(sourcePath && info.exists),
    sourceModifiedAt,
    sourceSize: info.size || Number(document.sourceSize || document.uploadedBytes || 0),
    refreshedAt: lastRefresh,
    // An archived document is one the user has finished with, so a newer source file is not news.
    hasNewerSource: !document.archivedAt && (hashChanged || (!sourceHash && metadataChanged))
  };
}

async function cachedSourceHash(filePath, info) {
  const key = path.resolve(filePath);
  const cached = sourceHashProbes.get(key);
  const signature = `${Number(info.modifiedAt || 0)}:${Number(info.size || 0)}`;
  if (cached && cached.signature === signature && Date.now() - cached.checkedAt < SOURCE_HASH_RECHECK_MS) return cached.hash;
  const hash = await fileSha256Async(key);
  sourceHashProbes.set(key, { signature, hash, checkedAt: Date.now() });
  return hash;
}

function fileInfo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { exists: false, modifiedAt: 0, size: 0 };
  const stat = fs.statSync(filePath);
  return { exists: true, modifiedAt: stat.mtimeMs, size: stat.size };
}

function readAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return process.env.npm_package_version || "0.0.0";
  }
}

function safeFileStem(name) {
  return String(name)
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "review-annotations";
}

function splitTextPages(text, name) {
  const chunks = [];
  const clean = String(text || "");
  for (let index = 0; index < Math.max(clean.length, 1); index += 1600) {
    chunks.push(clean.slice(index, index + 1600));
  }
  return chunks.map((chunk, index) => ({
    title: index === 0 ? name : `${name} · ${index + 1}`,
    text: chunk
  }));
}

function numberCss(value) {
  return Math.max(0, Math.min(100, Number(value) || 0)).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function percent(value, total) {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(3));
}

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || minimum)));
}

function saveDocument(document) {
  store.upsertDocument(document);
}

function classify(mime, ext) {
  const e = String(ext || "").toLowerCase();
  if (mime === "application/pdf" || e === "pdf") return "pdf";
  if (mime?.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(e)) return "image";
  if (["md", "markdown", "txt"].includes(e)) return "markdown";
  if (["csv", "tsv"].includes(e)) return "data";
  if (["ppt", "pptx", "doc", "docx", "xls", "xlsx"].includes(e)) return "office";
  if (["html", "htm"].includes(e)) return "html";
  return "file";
}

function annotationIsResolved(annotation, thread) {
  return annotation?.tag === "resolved" || ["resolved", "rejected"].includes(String(thread?.status || ""));
}

// Closing a review item is the reviewer's decision. docs/AI_REVIEW_WORKFLOW.md says an assistant
// should stop at "addressed" and let the user confirm.
//
// A task-scoped capability proves the caller is an isolated review agent, so that half is actually
// enforced. Everything else authenticates with the one workspace capability, which the app UI and a
// non-task MCP client share, so there the declared role is all the server has to go on: it stops an
// agent following its own tool schema, not one that chooses to claim role "human". Closing that
// remaining gap needs a separate document-scoped capability rather than a bigger check here.
const HUMAN_ONLY_REVIEW_STATUSES = new Set(["resolved", "rejected"]);

function refusesReviewClosure(req, role, status) {
  if (!HUMAN_ONLY_REVIEW_STATUSES.has(status)) return false;
  // Both agent credentials prove the caller is not the reviewer, whatever role it declares.
  return req.reviewActorIsTaskAgent === true || req.reviewActorIsDocumentAgent === true || role !== "human";
}

function secureTokenMatch(supplied, expected) {
  if (!supplied || !expected) return false;
  const suppliedBytes = Buffer.from(String(supplied), "utf8");
  const expectedBytes = Buffer.from(String(expected), "utf8");
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

// The current-document MCP connection used to be handed the workspace-wide capability, which also
// unlocked full backups, document deletion and minting any task's token. "Only the active document"
// lived solely in the MCP process's JavaScript. This is the same boundary, enforced by the server.
const DOCUMENT_CAPABILITY_ROUTES = [
  { method: "GET", pattern: /^\/api\/review\/context$/ },
  { method: "GET", pattern: /^\/api\/review\/document$/ },
  { method: "GET", pattern: /^\/api\/review\/threads$/ },
  { method: "POST", pattern: /^\/api\/review\/threads$/ },
  { method: "GET", pattern: /^\/api\/review\/threads\/[^/]+$/ },
  { method: "PATCH", pattern: /^\/api\/review\/threads\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/review\/threads\/[^/]+\/messages$/ },
  { method: "GET", pattern: /^\/api\/documents\/[^/]+\/pages\/\d+\/text$/ }
];

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function documentCapabilityAuthorizesRequest(req) {
  if (!store) return false;
  const supplied = String(req.get("x-review-document-token") || "");
  if (!supplied || !secureTokenMatch(supplied, store.getDocumentAccessToken())) return false;
  return DOCUMENT_CAPABILITY_ROUTES.some((route) => route.method === req.method && route.pattern.test(req.path));
}

function taskCapabilityAuthorizesRequest(req) {
  const match = String(req.path || "").match(/^\/api\/review\/tasks\/([^/]+)(?:\/|$)/);
  if (!match || !store) return false;
  let routeTaskId = "";
  try {
    routeTaskId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const scopedTaskId = String(req.get("x-review-task-id") || "");
  const scopedToken = String(req.get("x-review-task-token") || "");
  return routeTaskId === scopedTaskId && store.authorizeReviewTask(scopedTaskId, scopedToken);
}

function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

// Sub-projects go one level deep and no further. A tree of arbitrary depth would need cycle
// detection, a deletion policy per level and a sidebar that can scroll sideways; one level covers
// "a course, and the parts of that course" without any of it.
function invalidParentReason(projectId, parentId) {
  if (parentId === projectId) return "project_parent_self";
  const parent = store.getProject(parentId);
  if (!parent) return "project_parent_not_found";
  if (parent.parentId) return "project_nesting_too_deep";
  if (store.childProjects(projectId).length) return "project_has_children";
  return "";
}

function projectPatch(value) {
  const patch = {};
  if (value && Object.hasOwn(value, "parentId")) patch.parentId = String(value.parentId || "");
  if (value && Object.hasOwn(value, "groupId")) patch.groupId = String(value.groupId || "");
  if (value && Object.hasOwn(value, "name")) patch.name = safeText(value.name, "未命名项目", 160);
  if (value && Object.hasOwn(value, "path")) patch.path = safeText(value.path, "本地工作区", 500);
  if (value && Object.hasOwn(value, "color")) patch.color = safeColor(value.color);
  return patch;
}

function documentPatch(value) {
  const patch = {};
  if (value && Object.hasOwn(value, "name")) patch.name = safeText(value.name, "未命名文档", 255);
  if (value && Object.hasOwn(value, "annotationsNeedReview")) patch.annotationsNeedReview = Boolean(value.annotationsNeedReview);
  return patch;
}

function safeEntityId(value, fallback) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(candidate) ? candidate : fallback;
}

function safeText(value, fallback, maximumLength) {
  const text = String(value || "").trim().slice(0, maximumLength);
  return text || fallback;
}

function safeColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#5b4ce2";
}

function optionalRevision(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

// One status mapping for every ingest-shaped route: a declared status wins, then the known
// application codes, then a generic failure.
function ingestErrorStatus(error) {
  const declared = Number(error?.statusCode || 0);
  if (Number.isInteger(declared) && declared >= 400 && declared <= 599) return declared;
  if (error?.code === "unsupported_document_type") return 415;
  if (error?.code === "file_too_large") return 413;
  return 500;
}

function applicationErrorCode(error, fallback) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : fallback;
}

function publishEvent(type, payload) {
  const event = {
    id: ++eventSequence,
    type,
    data: { type, at: Date.now(), ...payload }
  };
  recentEvents.push(event);
  if (recentEvents.length > MAX_EVENT_HISTORY) recentEvents.splice(0, recentEvents.length - MAX_EVENT_HISTORY);
  const serialized = serverEventText(event);
  for (const client of eventClients) {
    try {
      client.write(serialized);
    } catch {
      eventClients.delete(client);
    }
  }
}

function serverEventText(event) {
  const idLine = Number.isFinite(event.id) ? `id: ${event.id}\n` : "";
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function formatMegabytes(bytes) {
  return Math.round(Number(bytes) / 1024 / 1024);
}

async function cachedDirectorySize(directory) {
  if (Date.now() - dataSizeCache.measuredAt < 30000) return dataSizeCache.bytes;
  if (dataSizeCache.promise) return dataSizeCache.promise;
  dataSizeCache.promise = directorySizeAsync(directory)
    .then((bytes) => {
      dataSizeCache = { measuredAt: Date.now(), bytes, promise: null };
      return bytes;
    })
    .catch((error) => {
      dataSizeCache.promise = null;
      throw error;
    });
  return dataSizeCache.promise;
}

async function directorySizeAsync(directory) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) total += (await fs.promises.stat(entryPath)).size;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return total;
}

function fileSha256Async(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

function atomicWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const descriptor = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(tempPath, filePath);
}

const RUNTIME_TOOL_LABELS = {
  pdfinfo: "Poppler",
  pdftoppm: "Poppler",
  pdftotext: "Poppler",
  tesseract: "Tesseract",
  soffice: "LibreOffice",
  python3: "Python"
};

function assertExecutable(filePath, label) {
  if (filePath && fs.existsSync(filePath)) return;
  const packageName = RUNTIME_TOOL_LABELS[label] || label;
  const error = new Error(`本机未安装 ${packageName}（找不到 ${label}），这一步需要它。`);
  error.code = "runtime_tool_missing";
  error.tool = label;
  error.toolPackage = packageName;
  error.statusCode = 503;
  throw error;
}

function parseLoopbackAddress(value) {
  try {
    const parsed = new URL(`http://${String(value || "")}`);
    const hostname = parsed.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return null;
    return { hostname, port: parsed.port || "80" };
  } catch {
    return null;
  }
}

function sameLoopbackOrigin(value, requestHost) {
  try {
    const parsed = new URL(String(value || ""));
    return (
      parsed.protocol === "http:" &&
      parsed.hostname.toLowerCase() === requestHost.hostname &&
      (parsed.port || "80") === requestHost.port
    );
  } catch {
    return false;
  }
}

function pythonCanImport(executable, modules) {
  if (!executable || !fs.existsSync(executable)) return false;
  try {
    execFileSync(executable, ["-c", `import ${modules.join(", ")}`], { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function resolvePythonExecutable(explicitPath, candidates) {
  if (explicitPath) return resolveExecutable(explicitPath, []);
  const found = [];
  for (const candidate of candidates) {
    const resolved = resolveExecutable("", [candidate]);
    if (resolved && !found.includes(resolved)) found.push(resolved);
  }
  // Probe for everything the app actually uses, not just part of it: a system python3 commonly has
  // pypdf but not reportlab, and picking that one silently disables annotated-PDF export.
  const fullyEquipped = found.find((executable) => pythonCanImport(executable, ["pypdf", "reportlab"]));
  if (fullyEquipped) {
    resolvedPythonHasPypdf = true;
    resolvedPythonHasExport = true;
    return fullyEquipped;
  }
  const outlineOnly = found.find((executable) => pythonCanImport(executable, ["pypdf"]));
  resolvedPythonHasPypdf = outlineOnly ? true : (found.length > 0 ? false : null);
  resolvedPythonHasExport = outlineOnly ? false : (found.length > 0 ? false : null);
  return outlineOnly || found[0] || "";
}

function resolveExecutable(explicitPath, candidates) {
  if (explicitPath) return resolveCandidate(explicitPath);
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate);
    if (resolved) return resolved;
  }
  return "";
}

function resolveCandidate(candidate) {
  if (!candidate) return "";
  if (path.isAbsolute(candidate)) return fs.existsSync(candidate) ? candidate : "";
  try {
    const resolved = execFileSync("/usr/bin/which", [candidate], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return resolved && fs.existsSync(resolved) ? resolved : "";
  } catch {
    return "";
  }
}

function resolveMcpServerEntry(root) {
  const configured = String(process.env.REVIEW_MCP_ENTRY || "").trim();
  const candidates = [
    configured,
    root.endsWith(".asar") ? path.join(`${root}.unpacked`, "dist-mcp", "review-annotation-server.mjs") : "",
    path.join(root, "dist-mcp", "review-annotation-server.mjs"),
    path.join(root, "mcp", "review-annotation-server.mjs")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function activeApiUrl(req) {
  const address = activeListener?.address();
  const port = typeof address === "object" && address ? address.port : Number(req.socket?.localPort || PORT);
  return `http://127.0.0.1:${port}`;
}

function shellCommand(parts) {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}
