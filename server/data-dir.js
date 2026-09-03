import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dataDirectoryHelpers from "./data-directory.cjs";

const { defaultWorkspaceDataDirectory } = dataDirectoryHelpers;

export function resolveDataDirectory(root = process.cwd()) {
  if (process.env.REVIEW_APP_DATA) return path.resolve(process.env.REVIEW_APP_DATA);
  return defaultWorkspaceDataDirectory();
}

export function legacyDataDirectory(root = process.cwd()) {
  return path.resolve(root, "app-data");
}

// The local API's capability token. Kept in the data directory so the desktop app, the dev launcher
// and a bare `node server/index.js` all agree on the same value without passing secrets around.
export function loadOrCreateCapability(dataDir) {
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

export function acquireDataDirectoryLock(dataDir, port = 0) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".workspace.lock");
  const token = crypto.randomBytes(12).toString("hex");
  const record = { pid: process.pid, port, token, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fs.closeSync(descriptor);
      return {
        path: lockPath,
        release() {
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (current.token === token) fs.rmSync(lockPath, { force: true });
          } catch {
            // A missing or replaced lock is not ours to remove.
          }
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (existing?.pid && processIsRunning(existing.pid)) {
        const locked = new Error(`Workspace is already open by process ${existing.pid}${existing.port ? ` on port ${existing.port}` : ""}.`);
        locked.code = "DATA_DIR_LOCKED";
        locked.lock = existing;
        throw locked;
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Unable to acquire workspace lock.");
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function processIsRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
