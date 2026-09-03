import assert from "node:assert/strict";
import { clientRectToPageRect, continuousActivePage, MAX_ZOOM, MIN_ZOOM, rotatedPageSize, ZOOM_STEP } from "../src/lib/viewer.js";

assert.equal(MIN_ZOOM, 0.5);
assert.equal(MAX_ZOOM, 5);
assert.equal(ZOOM_STEP, 0.1);
assert.deepEqual(rotatedPageSize(600, 800, 90), { width: 800, height: 600 });
assert.deepEqual(rotatedPageSize(600, 800, 180), { width: 600, height: 800 });

const canvasRect = { left: 100, top: 200, width: 800, height: 600 };
const selectedScreenRect = { left: 820, top: 230, right: 860, bottom: 330 };
const restored = clientRectToPageRect(selectedScreenRect, canvasRect, 600, 800, 90);
assert.ok(restored.x >= 5 && restored.x <= 22);
assert.ok(restored.y >= 5 && restored.y <= 10);
assert.ok(restored.w > 10);
assert.ok(restored.h >= 5);

const continuousBase = {
  clientHeight: 700,
  scrollHeight: 5000,
  firstPage: 1,
  lastPage: 7,
  readingLine: 180,
  candidates: [{ page: 3, top: 100 }, { page: 4, top: 240 }]
};
assert.equal(continuousActivePage({ ...continuousBase, scrollTop: 0 }), 1);
assert.equal(continuousActivePage({ ...continuousBase, scrollTop: 4300 }), 7);
assert.equal(continuousActivePage({ ...continuousBase, scrollTop: 1200 }), 4);
assert.equal(continuousActivePage({ ...continuousBase, scrollTop: 1200, candidates: [] }), null);

console.log("viewer.test.mjs passed");
