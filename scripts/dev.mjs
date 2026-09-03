import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import dataDirectoryHelpers from "../server/data-directory.cjs";
import { loadOrCreateCapability } from "../server/data-dir.js";
import apiVersionHelpers from "../server/api-version.cjs";

const { defaultWorkspaceDataDirectory, workspaceStoreId } = dataDirectoryHelpers;
const { isSupportedApi } = apiVersionHelpers;

const root = process.cwd();
const apiPort = Number(process.env.PORT || 4517);
const desktopPort = Number(process.env.REVIEW_DESKTOP_PORT || 4520);
const dataDir = path.resolve(process.env.REVIEW_APP_DATA || defaultWorkspaceDataDirectory());
const expectedStoreId = workspaceStoreId(path.join(dataDir, "workspace.json"));
// The API now requires a capability. Hand the same one to the API child and to Vite, whose proxy
// attaches it, so the dev page at :5173 keeps working without the user pasting anything.
let capability = "";
try {
  capability = process.env.REVIEW_API_TOKEN || loadOrCreateCapability(dataDir);
} catch (error) {
  console.error(`无法使用数据目录中的 .api-capability：${error.message}`);
  process.exit(1);
}
let apiChild = null;
let viteChild = null;
let stopping = false;

const currentApi = await findCompatibleApi([apiPort, desktopPort], expectedStoreId);
const legacyApi = currentApi ? null : (await readHealth(apiPort)) || (await readHealth(desktopPort));
if (legacyApi?.service === "review-annotation-api" && !process.env.REVIEW_APP_DATA) {
  console.error("检测到旧版批注工作台仍在运行。请先退出旧版桌面 App，再重新运行 npm run dev，以免两个进程同时写入工作区。");
  process.exit(1);
}

let target = currentApi ? `http://127.0.0.1:${currentApi.port}` : `http://127.0.0.1:${apiPort}`;
if (!currentApi) {
  apiChild = spawn(process.execPath, [path.join(root, "server", "index.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(apiPort), REVIEW_APP_DATA: dataDir, REVIEW_API_TOKEN: capability },
    stdio: "inherit"
  });
  apiChild.once("exit", (code) => {
    if (!stopping) {
      console.error(`本地 API 已退出（${code ?? "signal"}）。`);
      stop(code || 1);
    }
  });
  await waitForApi(apiPort, apiChild, expectedStoreId);
}

viteChild = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, REVIEW_API_URL: target, REVIEW_API_TOKEN: capability },
  stdio: "inherit"
});
viteChild.once("exit", (code) => stop(code || 0));

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function findCompatibleApi(ports, storeId) {
  for (const port of ports) {
    const health = await readHealth(port);
    if (isSupportedApi(health) && health.storeId === storeId) return { port, health };
  }
  return null;
}

async function readHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function waitForApi(port, child, storeId) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) throw new Error(`本地 API 启动失败（${child.exitCode}）。`);
    const health = await readHealth(port);
    if (isSupportedApi(health) && health.storeId === storeId) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("等待本地 API 启动超时。");
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  viteChild?.kill("SIGTERM");
  apiChild?.kill("SIGTERM");
  windowlessDelay(code);
}

function windowlessDelay(code) {
  setTimeout(() => process.exit(code), 50);
}
