import assert from "node:assert/strict";
import path from "node:path";
import dataDirectoryHelpers from "../server/data-directory.cjs";

const { defaultWorkspaceDataDirectory, workspaceStoreId } = dataDirectoryHelpers;

assert.equal(
  defaultWorkspaceDataDirectory({ platform: "darwin", home: "/Users/test", env: {} }),
  path.join("/Users/test", "Library", "Application Support", "review-annotation-prototype", "data")
);
assert.equal(
  defaultWorkspaceDataDirectory({ platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" } }),
  path.join("C:\\Users\\test\\AppData\\Roaming", "review-annotation-prototype", "data")
);
assert.equal(
  defaultWorkspaceDataDirectory({ platform: "linux", home: "/home/test", env: { XDG_DATA_HOME: "/data/test" } }),
  path.join("/data/test", "review-annotation-prototype", "data")
);
assert.equal(workspaceStoreId("/tmp/review/workspace.json"), workspaceStoreId("/tmp/review/workspace.json"));
assert.notEqual(workspaceStoreId("/tmp/review/workspace.json"), workspaceStoreId("/tmp/other/workspace.json"));

console.log("data-directory.test.mjs passed");
