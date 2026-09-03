import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") process.exit(0);

const requestedPath = process.argv[2];
const appPath = path.resolve(requestedPath || defaultAppPath());
if (!fs.existsSync(appPath)) throw new Error(`Desktop app not found: ${appPath}`);

run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
console.log(`Local desktop app signed: ${appPath}`);

function defaultAppPath() {
  const architecture = process.arch === "arm64" ? "mac-arm64" : "mac";
  return path.join("release", architecture, "批注工作台.app");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}
