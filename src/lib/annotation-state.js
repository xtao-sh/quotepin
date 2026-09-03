export const ANNOTATION_STATES = {
  pending: { label: "待解决", tag: "todo", threadStatus: "open" },
  resolved: { label: "已解决", tag: "resolved", threadStatus: "resolved" }
};

export function annotationReviewState(thread, annotation) {
  const threadStatus = thread?.status || "";
  if (["resolved", "rejected"].includes(threadStatus) || annotation?.tag === "resolved") return "resolved";
  return "pending";
}

export function annotationStateTag(state) {
  return ANNOTATION_STATES[state]?.tag || ANNOTATION_STATES.pending.tag;
}

export function annotationThreadStatus(state) {
  return ANNOTATION_STATES[state]?.threadStatus || ANNOTATION_STATES.pending.threadStatus;
}

export function annotationMatchesFilter(thread, annotation, filter) {
  if (!filter || filter === "all") return true;
  const state = annotationReviewState(thread, annotation);
  if (filter === "open") return state === "pending";
  if (filter === "closed") return state === "resolved";
  return annotationStateTag(state) === filter;
}

export function annotationOverlayVisible(thread, annotation) {
  if (annotation?.type === "text" && annotation?.anchorStatus === "unmatched") return false;
  return annotationReviewState(thread, annotation) !== "resolved";
}
