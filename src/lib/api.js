export async function syncPageAnnotations(documentId, page, annotations, updatedAt = Date.now(), expectedRevision = undefined) {
  return requestJson(`/api/documents/${documentId}/pages/${page}/annotations`, {
    method: "PUT",
    // expectedRevision is the server-issued token this client last saw for the page. Sending it
    // means only a client that has seen the current state can write over it.
    body: { annotations, updatedAt, ...(expectedRevision === undefined ? {} : { expectedRevision }) }
  });
}

export async function syncPageHistory(documentId, page, history, updatedAt = Date.now()) {
  return requestJson(`/api/documents/${documentId}/pages/${page}/history`, {
    method: "PUT",
    body: { history, updatedAt }
  });
}

export async function archiveAnnotation(documentId, page, annotationId) {
  return requestJson(`/api/documents/${documentId}/pages/${page}/annotations/${encodeURIComponent(annotationId)}/archive`, {
    method: "POST"
  });
}

export async function getWorkspace() {
  const response = await fetch("/api/workspace");
  // Go through responseError so callers can act on the server's error code — the recovery screen
  // depends on recognising workspace_recovery_required rather than a status number.
  if (!response.ok) throw await responseError(response, "本地工作区读取失败");
  return response.json();
}

export async function getAiIntegration(taskId = "") {
  return requestJson(`/api/integrations/ai${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`);
}

export async function getHealth() {
  return requestJson("/api/health");
}

export async function getRecoveryState() {
  return requestJson("/api/recovery");
}

export async function restoreWorkspaceSnapshot(snapshot, confirmDowngrade = false) {
  return postJson("/api/recovery/restore", { snapshot, confirmDowngrade });
}

export async function getDiagnostics() {
  return requestJson("/api/diagnostics");
}

export async function uploadDocument(file, projectId, pageCount = 1) {
  const form = new FormData();
  form.append("file", file);
  form.append("projectId", projectId);
  form.append("pageCount", String(pageCount));
  const response = await fetch("/api/documents/upload", { method: "POST", body: form });
  if (!response.ok) throw await responseError(response, "Upload failed");
  return response.json();
}

// Read a selection off the rendered page. Used when the PDF's own text layer decodes to glyph
// indices, which is a property of the file and cannot be fixed by extracting it again.
export async function readRegionText(documentId, page, rects) {
  return requestJson(`/api/documents/${encodeURIComponent(documentId)}/pages/${page}/region-text`, {
    method: "POST",
    body: { rects }
  });
}

export async function importDocumentPath(filePath, projectId) {
  return postJson("/api/documents/import-path", { path: filePath, projectId });
}

export async function importDocumentUrl(url, projectId) {
  return postJson("/api/documents/import-url", { url, projectId });
}

export async function createGroup(group) {
  return postJson("/api/groups", group);
}

export async function reorderGroups(orderedIds) {
  return postJson("/api/groups/reorder", { orderedIds });
}

export async function updateGroup(groupId, patch) {
  return requestJson(`/api/groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: patch });
}

export async function deleteGroup(groupId) {
  return requestJson(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
}

export async function createProject(project) {
  return postJson("/api/projects", project);
}

export async function updateProject(projectId, patch) {
  return requestJson(`/api/projects/${projectId}`, { method: "PATCH", body: patch });
}

export async function deleteProject(projectId, taskPolicy = "retain") {
  return requestJson(`/api/projects/${projectId}?taskPolicy=${encodeURIComponent(taskPolicy)}`, { method: "DELETE" });
}

// Membership lives in two places on the server, so moving is its own operation rather than a patch.
export async function getDuplicateDocuments() {
  return requestJson("/api/documents/duplicates");
}

export async function setDocumentArchived(documentId, archived) {
  return postJson(`/api/documents/${encodeURIComponent(documentId)}/archive`, { archived });
}

export async function moveDocumentToProject(documentId, projectId) {
  return postJson(`/api/documents/${encodeURIComponent(documentId)}/move`, { projectId });
}

// Show the file in Finder. Only the document id travels; the server knows where the file is.
export async function revealDocument(documentId) {
  return postJson(`/api/documents/${encodeURIComponent(documentId)}/reveal`, {});
}

export async function updateDocument(documentId, patch) {
  return requestJson(`/api/documents/${documentId}`, { method: "PATCH", body: patch });
}

export async function refreshDocument(documentId, { clearAnnotations = false, file = null, path = "" } = {}) {
  if (file) {
    const form = new FormData();
    form.append("file", file);
    form.append("clearAnnotations", String(clearAnnotations));
    const response = await fetch(`/api/documents/${documentId}/refresh`, { method: "POST", body: form });
    if (!response.ok) throw await responseError(response, "Refresh failed");
    return response.json();
  }
  return requestJson(`/api/documents/${documentId}/refresh`, { method: "POST", body: { clearAnnotations, path } });
}

export async function restoreDocumentVersion(documentId, versionId) {
  return requestJson(`/api/documents/${documentId}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
}

export async function clearAnnotations(documentId, page = null) {
  const endpoint = page == null
    ? `/api/documents/${documentId}/annotations`
    : `/api/documents/${documentId}/pages/${page}/annotations`;
  return requestJson(endpoint, { method: "DELETE" });
}

export async function replyToReviewThread(threadId, payload) {
  return requestJson(`/api/review/threads/${threadId}/messages`, { method: "POST", body: payload });
}

export async function updateReviewThread(threadId, payload) {
  return requestJson(`/api/review/threads/${threadId}`, { method: "PATCH", body: payload });
}

export async function updateReviewState(threadId, payload) {
  return requestJson(`/api/review/threads/${threadId}/state`, { method: "PATCH", body: payload });
}

export async function setActiveReviewDocument(documentId) {
  return requestJson("/api/review/context", { method: "PUT", body: { documentId } });
}

export async function createReviewTask(payload) {
  return requestJson("/api/review/tasks", { method: "POST", body: payload });
}

export async function getReviewTaskChecklist(taskId) {
  return requestJson(`/api/review/tasks/${encodeURIComponent(taskId)}/checklist`);
}

export async function rotateReviewTaskToken(taskId) {
  return postJson(`/api/review/tasks/${taskId}/rotate-token`, {});
}

export async function deleteReviewTask(taskId) {
  return requestJson(`/api/review/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export function subscribeReviewEvents(onEvent, onError, onOpen) {
  const source = new EventSource("/api/events");
  for (const type of ["document.updated", "review.thread.updated", "review.thread.created", "review.task.created", "review.task.updated", "review.task.deleted", "review.context.updated", "review.sync.required", "annotations.updated", "history.updated", "annotations.cleared"]) {
    source.addEventListener(type, (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed events and keep the live connection open.
      }
    });
  }
  if (onError) source.addEventListener("error", onError);
  if (onOpen) source.addEventListener("open", onOpen);
  return () => source.close();
}

export async function reanalyzeDocument(documentId) {
  return postJson(`/api/documents/${documentId}/analyze`, {});
}

export async function getDocumentSourceInfo(documentId) {
  return requestJson(`/api/documents/${documentId}/source-info`);
}

export async function searchDocument(documentId, query, signal) {
  return requestJson(`/api/documents/${documentId}/search?q=${encodeURIComponent(query)}`, { signal });
}

export async function deleteDocument(documentId, taskPolicy = "retain") {
  return requestJson(`/api/documents/${documentId}?taskPolicy=${encodeURIComponent(taskPolicy)}`, { method: "DELETE" });
}

export async function restoreFullBackup(file) {
  const form = new FormData();
  form.append("backup", file);
  const response = await fetch("/api/backup/full/restore", { method: "POST", body: form });
  if (!response.ok) throw await responseError(response, "Restore failed");
  return response.json();
}

export async function exportAnnotations(payload, format = "json", action = "export") {
  return postJson("/api/export", { payload, format, action });
}

export async function exportReviewHtml(payload) {
  return postJson("/api/export/review-html", payload);
}

export async function exportAnnotatedPdf(documentId, scope, page, pageMode = "all", includeResolved = false) {
  const response = await fetch("/api/export/annotated-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, scope, page, pageMode, includeResolved })
  });
  if (!response.ok) throw await responseError(response, "Annotated PDF export failed");
  return {
    blob: await response.blob(),
    fileName: responseFileName(response.headers.get("content-disposition")) || "annotated-review.pdf"
  };
}

export async function openDataFolder() {
  return postJson("/api/open-data-folder", {});
}

export async function buildRevisionChecklist(payload) {
  return postJson("/api/revision-checklist", payload);
}

async function postJson(url, body) {
  return requestJson(url, { method: "POST", body });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });
  if (!response.ok) throw await responseError(response, "Request failed");
  return response.json();
}

async function responseError(response, prefix) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  const error = new Error(`${prefix}: ${payload.detail || payload.error || response.status}`);
  error.status = response.status;
  error.code = payload.error || "";
  error.payload = payload;
  return error;
}

export function isApiAvailableError(error) {
  return error instanceof TypeError || String(error?.message || "").includes("fetch");
}

function responseFileName(contentDisposition) {
  const encoded = String(contentDisposition || "").match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return "";
    }
  }
  return String(contentDisposition || "").match(/filename="([^"]+)"/i)?.[1] || "";
}
