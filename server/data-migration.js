import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function mergeLegacyDataDirectory({ sourceDir, targetDir, store }) {
  const sourceWorkspacePath = path.join(sourceDir, "workspace.json");
  if (!fs.existsSync(sourceWorkspacePath) || path.resolve(sourceDir) === path.resolve(targetDir)) return { changed: false };

  const sourceBuffer = fs.readFileSync(sourceWorkspacePath);
  const sourceHash = crypto.createHash("sha256").update(sourceBuffer).digest("hex");
  const markerPath = path.join(targetDir, "backups", "legacy-data-merges.json");
  const markers = readJson(markerPath, []);
  if (markers.some((item) => item.sourceHash === sourceHash && path.resolve(item.sourceDir || "") === path.resolve(sourceDir))) {
    return { changed: false, alreadyMerged: true };
  }

  const source = normalizeWorkspace(readJson(sourceWorkspacePath, {}));
  const target = normalizeWorkspace(store.getState());
  const realSourceDocuments = source.documents.filter(hasRealDocumentData);
  if (realSourceDocuments.length === 0) {
    writeMarkers(markerPath, markers, { sourceDir, sourceHash, mergedAt: new Date().toISOString(), documents: 0 });
    return { changed: false };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = path.join(targetDir, "backups", `data-merge-${stamp}`);
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "target-workspace-before.json"), `${JSON.stringify(target, null, 2)}\n`);
  fs.writeFileSync(path.join(snapshotDir, "source-workspace.json"), `${JSON.stringify(source, null, 2)}\n`);

  const targetDocuments = [...target.documents];
  const targetProjects = [...target.projects];
  const annotations = { ...target.annotations };
  const history = { ...target.history };
  const reviewThreads = { ...target.reviewThreads };
  const reviewTasks = { ...target.reviewTasks };
  const annotationRevisions = { ...target.annotationRevisions };
  const historyRevisions = { ...target.historyRevisions };
  const targetHashes = new Map(targetDocuments.map((document) => [document.id, documentHash(document, targetDir)]));
  const projectMap = new Map();
  const documentMap = new Map();

  for (const sourceProject of source.projects) {
    const targetProject = targetProjects.find((item) => item.id === sourceProject.id) || targetProjects.find((item) => item.name === sourceProject.name);
    if (targetProject) {
      projectMap.set(sourceProject.id, targetProject.id);
      continue;
    }
    const id = uniqueId(sourceProject.id || "project", new Set(targetProjects.map((item) => item.id)));
    const project = { ...sourceProject, id, docIds: [], updated: Number(sourceProject.updated || Date.now()) };
    targetProjects.push(project);
    projectMap.set(sourceProject.id, id);
  }

  for (const sourceDocument of realSourceDocuments) {
    const sourceHashValue = documentHash(sourceDocument, sourceDir);
    let targetDocument = targetDocuments.find((item) => item.id === sourceDocument.id);
    if (!targetDocument && sourceHashValue) {
      targetDocument = targetDocuments.find((item) => targetHashes.get(item.id) === sourceHashValue);
    }

    if (targetDocument) {
      documentMap.set(sourceDocument.id, targetDocument.id);
      if (!targetDocument.contentHash && sourceHashValue) {
        Object.assign(targetDocument, { contentHash: sourceHashValue, updated: Math.max(Number(targetDocument.updated || 0), Number(sourceDocument.updated || 0)) });
      }
      continue;
    }

    const targetId = uniqueId(sourceDocument.id || "document", new Set(targetDocuments.map((item) => item.id)));
    const targetProjectId = projectMap.get(sourceDocument.projectId) || targetProjects[0]?.id;
    const copied = copyDocumentAssets(sourceDocument, sourceDir, targetDir, targetId);
    const document = rebaseDocument(sourceDocument, sourceDir, targetDir, targetId, targetProjectId, copied, sourceHashValue);
    targetDocuments.push(document);
    targetHashes.set(targetId, sourceHashValue);
    documentMap.set(sourceDocument.id, targetId);
  }

  for (const sourceProject of source.projects) {
    const targetProjectId = projectMap.get(sourceProject.id);
    const targetProject = targetProjects.find((item) => item.id === targetProjectId);
    if (!targetProject) continue;
    const mappedIds = (sourceProject.docIds || []).map((id) => documentMap.get(id)).filter(Boolean);
    targetProject.docIds = [...new Set([...(targetProject.docIds || []), ...mappedIds])];
    targetProject.updated = Math.max(Number(targetProject.updated || 0), Number(sourceProject.updated || 0));
  }

  mergePageRecords(annotations, source.annotations, documentMap);
  mergePageRecords(history, source.history, documentMap, 200);
  mergeReviewThreads(reviewThreads, source.reviewThreads, documentMap);
  mergeRevisionRecords(annotationRevisions, source.annotationRevisions, documentMap);
  mergeRevisionRecords(historyRevisions, source.historyRevisions, documentMap);
  const merged = { projects: targetProjects, documents: targetDocuments, annotations, history, reviewThreads, reviewTasks, annotationRevisions, historyRevisions };
  store.replaceWorkspace(merged);
  writeMarkers(markerPath, markers, {
    sourceDir,
    sourceHash,
    mergedAt: new Date().toISOString(),
    documents: realSourceDocuments.length,
    documentMap: Object.fromEntries(documentMap)
  });
  return { changed: true, documentMap: Object.fromEntries(documentMap), snapshotDir };
}

function mergeRevisionRecords(target, source, documentMap) {
  for (const [key, revision] of Object.entries(source || {})) {
    const separator = key.lastIndexOf(":");
    const mappedDocumentId = documentMap.get(key.slice(0, separator));
    if (!mappedDocumentId || separator < 1) continue;
    const targetKey = `${mappedDocumentId}:${key.slice(separator + 1)}`;
    target[targetKey] = Math.max(Number(target[targetKey] || 0), Number(revision || 0));
  }
}

function mergeReviewThreads(target, source, documentMap) {
  for (const [annotationId, thread] of Object.entries(source || {})) {
    const documentId = documentMap.get(thread?.documentId);
    if (!documentId || !thread?.annotationId) continue;
    const next = { ...thread, documentId };
    const previous = target[annotationId];
    if (!previous || Number(next.updatedAt || 0) >= Number(previous.updatedAt || 0)) target[annotationId] = next;
  }
}

function copyDocumentAssets(document, sourceDir, targetDir, targetId) {
  const copied = { sourcePath: "", convertedPdfPath: "" };
  const sourceUpload = managedUploadForDocument(document, sourceDir);
  if (sourceUpload) {
    const extension = path.extname(sourceUpload) || `.${String(document.ext || "file").toLowerCase()}`;
    copied.sourcePath = path.join(targetDir, "uploads", `${targetId}${extension}`);
    fs.mkdirSync(path.dirname(copied.sourcePath), { recursive: true });
    fs.copyFileSync(sourceUpload, copied.sourcePath);
  }

  const sourceRenderDir = path.join(sourceDir, "renders", document.id);
  const targetRenderDir = path.join(targetDir, "renders", targetId);
  if (fs.existsSync(sourceRenderDir)) {
    fs.cpSync(sourceRenderDir, targetRenderDir, { recursive: true, force: false, errorOnExist: true });
    const converted = findConvertedPdf(targetRenderDir);
    if (converted) copied.convertedPdfPath = converted;
  }
  return copied;
}

function rebaseDocument(document, sourceDir, targetDir, targetId, projectId, copied, contentHash) {
  const oldRenderPrefix = `/api/renders/${document.id}/`;
  const newRenderPrefix = `/api/renders/${targetId}/`;
  const oldUploadPrefix = `/api/uploads/${document.id}`;
  const newUploadPrefix = `/api/uploads/${targetId}`;
  return {
    ...document,
    id: targetId,
    projectId,
    sourcePath: copied.sourcePath || rebaseManagedPath(document.sourcePath, sourceDir, targetDir),
    convertedPdfPath: copied.convertedPdfPath || rebaseManagedPath(document.convertedPdfPath, sourceDir, targetDir),
    originalPath: isManagedPath(document.originalPath, sourceDir) ? "" : document.originalPath || "",
    contentHash: contentHash || document.contentHash || "",
    pages: (document.pages || []).map((page) => ({
      ...page,
      imageUrl: page.imageUrl?.replace(oldRenderPrefix, newRenderPrefix),
      sourceUrl: page.sourceUrl?.replace(oldUploadPrefix, newUploadPrefix)
    })),
    updated: Number(document.updated || Date.now())
  };
}

function mergePageRecords(target, source, documentMap, limit = Infinity) {
  for (const [key, sourceItems] of Object.entries(source || {})) {
    if (!Array.isArray(sourceItems)) continue;
    const separator = key.lastIndexOf(":");
    const mappedDocumentId = documentMap.get(key.slice(0, separator));
    if (!mappedDocumentId) continue;
    const targetKey = `${mappedDocumentId}:${key.slice(separator + 1)}`;
    const byId = new Map((target[targetKey] || []).map((item) => [item.id || JSON.stringify(item), item]));
    for (const item of sourceItems) {
      const itemKey = item.id || JSON.stringify(item);
      const previous = byId.get(itemKey);
      if (!previous || Number(item.updatedAt || item.ts || 0) >= Number(previous.updatedAt || previous.ts || 0)) byId.set(itemKey, item);
    }
    target[targetKey] = [...byId.values()].sort((a, b) => Number(b.ts || b.createdAt || 0) - Number(a.ts || a.createdAt || 0)).slice(0, limit);
  }
}

function documentHash(document, dataDir) {
  if (document.contentHash) return document.contentHash;
  const filePath = managedUploadForDocument(document, dataDir) || (document.sourcePath && fs.existsSync(document.sourcePath) ? document.sourcePath : "");
  if (!filePath) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function managedUploadForDocument(document, dataDir) {
  if (document.sourcePath && isManagedPath(document.sourcePath, dataDir) && fs.existsSync(document.sourcePath)) return document.sourcePath;
  const uploadDir = path.join(dataDir, "uploads");
  if (!fs.existsSync(uploadDir)) return "";
  const fileName = fs.readdirSync(uploadDir).find((file) => file === document.id || file.startsWith(`${document.id}.`));
  return fileName ? path.join(uploadDir, fileName) : "";
}

function hasRealDocumentData(document) {
  return Boolean(document?.sourcePath || document?.originalPath || document?.pages?.length);
}

function normalizeWorkspace(raw) {
  const workspace = raw?.workspace || raw || {};
  return {
    projects: Array.isArray(workspace.projects) ? structuredClone(workspace.projects) : [],
    documents: Array.isArray(workspace.documents) ? structuredClone(workspace.documents) : [],
    annotations: workspace.annotations && typeof workspace.annotations === "object" ? structuredClone(workspace.annotations) : {},
    history: workspace.history && typeof workspace.history === "object" ? structuredClone(workspace.history) : {},
    reviewThreads: workspace.reviewThreads && typeof workspace.reviewThreads === "object" ? structuredClone(workspace.reviewThreads) : {},
    reviewTasks: workspace.reviewTasks && typeof workspace.reviewTasks === "object" ? structuredClone(workspace.reviewTasks) : {},
    annotationRevisions: workspace.annotationRevisions && typeof workspace.annotationRevisions === "object" ? structuredClone(workspace.annotationRevisions) : {},
    historyRevisions: workspace.historyRevisions && typeof workspace.historyRevisions === "object" ? structuredClone(workspace.historyRevisions) : {}
  };
}

function findConvertedPdf(directory) {
  if (!fs.existsSync(directory)) return "";
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findConvertedPdf(absolutePath);
      if (nested) return nested;
    } else if (entry.name.toLowerCase().endsWith(".pdf")) {
      return absolutePath;
    }
  }
  return "";
}

function rebaseManagedPath(filePath, sourceDir, targetDir) {
  if (!isManagedPath(filePath, sourceDir)) return filePath || "";
  return path.join(targetDir, path.relative(sourceDir, path.resolve(filePath)));
}

function isManagedPath(filePath, dataDir) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const root = path.resolve(dataDir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function uniqueId(preferred, used) {
  if (!used.has(preferred)) return preferred;
  let index = 2;
  while (used.has(`${preferred}-${index}`)) index += 1;
  return `${preferred}-${index}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeMarkers(markerPath, markers, record) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify([...markers, record].slice(-50), null, 2)}\n`);
}
