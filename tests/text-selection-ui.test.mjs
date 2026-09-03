import assert from "node:assert/strict";
import { isPageNumberTitle, normalizePageNumberTitle } from "../src/lib/page-title.js";
import {
  buildTextAnchor,
  isFootnoteOnlySelection,
  normalizeSelectedText,
  shouldPreferPointerSelection,
  shouldPreferSpanSelection
} from "../src/lib/text-selection.js";

assert.equal(normalizePageNumberTitle("第 2 页 第 3 页 第 3 页", 3), "第 3 页");
assert.equal(normalizePageNumberTitle("Data and Institutional Setting", 6), "Data and Institutional Setting");
assert.equal(isPageNumberTitle("第 12 页"), true);
assert.equal(isPageNumberTitle("第 1 页 Introduction"), false);

assert.equal(normalizeSelectedText("adop-\ntion rises across\nregions"), "adoption rises across regions");
assert.equal(normalizeSelectedText("soft\u00adhyphen"), "softhyphen");
assert.equal(normalizeSelectedText("first line\nsecond line"), "first line second line");
assert.equal(isFootnoteOnlySelection("12"), true);
assert.equal(isFootnoteOnlySelection("\u00b2"), true);
assert.equal(isFootnoteOnlySelection("footnote 2"), false);
assert.equal(shouldPreferSpanSelection("2", "preceding sentence 2"), true);
assert.equal(shouldPreferSpanSelection("selected text 2", "selected text 2"), false);
assert.equal(shouldPreferPointerSelection(null, { quote: "paragraph opening", clientRects: [{}] }), true);
assert.equal(shouldPreferPointerSelection(
  { quote: "(h, j)", clientRects: [{}, {}] },
  { quote: "(h, j)", clientRects: [{}, {}, {}, {}, {}] }
), true);
assert.equal(shouldPreferPointerSelection(
  { quote: "narrow one", clientRects: [{}] },
  { quote: "narrow one and the entire rest of the line", clientRects: [{}] }
), false);
assert.equal(shouldPreferPointerSelection(
  { quote: "narrow one and the entire rest of the line", clientRects: [{}] },
  { quote: "narrow one", clientRects: [{}] }
), true);
assert.deepEqual(buildTextAnchor("adop-\ntion", "  before\ncontext  ", " after\ncontext "), {
  exact: "adoption",
  prefix: "before context",
  suffix: "after context"
});

console.log("text-selection-ui.test.mjs passed");
