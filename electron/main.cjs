const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { defaultWorkspaceDataDirectory, workspaceStoreId } = require("../server/data-directory.cjs");
const { isSupportedApi } = require("../server/api-version.cjs");

const PORT = Number(process.env.REVIEW_DESKTOP_PORT || 4520);
let server;
let mainWindow;
let serverUrl = `http://127.0.0.1:${PORT}`;
let closeRequestId = 0;
let closeTimer = null;
let allowWindowClose = false;
let isQuitting = false;
let closeInProgress = false;
let reloadingAfterCrash = false;
let apiToken = "";

if (process.env.REVIEW_APP_DATA) app.setPath("userData", path.resolve(process.env.REVIEW_APP_DATA));
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

async function startLocalServer() {
  if (server) return;
  const root = app.getAppPath();
  const dataDir = path.resolve(process.env.REVIEW_APP_DATA || defaultWorkspaceDataDirectory());
  apiToken = loadOrCreateApiToken(dataDir);
  process.env.REVIEW_API_TOKEN = apiToken;
  const reusable = await findWorkspaceServer([PORT, 4517], dataDir);
  if (reusable) {
    serverUrl = `http://127.0.0.1:${reusable.port}`;
    return;
  }
  process.env.PORT = String(PORT);
  process.env.REVIEW_APP_ROOT = root;
  process.env.REVIEW_APP_DATA = dataDir;

  const serverModule = await import(pathToFileURL(path.join(root, "server", "index.js")).href);
  try {
    server = await listenOrFallback(serverModule, PORT);
  } catch (error) {
    if (error?.code === "DATA_DIR_LOCKED" && error.lock?.port) {
      const lockedServer = await findWorkspaceServer([error.lock.port], dataDir, 4);
      if (lockedServer) {
        serverUrl = `http://127.0.0.1:${lockedServer.port}`;
        return;
      }
    }
    throw error;
  }
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : PORT;
  serverUrl = `http://127.0.0.1:${boundPort}`;
}

// The preferred port is a convention, not a requirement. If something else already holds it, bind
// an ephemeral port rather than refusing to launch.
async function listenOrFallback(serverModule, preferredPort) {
  for (const port of [preferredPort, 0]) {
    let candidate;
    try {
      process.env.PORT = String(port);
      candidate = serverModule.startServer(port);
    } catch (error) {
      if (port === 0 || error?.code === "DATA_DIR_LOCKED") throw error;
      continue;
    }
    try {
      await new Promise((resolve, reject) => {
        if (candidate.listening) {
          resolve();
          return;
        }
        candidate.once("listening", resolve);
        candidate.once("error", reject);
      });
      return candidate;
    } catch (error) {
      candidate.close();
      if (port === 0 || error?.code !== "EADDRINUSE") throw error;
      console.warn(`[review-annotation] 端口 ${port} 被占用，改用系统分配的端口。`);
    }
  }
  throw new Error("无法启动本地服务。");
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "批注工作台",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#eef0f3",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) shell.openExternal(url);
    } catch {
      // Malformed external URLs stay blocked.
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!sameServerOrigin(url)) event.preventDefault();
  });

  mainWindow.on("close", (event) => {
    if (allowWindowClose || mainWindow?.webContents.isDestroyed()) return;
    // A crashed renderer cannot answer the save check; do not block the close on a reply that will
    // never come, and do not warn about unsaved work we have no way to confirm.
    if (reloadingAfterCrash) return;
    event.preventDefault();
    requestRendererClose();
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    handleRendererGone(details?.reason || "unknown");
  });

  mainWindow.webContents.on("unresponsive", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "界面无响应",
      message: "批注工作台的界面暂时没有响应。",
      detail: "可以再等一会儿，或者重新载入界面。已保存的批注不受影响。",
      buttons: ["继续等待", "重新载入"],
      defaultId: 0,
      cancelId: 0
    }).then((decision) => {
      if (decision.response === 1) reloadRenderer();
    }).catch(() => {});
  });

  await mainWindow.loadURL(`${serverUrl}/?cap=${encodeURIComponent(apiToken)}`);
  if (process.env.REVIEW_DESKTOP_SMOKE_REPORT) await writeRendererSmokeReport(process.env.REVIEW_DESKTOP_SMOKE_REPORT);
  mainWindow.once("closed", () => {
    clearTimeout(closeTimer);
    closeTimer = null;
    allowWindowClose = false;
    mainWindow = null;
  });
}

async function handleRendererGone(reason) {
  if (!mainWindow || mainWindow.isDestroyed() || reloadingAfterCrash) return;
  reloadingAfterCrash = true;
  clearTimeout(closeTimer);
  closeTimer = null;
  const decision = await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "界面已停止运行",
    message: "批注工作台的界面进程意外结束了。",
    detail: `原因：${reason}。批注保存在本地工作区，重新载入不会丢失已同步的内容。`,
    buttons: ["重新载入", "退出"],
    defaultId: 0,
    cancelId: 0
  }).catch(() => ({ response: 0 }));
  if (decision.response === 1) {
    allowWindowClose = true;
    app.quit();
    return;
  }
  await reloadRenderer();
}

async function reloadRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.loadURL(`${serverUrl}/?cap=${encodeURIComponent(apiToken)}`);
  } catch (error) {
    dialog.showErrorBox("重新载入失败", error.message);
  } finally {
    reloadingAfterCrash = false;
  }
}

async function writeRendererSmokeReport(reportPath) {
  const report = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const startedAt = Date.now();
    const inspect = () => {
      const root = document.getElementById("root");
      const ready = Boolean(document.querySelector(".projects-layout, .workspace-layout, .workspace-load-state"));
      if (!ready && Date.now() - startedAt < 15000) {
        setTimeout(inspect, 100);
        return;
      }
      resolve({
        url: location.href,
        title: document.title,
        rootChildCount: root?.childElementCount || 0,
        appShell: Boolean(document.querySelector(".app-shell")),
        primaryViewReady: ready,
        bodyText: document.body.innerText.slice(0, 1000)
      });
    };
    inspect();
  })`, true);
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function requestRendererClose() {
  if (!mainWindow || mainWindow.isDestroyed() || closeTimer || closeInProgress) return;
  closeRequestId += 1;
  const requestId = closeRequestId;
  mainWindow.webContents.send("review:before-close", requestId);
  closeTimer = setTimeout(() => {
    // Retire this request id so a reply that arrives after the timeout cannot re-enter the flow
    // while the warning dialog is open.
    closeRequestId += 1;
    handleRendererCloseResult({ ok: false, message: "等待批注保存超时。" }).catch((error) => dialog.showErrorBox("关闭应用失败", error.message));
  }, 5000);
}

async function handleRendererCloseResult(result) {
  clearTimeout(closeTimer);
  closeTimer = null;
  if (closeInProgress) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  closeInProgress = true;
  try {
    await finishRendererClose(result);
  } finally {
    closeInProgress = false;
  }
}

async function finishRendererClose(result) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!result.ok) {
    const decision = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "批注尚未保存",
      message: result.message || "最近的批注还没有保存到本地工作区。",
      detail: "返回应用可以继续重试；仍然关闭可能丢失最近的修改。",
      buttons: ["返回应用", "仍然关闭"],
      defaultId: 0,
      cancelId: 0
    });
    if (decision.response !== 1) {
      isQuitting = false;
      return;
    }
  }
  const shouldQuit = isQuitting;
  allowWindowClose = true;
  mainWindow.close();
  if (shouldQuit) app.quit();
}

if (hasInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady()
    .then(startLocalServer)
    .then(createWindow)
    .catch((error) => {
      if (error?.code === "DATA_DIR_LOCKED") {
        dialog.showErrorBox(
          "工作区正被另一个进程使用",
          `另一个批注工作台（进程 ${error.lock?.pid || "未知"}）正在使用同一份数据。请退出那个窗口后重试。\n\n如果它已经不在运行，删除数据目录里的 .workspace.lock 文件即可。`
        );
      } else {
        dialog.showErrorBox("批注工作台无法启动", error.message);
      }
      app.quit();
    });
}

ipcMain.handle("review:pick-document-path", async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要跟踪的文档",
    properties: ["openFile"],
    filters: documentFilters()
  });
  return result.canceled ? "" : result.filePaths[0] || "";
});

ipcMain.handle("review:pick-document-paths", async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入并跟踪文档",
    properties: ["openFile", "multiSelections"],
    filters: documentFilters()
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("review:pick-import-directory", async (event, startPath) => {
  assertTrustedRenderer(event);
  // Opening at the folder the user is already thinking about — the one holding a document they just
  // looked at — is the whole point of the entry point on a document row.
  const suggested = typeof startPath === "string" && startPath ? startPath : undefined;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要导入的文件夹",
    buttonLabel: "扫描这个文件夹",
    ...(suggested ? { defaultPath: suggested } : {}),
    properties: ["openDirectory"]
  });
  return result.canceled ? "" : result.filePaths[0] || "";
});

ipcMain.handle("review:pick-project-directory", async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? "" : result.filePaths[0] || "";
});

ipcMain.on("review:close-ready", (event, result = {}) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || Number(result.requestId) !== closeRequestId) return;
  handleRendererCloseResult(result).catch((error) => dialog.showErrorBox("关闭应用失败", error.message));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch((error) => dialog.showErrorBox("批注工作台无法打开窗口", error.message));
});

process.on("uncaughtException", (error) => {
  console.error("[review-annotation] 主进程未捕获异常:", error);
  if (app.isReady() && mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox("批注工作台遇到问题", `${error.message}\n\n已保存的批注不受影响。建议退出后重新打开应用。`);
    return;
  }
  dialog.showErrorBox("批注工作台无法启动", error.message);
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[review-annotation] 主进程未处理的 Promise 拒绝:", reason);
});

app.on("child-process-gone", (_event, details) => {
  console.error(`[review-annotation] 子进程结束: ${details?.type} (${details?.reason})`);
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", (event) => {
  if (!server) return;
  const closing = server;
  server = null;
  event.preventDefault();
  const done = () => app.exit(0);
  // The listener's close handler is what releases the workspace lock; give it a moment to run
  // rather than exiting out from under it.
  const guard = setTimeout(done, 2000);
  closing.close(() => {
    clearTimeout(guard);
    done();
  });
});

async function localHealth(port, challenge = "") {
  try {
    const query = challenge ? `?challenge=${encodeURIComponent(challenge)}` : "";
    const response = await fetch(`http://127.0.0.1:${port}/api/health${query}`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

function provesCapability(health, challenge) {
  if (!apiToken) return true;
  const expected = crypto.createHmac("sha256", apiToken).update(challenge).digest("hex");
  const supplied = String(health?.proof || "");
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function findWorkspaceServer(ports, dataDir, attempts = 2) {
  const expectedStoreId = workspaceStoreId(path.join(dataDir, "workspace.json"));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const port of [...new Set(ports)]) {
      const challenge = crypto.randomBytes(16).toString("hex");
      const health = await localHealth(port, challenge);
      if (
        isSupportedApi(health) &&
        health.storeId === expectedStoreId &&
        provesCapability(health, challenge)
      ) {
        return { port, health };
      }
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return null;
}

function documentFilters() {
  return [{
    name: "Documents",
    extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif", "md", "markdown", "txt", "csv", "tsv", "html", "htm", "ppt", "pptx", "doc", "docx", "xls", "xlsx"]
  }];
}

function sameServerOrigin(url) {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function assertTrustedRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !sameServerOrigin(event.senderFrame?.url || "")) {
    throw new Error("Untrusted renderer IPC request.");
  }
}

function loadOrCreateApiToken(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, ".api-capability");
  try {
    const stats = fs.statSync(tokenPath);
    // A token another user can read, or that anyone can write, is not a capability worth honouring.
    if (stats.uid !== process.getuid?.()) throw new Error("capability_not_owned");
    if ((stats.mode & 0o077) !== 0) throw new Error("capability_too_permissive");
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch (error) {
    if (error?.message === "capability_not_owned" || error?.message === "capability_too_permissive") throw error;
    // Anything else means there is no usable token yet; write a fresh one below.
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  return token;
}
