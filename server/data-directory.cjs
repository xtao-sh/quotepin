const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const APP_DIRECTORY = "review-annotation-prototype";

function defaultWorkspaceDataDirectory({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIRECTORY, "data");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIRECTORY, "data");
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), APP_DIRECTORY, "data");
}

function workspaceStoreId(storePath) {
  return crypto.createHash("sha256").update(path.resolve(storePath)).digest("hex").slice(0, 24);
}

module.exports = { APP_DIRECTORY, defaultWorkspaceDataDirectory, workspaceStoreId };
