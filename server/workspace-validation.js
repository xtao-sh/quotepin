const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ANNOTATION_TYPES = new Set(["note", "pin", "region", "text"]);
const ANNOTATION_TAGS = new Set(["", "todo", "question", "resolved"]);
const REVIEW_STATUSES = new Set(["open", "in_progress", "needs_human", "addressed", "resolved", "rejected"]);
const REVIEW_ROLES = new Set(["human", "assistant", "system"]);
const REVIEW_TASK_SCOPES = new Set(["document", "project"]);
const REVIEW_TASK_STATUSES = new Set(["ready", "in_progress", "needs_human", "completed", "archived"]);

export function validAnnotationList(value) {
  if (!Array.isArray(value) || value.length > 1000) return false;
  return value.every((item) => {
    if (!isRecord(item) || !validEntityId(item.id) || !ANNOTATION_TYPES.has(item.type)) return false;
    if (item.tag !== undefined && item.tag !== null && (!ANNOTATION_TAGS.has(item.tag) || typeof item.tag !== "string")) return false;
    if (!validOptionalText(item.text, 100000) || !validOptionalText(item.quote, 100000)) return false;
    if (item.anchor !== undefined && !validTextAnchor(item.anchor)) return false;
    if (item.anchorStatus !== undefined && !["matched", "unmatched", "needs_review"].includes(item.anchorStatus)) return false;
    if (!validOptionalText(item.anchoredRevision, 500)) return false;
    if (!validOptionalTimestamp(item.createdAt) || !validOptionalTimestamp(item.updatedAt)) return false;
    if (item.rects !== undefined && (!Array.isArray(item.rects) || item.rects.length > 200 || !item.rects.every(validRect))) return false;
    for (const coordinate of ["x", "y", "w", "h"]) {
      if (item[coordinate] !== undefined && !validPercent(item[coordinate])) return false;
    }
    if (item.type === "pin" && (!validPercent(item.x) || !validPercent(item.y))) return false;
    if (item.type === "region" && (![item.x, item.y, item.w, item.h].every(validPercent) || Number(item.w) <= 0 || Number(item.h) <= 0)) return false;
    if (item.type === "text" && !(item.rects?.length || [item.x, item.y, item.w, item.h].every(validPercent))) return false;
    return true;
  });
}

export function validHistoryList(value) {
  return Array.isArray(value) && value.length <= 200 && value.every((item) =>
    isRecord(item) && validEntityId(item.id) && validRequiredText(item.action, 80) && validRequiredText(item.label, 500) &&
    validOptionalText(item.rev, 80) && validOptionalTimestamp(item.ts) &&
    (item.snapshot === undefined || validAnnotationList(item.snapshot)) &&
    (item.archivedAnnotation === undefined || validAnnotationList([item.archivedAnnotation])) &&
    (item.archivedThread === undefined || validReviewThread(item.archivedThread)) &&
    validOptionalText(item.displayLabel, 40)
  );
}

export function validReviewThread(value) {
  if (!isRecord(value) || !validEntityId(value.id) || !validEntityId(value.annotationId)) return false;
  if (!validEntityId(value.documentId) || !Number.isInteger(Number(value.page)) || Number(value.page) < 1) return false;
  if (!REVIEW_STATUSES.has(value.status)) return false;
  if (!validOptionalText(value.createdBy, 120) || !validOptionalTimestamp(value.createdAt) || !validOptionalTimestamp(value.updatedAt)) return false;
  if (!Number.isFinite(Number(value.revision || 0)) || Number(value.revision || 0) < 0) return false;
  return Array.isArray(value.messages) && value.messages.length <= 2000 && value.messages.every(validReviewMessage);
}

export function validReviewMessage(value) {
  if (!isRecord(value) || !validEntityId(value.id) || !REVIEW_ROLES.has(value.role)) return false;
  if (!validRequiredText(value.body, 100000) || !validOptionalText(value.author, 120) || !validOptionalTimestamp(value.createdAt)) return false;
  return value.change === undefined || validReviewChange(value.change);
}

export function validReviewChange(value) {
  return isRecord(value) &&
    validOptionalText(value.summary, 10000) &&
    validOptionalText(value.file, 2000) &&
    validOptionalText(value.section, 1000) &&
    validOptionalText(value.commit, 200) &&
    validOptionalText(value.before, 50000) &&
    validOptionalText(value.after, 50000);
}

export function validReviewStatus(value) {
  return REVIEW_STATUSES.has(value);
}

export function validReviewRole(value) {
  return REVIEW_ROLES.has(value);
}

export function validReviewTask(value) {
  if (!isRecord(value) || !validEntityId(value.id) || !REVIEW_TASK_SCOPES.has(value.scope)) return false;
  if (!validRequiredText(value.name, 500) || !validEntityId(value.projectId) || !REVIEW_TASK_STATUSES.has(value.status)) return false;
  if (!validOptionalText(value.projectName, 500) || !validOptionalText(value.projectRootPath, 4096)) return false;
  if (value.allowedPaths !== undefined && (!Array.isArray(value.allowedPaths) || value.allowedPaths.length > 500 || !value.allowedPaths.every((item) => validOptionalText(item, 4096)))) return false;
  if (!validOptionalText(value.accessToken, 128)) return false;
  if (value.storageBytes !== undefined && (!Number.isFinite(Number(value.storageBytes)) || Number(value.storageBytes) < 0)) return false;
  if (!validOptionalText(value.directory, 4096) || !validOptionalText(value.checklistFile, 255) || !validOptionalText(value.snapshotFile, 255)) return false;
  if (!validOptionalTimestamp(value.createdAt) || !validOptionalTimestamp(value.updatedAt) || !Number.isFinite(Number(value.revision || 0))) return false;
  if (!Array.isArray(value.documentIds) || value.documentIds.length === 0 || value.documentIds.length > 500 || !value.documentIds.every(validEntityId)) return false;
  if (!Array.isArray(value.documents) || value.documents.length !== value.documentIds.length || !value.documents.every(validReviewTaskDocument)) return false;
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 10000 || !value.items.every(validReviewTaskItem)) return false;
  if (value.pageSnapshots !== undefined) {
    if (!isRecord(value.pageSnapshots) || Object.keys(value.pageSnapshots).length > 5000) return false;
    if (Object.entries(value.pageSnapshots).some(([key, text]) => !key || typeof text !== "string" || text.length > 5000000)) return false;
  }
  const documentIds = new Set(value.documentIds);
  if (value.documents.some((document) => !documentIds.has(document.id))) return false;
  return value.items.every((item) => documentIds.has(item.documentId));
}

export function validReviewTaskItem(value) {
  if (!isRecord(value) || !validEntityId(value.id) || !validEntityId(value.sourceThreadId) || !validEntityId(value.documentId)) return false;
  if (!Number.isInteger(Number(value.page)) || Number(value.page) < 1 || !REVIEW_STATUSES.has(value.status)) return false;
  if (!validRequiredText(value.documentName, 500) || !validOptionalText(value.pageTitle, 2000) || !validOptionalText(value.documentRevision, 500)) return false;
  if (!validOptionalText(value.pageText, 5000000) || !validOptionalText(value.pageSnapshotKey, 500) || !validOptionalText(value.createdBy, 120)) return false;
  if (!validOptionalText(value.sourceAnnotationHash, 128) || !validOptionalText(value.syncConflict, 120)) return false;
  if (value.sourceThreadRevision !== undefined && !Number.isFinite(Number(value.sourceThreadRevision))) return false;
  if (value.liveThreadRevision !== undefined && !Number.isFinite(Number(value.liveThreadRevision))) return false;
  if (value.syncStatus !== undefined && !["synced", "pending_conflict"].includes(value.syncStatus)) return false;
  if (!validOptionalTimestamp(value.createdAt) || !validOptionalTimestamp(value.updatedAt) || !Number.isFinite(Number(value.revision || 0))) return false;
  if (!validAnnotationList([value.annotation])) return false;
  return Array.isArray(value.messages) && value.messages.length <= 2000 && value.messages.every(validReviewMessage);
}

export function validReviewTaskStatus(value) {
  return REVIEW_TASK_STATUSES.has(value);
}

export function validRect(rect) {
  return isRecord(rect) && ["x", "y", "w", "h"].every((key) => validPercent(rect[key])) && Number(rect.w) > 0 && Number(rect.h) > 0;
}

function validTextAnchor(value) {
  return isRecord(value) &&
    validOptionalText(value.exact, 100000) &&
    validOptionalText(value.prefix, 240) &&
    validOptionalText(value.suffix, 240);
}

export function validEntityId(value) {
  return typeof value === "string" && ENTITY_ID.test(value.trim());
}

export function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validPercent(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;
}

function validOptionalText(value, maximumLength) {
  return value === undefined || (typeof value === "string" && value.length <= maximumLength);
}

function validRequiredText(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function validOptionalTimestamp(value) {
  return value === undefined || (Number.isFinite(Number(value)) && Number(value) >= 0);
}

function validReviewTaskDocument(value) {
  if (!isRecord(value) || !validEntityId(value.id) || !validRequiredText(value.name, 500)) return false;
  if (!Number.isInteger(Number(value.pageCount)) || Number(value.pageCount) < 1) return false;
  for (const key of ["type", "ext", "documentRevision", "workingArtifactPath", "managedCopyPath", "snapshotRelativePath"]) {
    if (!validOptionalText(value[key], key.endsWith("Path") ? 4096 : 500)) return false;
  }
  if (!validOptionalText(value.snapshotHash, 128)) return false;
  if (value.snapshotSize !== undefined && (!Number.isFinite(Number(value.snapshotSize)) || Number(value.snapshotSize) < 0)) return false;
  return validOptionalTimestamp(value.sourceModifiedAt) && validOptionalTimestamp(value.refreshedAt);
}
