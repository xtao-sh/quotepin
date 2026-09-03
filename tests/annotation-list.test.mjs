import assert from "node:assert/strict";
import { annotationGroupCount, buildAnnotationListGroups } from "../src/lib/annotation-list.js";

const annotations = {
  "doc-1:1": [
    { id: "note-1", type: "note", text: "整页需要精简", tag: "todo" },
    { id: "pin-1", type: "pin", text: "核对数字", tag: "todo" }
  ],
  "doc-1:2": [
    { id: "note-2", type: "note", text: "", tag: "todo" },
    { id: "text-2", type: "text", text: "已经处理", tag: "todo" },
    { id: "ai-note-2", type: "note", createdBy: "assistant", text: "需要用户确认", tag: "question" }
  ]
};
const reviewThreads = { "text-2": { status: "resolved" } };

const pageGroups = buildAnnotationListGroups({
  documentId: "doc-1",
  pageCount: 3,
  annotations,
  reviewThreads,
  currentPage: 1,
  scope: "page"
});
assert.equal(annotationGroupCount(pageGroups), 1);
assert.equal(pageGroups[0].entries[0].item.id, "pin-1");

const documentGroups = buildAnnotationListGroups({
  documentId: "doc-1",
  pageCount: 3,
  annotations,
  reviewThreads,
  currentPage: 1,
  scope: "document"
});
assert.deepEqual(documentGroups.map((group) => group.page), [1, 2]);
assert.equal(annotationGroupCount(documentGroups), 4);
assert.deepEqual(documentGroups[0].entries.map((entry) => entry.item.id), ["note-1", "pin-1"]);
assert.deepEqual(documentGroups[1].entries.map((entry) => entry.item.id), ["text-2", "ai-note-2"]);
assert.equal(documentGroups[0].entries[0].index, -1);
assert.equal(documentGroups[0].entries[1].index, 0);
assert.equal(documentGroups[0].entries[1].label, "1");
assert.equal(documentGroups[1].entries[0].label, "1");

const resolvedGroups = buildAnnotationListGroups({
  documentId: "doc-1",
  pageCount: 3,
  annotations,
  reviewThreads,
  currentPage: 1,
  scope: "document",
  filter: "resolved"
});
assert.equal(annotationGroupCount(resolvedGroups), 1);
assert.equal(resolvedGroups[0].entries[0].item.id, "text-2");

const openGroups = buildAnnotationListGroups({
  documentId: "doc-1",
  pageCount: 3,
  annotations,
  reviewThreads,
  currentPage: 1,
  scope: "document",
  filter: "open"
});
assert.deepEqual(openGroups.flatMap((group) => group.entries.map((entry) => entry.item.id)), ["note-1", "pin-1", "ai-note-2"]);

console.log("annotation-list.test.mjs passed");
