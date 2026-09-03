import assert from "node:assert/strict";
import { addOutlineDisplayNumbers, buildOutlineTree } from "../src/lib/outline-tree.js";

const numbered = addOutlineDisplayNumbers([
  { id: "intro", title: "Introduction", level: 1, page: 2, type: "section" },
  { id: "related", title: "Related literature", level: 2, page: 6, type: "section" },
  { id: "data", title: "2 Data", level: 1, page: 8, type: "section" },
  { id: "sample", title: "Sample", level: 2, page: 9, type: "section" },
  { id: "figure", title: "Figure 1: Overview", level: 2, page: 10, type: "figure" }
]);

assert.equal(numbered[0].displayTitle, "1 Introduction");
assert.equal(numbered[1].displayTitle, "1.1 Related literature");
assert.equal(numbered[2].displayTitle, "2 Data");
assert.equal(numbered[3].displayTitle, "2.1 Sample");
assert.equal(numbered[4].displayTitle, "Figure 1: Overview");

const tree = buildOutlineTree(numbered);
assert.equal(tree.length, 2);
assert.equal(tree[0].id, "intro");
assert.deepEqual(tree[0].children.map((item) => item.id), ["related"]);
assert.equal(tree[1].id, "data");
assert.deepEqual(tree[1].children.map((item) => item.id), ["sample", "figure"]);
assert.equal(tree[1].children[0].treeKey, "sample");

console.log("outline-tree.test.mjs passed");
