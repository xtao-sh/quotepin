import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") throw new Error("Local desktop installation is only supported on macOS.");

const architecture = process.arch === "arm64" ? "mac-arm64" : "mac";
const source = path.resolve(process.argv[2] || path.join("release", architecture, "批注工作台.app"));
const destination = path.resolve(process.argv[3] || "/Applications/批注工作台.app");
const parent = path.dirname(destination);
const temp = path.join(parent, `.批注工作台.install-${process.pid}.app`);
const previous = path.join(parent, `.批注工作台.previous-${process.pid}.app`);
const wasRunning = appIsRunning(destination);

if (!fs.existsSync(source)) throw new Error(`Desktop app not found: ${source}`);
if (source === destination) throw new Error("Source and destination app paths must be different.");

fs.rmSync(temp, { recursive: true, force: true });
fs.rmSync(previous, { recursive: true, force: true });

if (wasRunning) stopRunningApp(destination);

let movedPrevious = false;
try {
  run("ditto", [source, temp]);
  run("xattr", ["-dr", "com.apple.quarantine", temp], { allowFailure: true });
  run("codesign", ["--force", "--deep", "--sign", "-", temp]);
  verify(temp);

  if (fs.existsSync(destination)) {
    fs.renameSync(destination, previous);
    movedPrevious = true;
  }
  fs.renameSync(temp, destination);
  verify(destination);
  console.log(`Local desktop app installed: ${destination}`);
  if (movedPrevious) console.log(`Previous version retained for rollback: ${previous}`);
  prunePreviousApps(parent, previous);
  if (wasRunning) run("open", [destination], { allowFailure: true });
} catch (error) {
  fs.rmSync(temp, { recursive: true, force: true });
  if (movedPrevious && !fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
  throw error;
}

function verify(appPath) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} failed with status ${result.status}`);
}

function appIsRunning(appPath) {
  const result = spawnSync("pgrep", ["-f", `${appPath}/Contents/`], { stdio: "ignore" });
  return result.status === 0;
}

function stopRunningApp(appPath) {
  run("osascript", ["-e", 'tell application id "tech.taich.review-annotation" to quit'], { allowFailure: true });
  waitUntil(() => !appIsRunning(appPath), 5000);
  if (appIsRunning(appPath)) {
    run("pkill", ["-TERM", "-f", `${appPath}/Contents/`], { allowFailure: true });
    waitUntil(() => !appIsRunning(appPath), 5000);
  }
  if (appIsRunning(appPath)) throw new Error("The running desktop app did not exit. Close it and retry installation.");
}

function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return predicate();
}

function prunePreviousApps(directory, retainedPath) {
  const backups = fs.readdirSync(directory)
    .filter((name) => name.startsWith(".批注工作台.previous-") && name.endsWith(".app"))
    .map((name) => path.join(directory, name))
    .filter((appPath) => appPath !== retainedPath)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  // Everything except the one just retained. Keeping a second rollback bought nothing — it is two
  // installs behind by the time it would be reached for — and each one is 300MB.
  for (const appPath of backups) fs.rmSync(appPath, { recursive: true, force: true });
}
