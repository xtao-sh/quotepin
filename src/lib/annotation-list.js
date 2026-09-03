import { annotationMatchesFilter } from "./annotation-state.js";

export function buildAnnotationListGroups({
  documentId,
  pageCount,
  annotations,
  reviewThreads,
  currentPage,
  scope = "page",
  filter = "all"
}) {
  if (!documentId) return [];
  const pages = scope === "document"
    ? Array.from({ length: Math.max(0, Number(pageCount) || 0) }, (_, index) => index + 1)
    : [Math.max(1, Number(currentPage) || 1)];

  return pages.flatMap((page) => {
    const pageItems = annotations?.[`${documentId}:${page}`] || [];
    const markerLabels = annotationMarkerLabels(pageItems);
    const pageNote = pageItems.find((item) => item.type === "note" && item.createdBy !== "assistant");
    const markItems = pageItems.filter((item) => item.id !== pageNote?.id);
    const candidates = scope === "document"
      ? pageItems.filter((item) => item.id !== pageNote?.id || String(item.text || "").trim())
      : markItems;
    const entries = candidates
      .filter((item) => annotationMatchesFilter(reviewThreads?.[item.id], item, filter))
      .map((item) => ({
        item,
        page,
        index: markItems.findIndex((entry) => entry.id === item.id),
        label: markerLabels[item.id] || "页"
      }));
    return entries.length ? [{ page, entries }] : [];
  });
}

export function annotationMarkerLabels(pageItems = []) {
  let marker = 0;
  return Object.fromEntries(pageItems.flatMap((item) => {
    if (!["pin", "region", "text"].includes(item.type)) return [];
    marker += 1;
    return [[item.id, String(marker)]];
  }));
}

export function withAnnotationDisplayLabels(pageItems = []) {
  const labels = annotationMarkerLabels(pageItems);
  return pageItems.map((item) => labels[item.id] ? { ...item, displayLabel: labels[item.id] } : item);
}

export function annotationGroupCount(groups) {
  return (groups || []).reduce((sum, group) => sum + group.entries.length, 0);
}
