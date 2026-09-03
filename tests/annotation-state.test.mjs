import assert from "node:assert/strict";
import {
  annotationMatchesFilter,
  annotationOverlayVisible,
  annotationReviewState,
  annotationStateTag,
  annotationThreadStatus
} from "../src/lib/annotation-state.js";

const pending = { id: "a1", tag: "todo" };
const question = { id: "a2", tag: "question" };
const resolved = { id: "a3", tag: "resolved" };

assert.equal(annotationReviewState(null, pending), "pending");
assert.equal(annotationReviewState(null, question), "pending");
assert.equal(annotationReviewState(null, resolved), "resolved");
assert.equal(annotationReviewState({ status: "resolved" }, pending), "resolved");
assert.equal(annotationReviewState({ status: "rejected" }, question), "resolved");
assert.equal(annotationReviewState({ status: "addressed" }, pending), "pending");

assert.equal(annotationStateTag("pending"), "todo");
assert.equal(annotationStateTag("question"), "todo");
assert.equal(annotationStateTag("resolved"), "resolved");
assert.equal(annotationThreadStatus("pending"), "open");
assert.equal(annotationThreadStatus("question"), "open");
assert.equal(annotationThreadStatus("resolved"), "resolved");
assert.equal(annotationThreadStatus("rejected"), "open");

assert.equal(annotationMatchesFilter({ status: "resolved" }, pending, "resolved"), true);
assert.equal(annotationMatchesFilter({ status: "resolved" }, pending, "todo"), false);
assert.equal(annotationMatchesFilter(null, question, "question"), false);
assert.equal(annotationMatchesFilter(null, pending, "all"), true);
assert.equal(annotationMatchesFilter(null, pending, "open"), true);
assert.equal(annotationMatchesFilter(null, question, "open"), true);
assert.equal(annotationMatchesFilter({ status: "resolved" }, pending, "open"), false);
assert.equal(annotationMatchesFilter({ status: "resolved" }, pending, "closed"), true);
assert.equal(annotationMatchesFilter({ status: "rejected" }, pending, "closed"), true);

assert.equal(annotationOverlayVisible(null, pending), true);
assert.equal(annotationOverlayVisible({ status: "addressed" }, pending), true);
assert.equal(annotationOverlayVisible(null, resolved), false);
assert.equal(annotationOverlayVisible({ status: "resolved" }, pending), false);
assert.equal(annotationOverlayVisible({ status: "rejected" }, pending), false);
assert.equal(annotationOverlayVisible(null, { ...pending, type: "text", anchorStatus: "unmatched" }), false);

console.log("annotation-state.test.mjs passed");
