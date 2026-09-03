import React, { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import "@fontsource/onest/latin-400.css";
import "@fontsource/onest/latin-500.css";
import "@fontsource/onest/latin-600.css";
import "@fontsource/onest/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import {
  AlignLeft,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BadgeAlert,
  Bookmark,
  BookmarkPlus,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  ClipboardCheck,
  Code2,
  Copy,
  Crop,
  Download,
  Ellipsis,
  File,
  FileText,
  FileUp,
  FilterX,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Image as ImageIcon,
  Info,
  Link2,
  ListChecks,
  ListFilter,
  Lock,
  MapPinPlus,
  MessageSquareText,
  MousePointer2,
  Pencil,
  Pin,
  Plus,
  Presentation,
  Quote,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Rows3,
  Scan,
  Search,
  SearchX,
  SquareDashedMousePointer,
  StickyNote,
  Table2,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { ACCENT, DOCTYPE, TAGS } from "./data/seed";
import {
  ANNOTATION_STATES,
  annotationOverlayVisible,
  annotationReviewState,
  annotationStateTag,
  annotationThreadStatus
} from "./lib/annotation-state";
import { annotationGroupCount, annotationMarkerLabels, buildAnnotationListGroups, withAnnotationDisplayLabels } from "./lib/annotation-list";
import { addOutlineDisplayNumbers, buildOutlineTree } from "./lib/outline-tree";
import { isPageNumberTitle, normalizePageNumberTitle, pageLabel } from "./lib/page-title";
import { loadPendingChanges, pendingChangeSummary, savePendingChanges } from "./lib/pending-store";
import { buildTextAnchor, contextForExport, normalizeSelectedText, quoteWithContext, rangeText } from "./lib/text-selection";
import { isUnmappableText } from "./lib/text-encoding";
import { clientRectToPageRect, continuousActivePage, MAX_ZOOM, MIN_ZOOM, rotatedPageSize, ZOOM_STEP } from "./lib/viewer";
import {
  archiveAnnotation,
  createGroup,
  deleteGroup,
  getDuplicateDocuments,
  reorderGroups,
  updateGroup,
  clearAnnotations,
  buildRevisionChecklist,
  createProject,
  deleteDocument,
  deleteProject,
  exportAnnotatedPdf,
  exportAnnotations,
  exportReviewHtml,
  getDiagnostics,
  getDocumentSourceInfo,
  getHealth,
  getRecoveryState,
  getWorkspace,
  importDocumentPath,
  importDocumentUrl,
  moveDocumentToProject,
  readRegionText,
  setDocumentArchived,
  revealDocument,
  isApiAvailableError,
  openDataFolder,
  reanalyzeDocument,
  refreshDocument,
  replyToReviewThread,
  restoreDocumentVersion,
  restoreFullBackup,
  restoreWorkspaceSnapshot,
  searchDocument,
  setActiveReviewDocument,
  subscribeReviewEvents,
  syncPageAnnotations,
  syncPageHistory,
  updateDocument,
  updateProject,
  updateReviewState,
  uploadDocument
} from "./lib/api";
import { classifyImportSource, describeImportSourceProblem, splitImportSources } from "./lib/import-source";
import { missingToolMessage, runtimeReadiness } from "./lib/runtime-tools";
import "./styles.css";

// A handler whose identity never changes but which always runs the latest closure. Memoised child
// components need stable props to skip work; hand-written dependency arrays over this much state
// would invite exactly the stale-closure bugs they are meant to avoid.
function useStableCallback(handler) {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  return useCallback((...args) => ref.current?.(...args), []);
}

const ANNOTATION_TYPE_LABELS = {
  note: "整页备注",
  pin: "标记",
  region: "框选",
  text: "文字批注"
};

const EMPTY_OVERLAY_ITEMS = Object.freeze([]);
const EMPTY_OVERLAY_MAP = new Map();

const STORAGE_KEY = "review-annotation-workspace-v1";
const PAGE_FLOW_KEY = "review-annotation-page-flow";
const DOCUMENT_ACCEPT = ".pdf,image/*,.md,.markdown,.txt,.csv,.tsv,.html,.htm,.ppt,.pptx,.doc,.docx,.xls,.xlsx";
const PdfPage = lazy(() => import("./PdfPage").then((module) => ({ default: module.PdfPage })));

function App() {
  const saved = useMemo(readSavedWorkspace, []);
  const [projects, setProjects] = useState([]);
  const [groups, setGroups] = useState([]);
  const [documents, setDocuments] = useState({});
  const [annotations, setAnnotations] = useState({});
  const [history, setHistory] = useState({});
  const [reviewThreads, setReviewThreads] = useState({});
  const [reviewTasks, setReviewTasks] = useState([]);
  const [, setReviewContext] = useState({ scope: "none", documentId: "" });
  const [view, setView] = useState("projects");
  const [currentProjectId, setCurrentProjectId] = useState(saved?.currentProjectId || "p1");
  const [currentDocId, setCurrentDocId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [mode, setMode] = useState("text");
  const [panelTab, setPanelTab] = useState("annotate");
  const [filterAnnotated, setFilterAnnotated] = useState(false);
  const [selectedAnnoId, setSelectedAnnoId] = useState(null);
  const [relocatingAnnotation, setRelocatingAnnotation] = useState(null);
  const [dragRect, setDragRect] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState("doc");
  const [exportFormat, setExportFormat] = useState("prompt");
  const [pdfPageMode, setPdfPageMode] = useState("all");
  const [exportIncludeResolved, setExportIncludeResolved] = useState(false);
  const [exportConversationMode, setExportConversationMode] = useState("full");
  const [exportIncludeLocalPaths, setExportIncludeLocalPaths] = useState(false);
  const [pageSearch, setPageSearch] = useState("");
  const [annotationFilter, setAnnotationFilter] = useState("all");
  const [viewer, setViewer] = useState({ zoom: 1, rotation: 0 });
  const [pageFlow, setPageFlow] = useState(() => window.localStorage.getItem(PAGE_FLOW_KEY) === "continuous" ? "continuous" : "single");
  const [copied, setCopied] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [syncState, setSyncState] = useState("local");
  const [refreshState, setRefreshState] = useState("idle");
  const [refreshNotice, setRefreshNotice] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [runtimeTools, setRuntimeTools] = useState(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [runtimeNoticeDismissed, setRuntimeNoticeDismissed] = useState(false);
  const [recovery, setRecovery] = useState(null);
  const [aiCopyState, setAiCopyState] = useState("");
  const [pendingSummary, setPendingSummary] = useState(null);
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [projectRenameOpen, setProjectRenameOpen] = useState(false);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [duplicateReview, setDuplicateReview] = useState(null);
  // Per-annotation status of reading an unreadable quote off the rendered page.
  const [quoteRecovery, setQuoteRecovery] = useState({});
  const [appDialog, setAppDialog] = useState(null);
  const canPickTrackedPath = Boolean(window.reviewAnnotationDesktop?.pickDocumentPath);
  const canResolveFilePath = Boolean(window.reviewAnnotationDesktop?.getFilePath);
  const dragStart = useRef(null);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const dirtyPageKeys = useRef(new Map());
  const dirtyHistoryKeys = useRef(new Map());
  const archivingAnnotationIds = useRef(new Set());
  const saveQueue = useRef(Promise.resolve());
  const clientRevision = useRef(Date.now());
  const dialogResolver = useRef(null);

  const requestAppDialog = (options) => new Promise((resolve) => {
    dialogResolver.current?.(null);
    dialogResolver.current = resolve;
    setAppDialog({ id: Date.now(), ...options });
  });
  const resolveAppDialog = (value) => {
    const resolve = dialogResolver.current;
    dialogResolver.current = null;
    setAppDialog(null);
    resolve?.(value);
  };
  const alertUser = (message, title = "提示") => requestAppDialog({ type: "alert", title, message });
  const confirmUser = (message, title = "确认操作", destructive = false) => requestAppDialog({ type: "confirm", title, message, destructive });
  // Default to keeping linked review tasks: a task snapshot is self-contained review evidence and
  // outlives the live document by design. The user can opt into removing them.
  const confirmDeletion = (message, title, taskCleanupCount = 0) =>
    requestAppDialog({ type: "confirm", title, message, destructive: true, taskCleanupCount, taskCleanupDefault: false });
  const promptUser = (title, defaultValue = "") => requestAppDialog({ type: "prompt", title, message: "请输入新的名称。", defaultValue });
  // Some decisions are not yes-or-no. Importing a file the project already has is a choice between
  // updating what is there and keeping both, and folding either one onto "取消" would misreport it.
  const chooseUser = (message, title, choices) => requestAppDialog({ type: "choice", title, message, choices });
  const nextClientRevision = () => {
    clientRevision.current = Math.max(Date.now(), clientRevision.current + 1);
    return clientRevision.current;
  };

  // The server-issued revision this client last saw for each page key. Echoing it back is what
  // makes the conflict check real: a client that has not seen the current state cannot overwrite it.
  const pageRevisions = useRef(new Map());
  const rememberPageRevision = (key, revision) => {
    const value = Number(revision ?? 0);
    if (Number.isFinite(value) && value >= 0) pageRevisions.current.set(key, value);
  };
  // stale_annotations reports annotationsClearedAt, which is not a page revision. Read the real one
  // back rather than guessing, so the deliberate overwrite lands on the first retry.
  const currentPageRevision = async (documentId, page) => {
    try {
      const workspace = await getWorkspace();
      return Number(workspace.annotationRevisions?.[`${documentId}:${page}`] || 0);
    } catch {
      return 0;
    }
  };

  const forgetPageRevisions = (predicate) => {
    for (const key of [...pageRevisions.current.keys()]) {
      if (predicate(key)) pageRevisions.current.delete(key);
    }
  };

  const discardPendingAnnotations = (documentIds) => {
    const ids = documentIds instanceof Set ? documentIds : new Set(documentIds);
    for (const key of dirtyPageKeys.current.keys()) {
      if (ids.has(key.split(":")[0])) dirtyPageKeys.current.delete(key);
    }
    for (const key of dirtyHistoryKeys.current.keys()) {
      if (ids.has(key.split(":")[0])) dirtyHistoryKeys.current.delete(key);
    }
  };

  const discardOutOfRangePageData = (documentId, pageCount) => {
    const prefix = `${documentId}:`;
    const isOutOfRange = (key) => key.startsWith(prefix) && Number(key.slice(prefix.length)) > Number(pageCount);
    for (const key of [...dirtyPageKeys.current.keys()]) {
      if (isOutOfRange(key)) dirtyPageKeys.current.delete(key);
    }
    for (const key of [...dirtyHistoryKeys.current.keys()]) {
      if (isOutOfRange(key)) dirtyHistoryKeys.current.delete(key);
    }
  };

  const project = projects.find((item) => item.id === currentProjectId) || projects[0];
  const doc = currentDocId ? documents[currentDocId] : null;
  useEffect(() => {
    if (!hydrated || view !== "workspace" || !currentDocId || documents[currentDocId]) return;
    setView("projects");
    setCurrentDocId(null);
  }, [hydrated, view, currentDocId, documents]);
  const pageKey = doc ? `${doc.id}:${currentPage}` : "";
  const pageAnnotations = annotations[pageKey] || [];
  const noteAnno = pageAnnotations.find((item) => item.type === "note" && item.createdBy !== "assistant");
  const markItems = pageAnnotations.filter((item) => item.id !== noteAnno?.id);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceLoadError("");
    getWorkspace()
      .then(async (workspace) => {
        if (cancelled) return;
        const docs = Object.fromEntries((workspace.documents || []).map((item) => [item.id, item]));
        const pending = await loadPendingChanges().catch(() => null);
        let serverProjects = workspace.projects || [];
        if (serverProjects.length === 0) {
          const result = await createProject(createDefaultProject());
          serverProjects = [result.project];
        }
        if (cancelled) return;
        const projectsWithDocs = attachDocumentsToProjects(serverProjects, docs);
        setProjects(projectsWithDocs);
        setGroups(workspace.groups || []);
        setDocuments(docs);
        // Seed from the server first; the restored offline edits then overwrite each dirty page with
        // the revision it was actually made against, so reconnecting conflicts only when it should.
        for (const [key, revision] of Object.entries(workspace.annotationRevisions || {})) rememberPageRevision(key, revision);
        const restoredAnnotations = restorePendingMap(workspace.annotations || {}, pending?.annotations, docs, dirtyPageKeys.current, pageRevisions.current);
        const restoredHistory = restorePendingMap(workspace.history || {}, pending?.history, docs, dirtyHistoryKeys.current);
        setAnnotations(restoredAnnotations);
        setReviewThreads(workspace.reviewThreads || {});
        setReviewTasks(workspace.reviewTasks || []);
        setReviewContext(workspace.reviewContext || { scope: "none", documentId: "" });
        const legacyHistory = filterHistoryForDocuments(saved?.history || {}, docs);
        const mergedHistory = mergeHistoryMaps(restoredHistory, legacyHistory);
        setHistory(mergedHistory);
        for (const key of Object.keys(legacyHistory)) dirtyHistoryKeys.current.set(key, nextClientRevision());
        setCurrentProjectId((current) => projectsWithDocs.some((item) => item.id === current) ? current : projectsWithDocs[0]?.id || "p1");
        setSyncState("synced");
        setHydrated(true);
        setWorkspaceLoadError("");
      })
      .catch((error) => {
        if (!cancelled) {
          setSyncState("offline");
          setHydrated(false);
          // Queued edits live in IndexedDB. If the workspace will not load they are otherwise
          // invisible, which reads as data loss even though nothing has been lost.
          loadPendingChanges()
            .then((pending) => {
              const summary = pendingChangeSummary(pending);
              setPendingSummary(summary.hasPending ? summary : null);
            })
            .catch(() => setPendingSummary(null));
          if (error?.code === "workspace_recovery_required") {
            getRecoveryState().then((state) => setRecovery(state)).catch(() => setRecovery(null));
          }
          setWorkspaceLoadError(error.payload?.detail || error.message || "本地工作区无法读取。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceLoadAttempt]);

  useEffect(() => {
    if (!workspaceLoadError) return undefined;
    const retry = () => setWorkspaceLoadAttempt((value) => value + 1);
    window.addEventListener("online", retry, { once: true });
    return () => window.removeEventListener("online", retry);
  }, [workspaceLoadError]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ currentProjectId }));
    } catch {
      setSyncState("error");
    }
  }, [currentProjectId, hydrated]);

  const flushPendingChanges = () => {
    const run = async () => {
      const pendingEntries = [...dirtyPageKeys.current.entries()];
      const pendingHistoryEntries = [...dirtyHistoryKeys.current.entries()];
      if (pendingEntries.length === 0 && pendingHistoryEntries.length === 0) return;
      const payloads = pendingEntries.map(([key, updatedAt]) => {
        const separator = key.lastIndexOf(":");
        return {
          key,
          documentId: key.slice(0, separator),
          page: Number(key.slice(separator + 1)),
          annotations: annotations[key] || [],
          updatedAt,
          expectedRevision: pageRevisions.current.get(key) ?? 0
        };
      });
      const historyPayloads = pendingHistoryEntries.map(([key, updatedAt]) => {
        const separator = key.lastIndexOf(":");
        return {
          key,
          documentId: key.slice(0, separator),
          page: Number(key.slice(separator + 1)),
          history: history[key] || [],
          updatedAt
        };
      });
      setSyncState("saving");
      try {
        await Promise.all([
          ...payloads.map((payload) => syncPageAnnotations(payload.documentId, payload.page, payload.annotations, payload.updatedAt, payload.expectedRevision)
            .then((result) => rememberPageRevision(payload.key, result.revision))),
          ...historyPayloads.map((payload) => syncPageHistory(payload.documentId, payload.page, payload.history, payload.updatedAt))
        ]);
        pendingEntries.forEach(([key, updatedAt]) => {
          if (dirtyPageKeys.current.get(key) === updatedAt) dirtyPageKeys.current.delete(key);
        });
        pendingHistoryEntries.forEach(([key, updatedAt]) => {
          if (dirtyHistoryKeys.current.get(key) === updatedAt) dirtyHistoryKeys.current.delete(key);
        });
        setSyncState(dirtyPageKeys.current.size || dirtyHistoryKeys.current.size ? "saving" : "synced");
      } catch (error) {
        const conflictKey = error.payload?.documentId && error.payload?.page ? `${error.payload.documentId}:${error.payload.page}` : "";
        const annotationConflict = error.code === "annotation_conflict" || error.code === "stale_annotations";
        if (annotationConflict && conflictKey) {
          const payload = payloads.find((item) => item.key === conflictKey);
          if (payload && dirtyPageKeys.current.get(conflictKey) === payload.updatedAt) {
            const latest = error.payload.annotations || [];
            const keepLocal = await confirmUser(
              "这页批注已在另一个窗口中发生变化。\n\n选择“继续”会保留并重新保存当前窗口的版本；选择“取消”会采用工作区中的最新版本，当前版本仍可用“重做”恢复。",
              "批注保存冲突"
            );
            if (keepLocal) {
              const retryRevision = Math.max(nextClientRevision(), Number(error.payload.revision || 0) + 1);
              dirtyPageKeys.current.set(conflictKey, retryRevision);
              // Keeping the local version means deliberately writing over what the server holds, so
              // echo its current revision. A stale_annotations conflict reports annotationsClearedAt
              // rather than a page revision, so re-read the page's real one instead of echoing that.
              const currentRevision = error.code === "annotation_conflict"
                ? Number(error.payload.revision || 0)
                : await currentPageRevision(payload.documentId, payload.page);
              rememberPageRevision(conflictKey, currentRevision);
              try {
                const retried = await syncPageAnnotations(payload.documentId, payload.page, payload.annotations, retryRevision, currentRevision);
                rememberPageRevision(conflictKey, retried.revision);
                if (dirtyPageKeys.current.get(conflictKey) === retryRevision) dirtyPageKeys.current.delete(conflictKey);
              } catch (retryError) {
                // One retry is enough; leave the page dirty so the next flush tries again rather
                // than letting the rejection escape and strand the UI on "saving".
                rememberPageRevision(conflictKey, retryError.payload?.revision);
                setSyncState(isApiAvailableError(retryError) ? "offline" : "error");
              }
            } else {
              dirtyPageKeys.current.delete(conflictKey);
              rememberPageRevision(conflictKey, error.payload.revision);
              redoStack.current.push({ key: conflictKey, before: cloneValue(latest), after: cloneValue(payload.annotations), coalesceKey: "", ts: Date.now() });
              setAnnotations((prev) => setAnnotationPage(prev, conflictKey, latest));
            }
          }
        }
        if (error.code === "history_conflict" && conflictKey) {
          const payload = historyPayloads.find((item) => item.key === conflictKey);
          if (payload && dirtyHistoryKeys.current.get(conflictKey) === payload.updatedAt) {
            const merged = mergeHistoryRecords(error.payload.history || [], payload.history);
            const retryRevision = Math.max(nextClientRevision(), Number(error.payload.revision || 0) + 1);
            dirtyHistoryKeys.current.set(conflictKey, retryRevision);
            setHistory((prev) => setRecordPage(prev, conflictKey, merged));
            await syncPageHistory(payload.documentId, payload.page, merged, retryRevision);
            if (dirtyHistoryKeys.current.get(conflictKey) === retryRevision) dirtyHistoryKeys.current.delete(conflictKey);
          }
        }
        if (annotationConflict || error.code === "history_conflict") {
          setSyncState(dirtyPageKeys.current.size || dirtyHistoryKeys.current.size ? "saving" : "synced");
          return;
        }
        setSyncState(isApiAvailableError(error) ? "offline" : "error");
        throw error;
      }
    };
    const queued = saveQueue.current.catch(() => undefined).then(run);
    saveQueue.current = queued;
    return queued;
  };

  useEffect(() => {
    if (!hydrated || (dirtyPageKeys.current.size === 0 && dirtyHistoryKeys.current.size === 0)) return undefined;
    const timer = window.setTimeout(() => {
      flushPendingChanges().catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [annotations, history, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const snapshot = pendingChangesSnapshot(annotations, history, dirtyPageKeys.current, dirtyHistoryKeys.current, pageRevisions.current);
    savePendingChanges(snapshot).catch(() => setSyncState("error"));
  }, [annotations, history, hydrated, syncState]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const retryPending = () => {
      if (dirtyPageKeys.current.size || dirtyHistoryKeys.current.size) flushPendingChanges().catch(() => undefined);
    };
    window.addEventListener("online", retryPending);
    window.addEventListener("focus", retryPending);
    return () => {
      window.removeEventListener("online", retryPending);
      window.removeEventListener("focus", retryPending);
    };
  }, [annotations, history, hydrated]);

  useEffect(() => {
    if (!doc?.id || !hydrated) return;
    let cancelled = false;
    const refreshSourceInfo = () => {
      getDocumentSourceInfo(doc.id)
        .then((result) => {
          if (cancelled) return;
          setDocuments((prev) => ({
            ...prev,
            [doc.id]: {
              ...prev[doc.id],
              sourceModifiedAt: result.sourceModifiedAt,
              sourceSize: result.sourceSize,
              sourceReadable: result.sourceReadable,
              sourceLabel: result.sourceLabel,
              sourceTracked: result.sourceTracked,
              sourceMissing: result.sourceMissing,
              hasNewerSource: result.hasNewerSource,
              refreshedAt: result.refreshedAt || prev[doc.id]?.refreshedAt
            }
          }));
        })
        .catch(() => undefined);
    };
    refreshSourceInfo();
    const timer = window.setInterval(refreshSourceInfo, 30000);
    window.addEventListener("focus", refreshSourceInfo);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshSourceInfo);
    };
  }, [doc?.id, hydrated]);

  useEffect(() => {
    if (!hydrated) return undefined;
    let reconciling = false;
    const reconcileWorkspace = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        const workspace = await getWorkspace();
        const remoteDocuments = Object.fromEntries((workspace.documents || []).map((item) => [item.id, item]));
        setDocuments(remoteDocuments);
        setProjects(attachDocumentsToProjects(workspace.projects || [], remoteDocuments));
        setGroups(workspace.groups || []);
        for (const [key, revision] of Object.entries(workspace.annotationRevisions || {})) {
          if (!dirtyPageKeys.current.has(key)) rememberPageRevision(key, revision);
        }
        setAnnotations((local) => mergeRemotePageMap(local, workspace.annotations || {}, dirtyPageKeys.current));
        setHistory((local) => mergeRemotePageMap(local, workspace.history || {}, dirtyHistoryKeys.current));
        setReviewThreads(workspace.reviewThreads || {});
        setReviewTasks(workspace.reviewTasks || []);
        setReviewContext(workspace.reviewContext || { scope: "none", documentId: "" });
        setSyncState(dirtyPageKeys.current.size || dirtyHistoryKeys.current.size ? "saving" : "synced");
      } catch {
        setSyncState("offline");
      } finally {
        reconciling = false;
      }
    };
    return subscribeReviewEvents((event) => {
      if (event.type === "review.sync.required") {
        reconcileWorkspace();
        return;
      }
      if (event.type === "review.context.updated" && event.context) {
        setReviewContext(event.context);
        return;
      }
      if (event.type === "document.updated" && event.document) {
        setDocuments((prev) => ({ ...prev, [event.document.id]: event.document }));
        return;
      }
      if (event.type === "review.thread.updated" && event.thread) {
        setReviewThreads((prev) => ({ ...prev, [event.thread.id]: event.thread }));
        return;
      }
      if (event.type === "review.thread.created" && event.thread) {
        const key = `${event.documentId}:${event.page}`;
        if (!dirtyPageKeys.current.has(key)) {
          rememberPageRevision(key, event.revision);
          setAnnotations((prev) => setAnnotationPage(prev, key, event.annotations || []));
        }
        setReviewThreads((prev) => ({ ...prev, [event.thread.id]: event.thread }));
        return;
      }
      if ((event.type === "review.task.created" || event.type === "review.task.updated") && event.task) {
        setReviewTasks((prev) => [event.task, ...prev.filter((task) => task.id !== event.task.id)]
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)));
        return;
      }
      if (event.type === "review.task.deleted" && event.taskId) {
        setReviewTasks((prev) => prev.filter((task) => task.id !== event.taskId));
        return;
      }
      if (event.type === "annotations.updated") {
        const key = `${event.documentId}:${event.page}`;
        // Only adopt the revision when this client also adopts the content. A dirty page keeps the
        // revision it last saw, so its next flush conflicts instead of silently overwriting a change
        // it never merged — which is how an AI-written annotation used to disappear.
        if (!dirtyPageKeys.current.has(key)) {
          rememberPageRevision(key, event.revision);
          const nextAnnotations = event.annotations || [];
          const nextIds = new Set(nextAnnotations.map((item) => item.id));
          setAnnotations((prev) => setAnnotationPage(prev, key, nextAnnotations));
          setReviewThreads((prev) => Object.fromEntries(Object.entries(prev).filter(([annotationId, thread]) => (
            thread.documentId !== event.documentId
            || Number(thread.page) !== Number(event.page)
            || nextIds.has(annotationId)
          ))));
        }
        return;
      }
      if (event.type === "history.updated") {
        const key = `${event.documentId}:${event.page}`;
        if (!dirtyHistoryKeys.current.has(key)) setHistory((prev) => setRecordPage(prev, key, event.history || []));
        return;
      }
      if (event.type === "annotations.cleared") {
        const pagePrefix = `${event.documentId}:`;
        if (event.scope === "page") rememberPageRevision(`${event.documentId}:${event.page}`, event.clearedAt);
        else forgetPageRevisions((key) => key.startsWith(pagePrefix));
        setAnnotations((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => event.scope === "page" ? key !== `${event.documentId}:${event.page}` : !key.startsWith(pagePrefix))));
        if (event.historyPages) setHistory((prev) => ({ ...prev, ...event.historyPages }));
        setReviewThreads((prev) => Object.fromEntries(Object.entries(prev).filter(([, thread]) => event.scope === "page"
          ? !(thread.documentId === event.documentId && Number(thread.page) === Number(event.page))
          : thread.documentId !== event.documentId)));
      }
    }, () => setSyncState((current) => current === "saving" ? current : "offline"), reconcileWorkspace);
  }, [hydrated]);

  useEffect(() => {
    // Leaving the workspace closes the AI's window onto the document too. Without this the
    // current-document MCP connection kept reading whatever was open last.
    if (!hydrated || view === "workspace") return;
    setActiveReviewDocument("")
      .then((result) => {
        if (result.context) setReviewContext(result.context);
      })
      .catch(() => {});
  }, [hydrated, view]);

  useEffect(() => {
    if (!hydrated || view !== "workspace" || !doc?.id) return undefined;
    let cancelled = false;
    const activateDocument = () => {
      if (document.visibilityState === "hidden") return;
      setActiveReviewDocument(doc.id)
        .then((result) => {
          if (!cancelled && result.context) setReviewContext(result.context);
        })
        .catch(() => {
          if (!cancelled) setSyncState("error");
        });
    };
    activateDocument();
    window.addEventListener("focus", activateDocument);
    document.addEventListener("visibilitychange", activateDocument);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", activateDocument);
      document.removeEventListener("visibilitychange", activateDocument);
    };
  }, [doc?.id, hydrated, view]);

  const checkRuntimeTools = async () => {
    setRuntimeChecking(true);
    try {
      const health = await getHealth();
      setRuntimeTools(health.tools || {});
    } catch {
      // The API being unreachable is already reported through syncState; leave the panel closed
      // rather than claiming every tool is missing.
      setRuntimeTools(null);
    } finally {
      setRuntimeChecking(false);
    }
  };

  useEffect(() => {
    checkRuntimeTools();
  }, []);

  const describeOperationError = (error) => {
    if (error?.code !== "runtime_tool_missing") return error?.message || "未知错误。";
    checkRuntimeTools();
    return missingToolMessage(error.payload?.detail || error.message, error.payload?.tool);
  };

  const openDoc = (id) => {
    const targetDocument = documents[id];
    if (targetDocument?.projectId) setCurrentProjectId(targetDocument.projectId);
    setCurrentDocId(id);
    setCurrentPage(1);
    setView("workspace");
    // Text remains the primary review mode. Scanned documents request OCR on demand.
    setMode("text");
    setPanelTab("annotate");
    setSelectedAnnoId(null);
    setRelocatingAnnotation(null);
    setFilterAnnotated(false);
    setViewer({ zoom: 1, rotation: 0 });
    setRefreshNotice(null);
  };

  const goPage = (page) => {
    if (!doc) return;
    setCurrentPage(Math.max(1, Math.min(doc.pageCount, page)));
    setSelectedAnnoId(null);
    setRelocatingAnnotation(null);
    setDragRect(null);
  };

  const commitPageAnnotations = (updater, { coalesceKey = "", targetKey = pageKey } = {}) => {
    if (!targetKey) return;
    setAnnotations((prev) => {
      const before = cloneValue(prev[targetKey] || []);
      const after = cloneValue(typeof updater === "function" ? updater(prev[targetKey] || []) : updater);
      if (JSON.stringify(before) === JSON.stringify(after)) return prev;
      const now = nextClientRevision();
      const previousEntry = undoStack.current.at(-1);
      if (coalesceKey && previousEntry?.key === targetKey && previousEntry.coalesceKey === coalesceKey && now - previousEntry.ts < 1200) {
        previousEntry.after = after;
        previousEntry.ts = now;
      } else {
        undoStack.current.push({ key: targetKey, before, after, coalesceKey, ts: now });
        if (undoStack.current.length > 100) undoStack.current.splice(0, undoStack.current.length - 100);
      }
      redoStack.current = [];
      dirtyPageKeys.current.set(targetKey, now);
      if (after.length === 0) {
        const next = { ...prev };
        delete next[targetKey];
        return next;
      }
      return { ...prev, [targetKey]: after };
    });
  };

  const undoAnnotations = () => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(entry);
    dirtyPageKeys.current.set(entry.key, nextClientRevision());
    setAnnotations((prev) => setAnnotationPage(prev, entry.key, entry.before));
  };

  const redoAnnotations = () => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    undoStack.current.push(entry);
    dirtyPageKeys.current.set(entry.key, nextClientRevision());
    setAnnotations((prev) => setAnnotationPage(prev, entry.key, entry.after));
  };

  const logHistory = (key, action, label, rev = "", snapshot = null, details = {}) => {
    const item = { id: id("h"), action, label, ts: Date.now(), rev, ...(snapshot ? { snapshot } : {}), ...details };
    dirtyHistoryKeys.current.set(key, nextClientRevision());
    setHistory((prev) => ({ ...prev, [key]: [item, ...(prev[key] || [])].slice(0, 200) }));
  };

  const addAnnotation = (item, targetPage = currentPage) => {
    const targetKey = doc ? `${doc.id}:${targetPage}` : "";
    commitPageAnnotations((list) => [...list, item], { targetKey });
    setCurrentPage(targetPage);
    setSelectedAnnoId(item.id);
    logHistory(targetKey, "create", { pin: "新增标记", region: "新增框选区域", text: "新增文字批注" }[item.type] || "新增批注");
    window.setTimeout(() => document.querySelector(`[data-anno-input="${item.id}"]`)?.focus(), 40);
  };

  const updateAnnotation = (annoId, patch, targetPage = currentPage) => {
    const targetKey = doc ? `${doc.id}:${targetPage}` : "";
    const isTyping = Object.keys(patch).length === 1 && Object.hasOwn(patch, "text");
    commitPageAnnotations(
      (list) => list.map((item) => (item.id === annoId ? { ...item, ...patch, updatedAt: Date.now() } : item)),
      { coalesceKey: isTyping ? `annotation:${annoId}:text` : "", targetKey }
    );
  };

  const deleteAnnotation = async (annoId, targetPage = currentPage) => {
    const targetKey = doc ? `${doc.id}:${targetPage}` : "";
    const targetItems = annotations[targetKey] || [];
    const annotation = targetItems.find((item) => item.id === annoId);
    if (!doc || !annotation || archivingAnnotationIds.current.has(annoId)) return;
    archivingAnnotationIds.current.add(annoId);
    try {
      setSyncState("saving");
      await flushPendingChanges();
      const result = await archiveAnnotation(doc.id, targetPage, annoId);
      dirtyPageKeys.current.delete(targetKey);
      dirtyHistoryKeys.current.delete(targetKey);
      // Archiving rewrites the page, so it moves the page's revision just as saving does. The
      // broadcast carries the new one too, but it is ignored while the page is dirty — and the page
      // is dirty again the moment someone deletes an annotation and selects the next passage. Taking
      // it from the response is what keeps that next annotation from conflicting with nothing.
      rememberPageRevision(targetKey, result.annotationRevision);
      setAnnotations((prev) => setAnnotationPage(prev, targetKey, result.annotations || []));
      setHistory((prev) => setRecordPage(prev, targetKey, result.history || []));
      setReviewThreads((prev) => {
        if (!prev[annoId]) return prev;
        const next = { ...prev };
        delete next[annoId];
        return next;
      });
      setSelectedAnnoId((current) => current === annoId ? null : current);
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("批注没有归档，正文标记仍然保留。请稍后重试。", "归档失败");
    } finally {
      archivingAnnotationIds.current.delete(annoId);
    }
  };

  const relocateTextAnnotation = (annoId, targetPage = currentPage) => {
    if (!doc) return;
    setCurrentPage(Math.max(1, Math.min(doc.pageCount, targetPage)));
    setSelectedAnnoId(annoId);
    setRelocatingAnnotation({ id: annoId, page: targetPage });
    setMode("text");
  };

  const updateNote = (text) => {
    const note = noteAnno || { id: id("a"), type: "note", text: "", tag: null, createdAt: Date.now(), updatedAt: Date.now() };
    const next = { ...note, text, updatedAt: Date.now() };
    commitPageAnnotations(
      (list) => noteAnno ? list.map((item) => (item.id === note.id ? next : item)) : [next, ...list],
      { coalesceKey: `note:${note.id}:text` }
    );
    if (!noteAnno) logHistory(pageKey, "create", "新增整页备注");
  };

  const setNoteTag = (tag) => {
    const note = noteAnno || { id: id("a"), type: "note", text: "", tag: null, createdAt: Date.now(), updatedAt: Date.now() };
    const nextTag = note.tag === tag ? null : tag;
    commitPageAnnotations((list) => {
      const next = { ...note, tag: nextTag, updatedAt: Date.now() };
      return noteAnno ? list.map((item) => (item.id === note.id ? next : item)) : [next, ...list];
    });
  };

  const submitReviewReply = async (annotationId, body) => {
    const text = String(body || "").trim();
    if (!text) return false;
    const thread = reviewThreads[annotationId];
    const targetPage = Number(thread?.page || currentPage);
    const targetKey = doc ? `${doc.id}:${targetPage}` : "";
    const annotation = (annotations[targetKey] || []).find((item) => item.id === annotationId);
    try {
      setSyncState("saving");
      await flushPendingChanges();
      const result = await replyToReviewThread(annotationId, {
        role: "human",
        author: "用户",
        body: text,
        status: "open",
        ...(annotation?.tag === "resolved" ? { tag: "todo" } : {}),
        expectedRevision: thread?.revision || 0
      });
      setReviewThreads((prev) => ({ ...prev, [annotationId]: result.thread }));
      if (result.annotations && targetKey) setAnnotations((prev) => setAnnotationPage(prev, targetKey, result.annotations));
      setSyncState("synced");
      return true;
    } catch (error) {
      if (error.code === "review_thread_conflict" && error.payload?.thread) {
        setReviewThreads((prev) => ({ ...prev, [annotationId]: error.payload.thread }));
        setSyncState("conflict");
      } else {
        setSyncState(isApiAvailableError(error) ? "offline" : "error");
      }
      await alertUser("回复没有发送成功，请检查最新对话后重试。", "发送失败");
      return false;
    }
  };

  const changeReviewStatus = async (annotationId, status, tag, targetPage = currentPage) => {
    if (!doc) return;
    const targetKey = `${doc.id}:${targetPage}`;
    const previousAnnotations = annotations[targetKey] || [];
    const previousAnnotation = previousAnnotations.find((item) => item.id === annotationId);
    if (!previousAnnotation) return;
    const previousThread = reviewThreads[annotationId];
    const optimisticAnnotation = { ...previousAnnotation, tag, updatedAt: Date.now() };
    setAnnotations((prev) => setAnnotationPage(
      prev,
      targetKey,
      (prev[targetKey] || []).map((item) => item.id === annotationId ? optimisticAnnotation : item)
    ));
    setReviewThreads((prev) => ({
      ...prev,
      [annotationId]: { ...(prev[annotationId] || {}), annotationId, status }
    }));
    try {
      setSyncState("saving");
      await flushPendingChanges();
      const result = await updateReviewState(annotationId, {
        status,
        tag,
        expectedRevision: previousThread?.revision || 0
      });
      setAnnotations((prev) => setAnnotationPage(prev, `${result.thread.documentId}:${result.thread.page}`, result.annotations));
      setReviewThreads((prev) => ({ ...prev, [annotationId]: result.thread }));
      setSyncState("synced");
    } catch (error) {
      if (error.code === "review_thread_conflict" && error.payload?.thread) {
        const latestAnnotation = error.payload.thread.annotation;
        if (latestAnnotation) {
          setAnnotations((prev) => setAnnotationPage(
            prev,
            targetKey,
            (prev[targetKey] || []).map((item) => item.id === annotationId ? latestAnnotation : item)
          ));
        }
        setReviewThreads((prev) => ({ ...prev, [annotationId]: error.payload.thread }));
        setSyncState("conflict");
      } else {
        setAnnotations((prev) => setAnnotationPage(
          prev,
          targetKey,
          (prev[targetKey] || []).map((item) => item.id === annotationId ? previousAnnotation : item)
        ));
        setReviewThreads((prev) => {
          if (prev[annotationId]?.status !== status) return prev;
          if (previousThread) return { ...prev, [annotationId]: previousThread };
          const next = { ...prev };
          delete next[annotationId];
          return next;
        });
        setSyncState(isApiAvailableError(error) ? "offline" : "error");
      }
    }
  };

  const pageCoord = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const rotation = ((viewer.rotation % 360) + 360) % 360;
    const renderedX = event.clientX - rect.left;
    const renderedY = event.clientY - rect.top;
    const width = event.currentTarget.offsetWidth || rect.width;
    const height = event.currentTarget.offsetHeight || rect.height;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = renderedX - cx;
    const dy = renderedY - cy;
    const radians = (-rotation * Math.PI) / 180;
    const unrotatedX = dx * Math.cos(radians) - dy * Math.sin(radians) + width / 2;
    const unrotatedY = dx * Math.sin(radians) + dy * Math.cos(radians) + height / 2;
    return {
      x: clamp((unrotatedX / width) * 100, 0, 100),
      y: clamp((unrotatedY / height) * 100, 0, 100)
    };
  };

  const onPageClick = (event, targetPage = currentPage) => {
    if (mode !== "pin" || event.target.closest("[data-overlay-item]")) return;
    const coord = pageCoord(event);
    addAnnotation({
      id: id("a"),
      type: "pin",
      x: round1(coord.x),
      y: round1(coord.y),
      text: "",
      tag: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, targetPage);
  };

  const onPointerDown = (event, targetPage = currentPage) => {
    if (mode !== "region") return;
    const coord = pageCoord(event);
    dragStart.current = { ...coord, page: targetPage };
    setCurrentPage(targetPage);
    setDragRect({ page: targetPage, x: coord.x, y: coord.y, w: 0, h: 0 });
  };

  const onPointerMove = (event) => {
    if (!dragStart.current) return;
    const coord = pageCoord(event);
    setDragRect({
      page: dragStart.current.page,
      x: Math.min(dragStart.current.x, coord.x),
      y: Math.min(dragStart.current.y, coord.y),
      w: Math.abs(coord.x - dragStart.current.x),
      h: Math.abs(coord.y - dragStart.current.y)
    });
  };

  const onPointerUp = () => {
    if (!dragStart.current) return;
    const targetPage = dragStart.current.page || currentPage;
    dragStart.current = null;
    if (dragRect && dragRect.w > 2.5 && dragRect.h > 2.5) {
      addAnnotation({
        id: id("a"),
        type: "region",
        x: round1(dragRect.x),
        y: round1(dragRect.y),
        w: round1(dragRect.w),
        h: round1(dragRect.h),
        text: "",
        tag: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }, targetPage);
    }
    setDragRect(null);
  };

  const onTextSelection = (layerOrSelection, targetPage = currentPage) => {
    if (mode !== "text") return false;
    const suppliedSelection = layerOrSelection?.layer ? layerOrSelection : null;
    const layer = suppliedSelection?.layer || layerOrSelection?.currentTarget || layerOrSelection;
    if (!(layer instanceof Element)) return false;
    const selection = window.getSelection();
    const range = !suppliedSelection && selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!suppliedSelection && (!selection || selection.isCollapsed || !range || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode))) return false;
    const canvas = layer.closest(".page-canvas");
    if (!canvas) return false;
    const canvasRect = canvas.getBoundingClientRect();
    const canvasWidth = canvas.offsetWidth || canvasRect.width;
    const canvasHeight = canvas.offsetHeight || canvasRect.height;
    const clientRects = suppliedSelection?.clientRects || Array.from(range.getClientRects());
    const selectedRects = clientRects
      .map((rect) => clientRectToPageRect(rect, canvasRect, canvasWidth, canvasHeight, viewer.rotation))
      .map((rect) => ({ x: round3(rect.x), y: round3(rect.y), w: round3(rect.w), h: round3(rect.h) }))
      .filter((rect) => rect.w > 0.05 && rect.h > 0.05);
    const quote = normalizeSelectedText(suppliedSelection?.quote || rangeText(range));
    const rects = mergeSelectionRects(selectedRects);
    if (!rects.length || !quote) return false;
    const context = suppliedSelection || selectionContextForRange(layer, range);
    const bounds = boundsFromRects(rects);
    const selectionPatch = {
      quote,
      anchor: buildTextAnchor(quote, context?.prefix, context?.suffix),
      anchorStatus: "matched",
      anchoredRevision: doc?.contentHash || "",
      rects,
      ...bounds,
      updatedAt: Date.now()
    };
    if (relocatingAnnotation) {
      // updateAnnotation only maps over the target page's list, so a selection on a different page
      // used to change nothing while still logging a relocation that never happened. Say so and stay
      // in relocation mode instead of failing silently.
      if (Number(relocatingAnnotation.page) !== Number(targetPage)) {
        alertUser(
          `这条批注在第 ${relocatingAnnotation.page} 页。请在第 ${relocatingAnnotation.page} 页上重新选择原文，或先取消重新定位。`,
          "重新定位"
        );
        return false;
      }
      updateAnnotation(relocatingAnnotation.id, selectionPatch, targetPage);
      setSelectedAnnoId(relocatingAnnotation.id);
      setRelocatingAnnotation(null);
      logHistory(`${doc.id}:${targetPage}`, "update", "重新定位文字批注");
      recoverUnreadableQuote(relocatingAnnotation.id, targetPage, selectionPatch);
    } else {
      const annotationId = id("a");
      addAnnotation({
        id: annotationId,
        type: "text",
        ...selectionPatch,
      text: "",
      tag: null,
      createdAt: Date.now(),
        updatedAt: Date.now()
      }, targetPage);
      recoverUnreadableQuote(annotationId, targetPage, selectionPatch);
    }
    selection?.removeAllRanges();
    return true;
  };


  // Some PDFs embed a subset font with no ToUnicode map, and then the text layer reports glyph
  // indices instead of characters: a slide reading 示例课程 comes back as œୗܽؽ. Nothing in the file
  // says what those glyphs mean, so the only way to read the selection is to look at the rendered
  // page. The annotation is saved immediately either way — this replaces its quote once the page
  // has been read, rather than making the user wait on OCR before they can start typing.
  const recoverUnreadableQuote = (annotationId, targetPage, patch) => {
    if (!doc?.id || !isUnmappableText(patch.quote) || !patch.rects?.length) return;
    setQuoteRecovery((prev) => ({ ...prev, [annotationId]: "reading" }));
    readRegionText(doc.id, targetPage, patch.rects)
      .then((result) => {
        const recovered = normalizeSelectedText(result?.text || "");
        if (!recovered || isUnmappableText(recovered)) {
          setQuoteRecovery((prev) => ({ ...prev, [annotationId]: "failed" }));
          return;
        }
        // The surrounding text came from the same broken layer, so it is no more readable than the
        // quote was. Dropping it beats pasting one unreadable half into a chat window.
        updateAnnotation(annotationId, {
          quote: recovered,
          anchor: buildTextAnchor(recovered, "", ""),
          quoteSource: "ocr",
          quoteConfidence: Number(result?.confidence || 0)
        }, targetPage);
        setQuoteRecovery((prev) => ({ ...prev, [annotationId]: "recovered" }));
      })
      .catch(() => setQuoteRecovery((prev) => ({ ...prev, [annotationId]: "failed" })));
  };

  const registerImportedDocument = (serverDoc, { open = true } = {}) => {
    const newDoc = { ...serverDoc, projectId: currentProjectId, updated: Date.now() };
    setDocuments((prev) => ({ ...prev, [newDoc.id]: newDoc }));
    setProjects((prev) => prev.map((item) => item.id === currentProjectId
      ? { ...item, docIds: [newDoc.id, ...(item.docIds || []).filter((id) => id !== newDoc.id)], updated: Date.now() }
      : item));
    setSyncState("synced");
    if (open) openDoc(newDoc.id);
  };

  const handleUpload = async (file, { open = true } = {}) => {
    if (!file) return false;
    try {
      setSyncState("saving");
      const result = await uploadDocument(file, currentProjectId);
      registerImportedDocument(result.document, { open });
      return true;
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`导入失败：${file.name} 未写入工作区。${describeOperationError(error)}`, "导入失败");
      return false;
    }
  };

  // Importing a file the project already holds is almost always someone reaching for import when
  // they meant refresh — which is how an annotated copy ends up sitting beside an empty one. Offer
  // the refresh instead, but keep importing a second copy available: two parallel versions of a deck
  // is a thing people deliberately do.
  const importPathHonouringDuplicates = async (filePath) => {
    const existing = Object.values(documents).find((document) =>
      document.projectId === currentProjectId && String(document.originalPath || "") === String(filePath || ""));
    if (!existing) {
      const result = await importDocumentPath(filePath, currentProjectId);
      return { document: result.document, imported: true };
    }
    const annotationCount = countDocAnnotations(existing, annotations);
    const choice = await chooseUser(
      `「${existing.name}」已经在本项目里${annotationCount ? `，带 ${annotationCount} 处批注` : ""}，来自同一个文件。`,
      "这个文件已经导入过",
      [
        { value: "refresh", label: "更新已有文档", primary: true },
        { value: "import", label: "再导入一份" }
      ]
    );
    if (!choice) return { document: null, imported: false, cancelled: true };
    if (choice === "import") {
      const result = await importDocumentPath(filePath, currentProjectId);
      return { document: result.document, imported: true };
    }
    const refreshed = await refreshDocument(existing.id, { path: filePath, clearAnnotations: false });
    applyRefreshResult(refreshed, false);
    return { document: refreshed.document, imported: false };
  };

  const handlePathImports = async (paths) => {
    const list = Array.from(paths || []).filter(Boolean);
    for (let index = 0; index < list.length; index += 1) {
      const filePath = list[index];
      try {
        setSyncState("saving");
        const outcome = await importPathHonouringDuplicates(filePath);
        if (outcome.cancelled) continue;
        if (outcome.imported) registerImportedDocument(outcome.document, { open: index === list.length - 1 });
        else setSyncState("synced");
      } catch (error) {
        setSyncState(isApiAvailableError(error) ? "offline" : "error");
        await alertUser(`导入失败：${filePath.split(/[\\/]/).pop() || filePath} 未写入工作区。${describeOperationError(error)}`, "导入失败");
      }
    }
  };

  const handleUploads = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (canResolveFilePath && list.length) {
      const paths = list.map((file) => {
        try {
          return window.reviewAnnotationDesktop.getFilePath(file);
        } catch {
          return "";
        }
      });
      if (paths.every(Boolean)) {
        await handlePathImports(paths);
        return;
      }
    }
    for (let index = 0; index < list.length; index += 1) {
      await handleUpload(list[index], { open: index === list.length - 1 });
    }
  };

  const handleImportSources = async (input) => {
    const entries = splitImportSources(input).map((line) => classifyImportSource(line));
    if (!entries.length) throw new Error("请输入文件链接或本机路径。");
    const unusable = entries.find((entry) => entry.kind === "unsupported" || entry.kind === "unknown");
    if (unusable) throw new Error(describeImportSourceProblem(unusable.kind));

    setSyncState("saving");
    const imported = [];
    try {
      for (const entry of entries) {
        if (entry.kind === "path") {
          const outcome = await importPathHonouringDuplicates(entry.value);
          if (outcome.imported) imported.push(outcome.document);
          continue;
        }
        const result = await importDocumentUrl(entry.value, currentProjectId);
        imported.push(result.document);
      }
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      // Anything that already landed stays in the workspace; only the failing entry is reported.
      imported.forEach((document, index) => registerImportedDocument(document, { open: false }));
      if (imported.length) setImportDialogOpen(false);
      throw error;
    }
    setImportDialogOpen(false);
    imported.forEach((document, index) => registerImportedDocument(document, { open: index === imported.length - 1 }));
    return true;
  };

  const createSnapshot = () => {
    const snapshots = (history[pageKey] || []).filter((item) => item.action === "snapshot").length + 1;
    logHistory(pageKey, "snapshot", "手动创建快照", `v${snapshots}`, cloneValue(pageAnnotations));
    setPanelTab("history");
  };

  const restoreAnnotationSnapshot = (snapshot) => {
    if (!snapshot?.snapshot) return;
    commitPageAnnotations(cloneValue(snapshot.snapshot));
    logHistory(pageKey, "restore", `恢复到 ${snapshot.rev || "所选快照"}`);
    setPanelTab("annotate");
  };

  const exportPayload = useMemo(() => {
    // Only worth building while the dialog is on screen; it walks every page and clones every
    // review message, and the default scope is the whole document.
    if (!exportOpen || !doc || !project) return null;
    return buildExportPayload(project, doc, annotations, reviewThreads, exportScope, currentPage, {
      includeResolved: exportIncludeResolved,
      conversationMode: exportConversationMode,
      includeLocalPaths: exportIncludeLocalPaths
    });
  }, [exportOpen, project, doc, annotations, reviewThreads, exportScope, currentPage, exportIncludeResolved, exportConversationMode, exportIncludeLocalPaths]);

  const copyAnnotationsForAi = async () => {
    if (!doc || !project) return;
    const payload = buildExportPayload(project, doc, annotations, reviewThreads, "doc", currentPage, {
      includeResolved: exportIncludeResolved,
      conversationMode: exportConversationMode,
      includeLocalPaths: exportIncludeLocalPaths
    });
    const total = (payload.pages || []).reduce((sum, page) => sum + (page.annotations || []).length, 0);
    if (!total) {
      await alertUser("这份文档还没有待处理的批注。", "复制给 AI");
      return;
    }
    if (!(await copyTextToClipboard(formatExport(payload, "prompt")))) {
      await alertUser("复制失败。可以打开导出窗口手动复制。", "复制给 AI");
      return;
    }
    setAiCopyState(`已复制 ${total} 条`);
    window.setTimeout(() => setAiCopyState(""), 2000);
    exportAnnotations(payload, "prompt", "copy").catch(() => undefined);
  };

  const copyExport = async () => {
    if (!exportPayload) return;
    const text = formatExport(exportPayload, exportFormat);
    await copyTextToClipboard(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
    exportAnnotations(exportPayload, exportFormat, "copy").catch(() => undefined);
  };

  const downloadExport = () => {
    if (!exportPayload) return;
    exportAnnotations(exportPayload, exportFormat, "download").catch(() => undefined);
  };

  const downloadHtmlExport = async () => {
    if (!exportPayload) return;
    try {
      const result = await exportReviewHtml(exportPayload);
      const blob = new Blob([result.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName || exportFileName(exportPayload, "html", "html");
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
    }
  };

  const downloadAnnotatedPdfExport = async () => {
    if (!exportPayload) return;
    try {
      setSyncState("saving");
      const result = await exportAnnotatedPdf(exportPayload.document.id, exportScope, currentPage, pdfPageMode, exportIncludeResolved);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`批注 PDF 导出失败：${error.message}`, "导出失败");
    }
  };

  const createGroupFromPrompt = async () => {
    const name = await promptUser("新建分组", "新建分组");
    if (!name?.trim()) return;
    try {
      const result = await createGroup({ name: name.trim() });
      setGroups((prev) => [...prev.filter((item) => item.id !== result.group.id), result.group]);
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("新建分组失败，工作区没有发生变化。", "新建失败");
    }
  };

  const renameGroupFromPrompt = async (groupId) => {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    const name = await promptUser("重命名分组", group.name);
    if (!name?.trim() || name.trim() === group.name) return;
    await patchGroupState(groupId, { name: name.trim() }, "重命名失败");
  };

  const toggleGroupCollapsed = async (groupId) => {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    await patchGroupState(groupId, { collapsed: !group.collapsed }, "");
  };

  const moveGroupBy = async (groupId, offset) => {
    const from = groups.findIndex((item) => item.id === groupId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= groups.length) return;
    const next = [...groups];
    next.splice(to, 0, ...next.splice(from, 1));
    setGroups(next);
    try {
      const result = await reorderGroups(next.map((item) => item.id));
      setGroups(result.groups || next);
      setSyncState("synced");
    } catch (error) {
      setGroups(groups);
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("分组顺序没有保存成功。", "排序失败");
    }
  };

  const patchGroupState = async (groupId, patch, failureTitle) => {
    // Update in place first: collapsing a group should feel like a click, not like a request.
    setGroups((prev) => prev.map((item) => (item.id === groupId ? { ...item, ...patch } : item)));
    try {
      const result = await updateGroup(groupId, patch);
      setGroups((prev) => prev.map((item) => (item.id === groupId ? result.group : item)));
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      const workspace = await getWorkspace().catch(() => null);
      if (workspace) setGroups(workspace.groups || []);
      if (failureTitle) await alertUser("分组没有改动成功。", failureTitle);
    }
  };

  // Deleting a group releases its projects; it never takes a document with it, so this asks once
  // and says exactly what will happen rather than warning about data loss that cannot occur.
  const removeGroup = async (groupId) => {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    const members = projects.filter((item) => item.groupId === groupId);
    const confirmed = await confirmUser(
      members.length
        ? `删除分组「${group.name}」？里面的 ${members.length} 个项目会回到未分组，文档不受影响。`
        : `删除分组「${group.name}」？`,
      "删除分组"
    );
    if (!confirmed) return;
    try {
      const result = await deleteGroup(groupId);
      setGroups(result.workspace?.groups || []);
      setProjects((prev) => prev.map((item) => (item.groupId === groupId ? { ...item, groupId: "" } : item)));
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("删除分组失败，工作区没有发生变化。", "删除失败");
    }
  };

  const moveProjectToGroup = async (projectId, groupId) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || project.groupId === groupId) return;
    setProjects((prev) => prev.map((item) => (item.id === projectId ? { ...item, groupId } : item)));
    try {
      const result = await updateProject(projectId, { groupId });
      setProjects((prev) => prev.map((item) => (item.id === projectId ? { ...item, ...result.project, docIds: item.docIds } : item)));
      setSyncState("synced");
    } catch (error) {
      setProjects((prev) => prev.map((item) => (item.id === projectId ? { ...item, groupId: project.groupId || "" } : item)));
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`移动失败，项目仍在原处。${describeOperationError(error)}`, "移动失败");
    }
  };

  const createProjectFromPrompt = async (parentId = "", groupId = "") => {
    const parent = parentId ? projects.find((item) => item.id === parentId) : null;
    const name = await promptUser(parent ? `在「${parent.name}」下新建子项目` : "新建项目", parent ? "新建子项目" : "新建批注项目");
    if (!name?.trim()) return;
    const draft = {
      id: `p-${Date.now().toString(36)}`,
      parentId: parent?.id || "",
      groupId: parent ? "" : groupId,
      name: name.trim(),
      // A sub-project sits inside its parent's working directory unless it is given its own.
      path: parent?.path || "本地工作区",
      color: parent?.color || "#5b4ce2",
      docIds: [],
      updated: Date.now()
    };
    try {
      const result = await createProject(draft);
      setProjects((prev) => [result.project, ...prev.filter((item) => item.id !== result.project.id)]);
      setCurrentProjectId(result.project.id);
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("新建项目失败，工作区没有发生变化。", "新建失败");
    }
  };

  const openDuplicateReview = async () => {
    setDuplicateReview({ loading: true, groups: [] });
    try {
      const result = await getDuplicateDocuments();
      setDuplicateReview({ loading: false, groups: result.groups || [] });
      setSyncState("synced");
    } catch (error) {
      setDuplicateReview(null);
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`查找重复文档失败。${describeOperationError(error)}`, "查找失败");
    }
  };

  // Deleting a document takes its annotations with it, so the count is named before anything goes.
  // Every group in a normal workspace has exactly one annotated copy and this never fires; it is
  // there for the case where it does.
  const resolveDuplicateGroup = async (group, keepId) => {
    const doomed = group.documents.filter((item) => item.id !== keepId);
    if (!doomed.length) return;
    const keeper = group.documents.find((item) => item.id === keepId);
    const losing = doomed.reduce((total, item) => total + item.annotationCount, 0);
    const confirmed = await confirmUser(
      losing
        ? `删除其余 ${doomed.length} 份，保留「${keeper.name}」（${keeper.annotationCount} 处批注）。\n\n被删除的副本上还有 ${losing} 处批注，会一并删除，无法恢复。`
        : `删除其余 ${doomed.length} 份，保留「${keeper.name}」（${keeper.annotationCount} 处批注）。被删除的副本没有批注。`,
      losing ? "确认删除带批注的副本" : "清理重复文档",
      Boolean(losing)
    );
    if (!confirmed) return;
    try {
      for (const item of doomed) await deleteDocument(item.id);
      const workspace = await getWorkspace();
      const docs = Object.fromEntries((workspace.documents || []).map((item) => [item.id, item]));
      setDocuments(docs);
      setProjects(attachDocumentsToProjects(workspace.projects || [], docs));
      setAnnotations(workspace.annotations || {});
      const result = await getDuplicateDocuments();
      setDuplicateReview({ loading: false, groups: result.groups || [] });
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`清理失败。${describeOperationError(error)}`, "清理失败");
    }
  };

  const archiveDocument = async (document, archived) => {
    try {
      const result = await setDocumentArchived(document.id, archived);
      setDocuments((prev) => ({ ...prev, [document.id]: { ...prev[document.id], ...result.document } }));
      setSyncState("synced");
      if (archived && result.reclaimedBytes > 0) {
        setRefreshNotice({ documentId: document.id, text: `已归档 · 清理缓存 ${formatBytes(result.reclaimedBytes)}` });
      }
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`${archived ? "归档" : "取消归档"}失败，文档没有变化。${describeOperationError(error)}`, "操作失败");
    }
  };

  const revealDocumentInFinder = async (documentId) => {
    try {
      const result = await revealDocument(documentId);
      // Falling back to the app's own copy is worth saying out loud: the folder that opens is not
      // where the user filed the document, and copying out of it would be a mistake.
      if (result.reason === "original_missing") {
        await alertUser(
          `原文件已经不在 ${result.recordedPath}，可能被移动或重命名了。打开的是 App 内部保存的副本。`,
          "已在访达中显示"
        );
      } else if (result.reason === "copy_only") {
        await alertUser("这份文档没有记录到本机原文件，打开的是 App 内部保存的副本。", "已在访达中显示");
      }
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(describeOperationError(error), "无法定位文件");
    }
  };

  const moveDocumentToAnotherProject = async (documentId, targetProjectId) => {
    const document = documents[documentId];
    const target = projects.find((item) => item.id === targetProjectId);
    if (!document || !target || document.projectId === targetProjectId) return;
    try {
      const result = await moveDocumentToProject(documentId, targetProjectId);
      setDocuments((prev) => ({ ...prev, [documentId]: { ...prev[documentId], ...result.document } }));
      setProjects((prev) => prev.map((item) => {
        if (item.id === targetProjectId) {
          return { ...item, docIds: [documentId, ...(item.docIds || []).filter((id) => id !== documentId)] };
        }
        if (!(item.docIds || []).includes(documentId)) return item;
        return { ...item, docIds: (item.docIds || []).filter((id) => id !== documentId) };
      }));
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`移动失败，文档仍留在原项目。${describeOperationError(error)}`, "移动失败");
    }
  };

  const openProjectRename = () => {
    if (!project) return;
    setProjectRenameValue(project.name || "");
    setProjectRenameOpen(true);
  };

  const renameCurrentProject = async () => {
    if (!project) return;
    const name = projectRenameValue.trim();
    if (!name) return;
    const patch = { name: name.trim(), updated: Date.now() };
    try {
      const result = await updateProject(project.id, patch);
      setProjects((prev) => prev.map((item) => (item.id === project.id ? result.project : item)));
      setProjectRenameOpen(false);
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("项目重命名失败，原名称已保留。", "重命名失败");
    }
  };

  const markAnnotationsReviewed = async () => {
    if (!doc) return;
    try {
      const result = await updateDocument(doc.id, { annotationsNeedReview: false });
      setDocuments((prev) => ({ ...prev, [doc.id]: { ...prev[doc.id], ...result.document } }));
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
    }
  };

  const forgetDocumentsLocally = (documentIds) => {
    const ids = new Set(documentIds);
    setDocuments((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.has(id))));
    setAnnotations((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !ids.has(key.split(":")[0]))));
    setHistory((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !ids.has(key.split(":")[0]))));
    setReviewThreads((prev) => Object.fromEntries(Object.entries(prev).filter(([, thread]) => !ids.has(thread.documentId))));
    discardPendingAnnotations(ids);
    forgetPageRevisions((key) => ids.has(key.split(":")[0]));
    setProjects((prev) => prev.map((project) => ({
      ...project,
      docIds: (project.docIds || []).filter((id) => !ids.has(id))
    })));
    if (ids.has(currentDocId)) {
      setCurrentDocId(null);
      setView("projects");
    }
  };

  const removeDocument = async (document) => {
    const linkedTasks = reviewTasks.filter((task) => (task.documentIds || []).includes(document.id));
    const decision = await confirmDeletion(
      `删除「${document.name}」及其全部批注？源文件不会被删除。`,
      "删除文档",
      linkedTasks.length
    );
    if (!decision) return;
    const deleteTasks = decision !== true && Boolean(decision.deleteTasks);
    try {
      const result = await deleteDocument(document.id, deleteTasks ? "delete" : "retain");
      forgetDocumentsLocally([document.id]);
      const removedTaskIds = new Set(result.deletedTaskIds || []);
      setReviewTasks((prev) => prev.filter((task) => !removedTaskIds.has(task.id)));
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`删除失败：${describeOperationError(error)}`, "删除文档");
    }
  };

  const removeProject = async (project) => {
    const projectDocIds = new Set(project.docIds || []);
    const linkedTasks = reviewTasks.filter((task) => (task.documentIds || []).some((id) => projectDocIds.has(id)));
    const decision = await confirmDeletion(
      `删除项目「${project.name}」及其中的 ${projectDocIds.size} 份文档和全部批注？源文件不会被删除。`,
      "删除项目",
      linkedTasks.length
    );
    if (!decision) return;
    const deleteTasks = decision !== true && Boolean(decision.deleteTasks);
    try {
      const result = await deleteProject(project.id, deleteTasks ? "delete" : "retain");
      forgetDocumentsLocally([...projectDocIds]);
      setProjects((prev) => prev.filter((item) => item.id !== project.id));
      setCurrentProjectId((current) => (current === project.id ? "" : current));
      const removedTaskIds = new Set(result.deletedTaskIds || []);
      setReviewTasks((prev) => prev.filter((task) => !removedTaskIds.has(task.id)));
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      const detail = error?.code === "last_project"
        ? "这是最后一个项目，无法删除。"
        : describeOperationError(error);
      await alertUser(`删除失败：${detail}`, "删除项目");
    }
  };

  const canPickProjectDirectory = Boolean(window.reviewAnnotationDesktop?.pickProjectDirectory);

  const setProjectDirectory = async (project) => {
    if (!canPickProjectDirectory) return;
    const directory = await window.reviewAnnotationDesktop.pickProjectDirectory();
    if (!directory) return;
    try {
      const result = await updateProject(project.id, { path: directory });
      setProjects((prev) => prev.map((item) => (item.id === project.id ? { ...item, ...result.project } : item)));
    } catch (error) {
      await alertUser(`设置目录失败：${describeOperationError(error)}`, "设置项目目录");
    }
  };

  const retryDocumentAnalysis = async (document) => {
    try {
      const result = await reanalyzeDocument(document.id);
      setDocuments((prev) => ({ ...prev, [result.document.id]: { ...prev[result.document.id], ...result.document } }));
    } catch (error) {
      await alertUser(`重新索引失败：${describeOperationError(error)}`, "重新索引");
    }
  };

  const applyRefreshResult = (result, clearAnnotations = false) => {
      forgetPageRevisions((key) => key.startsWith(`${result.document.id}:`));
      setDocuments((prev) => ({ ...prev, [result.document.id]: { ...prev[result.document.id], ...result.document, ...result.sourceInfo } }));
      if (clearAnnotations || result.clearedAnnotations) {
        setAnnotations((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key.split(":")[0] !== doc.id)));
        if (result.historyPages) setHistory((prev) => ({ ...prev, ...result.historyPages }));
        setReviewThreads((prev) => Object.fromEntries(Object.entries(prev).filter(([, thread]) => thread.documentId !== doc.id)));
        discardPendingAnnotations([doc.id]);
      } else {
        const pageCount = Number(result.document.pageCount || 1);
        const prefix = `${result.document.id}:`;
        const inRange = (key) => !key.startsWith(prefix) || Number(key.slice(prefix.length)) <= pageCount;
        setAnnotations((prev) => result.annotationPages
          ? {
              ...Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(prefix))),
              ...result.annotationPages
            }
          : Object.fromEntries(Object.entries(prev).filter(([key]) => inRange(key))));
        setHistory((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => inRange(key))));
        setReviewThreads((prev) => result.reviewThreads
          ? {
              ...Object.fromEntries(Object.entries(prev).filter(([, thread]) => thread.documentId !== result.document.id)),
              ...result.reviewThreads
            }
          : Object.fromEntries(Object.entries(prev).filter(([, thread]) => thread.documentId !== result.document.id || Number(thread.page) <= pageCount)));
        discardOutOfRangePageData(result.document.id, pageCount);
      }
      // Refreshing re-anchors this document's annotations, which moves each page's revision on the
      // server. Both branches above drop the revisions we were holding; adopt the ones the refresh
      // reports instead of leaving them empty, or the next flush echoes 0 against a live revision
      // and every annotation made after a refresh conflicts.
      for (const [key, revision] of Object.entries(result.annotationRevisions || {})) rememberPageRevision(key, revision);
      undoStack.current = [];
      redoStack.current = [];
      setCurrentPage((page) => Math.max(1, Math.min(result.document.pageCount || 1, page)));
      setSelectedAnnoId(null);
      setDragRect(null);
      setSyncState("synced");
      const pageChange = Number(result.previousPageCount || 1) !== Number(result.document.pageCount || 1)
        ? `${result.previousPageCount} → ${result.document.pageCount} 页`
        : `${result.document.pageCount} 页`;
      const reanchorText = result.reanchorResult
        ? ` · 文字批注重新定位 ${result.reanchorResult.matchedCount} 条${result.reanchorResult.unmatchedCount ? `，${result.reanchorResult.unmatchedCount} 条待核对` : ""}`
        : "";
      setRefreshNotice({
        documentId: result.document.id,
        text: result.contentChanged
          ? (clearAnnotations || result.clearedAnnotations
            ? `已更新并清空原批注 · ${pageChange}`
            : `已更新 · ${pageChange}，原批注已保留${reanchorText}${result.orphanedPages?.annotationCount ? `，${result.orphanedPages.annotationCount} 条旧页批注已归档` : ""}`)
          : `已检查 · 当前已是最新版本`
      });
  };

  const refreshCurrentDocument = async (clearAnnotations = false) => {
    if (!doc) return;
    if (clearAnnotations && !(await confirmUser(`刷新「${doc.name}」并清除之前所有批注？批注和对话会移入历史。`, "清除标注"))) return;
    setRefreshState(clearAnnotations ? "clearing" : "refreshing");
    try {
      await flushPendingChanges();
      const result = await refreshDocument(doc.id, { clearAnnotations });
      applyRefreshResult(result, clearAnnotations);
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`刷新失败，旧版本已保留。${describeOperationError(error)}`, "刷新失败");
    } finally {
      setRefreshState("idle");
    }
  };

  const refreshCurrentDocumentWithFile = async (file) => {
    if (!doc || !file) return;
    setRefreshState("refreshing");
    try {
      await flushPendingChanges();
      let filePath = "";
      if (canResolveFilePath) {
        try {
          filePath = window.reviewAnnotationDesktop.getFilePath(file);
        } catch {
          filePath = "";
        }
      }
      const result = await refreshDocument(doc.id, filePath
        ? { path: filePath, clearAnnotations: false }
        : { file, clearAnnotations: false });
      applyRefreshResult(result, false);
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`替换版本失败，旧版本已保留。${error.message}`, "替换失败");
    } finally {
      setRefreshState("idle");
    }
  };

  const bindAndRefreshCurrentDocument = async () => {
    if (!doc || !canPickTrackedPath) return;
    const filePath = await window.reviewAnnotationDesktop.pickDocumentPath();
    if (!filePath) return;
    setRefreshState("refreshing");
    try {
      await flushPendingChanges();
      const result = await refreshDocument(doc.id, { path: filePath, clearAnnotations: false });
      applyRefreshResult(result, false);
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`设定源文件失败，旧版本已保留。${error.message}`, "设源失败");
    } finally {
      setRefreshState("idle");
    }
  };

  const restoreCurrentDocumentVersion = async (versionId) => {
    if (!doc || !versionId) return false;
    const version = (doc.versions || []).find((item) => item.id === versionId);
    if (!version) return false;
    if (!(await confirmUser(
      `恢复「${doc.name}」到 ${formatDateTime(version.capturedAt)} 的版本？当前版本会先自动保存，可再次恢复。`,
      "恢复文档版本"
    ))) return false;
    setRefreshState("refreshing");
    try {
      await flushPendingChanges();
      const result = await restoreDocumentVersion(doc.id, versionId);
      applyRefreshResult(result, false);
      return true;
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`版本恢复失败，当前版本没有变化。${error.message}`, "恢复失败");
      return false;
    } finally {
      setRefreshState("idle");
    }
  };

  const clearCurrentAnnotations = async (scope) => {
    if (!doc) return;
    const pageOnly = scope === "page";
    const label = pageOnly ? `第 ${currentPage} 页` : `「${doc.name}」的全部`;
    if (!(await confirmUser(`清空${label}批注及其对话？内容会移入历史，正文中的标记将被隐藏。`, pageOnly ? "清空本页标注" : "清空全部标注"))) return;
    try {
      setSyncState("saving");
      await flushPendingChanges();
      const result = await clearAnnotations(doc.id, pageOnly ? currentPage : null);
      if (pageOnly) {
        dirtyPageKeys.current.delete(pageKey);
        dirtyHistoryKeys.current.delete(pageKey);
        rememberPageRevision(pageKey, result.clearedAt);
      } else {
        discardPendingAnnotations([doc.id]);
        forgetPageRevisions((key) => key.startsWith(`${doc.id}:`));
      }
      const prefix = `${doc.id}:`;
      setAnnotations((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => pageOnly ? key !== pageKey : !key.startsWith(prefix))));
      if (result.historyPages) setHistory((prev) => ({ ...prev, ...result.historyPages }));
      setReviewThreads((prev) => Object.fromEntries(Object.entries(prev).filter(([, thread]) => pageOnly
        ? !(thread.documentId === doc.id && Number(thread.page) === currentPage)
        : thread.documentId !== doc.id)));
      setSelectedAnnoId(null);
      undoStack.current = [];
      redoStack.current = [];
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser("批注没有清空，请稍后重试。", "清空失败");
    }
  };

  const flushPendingForBackup = () => flushPendingChanges();

  useEffect(() => {
    const desktop = window.reviewAnnotationDesktop;
    if (!desktop?.onBeforeClose || !desktop?.signalCloseReady) return undefined;
    return desktop.onBeforeClose(async (requestId) => {
      try {
        await flushPendingChanges();
        desktop.signalCloseReady(requestId, { ok: true });
      } catch (error) {
        try {
          await savePendingChanges(pendingChangesSnapshot(annotations, history, dirtyPageKeys.current, dirtyHistoryKeys.current, pageRevisions.current));
          desktop.signalCloseReady(requestId, { ok: true, pending: true });
        } catch {
          desktop.signalCloseReady(requestId, { ok: false, message: `最近的批注保存失败：${error.message}` });
        }
      }
    });
  }, [annotations, history, hydrated]);

  const backupWorkspace = async () => {
    try {
      setSyncState("saving");
      await flushPendingForBackup();
      const link = document.createElement("a");
      link.href = "/api/backup/full";
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
      setSyncState("synced");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`完整备份失败：${error.message}`, "备份失败");
    }
  };

  const restoreWorkspaceFile = async (file) => {
    if (!file) return;
    if (!(await confirmUser("恢复完整备份会替换当前项目、文档副本、批注和历史记录。系统会先自动保存当前工作区。", "恢复完整备份", true))) return;
    try {
      setSyncState("saving");
      await flushPendingForBackup();
      const result = await restoreFullBackup(file);
      const workspace = result.workspace;
      const docs = Object.fromEntries((workspace.documents || []).map((item) => [item.id, item]));
      const nextProjects = attachDocumentsToProjects(workspace.projects || [], docs);
      setProjects(nextProjects);
      setGroups(workspace.groups || []);
      setDocuments(docs);
      setAnnotations(workspace.annotations || {});
      setHistory(workspace.history || {});
      setReviewThreads(workspace.reviewThreads || {});
      setReviewTasks(workspace.reviewTasks || []);
      dirtyPageKeys.current.clear();
      dirtyHistoryKeys.current.clear();
      pageRevisions.current.clear();
      for (const [key, revision] of Object.entries(workspace.annotationRevisions || {})) rememberPageRevision(key, revision);
      undoStack.current = [];
      redoStack.current = [];
      setCurrentProjectId(nextProjects[0].id);
      setCurrentDocId(null);
      setView("projects");
      setSyncState("synced");
      await alertUser("完整备份已恢复。恢复前的工作区也已自动保存在数据目录中。", "恢复完成");
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
      await alertUser(`完整备份恢复失败，当前工作区没有变化。${error.message}`, "恢复失败");
    }
  };

  const revealDataFolder = async () => {
    try {
      await openDataFolder();
    } catch (error) {
      setSyncState(isApiAvailableError(error) ? "offline" : "error");
    }
  };

  const runDiagnostics = async () => {
    try {
      const report = await getDiagnostics();
      const toolLabel = (available) => available ? "正常" : "缺失";
      const lines = [
        `版本：${report.appVersion} · ${report.platform} · ${report.nodeVersion}`,
        `数据：${formatBytes(report.dataBytes)} · ${report.workspace.documentCount} 份文档 · ${report.workspace.annotationCount} 条批注`,
        `PDF 渲染：${toolLabel(report.tools.pdfRender)} · 文字层：${toolLabel(report.tools.pdfText)} · OCR：${toolLabel(report.tools.ocr)} · Office：${toolLabel(report.tools.office)}`,
        `批注 PDF：${toolLabel(report.tools.pdfExport)} · MCP：${toolLabel(report.tools.mcp)}`,
        ...(report.warnings?.length ? ["", ...report.warnings.map((warning) => `• ${warning}`)] : ["", "未发现需要处理的运行问题。"])
      ];
      await alertUser(lines.join("\n"), report.status === "ready" ? "运行诊断正常" : "运行诊断");
    } catch (error) {
      await alertUser(`无法读取运行诊断：${error.message}`, "诊断失败");
    }
  };

  const sendCurrentExportToAi = async () => {
    if (!exportPayload) return;
    setAiResult({ loading: true });
    try {
      setAiResult(await buildRevisionChecklist(exportPayload));
    } catch (error) {
      setAiResult({
        ok: false,
        summary: `修改清单生成失败：${error.message}`,
        actions: []
      });
    }
  };

  return (
    <div className="app-shell">
      <TitleBar title={view === "projects" ? `批注工作台 - ${project?.name || ""}` : `批注工作台 - ${doc?.name || ""}`} syncState={syncState} />
      <RuntimeSetupNotice
        tools={runtimeTools}
        checking={runtimeChecking}
        dismissed={runtimeNoticeDismissed}
        onRecheck={checkRuntimeTools}
        onDismiss={() => setRuntimeNoticeDismissed(true)}
      />
      {view === "projects" ? (
        hydrated ? <ProjectsView
          projects={projects}
          documents={documents}
          annotations={annotations}
          currentProjectId={currentProjectId}
          onProject={setCurrentProjectId}
          onOpenDoc={openDoc}
          onUpload={handleUploads}
          onOpenImport={() => setImportDialogOpen(true)}
          onNewProject={createProjectFromPrompt}
          groups={groups}
          onNewGroup={createGroupFromPrompt}
          onRenameGroup={renameGroupFromPrompt}
          onDeleteGroup={removeGroup}
          onToggleGroup={toggleGroupCollapsed}
          onMoveGroup={moveGroupBy}
          onMoveProjectToGroup={moveProjectToGroup}
          onRenameProject={openProjectRename}
          onBackup={backupWorkspace}
          onRestore={restoreWorkspaceFile}
          onRevealData={revealDataFolder}
          onFindDuplicates={openDuplicateReview}
          onDiagnostics={runDiagnostics}
          onDeleteDoc={removeDocument}
          onRevealDoc={(doc) => revealDocumentInFinder(doc.id)}
          onArchiveDoc={(doc, archived) => archiveDocument(doc, archived)}
          onMoveDoc={(doc, projectId) => moveDocumentToAnotherProject(doc.id, projectId)}
          onRetryAnalysis={retryDocumentAnalysis}
          onSetProjectDirectory={setProjectDirectory}
          canPickProjectDirectory={canPickProjectDirectory}
          onDeleteProject={removeProject}
        /> : recovery?.active
          ? <WorkspaceRecovery
              recovery={recovery}
              onRestore={async (snapshot, confirmDowngrade) => {
                await restoreWorkspaceSnapshot(snapshot, confirmDowngrade);
                setRecovery(null);
                setWorkspaceLoadError("");
                setWorkspaceLoadAttempt((value) => value + 1);
              }}
              onOpenDataFolder={revealDataFolder}
            />
          : <WorkspaceLoadState
              error={workspaceLoadError}
              pending={pendingSummary}
              onRetry={() => setWorkspaceLoadAttempt((value) => value + 1)}
            />
      ) : doc ? (
        <WorkspaceView
          quoteRecovery={quoteRecovery}
          onRevealSource={() => revealDocumentInFinder(doc.id)}
          key={doc.id}
          project={project}
          doc={doc}
          annotations={annotations}
          pageAnnotations={pageAnnotations}
          markItems={markItems}
          noteAnno={noteAnno}
          history={history[pageKey] || []}
          reviewThreads={reviewThreads}
          currentPage={currentPage}
          mode={mode}
          panelTab={panelTab}
          filterAnnotated={filterAnnotated}
          selectedAnnoId={selectedAnnoId}
          relocatingAnnotation={relocatingAnnotation}
          dragRect={dragRect}
          exportPayload={exportPayload}
          exportOpen={exportOpen}
          exportScope={exportScope}
          exportFormat={exportFormat}
          pdfPageMode={pdfPageMode}
          exportIncludeResolved={exportIncludeResolved}
          exportConversationMode={exportConversationMode}
          exportIncludeLocalPaths={exportIncludeLocalPaths}
          pageSearch={pageSearch}
          annotationFilter={annotationFilter}
          viewer={viewer}
          pageFlow={pageFlow}
          copied={copied}
          aiResult={aiResult}
          refreshState={refreshState}
          refreshNotice={refreshNotice?.documentId === doc?.id ? refreshNotice.text : ""}
          onBack={() => setView("projects")}
          onGoPage={goPage}
          onActivePage={setCurrentPage}
          onPageFlow={(value) => {
            setPageFlow(value);
            window.localStorage.setItem(PAGE_FLOW_KEY, value);
          }}
          onMode={setMode}
          onPanelTab={setPanelTab}
          onFilter={() => setFilterAnnotated((value) => !value)}
          onPageSearch={setPageSearch}
          onAnnotationFilter={setAnnotationFilter}
          onViewer={setViewer}
          onUndo={undoAnnotations}
          onRedo={redoAnnotations}
          canUndo={undoStack.current.length > 0}
          canRedo={redoStack.current.length > 0}
          onPageClick={onPageClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onTextSelection={onTextSelection}
          onUpdateNote={updateNote}
          onSetNoteTag={setNoteTag}
          onUpdateAnnotation={updateAnnotation}
          onDeleteAnnotation={deleteAnnotation}
          onRelocateAnnotation={relocateTextAnnotation}
          onSelectAnnotation={setSelectedAnnoId}
          onReplyThread={submitReviewReply}
          onThreadStatus={changeReviewStatus}
          onClearAnnotations={clearCurrentAnnotations}
          onCreateSnapshot={createSnapshot}
          onRestoreSnapshot={restoreAnnotationSnapshot}
          onRefreshDocument={refreshCurrentDocument}
          onRefreshWithFile={refreshCurrentDocumentWithFile}
          onBindSourceDocument={bindAndRefreshCurrentDocument}
          onRestoreDocumentVersion={restoreCurrentDocumentVersion}
          onMarkAnnotationsReviewed={markAnnotationsReviewed}
          onOpenExport={() => {
            setExportScope("doc");
            setExportFormat("prompt");
            setExportOpen(true);
            setAiResult(null);
          }}
          onCloseExport={() => setExportOpen(false)}
          onExportScope={setExportScope}
          onExportFormat={setExportFormat}
          onPdfPageMode={setPdfPageMode}
          onExportIncludeResolved={setExportIncludeResolved}
          onExportConversationMode={setExportConversationMode}
          onExportIncludeLocalPaths={setExportIncludeLocalPaths}
          onCopyExport={copyExport}
          onCopyForAi={copyAnnotationsForAi}
          aiCopyState={aiCopyState}
          onDownloadExport={downloadExport}
          onDownloadHtmlExport={downloadHtmlExport}
          onDownloadPdfExport={downloadAnnotatedPdfExport}
          onSendAi={sendCurrentExportToAi}
          canPickTrackedPath={canPickTrackedPath}
        />
      ) : null}
      {duplicateReview && (
        <DuplicateReviewModal
          state={duplicateReview}
          onResolve={resolveDuplicateGroup}
          onClose={() => setDuplicateReview(null)}
        />
      )}
      {projectRenameOpen && (
        <ProjectRenameModal
          value={projectRenameValue}
          onValue={setProjectRenameValue}
          onClose={() => setProjectRenameOpen(false)}
          onSubmit={renameCurrentProject}
        />
      )}
      {importDialogOpen && (
        <ImportDocumentDialog
          onClose={() => setImportDialogOpen(false)}
          onImportUrl={handleImportSources}
          onUpload={(files) => {
            setImportDialogOpen(false);
            handleUploads(files);
          }}
        />
      )}
      {appDialog && <AppDialog key={appDialog.id} dialog={appDialog} onResolve={resolveAppDialog} />}
    </div>
  );
}

function TitleBar({ title, syncState }) {
  const label = { synced: "已保存", saving: "保存中", conflict: "保存冲突", offline: "待同步", error: "同步失败", local: "正在载入" }[syncState] || "正在载入";
  const visibleLabel = syncState === "synced" ? "" : label;
  return (
    <div className="titlebar">
      <div className="window-dots" aria-hidden="true">
        <span className="dot red" />
        <span className="dot yellow" />
        <span className="dot green" />
      </div>
      <div className="titlebar-title">{title}</div>
      <div className={`sync-chip ${syncState}`} aria-live="polite">{visibleLabel}</div>
    </div>
  );
}

function RuntimeSetupNotice({ tools, checking, dismissed, onRecheck, onDismiss }) {
  const [copiedId, setCopiedId] = useState("");
  if (!tools) return null;
  const readiness = runtimeReadiness(tools);
  if (readiness.ready) return null;
  if (!readiness.blocked && dismissed) return null;
  const required = readiness.missing.filter((requirement) => requirement.required);
  const optional = readiness.missing.filter((requirement) => !requirement.required);

  const copyInstall = async (requirement) => {
    try {
      await navigator.clipboard.writeText(requirement.install);
      setCopiedId(requirement.id);
      window.setTimeout(() => setCopiedId((current) => (current === requirement.id ? "" : current)), 1600);
    } catch {
      setCopiedId("");
    }
  };

  return (
    <section className={`runtime-setup ${readiness.blocked ? "runtime-setup-blocking" : ""}`} aria-live="polite">
      <div className="runtime-setup-head">
        <div>
          <strong>
            {readiness.blocked ? "还差一个组件才能打开 PDF" : "部分功能需要额外组件"}
          </strong>
          <p>
            {readiness.blocked
              ? "批注工作台调用本机的命令行工具来处理文档，安装包不包含它们。在终端运行下面的命令后点「重新检测」。"
              : "下面的功能暂时不可用，其余部分不受影响。"}
          </p>
        </div>
        <div className="runtime-setup-actions">
          <button type="button" onClick={onRecheck} disabled={checking}>
            {checking ? "检测中…" : "重新检测"}
          </button>
          {!readiness.blocked && (
            <button type="button" onClick={onDismiss}>知道了</button>
          )}
        </div>
      </div>
      {required.length > 0 && (
        <ul className="runtime-setup-list">
          {required.map((requirement) => (
            <li key={requirement.id}>
              <div className="runtime-setup-item-head">
                <strong>{requirement.name}</strong>
                <span className="runtime-tag runtime-tag-required">必需</span>
              </div>
              <p className="runtime-setup-purpose">{requirement.purpose}</p>
              <p className="runtime-setup-consequence">{requirement.consequence}</p>
              <div className="runtime-setup-install">
                <code>{requirement.install}</code>
                <button type="button" onClick={() => copyInstall(requirement)}>
                  {copiedId === requirement.id ? "已复制" : "复制命令"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {optional.length > 0 && (
        // When PDF support itself is missing, the user's whole job is the required command above.
        // Keep the optional components one click away instead of burying it under them.
        <details className="runtime-setup-optional" open={!readiness.blocked}>
          <summary>
            {readiness.blocked
              ? `另有 ${optional.length} 项可选组件`
              : "这些是可选的，缺少时只影响对应功能"}
          </summary>
          <ul>
            {optional.map((requirement) => (
              <li key={requirement.id}>
                <span className="runtime-setup-optional-name">{requirement.name}</span>
                <span className="runtime-setup-optional-purpose">{requirement.purpose}</span>
                <code>{requirement.install}</code>
                <button type="button" onClick={() => copyInstall(requirement)}>
                  {copiedId === requirement.id ? "已复制" : "复制"}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function WorkspaceLoadState({ error, pending, onRetry }) {
  return (
    <main className="workspace-load-state" role={error ? "alert" : "status"}>
      <div>
        <span className={`workspace-load-icon ${error ? "error" : ""}`}><Icon name={error ? "error" : "refresh"} /></span>
        <strong>{error ? "本地工作区无法打开" : "正在打开本地工作区"}</strong>
        <p>{error || "正在读取文档和批注，请稍候。"}</p>
        {error && pending?.hasPending && (
          <p className="workspace-load-pending">
            本机还有 {pending.annotationCount} 条批注（{pending.documentCount} 份文档 · {pending.pageCount} 页）尚未同步。
            它们保存在浏览器本地，连接恢复后会自动写回，不会丢失。
          </p>
        )}
        {error && <button className="secondary-action" onClick={onRetry}><Icon name="refresh" />重新连接</button>}
      </div>
    </main>
  );
}

function WorkspaceRecovery({ recovery, onRestore, onOpenDataFolder }) {
  const [selected, setSelected] = useState(() => recovery.snapshots.find((item) => item.usable)?.name || "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const downgrade = recovery.code === "WORKSPACE_SCHEMA_TOO_NEW";
  const usable = recovery.snapshots.filter((snapshot) => snapshot.usable);

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    setFailure("");
    try {
      await onRestore(selected, downgrade);
    } catch (error) {
      setFailure(error?.payload?.detail || error?.message || "恢复失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="workspace-recovery" role="alert">
      <div className="workspace-recovery-card">
        <span className="workspace-load-icon error"><Icon name="error" /></span>
        <strong>{downgrade ? "这个工作区由更新版本写入" : "工作区文件无法读取"}</strong>
        <p>{recovery.detail}</p>
        {downgrade ? (
          <p className="workspace-recovery-note">
            数据没有损坏。装回新版本的批注工作台就能继续使用。只有在确定要放弃新版本写入的内容时，
            才从下面的快照回滚。
          </p>
        ) : (
          <p className="workspace-recovery-note">
            应用每小时会自动保存一份工作区快照。选择一个时间点恢复，当前文件会被保留在数据目录的
            backups 里。
          </p>
        )}

        {usable.length === 0 ? (
          <p className="workspace-recovery-empty">
            没有可用的自动快照。可以打开数据目录，用「完整备份」文件恢复。
          </p>
        ) : (
          <ul className="workspace-recovery-list">
            {usable.map((snapshot) => (
              <li key={snapshot.name}>
                <label>
                  <input
                    type="radio"
                    name="workspace-snapshot"
                    value={snapshot.name}
                    checked={selected === snapshot.name}
                    onChange={() => setSelected(snapshot.name)}
                  />
                  <span className="workspace-recovery-time">{formatDateTime(snapshot.takenAt)}</span>
                  <span className="workspace-recovery-meta">
                    {snapshot.documentCount} 份文档 · {snapshot.annotationCount} 条批注 · {formatBytes(snapshot.bytes)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {recovery.preservedPath && (
          <p className="workspace-recovery-preserved">
            原文件：<code>{recovery.preservedPath.split("/").pop()}</code>（在数据目录的 backups 里）
          </p>
        )}

        {failure && <p className="workspace-recovery-failure">{failure}</p>}

        <div className="workspace-recovery-actions">
          <button className="secondary-action" onClick={onOpenDataFolder}>
            <Icon name="folder" />打开数据目录
          </button>
          <button
            className="primary-action"
            onClick={restore}
            disabled={busy || !selected}
          >
            {busy ? "恢复中…" : downgrade ? "仍要回滚到这个快照" : "恢复到这个快照"}
          </button>
        </div>
      </div>
    </main>
  );
}

function ProjectsView({
  projects,
  documents,
  annotations,
  currentProjectId,
  onProject,
  onOpenDoc,
  onUpload,
  onOpenImport,
  onNewProject,
  groups,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onToggleGroup,
  onMoveGroup,
  onMoveProjectToGroup,
  onRenameProject,
  onBackup,
  onRestore,
  onRevealData,
  onFindDuplicates,
  onDiagnostics,
  onDeleteDoc,
  onRevealDoc,
  onArchiveDoc,
  onMoveDoc,
  onDeleteProject,
  onRetryAnalysis,
  onSetProjectDirectory,
  canPickProjectDirectory,
}) {
  const [documentSearch, setDocumentSearch] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Ungrouped projects come first and without a heading, so a workspace that never makes a group
  // looks exactly as it did before groups existed.
  const roots = projects.filter((project) => !project.parentId);
  // The sidebar counts what is being worked on. Archived documents are still in the project, but
  // counting them makes a tidied project look as busy as it was before.
  const liveCount = (project) => (project.docIds || []).filter((id) => documents[id] && !documents[id].archivedAt).length;
  const sidebarSections = [
    { key: "__ungrouped", group: null, roots: roots.filter((project) => !project.groupId) },
    ...groups.map((group) => ({ key: group.id, group, roots: roots.filter((project) => project.groupId === group.id) }))
  ].filter((section) => section.group || section.roots.length);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectInfoOpen, setProjectInfoOpen] = useState(false);
  const projectMenuRef = useRef(null);
  const currentProject = projects.find((project) => project.id === currentProjectId) || projects[0];
  const childProjects = projects.filter((project) => project.parentId === currentProject.id);
  const [includeChildren, setIncludeChildren] = useState(false);
  // Moving every document into sub-projects would otherwise leave the parent looking empty, so it
  // can roll them up — but only on request, because "what is filed directly here" is the question
  // the list answers the rest of the time.
  const listedProjectIds = includeChildren && childProjects.length
    ? [currentProject.id, ...childProjects.map((project) => project.id)]
    : [currentProject.id];
  const projectDocs = listedProjectIds
    .flatMap((projectId) => projects.find((project) => project.id === projectId)?.docIds || [])
    .map((id) => documents[id])
    .filter(Boolean);
  // Roots first, each followed by its own children, so the menu reads like the sidebar.
  const moveTargets = projects
    .filter((project) => !project.parentId)
    .flatMap((root) => [root, ...projects.filter((project) => project.parentId === root.id)]);
  const query = documentSearch.trim().toLowerCase();
  const matched = (query ? Object.values(documents) : projectDocs).filter((doc) => {
    if (!query) return true;
    const annotationText = Array.from({ length: doc.pageCount }, (_, index) => annotations[`${doc.id}:${index + 1}`] || [])
      .flat()
      .map((item) => `${item.quote || ""} ${item.text || ""}`)
      .join(" ");
    return `${doc.name} ${doc.ext} ${documentSourceDisplayPath(doc)} ${annotationText}`.toLowerCase().includes(query);
  });
  // Archived documents keep their place in the project but drop below the fold: still here, still
  // searchable, just not in the way of the ones being worked on.
  const docs = matched.filter((doc) => !doc.archivedAt);
  const archivedDocs = matched.filter((doc) => doc.archivedAt);
  const projectNames = Object.fromEntries(projects.map((item) => [item.id, item.name]));

  useEffect(() => {
    setProjectMenuOpen(false);
    setProjectInfoOpen(false);
  }, [currentProjectId]);

  useEffect(() => {
    if (!projectMenuOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!projectMenuRef.current?.contains(event.target)) setProjectMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectMenuOpen]);

  const closeProjectMenu = () => {
    setProjectMenuOpen(false);
    setProjectInfoOpen(false);
  };

  return (
    <div className="projects-layout">
      <aside className="projects-sidebar">
        <Brand />
        <div className="nav-section-label">项目</div>
        <div className="project-list">
          {sidebarSections.map((section) => (
            <div key={section.key} className={`project-section ${section.group ? "grouped" : ""}`}>
              {section.group && (
                <div className="group-header">
                  <button
                    className="group-toggle"
                    type="button"
                    aria-expanded={!section.group.collapsed}
                    onClick={() => onToggleGroup(section.group.id)}
                    title={section.group.collapsed ? "展开分组" : "折叠分组"}
                  >
                    <Icon name={section.group.collapsed ? "chevron_right" : "expand_more"} />
                    <span className="group-name">{section.group.name}</span>
                    <span className="group-count">{section.roots.length}</span>
                  </button>
                  <GroupMenu
                    group={section.group}
                    canMoveUp={groups.findIndex((item) => item.id === section.group.id) > 0}
                    canMoveDown={groups.findIndex((item) => item.id === section.group.id) < groups.length - 1}
                    onNewProject={() => onNewProject("", section.group.id)}
                    onRename={() => onRenameGroup(section.group.id)}
                    onMove={(offset) => onMoveGroup(section.group.id, offset)}
                    onDelete={() => onDeleteGroup(section.group.id)}
                  />
                </div>
              )}
              {!section.group?.collapsed && section.roots.map((root) => (
                <div key={root.id} className="project-branch">
                  <div className="project-row-wrap">
                    <button className={`project-row ${root.id === currentProjectId ? "active" : ""}`} onClick={() => onProject(root.id)}>
                      <span className="project-dot" style={{ background: root.color }} />
                      <span className="project-copy">
                        <strong>{root.name}</strong>
                        <small>{root.path}</small>
                      </span>
                      <span className="doc-count">{liveCount(root)}</span>
                    </button>
                    <ProjectRowMenu
                      project={root}
                      groups={groups}
                      onNewChild={() => onNewProject(root.id)}
                      onMoveToGroup={(groupId) => onMoveProjectToGroup(root.id, groupId)}
                    />
                  </div>
                  {projects.filter((project) => project.parentId === root.id).map((child) => (
                    <button
                      key={child.id}
                      className={`project-row project-row-child ${child.id === currentProjectId ? "active" : ""}`}
                      onClick={() => onProject(child.id)}
                    >
                      <span className="project-dot" style={{ background: child.color }} />
                      <span className="project-copy">
                        <strong>{child.name}</strong>
                      </span>
                      <span className="doc-count">{liveCount(child)}</span>
                    </button>
                  ))}
                </div>
              ))}
              {section.group && !section.group.collapsed && section.roots.length === 0 && (
                <p className="group-empty">还没有项目。用右侧的 ＋ 在这个分组下新建。</p>
              )}
            </div>
          ))}
        </div>
        <button className="new-group-btn" type="button" onClick={onNewGroup}>
          <Icon name="create_new_folder" />
          新建分组
        </button>
        <button className="new-project-btn" onClick={() => onNewProject("")}>
          <Icon name="create_new_folder" />
          新建项目
        </button>
      </aside>

      <main
        className={`projects-main ${dragActive ? "drag-active" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
        onDrop={(event) => { event.preventDefault(); setDragActive(false); onUpload(event.dataTransfer.files); }}
      >
        {dragActive && <div className="drop-overlay"><Icon name="file_upload" /><strong>松开以导入文档</strong><span>支持同时导入多个文件</span></div>}
        <div className="project-heading">
          <h1>{currentProject.name}</h1>
          <div className="project-heading-actions" ref={projectMenuRef}>
            <button className="project-icon-action import" type="button" onClick={onOpenImport} title="导入文档" aria-label="导入文档">
              <Icon name="add" />
            </button>
            <button
              className="project-icon-action"
              type="button"
              title="更多项目操作"
              aria-label="更多项目操作"
              aria-haspopup="menu"
              aria-expanded={projectMenuOpen}
              onClick={() => setProjectMenuOpen((value) => !value)}
            >
              <Icon name="more_horiz" />
            </button>
            {projectMenuOpen && (
              <div className="project-menu" role="menu" aria-label="项目操作">
                <button type="button" role="menuitem" onClick={() => { closeProjectMenu(); onRenameProject(); }}><Icon name="edit" /><span>重命名</span></button>
                <button type="button" role="menuitem" aria-expanded={projectInfoOpen} onClick={() => setProjectInfoOpen((value) => !value)}>
                  <Icon name="info" /><span>项目基本信息</span><Icon name={projectInfoOpen ? "expand_less" : "chevron_right"} />
                </button>
                {projectInfoOpen && (
                  <div className="project-menu-info">
                    <span>目录</span>
                    <strong title={currentProject.path || "本地工作区"}>{currentProject.path || "本地工作区"}</strong>
                    <span>最近更新</span>
                    <strong>{formatDateTime(currentProject.updated)}</strong>
                  </div>
                )}
                {canPickProjectDirectory && (
                  <button type="button" role="menuitem" onClick={() => { closeProjectMenu(); onSetProjectDirectory(currentProject); }}>
                    <Icon name="folder" /><span>设置项目目录</span>
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => { closeProjectMenu(); onRevealData(); }}><Icon name="folder_open" /><span>在访达中打开</span></button>
                <div className="project-menu-divider" />
                <button type="button" role="menuitem" onClick={() => { closeProjectMenu(); onBackup(); }}><Icon name="archive" /><span>完整备份</span></button>
                <label role="menuitem" tabIndex={0} onKeyDown={activateFileLabel}>
                  <Icon name="unarchive" /><span>恢复备份</span>
                  <input type="file" accept=".reviewbackup,application/zip" onChange={(event) => { onRestore(event.target.files?.[0]); event.currentTarget.value = ""; closeProjectMenu(); }} />
                </label>
                <button type="button" role="menuitem" onClick={() => { closeProjectMenu(); onFindDuplicates(); }}><Icon name="content_copy" /><span>查找重复文档</span></button>
                <button type="button" role="menuitem" onClick={() => { closeProjectMenu(); onDiagnostics(); }}><Icon name="monitor_heart" /><span>运行诊断</span></button>
                <div className="project-menu-divider" />
                <button type="button" role="menuitem" className="project-menu-danger" onClick={() => { closeProjectMenu(); onDeleteProject(currentProject); }}>
                  <Icon name="delete" /><span>删除项目</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="project-search">
          <Icon name="search" />
          <input value={documentSearch} onChange={(event) => setDocumentSearch(event.target.value)} placeholder="搜索文件名、路径或批注" aria-label="搜索文件名、路径或批注" />
          {documentSearch && <button onClick={() => setDocumentSearch("")} title="清除搜索" aria-label="清除搜索"><Icon name="close" /></button>}
        </div>
        <div className="section-label">
          <span>{query ? `搜索结果 · ${docs.length + archivedDocs.length}` : "文档"}</span>
          {!query && childProjects.length > 0 && (
            <label className="include-children">
              <input type="checkbox" checked={includeChildren} onChange={(event) => setIncludeChildren(event.target.checked)} />
              含子项目（{childProjects.length}）
            </label>
          )}
        </div>
        <div className="document-list">
          <div className="document-list-head" aria-hidden="true">
            <span>文件名</span>
            <span>路径</span>
            <span>类型</span>
            <span>页数</span>
            <span>批注</span>
            <span />
          </div>
          {docs.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              annotations={annotations}
              projectName={query ? projectNames[doc.projectId] : ""}
              moveTargets={moveTargets.filter((target) => target.id !== doc.projectId)}
              onOpen={() => onOpenDoc(doc.id)}
              onDelete={() => onDeleteDoc(doc)}
              onRetryAnalysis={() => onRetryAnalysis(doc)}
              onReveal={() => onRevealDoc(doc)}
              onMove={(projectId) => onMoveDoc(doc, projectId)}
              onArchive={(archived) => onArchiveDoc(doc, archived)}
            />
          ))}
        </div>
        {archivedDocs.length > 0 && (
          <div className="archived-section">
            <button className="archived-toggle" type="button" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((value) => !value)}>
              <Icon name={archivedOpen ? "expand_more" : "chevron_right"} />
              <span>已归档 · {archivedDocs.length}</span>
            </button>
            {archivedOpen && (
              <div className="document-list archived-list">
                {archivedDocs.map((doc) => (
                  <DocumentRow
                    key={doc.id}
                    doc={doc}
                    annotations={annotations}
                    projectName={query ? projectNames[doc.projectId] : ""}
                    moveTargets={moveTargets.filter((target) => target.id !== doc.projectId)}
                    onOpen={() => onOpenDoc(doc.id)}
                    onDelete={() => onDeleteDoc(doc)}
                    onRetryAnalysis={() => onRetryAnalysis(doc)}
                    onReveal={() => onRevealDoc(doc)}
                    onMove={(projectId) => onMoveDoc(doc, projectId)}
                    onArchive={(archived) => onArchiveDoc(doc, archived)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {docs.length === 0 && archivedDocs.length === 0 && <div className="project-empty"><Icon name={query ? "search_off" : "draft"} /><span>{query ? "没有匹配的文档或批注" : "导入文档后即可开始批注"}</span></div>}
      </main>
    </div>
  );
}

function WorkspaceView(props) {
  const {
    quoteRecovery,
    onRevealSource,
    doc,
    annotations,
    pageAnnotations,
    markItems,
    noteAnno,
    history,
    reviewThreads,
    currentPage,
    mode,
    panelTab,
    filterAnnotated,
    selectedAnnoId,
    relocatingAnnotation,
    dragRect,
    exportPayload,
    exportOpen,
    exportScope,
    exportFormat,
    pdfPageMode,
    exportIncludeResolved,
    exportConversationMode,
    exportIncludeLocalPaths,
    pageSearch,
    annotationFilter,
    viewer,
    pageFlow,
    copied,
    aiResult,
    refreshState,
    refreshNotice,
    onBack,
    onGoPage,
    onActivePage,
    onPageFlow,
    onMode,
    onPanelTab,
    onFilter,
    onPageSearch,
    onAnnotationFilter,
    onViewer,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onPageClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTextSelection,
    onUpdateNote,
    onSetNoteTag,
    onUpdateAnnotation,
    onDeleteAnnotation,
    onRelocateAnnotation,
    onSelectAnnotation,
    onReplyThread,
    onThreadStatus,
    onClearAnnotations,
    onCreateSnapshot,
    onRestoreSnapshot,
    onRefreshDocument,
    onRefreshWithFile,
    onBindSourceDocument,
    onRestoreDocumentVersion,
    onMarkAnnotationsReviewed,
    onOpenExport,
    onCloseExport,
    onExportScope,
    onExportFormat,
    onPdfPageMode,
    onExportIncludeResolved,
    onExportConversationMode,
    onExportIncludeLocalPaths,
    onCopyExport,
    onCopyForAi,
    aiCopyState,
    onDownloadExport,
    onDownloadHtmlExport,
    onDownloadPdfExport,
    onSendAi,
    canPickTrackedPath
  } = props;

  const [sidebarTab, setSidebarTab] = useState("outline");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [outlineTarget, setOutlineTarget] = useState(null);
  const [pageSidebarOpen, setPageSidebarOpen] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const [annotationListScope, setAnnotationListScope] = useState("page");
  const [continuousVisiblePages, setContinuousVisiblePages] = useState(() => new Set([1, 2]));
  const [documentSearchMatches, setDocumentSearchMatches] = useState([]);
  const compactPanels = useMediaQuery("(max-width: 1320px)");
  const viewerWrapRef = useRef(null);
  const pageToggleRef = useRef(null);
  const annotationToggleRef = useRef(null);

  useEffect(() => {
    setSidebarTab("outline");
    setSelectedVersionId("");
  }, [doc?.id]);

  useEffect(() => {
    if (!outlineTarget) return undefined;
    const timer = window.setTimeout(() => setOutlineTarget(null), 1800);
    return () => window.clearTimeout(timer);
  }, [outlineTarget]);

  useEffect(() => {
    const query = pageSearch.trim();
    if (!doc?.id || query.length < 2) {
      setDocumentSearchMatches([]);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchDocument(doc.id, query, controller.signal)
        .then((result) => {
          if (!cancelled) setDocumentSearchMatches(result.matches || []);
        })
        .catch(() => {
          if (!cancelled) setDocumentSearchMatches([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [doc?.id, pageSearch]);

  useEffect(() => {
    if (!compactPanels || (!pageSidebarOpen && !annotationPanelOpen)) return undefined;
    const closePanel = (event) => {
      if (event.key !== "Escape") return;
      const focusTarget = pageSidebarOpen ? pageToggleRef.current : annotationToggleRef.current;
      setPageSidebarOpen(false);
      setAnnotationPanelOpen(false);
      window.requestAnimationFrame(() => focusTarget?.focus());
    };
    document.addEventListener("keydown", closePanel);
    return () => document.removeEventListener("keydown", closePanel);
  }, [compactPanels, pageSidebarOpen, annotationPanelOpen]);

  const restoreSelectedVersion = async () => {
    if (!selectedVersionId || refreshState !== "idle") return;
    const restored = await onRestoreDocumentVersion(selectedVersionId);
    if (restored) setSelectedVersionId("");
  };
  const searchMatchMap = new Map(documentSearchMatches.map((match) => [Number(match.page), match]));
  const visiblePages = Array.from({ length: doc.pageCount }, (_, index) => index + 1).filter((page) => {
    const count = (annotations[`${doc.id}:${page}`] || []).length;
    const title = pageTitle(doc, page);
    const list = annotations[`${doc.id}:${page}`] || [];
    const searchText = `${title} ${list.map((item) => item.text || "").join(" ")}`.toLowerCase();
    const matchesSearch = !pageSearch.trim() || searchText.includes(pageSearch.trim().toLowerCase()) || searchMatchMap.has(page);
    return matchesSearch && (!filterAnnotated || count > 0 || page === currentPage);
  });
  const visiblePageKey = visiblePages.join(",");
  const documentAnnotationGroups = buildAnnotationListGroups({
    documentId: doc.id,
    pageCount: doc.pageCount,
    annotations,
    reviewThreads,
    currentPage,
    scope: "document",
    filter: "all"
  });
  const visibleAnnotationGroups = buildAnnotationListGroups({
    documentId: doc.id,
    pageCount: doc.pageCount,
    annotations,
    reviewThreads,
    currentPage,
    scope: annotationListScope,
    filter: annotationFilter
  });
  const currentPageAnnotationCount = markItems.length + (noteAnno?.text?.trim() ? 1 : 0);
  const documentAnnotationCount = annotationGroupCount(documentAnnotationGroups);
  const listedAnnotationCount = annotationGroupCount(visibleAnnotationGroups);
  const viewerStyle = useMemo(
    () => ({ transform: `translate(-50%, -50%) rotate(${viewer.rotation}deg)`, transformOrigin: "center center" }),
    [viewer.rotation]
  );
  // Per-page overlay items, rebuilt only when the annotations or their review state change. Built
  // inline they were a fresh array per page per render, which defeated any memoisation downstream.
  // Rebuilding the whole map on any change handed every page a fresh array, so React.memo never
  // skipped during the interaction it exists for: typing in one annotation re-rendered every page.
  // Reuse the previous array for any page whose own inputs are identity-unchanged.
  const overlayCache = useRef({ docId: "", annotations: null, reviewThreads: null, byPage: new Map() });
  const overlayItemsByPage = useMemo(() => {
    if (pageFlow !== "continuous") return EMPTY_OVERLAY_MAP;
    const previous = overlayCache.current;
    const sameDocument = previous.docId === doc.id;
    const byPage = new Map();
    for (let page = 1; page <= Number(doc.pageCount || 1); page += 1) {
      const key = `${doc.id}:${page}`;
      const list = annotations[key] || [];
      const unchanged = sameDocument
        && previous.annotations?.[key] === annotations[key]
        && previous.reviewThreads === reviewThreads
        && previous.byPage.has(page);
      if (unchanged) {
        byPage.set(page, previous.byPage.get(page));
        continue;
      }
      const items = withAnnotationDisplayLabels(list).filter((item) => item.type !== "note" && annotationOverlayVisible(reviewThreads[item.id], item));
      byPage.set(page, items.length ? items : EMPTY_OVERLAY_ITEMS);
    }
    overlayCache.current = { docId: doc.id, annotations, reviewThreads, byPage };
    return byPage;
  }, [doc.id, doc.pageCount, annotations, reviewThreads, pageFlow]);

  const stablePageClick = useStableCallback(onPageClick);
  const stablePointerDown = useStableCallback(onPointerDown);
  const stablePointerMove = useStableCallback(onPointerMove);
  const stablePointerUp = useStableCallback(onPointerUp);
  const stableTextSelection = useStableCallback(onTextSelection);
  const stableSelectAnnotation = useStableCallback((annotationId, page) => {
    onActivePage(page);
    onSelectAnnotation(annotationId);
  });

  const currentPageData = doc.pages?.[currentPage - 1] || {};
  const currentLayout = pageStageLayout(currentPageData, viewer.zoom, viewer.rotation);
  const { orientation, effectiveBaseWidth, stageStyle } = currentLayout;
  const numberedOutline = useMemo(() => addOutlineDisplayNumbers(doc.outline || []), [doc.outline]);
  const visibleOutline = useMemo(() => {
    const query = pageSearch.trim().toLowerCase();
    if (!query) return numberedOutline;
    return numberedOutline.filter((item) => {
      const text = `${item.displayTitle || item.title || ""} ${item.number || ""} ${item.type || ""}`.toLowerCase();
      return text.includes(query);
    });
  }, [numberedOutline, pageSearch]);
  const goOutline = (item) => {
    setOutlineTarget(item);
    setPageSidebarOpen(false);
    goPage(item.page);
  };
  const scrollContinuousPage = (page, behavior = "smooth") => {
    const wrap = viewerWrapRef.current;
    const target = wrap?.querySelector(`[data-continuous-page="${page}"]`);
    if (!wrap || !target) return;
    const wrapRect = wrap.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    wrap.scrollTo({ top: wrap.scrollTop + targetRect.top - wrapRect.top - 16, behavior });
  };
  const goPage = (page) => {
    setPageSidebarOpen(false);
    if (pageFlow === "continuous") {
      onActivePage(page);
      window.requestAnimationFrame(() => scrollContinuousPage(page));
    } else {
      onGoPage(page);
    }
  };
  const selectListAnnotation = (page, annotationId) => {
    if (page !== currentPage) goPage(page);
    onSelectAnnotation(annotationId);
  };
  const fitViewerToWidth = () => {
    const wrap = viewerWrapRef.current;
    if (!wrap) {
      onViewer((value) => ({ ...value, zoom: 1 }));
      return;
    }
    const style = window.getComputedStyle(wrap);
    const horizontalPadding = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
    const availableWidth = Math.max(1, wrap.clientWidth - horizontalPadding);
    const fittedZoom = clamp(round2((availableWidth - 20) / effectiveBaseWidth), MIN_ZOOM, MAX_ZOOM);
    onViewer((value) => ({ ...value, zoom: fittedZoom }));
    window.requestAnimationFrame(() => {
      wrap.scrollLeft = 0;
    });
  };

  useEffect(() => {
    const wrap = viewerWrapRef.current;
    if (!wrap) return undefined;
    const onViewerWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const anchorX = pointerX + wrap.scrollLeft;
      const anchorY = pointerY + wrap.scrollTop;
      const previousZoom = viewer.zoom;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const nextZoom = clamp(round2(previousZoom * Math.exp(-delta * 0.002)), MIN_ZOOM, MAX_ZOOM);
      if (nextZoom === previousZoom) return;
      onViewer((value) => ({ ...value, zoom: nextZoom }));
      window.requestAnimationFrame(() => {
        const ratio = nextZoom / previousZoom;
        wrap.scrollLeft = anchorX * ratio - pointerX;
        wrap.scrollTop = anchorY * ratio - pointerY;
      });
    };
    wrap.addEventListener("wheel", onViewerWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onViewerWheel);
  }, [onViewer, viewer.zoom]);

  useEffect(() => {
    if (pageFlow !== "continuous") return undefined;
    const wrap = viewerWrapRef.current;
    if (!wrap || typeof IntersectionObserver === "undefined") return undefined;
    const nodes = [...wrap.querySelectorAll("[data-continuous-page]")];
    const candidates = new Map();
    let frame = 0;
    const updateActivePage = () => {
      frame = 0;
      if (!nodes.length) return;
      const firstPage = Number(nodes[0].dataset.continuousPage);
      const lastPage = Number(nodes[nodes.length - 1].dataset.continuousPage);
      const visible = [...candidates.values()];
      const readingLine = wrap.getBoundingClientRect().top + Math.min(180, wrap.clientHeight * 0.28);
      const page = continuousActivePage({
        scrollTop: wrap.scrollTop,
        clientHeight: wrap.clientHeight,
        scrollHeight: wrap.scrollHeight,
        firstPage,
        lastPage,
        readingLine,
        candidates: visible.map((entry) => ({
          page: Number(entry.target.dataset.continuousPage),
          top: entry.target.getBoundingClientRect().top
        }))
      });
      if (page) onActivePage(page);
    };
    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateActivePage);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) candidates.set(entry.target, entry);
        else candidates.delete(entry.target);
      }
      scheduleUpdate();
    }, { root: wrap, rootMargin: "-15% 0px -70% 0px", threshold: 0 });
    for (const node of nodes) observer.observe(node);
    wrap.addEventListener("scroll", scheduleUpdate, { passive: true });
    scheduleUpdate();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      wrap.removeEventListener("scroll", scheduleUpdate);
      observer.disconnect();
    };
  }, [doc.id, pageFlow, onActivePage, visiblePageKey]);

  useEffect(() => {
    if (pageFlow !== "continuous") return undefined;
    const wrap = viewerWrapRef.current;
    if (!wrap || typeof IntersectionObserver === "undefined") {
      setContinuousVisiblePages(new Set(Array.from({ length: doc.pageCount }, (_, index) => index + 1)));
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      setContinuousVisiblePages((previous) => {
        const next = new Set(previous);
        let changed = false;
        for (const entry of entries) {
          const page = Number(entry.target.dataset.continuousPage);
          if (!page) continue;
          if (entry.isIntersecting && !next.has(page)) {
            next.add(page);
            changed = true;
          } else if (!entry.isIntersecting && next.delete(page)) {
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    }, { root: wrap, rootMargin: "600px 0px", threshold: 0 });
    for (const node of wrap.querySelectorAll("[data-continuous-page]")) observer.observe(node);
    return () => observer.disconnect();
  }, [doc.id, doc.pageCount, pageFlow, visiblePageKey]);

  useEffect(() => {
    if (pageFlow !== "continuous") return;
    window.requestAnimationFrame(() => scrollContinuousPage(currentPage, "auto"));
  }, [doc.id, pageFlow]);

  return (
    <div className={`workspace-layout ${pageSidebarOpen ? "page-sidebar-open" : ""} ${annotationPanelOpen ? "annotation-panel-open" : ""}`}>
      <aside
        className="page-sidebar"
        id="page-sidebar"
        aria-hidden={compactPanels && !pageSidebarOpen ? "true" : undefined}
        inert={compactPanels && !pageSidebarOpen ? "" : undefined}
      >
        <div className="doc-head">
          <TypeIcon type={doc.type} />
          <div>
            <strong>{doc.name}</strong>
            <small>{doc.ext} · {doc.pageCount} 页</small>
            <div className="doc-version-meta">
              {doc.importUrl
                ? <span title={doc.importUrl}>来源链接：{remoteSourceHost(doc.importUrl)}</span>
                : doc.sourceTracked === false
                  ? <span title="设置一次源文件后，以后可直接刷新">源文件：未关联</span>
                  : <span title={doc.sourceLabel || doc.sourcePath || ""}>源文件修改：{formatDateTime(doc.sourceModifiedAt || doc.updated)}</span>}
              <span>上次刷新：{formatDateTime(doc.refreshedAt || doc.updated)}</span>
              {doc.sourceSize ? <span>{formatBytes(doc.sourceSize)}</span> : null}
              {doc.versions?.length ? <span>可恢复版本：{doc.versions.length}</span> : null}
              {refreshNotice && <em className="refresh-success"><Icon name="check" />{refreshNotice}</em>}
              {doc.sourceMissing && <em><Icon name="error" />源文件已移动</em>}
              {doc.hasNewerSource && <em><Icon name="new_releases" />有新版本</em>}
              {doc.textLayerStatus === "none" && <em><Icon name="error" />无可选文字层</em>}
              {doc.textLayerStatus === "partial" && <em><Icon name="error" />部分页面无文字层</em>}
              {doc.annotationsNeedReview && <em><Icon name="fact_check" />旧批注待核对</em>}
            </div>
          </div>
        </div>
        <div className="doc-management">
          <button onClick={() => onRefreshDocument(false)} disabled={refreshState !== "idle"}><Icon name="refresh" />{refreshState === "refreshing" ? "刷新中" : "刷新"}</button>
          <button onClick={onRevealSource} title="在访达中显示这份文档所在的文件夹"><Icon name="folder_open" />所在文件夹</button>
          <label role="button" tabIndex={0} onKeyDown={activateFileLabel} title="选择修改后的文档版本"><Icon name="upload_file" />选择新版<input type="file" accept={DOCUMENT_ACCEPT} onChange={(event) => { onRefreshWithFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          {canPickTrackedPath && <button onClick={onBindSourceDocument} disabled={refreshState !== "idle"} title="指定用于刷新的原始文件"><Icon name="link" />{doc.sourceTracked === false ? "设置源" : "更换源"}</button>}
          {doc.versions?.length ? (
            <div className="doc-version-restore">
              <label className="doc-version-select">
                <Icon name="history" />
                <select
                  value={selectedVersionId}
                  disabled={refreshState !== "idle"}
                  aria-label="选择文档旧版本"
                  onChange={(event) => setSelectedVersionId(event.target.value)}
                >
                  <option value="">选择旧版本</option>
                  {doc.versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {formatDateTime(version.capturedAt)} · {version.pageCount} 页
                    </option>
                  ))}
                </select>
              </label>
              <button className="restore-version-action" disabled={!selectedVersionId || refreshState !== "idle"} onClick={restoreSelectedVersion}>恢复</button>
            </div>
          ) : null}
          {doc.annotationsNeedReview && <button onClick={onMarkAnnotationsReviewed}><Icon name="fact_check" />已核对</button>}
        </div>
        <div className="sidebar-tabs">
          <button className={sidebarTab === "outline" ? "active" : ""} aria-pressed={sidebarTab === "outline"} onClick={() => setSidebarTab("outline")}><Icon name="account_tree" />结构</button>
          <button className={sidebarTab === "pages" ? "active" : ""} aria-pressed={sidebarTab === "pages"} onClick={() => setSidebarTab("pages")}><Icon name="view_agenda" />页面</button>
        </div>
        <div className="page-search">
          <Icon name="search" />
          <input value={pageSearch} onChange={(event) => onPageSearch(event.target.value)} placeholder={sidebarTab === "outline" ? "搜索章节或图表" : "搜索页标题或批注"} />
        </div>
        {sidebarTab === "pages" ? (
          <>
            <div className="pages-toolbar">
              <span>页面</span>
              <button className={filterAnnotated ? "small-filter active" : "small-filter"} onClick={onFilter}><Icon name="filter_list" />{filterAnnotated ? "全部" : "仅已批注"}</button>
            </div>
            <div className="thumb-list">
              {visiblePages.map((page) => {
                const count = (annotations[`${doc.id}:${page}`] || []).length;
                return (
                  <button key={page} className={`thumb-row ${page === currentPage ? "active" : ""}`} onClick={() => goPage(page)}>
                    <span className="page-num">{page}</span>
                    <span className="thumb-copy">
                      <span className="thumb-title">{pageTitle(doc, page)}</span>
                      {searchMatchMap.get(page)?.snippet && <small>{searchMatchMap.get(page).snippet}</small>}
                    </span>
                    {count > 0 && <span className="anno-bubble">{count}</span>}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <OutlineList items={visibleOutline} currentPage={currentPage} onJump={goOutline} />
        )}
      </aside>

      <main className="review-main">
        <div className="review-topbar">
          <button className="workspace-back-button" onClick={onBack} title="返回文档列表" aria-label="返回文档列表"><Icon name="arrow_back" /></button>
          <button ref={pageToggleRef} className="panel-toggle" aria-controls="page-sidebar" aria-expanded={pageSidebarOpen} onClick={() => { setPageSidebarOpen((open) => !open); setAnnotationPanelOpen(false); }} title="页面与结构"><Icon name={sidebarTab === "outline" ? "account_tree" : "view_agenda"} /><span>{sidebarTab === "outline" ? "结构" : "页面"}</span></button>
          <button ref={annotationToggleRef} className="panel-toggle" aria-controls="annotation-panel" aria-expanded={annotationPanelOpen} onClick={() => { setAnnotationPanelOpen((open) => !open); setPageSidebarOpen(false); }} title="批注面板"><Icon name="edit_note" /><span>批注</span></button>
          <span className="doc-path">{doc.name}</span>
          {/* Refresh lives in the sidebar with the rest of the source controls, and below 1320px the
              sidebar is a drawer that starts closed — so on anything but a maximised window neither
              the "newer version" badge nor the button to act on it was visible at all. Both belong
              in the bar that is always on screen. */}
          <button
            className={`topbar-refresh ${doc.hasNewerSource ? "has-update" : ""}`}
            type="button"
            disabled={refreshState !== "idle"}
            onClick={() => onRefreshDocument(false)}
            title={doc.hasNewerSource ? "源文件已更新，点击刷新到最新版本" : "从源文件刷新这份文档"}
          >
            <Icon name={doc.hasNewerSource ? "new_releases" : "refresh"} />
            <span>{refreshState === "refreshing" ? "刷新中" : doc.hasNewerSource ? "有新版本" : "刷新"}</span>
          </button>
          <div className="spacer" />
          <Segment className="page-controls">
            <button disabled={currentPage <= 1} onClick={() => goPage(currentPage - 1)} title="上一页" aria-label="上一页"><Icon name="chevron_left" /></button>
            <span>第 {currentPage} / {doc.pageCount} 页</span>
            <button disabled={currentPage >= doc.pageCount} onClick={() => goPage(currentPage + 1)} title="下一页" aria-label="下一页"><Icon name="chevron_right" /></button>
          </Segment>
          <Segment className="flow-controls" aria-label="页面浏览方式">
            <button className={pageFlow === "single" ? "active" : ""} aria-pressed={pageFlow === "single"} onClick={() => onPageFlow("single")} title="单页浏览"><Icon name="draft" /><span>单页</span></button>
            <button className={pageFlow === "continuous" ? "active" : ""} aria-pressed={pageFlow === "continuous"} onClick={() => onPageFlow("continuous")} title="连续滚动"><Icon name="view_agenda" /><span>连续</span></button>
          </Segment>
          <Segment className="mode-controls">
            {[
              ["select", "arrow_selector_tool", "指针"],
              ["pin", "push_pin", "标记"],
              ["text", "format_quote", "文字"],
              ["region", "highlight_alt", "框选"]
            ].map(([key, icon, label]) => (
              <button
                key={key}
                className={mode === key ? "active" : ""}
                aria-pressed={mode === key}
                onClick={() => onMode(key)}
                title={key === "text" && doc.textLayerStatus === "none" ? "文字选择；扫描页会在首次使用时执行 OCR" : label}
              >
                <Icon name={icon} /><span>{label}</span>
              </button>
            ))}
          </Segment>
          <Segment className="view-controls">
            <button onClick={() => onViewer((value) => ({ ...value, zoom: Math.max(MIN_ZOOM, round2(value.zoom - ZOOM_STEP)) }))} title="缩小" aria-label="缩小"><Icon name="zoom_out" /></button>
            <span>{Math.round(viewer.zoom * 100)}%</span>
            <button onClick={() => onViewer((value) => ({ ...value, zoom: Math.min(MAX_ZOOM, round2(value.zoom + ZOOM_STEP)) }))} title="放大" aria-label="放大"><Icon name="zoom_in" /></button>
            <button onClick={fitViewerToWidth} title="适合宽度" aria-label="适合宽度"><Icon name="fit_screen" /></button>
            <button onClick={() => onViewer((value) => ({ ...value, rotation: (value.rotation - 90 + 360) % 360 }))} title="左旋转" aria-label="左旋转"><Icon name="rotate_left" /></button>
            <button onClick={() => onViewer((value) => ({ ...value, rotation: (value.rotation + 90) % 360 }))} title="右旋转" aria-label="右旋转"><Icon name="rotate_right" /></button>
          </Segment>
          <Segment className="history-controls">
            <button onClick={onUndo} disabled={!canUndo} title="撤销" aria-label="撤销"><Icon name="undo" /></button>
            <button onClick={onRedo} disabled={!canRedo} title="重做" aria-label="重做"><Icon name="redo" /></button>
          </Segment>
          <button className="export-btn" onClick={onOpenExport} aria-label="导出批注" title="导出批注"><Icon name="data_object" /><span>导出</span></button>
        </div>

        <div className={`viewer-wrap ${pageFlow === "continuous" ? "continuous" : "single"}`} ref={viewerWrapRef}>
          {pageFlow === "continuous" ? (
            <div className="continuous-document">
              {Array.from({ length: doc.pageCount }, (_, index) => index + 1).map((page) => (
                <ContinuousPage
                  key={page}
                  doc={doc}
                  page={page}
                  current={page === currentPage}
                  nearViewport={continuousVisiblePages.has(page)}
                  mode={mode}
                  viewer={viewer}
                  viewerStyle={viewerStyle}
                  items={overlayItemsByPage.get(page) || EMPTY_OVERLAY_ITEMS}
                  selectedAnnoId={selectedAnnoId}
                  outlineTarget={outlineTarget?.page === page ? outlineTarget : null}
                  dragRect={dragRect?.page === page ? dragRect : null}
                  onPageClick={stablePageClick}
                  onPointerDown={stablePointerDown}
                  onPointerMove={stablePointerMove}
                  onPointerUp={stablePointerUp}
                  onTextSelection={stableTextSelection}
                  onSelectAnnotation={stableSelectAnnotation}
                />
              ))}
            </div>
          ) : (
            <div className={`page-stage ${orientation}`} style={stageStyle}>
              <PageHeading doc={doc} page={currentPage} />
              <div className="canvas-viewport">
                <div className="canvas-transform" style={viewerStyle}>
                  <div
                    className={`page-canvas ${mode}`}
                    onClick={(event) => onPageClick(event, currentPage)}
                    onMouseDown={(event) => onPointerDown(event, currentPage)}
                    onMouseMove={onPointerMove}
                    onMouseUp={onPointerUp}
                    onMouseLeave={onPointerUp}
                  >
                    <DocumentPreview doc={doc} page={currentPage} textEnabled={mode === "text"} onTextSelection={(selection) => onTextSelection(selection, currentPage)} />
                    {doc.renderMode !== "pdf" && <TextLayer documentId={doc.id} page={currentPage} pageData={currentPageData} enabled={mode === "text"} ocrEnabled={doc.type === "image"} onSelect={(selection) => onTextSelection(selection, currentPage)} />}
                    <Overlays
                      items={withAnnotationDisplayLabels(pageAnnotations).filter((item) => item.type !== "note" && annotationOverlayVisible(reviewThreads[item.id], item))}
                      selectedAnnoId={selectedAnnoId}
                      onSelect={onSelectAnnotation}
                    />
                    {outlineTarget?.page === currentPage && outlineTarget.rect && <div className="outline-focus" style={rectStyle(paddedRect(outlineTarget.rect))} />}
                    {dragRect?.page === currentPage && <div className="drag-rect" style={rectStyle(dragRect)} />}
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* The hint is the only on-screen sign that relocation mode is armed. It used to render in
              the single-page branch only, leaving continuous scroll with a hidden modal state. */}
          <div className={`hint-text ${relocatingAnnotation ? "attention" : ""}`}>
            {relocatingAnnotation
              ? `请在第 ${relocatingAnnotation.page} 页上重新选中这条批注对应的原文`
              : mode === "text" && currentPageData.hasTextLayer === false ? "正在尝试识别扫描页文字；识别失败时仍可使用标记或框选"
              : mode === "pin" ? "点击页面任意位置打一个标记" : mode === "region" ? "按住拖拽，框出要批注的区域" : mode === "text" ? "拖动选中页面文字，系统会把原文和位置一起保存为批注" : "指针模式：点击标记查看，不新增批注"}
          </div>
        </div>
      </main>

      <aside
        className="anno-panel"
        id="annotation-panel"
        aria-hidden={compactPanels && !annotationPanelOpen ? "true" : undefined}
        inert={compactPanels && !annotationPanelOpen ? "" : undefined}
      >
        <div className="panel-tabs">
          <button className={panelTab === "annotate" ? "active" : ""} aria-pressed={panelTab === "annotate"} onClick={() => onPanelTab("annotate")}><Icon name="edit_note" />批注<span>{annotationListScope === "document" ? documentAnnotationCount : currentPageAnnotationCount}</span></button>
          <button className={panelTab === "history" ? "active" : ""} aria-pressed={panelTab === "history"} onClick={() => onPanelTab("history")}><Icon name="history" />历史</button>
          <button
            className="copy-for-ai"
            type="button"
            onClick={onCopyForAi}
            disabled={!documentAnnotationCount}
            title="把整份文档的批注意见复制成一段可以直接粘给 AI 的文字"
          >
            <Icon name={aiCopyState ? "check" : "content_copy"} />{aiCopyState || "复制给 AI"}
          </button>
        </div>
        {panelTab === "annotate" ? (
          <AnnotatePanel
            quoteRecovery={quoteRecovery}
            doc={doc}
            annotationGroups={visibleAnnotationGroups}
            annotationListScope={annotationListScope}
            currentPage={currentPage}
            currentPageAnnotationCount={currentPageAnnotationCount}
            documentAnnotationCount={documentAnnotationCount}
            listedAnnotationCount={listedAnnotationCount}
            noteAnno={noteAnno}
            annotationFilter={annotationFilter}
            reviewThreads={reviewThreads}
            selectedAnnoId={selectedAnnoId}
            onUpdateNote={onUpdateNote}
            onSetNoteTag={onSetNoteTag}
            onUpdateAnnotation={onUpdateAnnotation}
            onAnnotationListScope={(scope) => {
              setAnnotationListScope(scope);
              onSelectAnnotation(null);
            }}
            onAnnotationFilter={onAnnotationFilter}
            onDeleteAnnotation={onDeleteAnnotation}
            onRelocateAnnotation={onRelocateAnnotation}
            onSelectAnnotation={selectListAnnotation}
            onJumpPage={goPage}
            onReplyThread={onReplyThread}
            onThreadStatus={onThreadStatus}
            onClearAnnotations={onClearAnnotations}
          />
        ) : (
          <HistoryPanel history={history} onCreateSnapshot={onCreateSnapshot} onRestoreSnapshot={onRestoreSnapshot} />
        )}
      </aside>
      {compactPanels && (pageSidebarOpen || annotationPanelOpen) && (
        <button
          className="panel-scrim"
          onClick={() => {
            const focusTarget = pageSidebarOpen ? pageToggleRef.current : annotationToggleRef.current;
            setPageSidebarOpen(false);
            setAnnotationPanelOpen(false);
            window.requestAnimationFrame(() => focusTarget?.focus());
          }}
          aria-label="关闭侧栏"
        />
      )}

      {exportOpen && (
        <ExportModal
          payload={exportPayload}
          scope={exportScope}
          format={exportFormat}
          pdfPageMode={pdfPageMode}
          includeResolved={exportIncludeResolved}
          conversationMode={exportConversationMode}
          includeLocalPaths={exportIncludeLocalPaths}
          copied={copied}
          aiResult={aiResult}
          onScope={onExportScope}
          onFormat={onExportFormat}
          onPdfPageMode={onPdfPageMode}
          onIncludeResolved={onExportIncludeResolved}
          onConversationMode={onExportConversationMode}
          onIncludeLocalPaths={onExportIncludeLocalPaths}
          onClose={onCloseExport}
          onCopy={onCopyExport}
          onDownloadExport={onDownloadExport}
          onDownloadHtmlExport={onDownloadHtmlExport}
          onDownloadPdfExport={onDownloadPdfExport}
          onSendAi={onSendAi}
        />
      )}
    </div>
  );
}

const ContinuousPage = memo(function ContinuousPage(props) {
  const {
    doc,
    page,
    current,
    nearViewport,
    mode,
    viewer,
    viewerStyle,
    items,
    selectedAnnoId,
    outlineTarget,
    dragRect,
    onPageClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTextSelection,
    onSelectAnnotation
  } = props;
  const pageData = doc.pages?.[page - 1] || {};
  const { orientation, stageStyle } = pageStageLayout(pageData, viewer.zoom, viewer.rotation);

  return (
    <section
      className={`page-stage continuous-page-stage ${orientation} ${current ? "current" : ""}`}
      style={stageStyle}
      data-continuous-page={page}
      aria-label={`第 ${page} 页`}
    >
      <PageHeading doc={doc} page={page} />
      <div className="canvas-viewport">
        <div className="canvas-transform" style={viewerStyle}>
          <div
            className={`page-canvas ${mode} ${nearViewport ? "" : "deferred"}`}
            onClick={nearViewport ? (event) => onPageClick(event, page) : undefined}
            onMouseDown={nearViewport ? (event) => onPointerDown(event, page) : undefined}
            onMouseMove={nearViewport ? onPointerMove : undefined}
            onMouseUp={nearViewport ? onPointerUp : undefined}
            onMouseLeave={nearViewport ? onPointerUp : undefined}
          >
            {nearViewport ? (
              <>
                <DocumentPreview doc={doc} page={page} textEnabled={mode === "text"} onTextSelection={(selection) => onTextSelection(selection, page)} />
                {doc.renderMode !== "pdf" && <TextLayer documentId={doc.id} page={page} pageData={pageData} enabled={mode === "text"} ocrEnabled={doc.type === "image"} onSelect={(selection) => onTextSelection(selection, page)} />}
              </>
            ) : (
              <div className="deferred-page" aria-hidden="true" />
            )}
            <Overlays items={items} selectedAnnoId={selectedAnnoId} onSelect={(annotationId) => onSelectAnnotation(annotationId, page)} />
            {outlineTarget?.rect && <div className="outline-focus" style={rectStyle(paddedRect(outlineTarget.rect))} />}
            {dragRect && <div className="drag-rect" style={rectStyle(dragRect)} />}
          </div>
        </div>
      </div>
    </section>
  );
});

function Brand() {
  return (
    <div className="brand">
      <div className="brand-icon"><img src="/app-icon.png" alt="" aria-hidden="true" /></div>
      <strong>批注工作台</strong>
    </div>
  );
}

function documentSourceDisplayPath(doc) {
  const sourceLabel = String(doc?.sourceLabel || "");
  return doc?.originalPath
    || doc?.importUrl
    || (/[\\/]/.test(sourceLabel) ? sourceLabel : "")
    || doc?.sourcePath
    || sourceLabel
    || "本地工作区";
}

function remoteSourceHost(value) {
  try {
    return new URL(value).host || "已关联";
  } catch {
    return "已关联";
  }
}

function documentTypeLabel(doc) {
  const extension = String(doc?.ext || "").trim().toUpperCase();
  if (extension) return extension;
  return { pdf: "PDF", office: "Office", image: "图片", markdown: "Markdown", html: "HTML" }[doc?.type] || "文件";
}

// Row menus used to be positioned inside the row that owns them, which put them at the mercy of
// whatever clipped that row: the document list hides its overflow to keep its rounded corners, so
// the last row's menu was cut away entirely and reads as a dead button, and the sidebar scrolls, so
// its menus lost their right-hand edge. Rendering into the body escapes every clipping ancestor;
// the position is then computed against the trigger and flipped up when there is no room below.
function RowMenu({ icon = "more_horiz", title, buttonClassName = "", disabled = false, children }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [placement, setPlacement] = useState(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const anchor = trigger.getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      const margin = 8;
      const below = anchor.bottom + 4;
      const top = below + box.height > window.innerHeight - margin
        ? Math.max(margin, anchor.top - box.height - 4)
        : below;
      const left = Math.min(
        Math.max(margin, anchor.right - box.width),
        Math.max(margin, window.innerWidth - box.width - margin)
      );
      setPlacement({ top, left });
    };
    place();
    // Anything that moves the trigger moves the menu: the sidebar and the document list both scroll.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // The menu is no longer a descendant of the trigger, so "outside" has to mean outside both.
    const onPointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        className={buttonClassName}
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <Icon name={icon} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="row-menu"
          role="menu"
          // Hidden until measured, so it is never painted at the wrong end of the window.
          style={placement ? { top: placement.top, left: placement.left } : { top: 0, left: 0, visibility: "hidden" }}
          onClick={(event) => event.stopPropagation()}
        >
          {children(() => setOpen(false))}
        </div>,
        document.body
      )}
    </>
  );
}

function GroupMenu({ group, canMoveUp, canMoveDown, onNewProject, onRename, onMove, onDelete }) {
  return (
    <div className="group-menu">
      <button
        className="group-menu-trigger"
        type="button"
        title={`在「${group.name}」下新建项目`}
        aria-label={`在「${group.name}」下新建项目`}
        onClick={() => onNewProject()}
      >
        <Icon name="add" />
      </button>
      <RowMenu buttonClassName="group-menu-trigger" title={`${group.name} 的更多操作`}>
        {(close) => (
          <>
            <button type="button" role="menuitem" onClick={() => { close(); onRename(); }}>重命名分组</button>
            <button type="button" role="menuitem" disabled={!canMoveUp} onClick={() => { close(); onMove(-1); }}>上移</button>
            <button type="button" role="menuitem" disabled={!canMoveDown} onClick={() => { close(); onMove(1); }}>下移</button>
            <button type="button" role="menuitem" className="row-menu-danger" onClick={() => { close(); onDelete(); }}>删除分组</button>
          </>
        )}
      </RowMenu>
    </div>
  );
}

function ProjectRowMenu({ project, groups, onNewChild, onMoveToGroup }) {
  const elsewhere = groups.filter((group) => group.id !== project.groupId);
  return (
    <div className="project-row-menu">
      <button
        className="project-add-child"
        type="button"
        title={`在「${project.name}」下新建子项目`}
        aria-label={`在「${project.name}」下新建子项目`}
        onClick={(event) => { event.stopPropagation(); onNewChild(); }}
      >
        <Icon name="add" />
      </button>
      <RowMenu buttonClassName="project-add-child" title={`${project.name} 的更多操作`}>
        {(close) => (
          <>
            <div className="row-menu-label">移到分组</div>
            {elsewhere.map((group) => (
              <button key={group.id} type="button" role="menuitem" onClick={() => { close(); onMoveToGroup(group.id); }}>
                {group.name}
              </button>
            ))}
            {project.groupId && (
              <button type="button" role="menuitem" onClick={() => { close(); onMoveToGroup(""); }}>移出分组</button>
            )}
            {!elsewhere.length && !project.groupId && <div className="row-menu-empty">还没有分组</div>}
          </>
        )}
      </RowMenu>
    </div>
  );
}

const DUPLICATE_REASONS = {
  identical: "内容完全相同",
  same_source: "来自同一个文件",
  related: "同一份文档的不同副本"
};

function DuplicateReviewModal({ state, onResolve, onClose }) {
  const [keepIds, setKeepIds] = useState({});
  const groups = state.groups || [];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="duplicate-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-icon"><Icon name="content_copy" /></div>
          <div>
            <strong>重复文档</strong>
            <small>同一个文件被导入了多次时，这里能把多余的清掉</small>
          </div>
          <button className="plain-icon" type="button" onClick={onClose} title="关闭" aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className="duplicate-body">
          {state.loading && <p className="duplicate-empty">正在检查…</p>}
          {!state.loading && !groups.length && (
            <p className="duplicate-empty">
              没有发现重复文档。判断依据是来源文件路径和内容哈希——同名但来自不同文件的不算重复。
            </p>
          )}
          {groups.map((group, index) => {
            const keepId = keepIds[groupKey(group)] || group.documents[0].id;
            const losing = group.documents
              .filter((item) => item.id !== keepId)
              .reduce((total, item) => total + item.annotationCount, 0);
            return (
              <section className="duplicate-group" key={groupKey(group)}>
                <header>
                  <strong>{group.documents[0].name}</strong>
                  <span className="duplicate-reason">
                    {DUPLICATE_REASONS[group.reason] || "疑似重复"}
                    {group.sameProject ? "" : " · 跨项目"}
                    {` · ${group.documents.length} 份`}
                  </span>
                </header>
                {group.sourcePath && <p className="duplicate-path" title={group.sourcePath}>{group.sourcePath}</p>}
                <ul className="duplicate-copies">
                  {group.documents.map((item) => (
                    <li key={item.id}>
                      <label>
                        <input
                          type="radio"
                          name={`keep-${index}`}
                          checked={item.id === keepId}
                          onChange={() => setKeepIds((prev) => ({ ...prev, [groupKey(group)]: item.id }))}
                        />
                        <span className="duplicate-copy-main">
                          <strong>{item.annotationCount ? `${item.annotationCount} 处批注` : "未批注"}</strong>
                          <small>{item.pageCount} 页 · {item.projectName || "未知项目"} · 更新于 {formatDateTime(item.updated)}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="duplicate-actions">
                  <span className={losing ? "duplicate-warning" : ""}>
                    {losing ? `删除其余会丢失 ${losing} 处批注` : "被删除的副本没有批注"}
                  </span>
                  <button
                    className={losing ? "danger-action" : "copy-action"}
                    type="button"
                    onClick={() => onResolve(group, keepId)}
                  >
                    <Icon name="delete" />
                    保留选中，删除其余 {group.documents.length - 1} 份
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Groups have no id of their own; what identifies one is the set of documents in it.
function groupKey(group) {
  return group.documents.map((item) => item.id).join("|");
}

function DocumentRow({ doc, annotations, projectName, moveTargets, onOpen, onDelete, onRetryAnalysis, onReveal, onMove, onArchive }) {
  const annotationCount = countDocAnnotations(doc, annotations);
  const annotatedPages = Array.from({ length: doc.pageCount }, (_, index) => index + 1).filter((page) => (annotations[`${doc.id}:${page}`] || []).length > 0).length;
  const sourcePath = documentSourceDisplayPath(doc);
  return (
    <div className="document-row-wrap">
      <button className="document-row" onClick={onOpen} title={`打开 ${doc.name}`}>
        <span className="document-name-cell">
          <TypeIcon type={doc.type} />
          <span>
            <strong>{doc.name}</strong>
            {projectName && <small>{projectName}</small>}
          </span>
        </span>
        <span className="document-path" title={sourcePath}>{sourcePath}</span>
        <span className="document-type">{documentTypeLabel(doc)}</span>
        <span className="document-pages">{doc.pageCount}</span>
        <span className={`document-annotation ${annotationCount ? "active" : ""}`}>
          <strong>{annotationCount ? `${annotationCount} 处` : "未批注"}</strong>
          <small>{annotationCount ? `${annotatedPages} 页已批注` : ""}{doc.hasNewerSource ? `${annotationCount ? " · " : ""}有新版本` : ""}</small>
        </span>
        <Icon name="chevron_right" />
      </button>
      {doc.analysisStatus === "pending" && <span className="document-analysis" title="正在建立目录和页标题">索引中</span>}
      {doc.analysisStatus === "error" && (
        <button
          className="document-analysis document-analysis-error"
          type="button"
          title={doc.analysisError || "文档索引失败"}
          onClick={(event) => { event.stopPropagation(); onRetryAnalysis(); }}
        >
          索引失败 · 重试
        </button>
      )}
      <div className="document-row-actions">
        <button
          className="document-row-action"
          type="button"
          title={`在访达中显示 ${doc.name}`}
          aria-label={`在访达中显示 ${doc.name}`}
          onClick={(event) => { event.stopPropagation(); onReveal(); }}
        >
          <Icon name="folder_open" />
        </button>
        <RowMenu
          icon="drive_file_move"
          buttonClassName="document-row-action"
          title={`把 ${doc.name} 移动到其他项目`}
          disabled={!moveTargets.length}
        >
          {(close) => (
            <>
              <div className="row-menu-label">移动到</div>
              {moveTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  role="menuitem"
                  className={target.parentId ? "row-menu-child" : ""}
                  onClick={() => { close(); onMove(target.id); }}
                >
                  <span className="project-dot" style={{ background: target.color }} />
                  {target.name}
                </button>
              ))}
            </>
          )}
        </RowMenu>
        <button
          className="document-row-action"
          type="button"
          title={doc.archivedAt ? `把 ${doc.name} 移回在用文档` : `归档 ${doc.name}（保留文件和批注，只从列表收起）`}
          aria-label={doc.archivedAt ? `取消归档 ${doc.name}` : `归档 ${doc.name}`}
          onClick={(event) => { event.stopPropagation(); onArchive(!doc.archivedAt); }}
        >
          <Icon name={doc.archivedAt ? "unarchive" : "archive"} />
        </button>
        <button
          className="document-row-action document-row-delete"
          type="button"
          title={`删除 ${doc.name}`}
          aria-label={`删除 ${doc.name}`}
          onClick={onDelete}
        >
          <Icon name="delete" />
        </button>
      </div>
    </div>
  );
}

function OutlineList({ items, currentPage, onJump }) {
  const [collapsedKeys, setCollapsedKeys] = useState(() => new Set());
  const tree = useMemo(() => buildOutlineTree(items), [items]);
  if (!items.length) {
    return (
      <div className="outline-empty">
        <Icon name="account_tree" />
        <span>暂未识别到章节或图表标题。刷新 PDF 后会重新分析结构。</span>
      </div>
    );
  }
  const toggleBranch = (treeKey) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (next.has(treeKey)) next.delete(treeKey);
      else next.add(treeKey);
      return next;
    });
  };
  return (
    <div className="outline-list" role="tree" aria-label="文档结构">
      {tree.map((item) => (
        <OutlineBranch
          key={item.treeKey}
          item={item}
          currentPage={currentPage}
          collapsedKeys={collapsedKeys}
          onToggle={toggleBranch}
          onJump={onJump}
        />
      ))}
    </div>
  );
}

function OutlineBranch({ item, currentPage, collapsedKeys, onToggle, onJump }) {
  const hasChildren = item.children.length > 0;
  const collapsed = hasChildren && collapsedKeys.has(item.treeKey);
  const type = item.type || "section";
  return (
    <div className="outline-branch" role="treeitem" aria-expanded={hasChildren ? !collapsed : undefined}>
      <div className={`outline-row ${item.page === currentPage ? "active" : ""}`}>
        {hasChildren ? (
          <button
            className="outline-toggle"
            type="button"
            onClick={() => onToggle(item.treeKey)}
            title={collapsed ? "展开下级结构" : "收起下级结构"}
            aria-label={`${collapsed ? "展开" : "收起"}${item.displayTitle || item.title}`}
          >
            <Icon name={collapsed ? "chevron_right" : "expand_more"} />
          </button>
        ) : <span className="outline-leaf" aria-hidden="true" />}
        <button className="outline-target" type="button" onClick={() => onJump(item)} title={`${item.displayTitle || item.title} · 第 ${item.page} 页`}>
          {type !== "section" && <span className={`outline-type ${type}`}><Icon name={outlineIcon(type)} /></span>}
          <strong>{item.displayTitle || item.title}</strong>
          <small>第 {item.page} 页</small>
        </button>
      </div>
      {hasChildren && !collapsed && (
        <div className="outline-children" role="group">
          {item.children.map((child) => (
            <OutlineBranch
              key={child.treeKey}
              item={child}
              currentPage={currentPage}
              collapsedKeys={collapsedKeys}
              onToggle={onToggle}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentPreview({ doc, page, textEnabled, onTextSelection }) {
  const pageData = doc.pages?.[page - 1];
  if (doc.renderMode === "pdf" || doc.type === "pdf" || doc.type === "office") {
    return (
      <Suspense fallback={<div className="pdf-page-surface"><div className="pdf-loading">正在载入 PDF 引擎</div></div>}>
        <PdfPage
          documentId={doc.id}
          version={doc.contentHash || doc.refreshedAt || doc.updated}
          page={page}
          textEnabled={textEnabled}
          onTextSelection={onTextSelection}
        />
      </Suspense>
    );
  }
  if (pageData?.imageUrl) {
    return <img className="native-preview rendered-page" src={pageData.imageUrl} alt={`${doc.name} 第 ${page} 页`} draggable="false" />;
  }
  if (doc.type === "image" && pageData?.sourceUrl) {
    return <img className="native-preview" src={pageData.sourceUrl} alt={doc.name} draggable="false" />;
  }
  if ((doc.type === "markdown" || doc.type === "html" || doc.type === "data" || doc.renderMode === "text") && pageData?.text) {
    return (
      <div
        className={`text-preview ${textEnabled ? "text-selection-enabled" : ""}`}
        onPointerUp={textEnabled ? (event) => {
          const layer = event.currentTarget;
          window.requestAnimationFrame(() => onTextSelection(layer));
        } : undefined}
      >
        <h2>{pageTitle(doc, page)}</h2>
        <pre>{pageData.text}</pre>
      </div>
    );
  }
  return <MockDocumentPage doc={doc} page={page} />;
}

function TextLayer({ documentId, page, pageData, enabled, ocrEnabled, onSelect }) {
  const [ocrWords, setOcrWords] = useState([]);
  const [ocrState, setOcrState] = useState("idle");
  const nativeWords = pageData?.words || [];
  const words = nativeWords.length ? nativeWords : ocrWords;
  useEffect(() => {
    setOcrWords([]);
    setOcrState("idle");
  }, [documentId, page]);
  useEffect(() => {
    if (!enabled || !ocrEnabled || nativeWords.length || ocrState !== "idle") return undefined;
    const controller = new AbortController();
    setOcrState("loading");
    fetch(`/api/documents/${encodeURIComponent(documentId)}/pages/${page}/ocr`, { method: "POST", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || payload.error || "OCR failed");
        return payload.layer?.words || [];
      })
      .then((nextWords) => {
        setOcrWords(nextWords);
        setOcrState(nextWords.length ? "ready" : "empty");
      })
      .catch((error) => {
        if (error.name !== "AbortError") setOcrState("error");
      });
    return () => controller.abort();
  }, [documentId, enabled, nativeWords.length, ocrEnabled, page]);
  if (!words.length) {
    if (ocrState === "loading") return <div className="ocr-loading" aria-live="polite">正在识别图片文字</div>;
    if (ocrState === "error") return <div className="ocr-loading error" role="status">图片文字识别失败，可改用标记或框选</div>;
    return null;
  }
  return (
    <div
      className={`text-layer ${enabled ? "enabled" : ""}`}
      onPointerUp={(event) => {
        const layer = event.currentTarget;
        window.requestAnimationFrame(() => onSelect(layer));
      }}
    >
      {words.map((word, index) => (
        <span
          key={`${index}-${word.x}-${word.y}`}
          data-word-index={index}
          data-text={word.text}
          data-x={word.x}
          data-y={word.y}
          data-w={word.w}
          data-h={word.h}
          style={rectStyle(word)}
        >
          {word.text}
        </span>
      ))}
    </div>
  );
}

function MockDocumentPage({ doc, page }) {
  const widths = [["82%", "66%", "72%"], ["88%", "58%", "77%"], ["74%", "82%", "54%", "68%"]][page % 3];
  return (
    <div className="mock-page">
      <div className="render-chip"><Icon name={doc.renderMode === "text" ? "article" : "image"} />{doc.renderMode === "text" ? "文本层" : "像素渲染"}</div>
      <h2>{pageTitle(doc, page)}</h2>
      <div className="mock-body">
        <div className="mock-lines">
          {widths.map((width, index) => <span key={index} style={{ width }} />)}
          <div className="mini-chart">
            <i style={{ height: "48%" }} />
            <i style={{ height: "74%" }} />
            <i style={{ height: "58%" }} />
            <i style={{ height: "86%" }} />
          </div>
        </div>
        <div className="mock-visual">配图 / 图表区</div>
      </div>
      <footer>{doc.ext} · 第 {page} 页 · 渲染预览</footer>
    </div>
  );
}

function Overlays({ items, selectedAnnoId, onSelect }) {
  return (
    <>
      {items.map((item) => {
        if (item.type === "pin") {
          const color = TAGS[item.tag]?.dot || ACCENT;
          const label = item.displayLabel || "•";
          return (
            <button
              key={item.id}
              data-overlay-item="pin"
              className={`pin-overlay ${item.id === selectedAnnoId ? "selected" : ""}`}
              style={{ left: `${item.x}%`, top: `${item.y}%`, "--pin": color }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item.id);
              }}
              aria-label={`标记 ${label}`}
            >
              {label}
            </button>
          );
        }
        if (item.type === "region") {
          const label = item.displayLabel || "•";
          return (
            <button
              key={item.id}
              data-overlay-item="region"
              className={`region-overlay ${item.id === selectedAnnoId ? "selected" : ""}`}
              style={rectStyle(item)}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item.id);
              }}
              aria-label={`框选 ${label}`}
            >
              <span>{label}</span>
            </button>
          );
        }
        if (item.type === "text") {
          const label = item.displayLabel || "•";
          const rects = item.rects?.length ? item.rects : [item];
          const firstRect = rects[0];
          return (
            <React.Fragment key={item.id}>
              {rects.map((rect, rectIndex) => (
                <button
                  key={`${item.id}-${rectIndex}`}
                  data-overlay-item="text"
                  className={`text-highlight ${item.id === selectedAnnoId ? "selected" : ""}`}
                  style={rectStyle(rect)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(item.id);
                  }}
                  title={item.quote || item.text || "文字批注"}
                  aria-label="文字批注"
                />
              ))}
              <button
                data-overlay-item="text"
                className={`text-quote-marker ${item.id === selectedAnnoId ? "selected" : ""}`}
                style={{ left: `${firstRect.x}%`, top: `${Number(firstRect.y) + Number(firstRect.h) / 2}%` }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(item.id);
                }}
              >
                {label}
              </button>
            </React.Fragment>
          );
        }
        return null;
      })}
    </>
  );
}

function AnnotatePanel(props) {
  const {
    doc,
    quoteRecovery,
    annotationGroups,
    annotationListScope,
    currentPage,
    currentPageAnnotationCount,
    documentAnnotationCount,
    listedAnnotationCount,
    noteAnno,
    annotationFilter,
    reviewThreads,
    selectedAnnoId,
    onUpdateNote,
    onSetNoteTag,
    onUpdateAnnotation,
    onAnnotationListScope,
    onAnnotationFilter,
    onDeleteAnnotation,
    onRelocateAnnotation,
    onSelectAnnotation,
    onJumpPage,
    onReplyThread,
    onThreadStatus,
    onClearAnnotations
  } = props;
  const clearMenuRef = useRef(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const noteState = annotationReviewState(noteAnno ? reviewThreads[noteAnno.id] : null, noteAnno);
  const documentScope = annotationListScope === "document";
  const currentPageListCount = Math.max(0, currentPageAnnotationCount - (noteAnno?.text?.trim() ? 1 : 0));
  const listTotalCount = documentScope ? documentAnnotationCount : currentPageListCount;

  const setNoteReviewState = (state) => {
    if (state === noteState) return;
    if (noteAnno?.id) {
      onThreadStatus(noteAnno.id, annotationThreadStatus(state), annotationStateTag(state), currentPage);
    } else {
      onSetNoteTag(annotationStateTag(state));
    }
  };

  useEffect(() => {
    if (!clearMenuOpen) return undefined;
    const closeFromOutside = (event) => {
      if (!clearMenuRef.current?.contains(event.target)) setClearMenuOpen(false);
    };
    const closeFromKeyboard = (event) => {
      if (event.key === "Escape") setClearMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [clearMenuOpen]);

  const runClearAction = (scope) => {
    setClearMenuOpen(false);
    onClearAnnotations(scope);
  };

  return (
    <div className="panel-scroll">
      <div className="annotation-scope-toolbar">
        <div className="annotation-scope-switch" role="group" aria-label="批注列表范围">
          <button type="button" className={documentScope ? "" : "active"} aria-pressed={!documentScope} onClick={() => onAnnotationListScope("page")}>
            <span>本页</span><em>{currentPageAnnotationCount}</em>
          </button>
          <button type="button" className={documentScope ? "active" : ""} aria-pressed={documentScope} onClick={() => onAnnotationListScope("document")}>
            <span>全文</span><em>{documentAnnotationCount}</em>
          </button>
        </div>
        <details ref={clearMenuRef} className="clear-menu" open={clearMenuOpen} onToggle={(event) => setClearMenuOpen(event.currentTarget.open)}>
          <summary title="清空标注" aria-label="清空标注"><Icon name="delete" /></summary>
          <div>
            <button onClick={() => runClearAction("page")}>清空本页标注</button>
            <button onClick={() => runClearAction("document")}>清空全部标注</button>
          </div>
        </details>
      </div>
      {!documentScope && (
        <>
          <div className="panel-row-head">
            <span><Icon name="sticky_note_2" />第 {currentPage} 页备注</span>
            {noteAnno?.text?.trim() && <AnnotationStateControl value={noteState} onPick={setNoteReviewState} compact />}
          </div>
          <textarea className="note-textarea" value={noteAnno?.text || ""} onChange={(event) => onUpdateNote(event.target.value)} placeholder="这一页整体要改什么？" />
          {noteAnno?.text?.trim() && (
            <ReviewConversation
              item={noteAnno}
              thread={reviewThreads[noteAnno.id]}
              onReply={onReplyThread}
            />
          )}
          <div className="panel-divider" />
        </>
      )}
      <div className="panel-row-head">
        <span>{documentScope ? "全文批注" : "本页标注"}</span>
        <small>{listedAnnotationCount === listTotalCount ? `${listTotalCount} 处` : `${listedAnnotationCount} / ${listTotalCount} 处`}</small>
      </div>
      <div className="filter-chips" aria-label="批注状态筛选">
        <button type="button" className={annotationFilter === "all" ? "active" : ""} aria-pressed={annotationFilter === "all"} onClick={() => onAnnotationFilter("all")}>全部</button>
        <button type="button" className={annotationFilter === "open" ? "active open" : "open"} aria-pressed={annotationFilter === "open"} onClick={() => onAnnotationFilter("open")}>待解决</button>
        <button type="button" className={annotationFilter === "closed" ? "active closed" : "closed"} aria-pressed={annotationFilter === "closed"} onClick={() => onAnnotationFilter("closed")}>已解决</button>
      </div>
      {listTotalCount === 0 ? (
        <div className="empty-state">
          <Icon name="add_location_alt" />
          <span>{documentScope ? "这份文档还没有批注。" : "在页面上点击打标记，或切到「框选」拖出一块区域。"}</span>
        </div>
      ) : listedAnnotationCount === 0 ? (
        <div className="empty-state">
          <Icon name="filter_alt_off" />
          <span>当前筛选下没有批注。</span>
        </div>
      ) : (
        <div className={`anno-page-groups ${documentScope ? "document" : "page"}`}>
          {annotationGroups.map((group) => (
            <section className="anno-page-group" key={group.page} aria-label={`第 ${group.page} 页批注`}>
              {documentScope && (
                <button className={`anno-page-heading ${group.page === currentPage ? "current" : ""}`} type="button" onClick={() => onJumpPage(group.page)} title={`跳转到第 ${group.page} 页`}>
                  <span>第 {group.page} 页</span>
                  <strong>{isPageNumberTitle(pageTitle(doc, group.page)) ? "" : pageTitle(doc, group.page)}</strong>
                  <em>{group.entries.length}</em>
                  <Icon name="chevron_right" />
                </button>
              )}
              <div className="anno-list">
                {group.entries.map(({ item, page, index, label }) => (
                  <AnnotationRow
                    key={item.id}
                    item={item}
                    index={index}
                    displayLabel={label}
                    selected={selectedAnnoId === item.id}
                    thread={reviewThreads[item.id]}
                    onFocus={() => onSelectAnnotation(page, item.id)}
                    recoveryState={quoteRecovery?.[item.id] || ""}
                    onInput={(text) => onUpdateAnnotation(item.id, { text }, page)}
                    onDelete={() => onDeleteAnnotation(item.id, page)}
                    onRelocate={() => onRelocateAnnotation(item.id, page)}
                    onReply={onReplyThread}
                    onStatus={(annotationId, status, tag) => onThreadStatus(annotationId, status, tag, page)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AnnotationRow({ item, index, displayLabel, selected, thread, recoveryState, onFocus, onInput, onDelete, onRelocate, onReply, onStatus }) {
  const isPin = item.type === "pin";
  const isText = item.type === "text";
  const isNote = item.type === "note";
  const status = reviewThreadStatus(thread, item);
  const reviewState = annotationReviewState(thread, item);
  const stateMeta = ANNOTATION_STATES[reviewState] || ANNOTATION_STATES.pending;
  const workflowHint = reviewState === "pending" ? ({ in_progress: "AI 处理中", needs_human: "待回复", addressed: "AI 已修改" }[status] || "") : "";
  const done = reviewState === "resolved";
  const textareaRef = useRef(null);
  const previousStatusRef = useRef(reviewState);
  const previousSelectedRef = useRef(selected);
  const [expanded, setExpanded] = useState(false);
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const [collapsed, setCollapsed] = useState(done || !selected);
  const displayQuote = normalizeSelectedText(item.quote);
  const coord = isNote ? "整页问题" : isPin ? `x ${item.x} · y ${item.y}` : isText ? `文字选区 · ${textLength(displayQuote)} 字 · ${item.rects?.length || 1} 行` : `${item.w}x${item.h} @ ${item.x},${item.y}`;
  const compactText = String(item.text || displayQuote || coord || "未填写批注意见").trim();
  const messages = thread?.messages || [];
  const latestMessage = messages.at(-1);
  const tagMeta = TAGS[annotationStateTag(reviewState)] || TAGS.todo;
  const quoteCanExpand = isText && displayQuote && (textLength(displayQuote) > 120 || (item.rects?.length || 1) > 3);
  // Text read off the rendered page is a guess in a way that a copied selection is not, so the card
  // says where it came from instead of presenting it as what the file says.
  const quoteNotice = !isText ? null
    : recoveryState === "reading" ? { tone: "pending", text: "这段文字在 PDF 里无法解码，正在从页面上识别…" }
    : recoveryState === "failed" ? { tone: "warning", text: "这段文字在 PDF 里无法解码，识别也没有成功。原文请以页面上看到的为准。" }
    : item.quoteSource === "ocr" ? { tone: "info", text: `PDF 的文字层无法解码，这段是从页面上识别的${item.quoteConfidence ? `（把握 ${item.quoteConfidence}%）` : ""}，请核对。` }
    : null;
  const needsRelocation = isText && item.anchorStatus === "unmatched";

  const focusAndOpen = () => {
    onFocus();
    setCollapsed(false);
  };

  const setUnifiedState = (state) => {
    if (state === reviewState) return;
    onStatus(item.id, annotationThreadStatus(state), annotationStateTag(state));
  };

  useEffect(() => {
    const wasDone = previousStatusRef.current === "resolved";
    if (done && !wasDone) setCollapsed(true);
    if (!done && wasDone && selected) setCollapsed(false);
    previousStatusRef.current = reviewState;
  }, [done, reviewState, selected]);

  useEffect(() => {
    if (selected && !previousSelectedRef.current) setCollapsed(false);
    if (!selected && previousSelectedRef.current) {
      setCollapsed(true);
      setExpanded(false);
      setQuoteExpanded(false);
    }
    previousSelectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 19;
    const verticalPadding = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
    const collapsedHeight = lineHeight * 3 + verticalPadding;
    const fullHeight = textarea.scrollHeight;
    const overflowing = fullHeight > collapsedHeight + 1;
    const panelHeight = textarea.closest(".panel-scroll")?.clientHeight || window.innerHeight;
    const expandedLimit = Math.max(260, Math.min(720, Math.floor(panelHeight * 0.7)));
    const nextHeight = expanded ? Math.min(fullHeight, expandedLimit) : Math.min(fullHeight, collapsedHeight);
    textarea.style.height = `${Math.ceil(nextHeight)}px`;
    textarea.style.overflowY = expanded && fullHeight > expandedLimit + 1 ? "auto" : "hidden";
    if (!expanded) textarea.scrollTop = 0;
    setCanExpand(overflowing);
  }, [item.text, expanded, collapsed]);

  return (
    <div className={`anno-row ${selected ? "selected" : ""} ${collapsed ? "collapsed" : "expanded"}`} onClickCapture={() => { if (!selected) onFocus(); }}>
      <div className="anno-card-head">
        <span className="anno-index" style={{ background: tagMeta.dot || ACCENT }}><Icon name={isNote ? "sticky_note_2" : isPin ? "push_pin" : isText ? "format_quote" : "crop_free"} />{isNote ? "页" : displayLabel || index + 1}</span>
        <div className="anno-card-badges">
          {needsRelocation && <span className="annotation-anchor-warning"><Icon name="link_off" />定位待核对</span>}
          {collapsed && <span className={`annotation-state-badge ${reviewState}`}>{stateMeta.label}{workflowHint ? ` · ${workflowHint}` : ""}</span>}
          {!collapsed && workflowHint && <span className="annotation-workflow-hint">{workflowHint}</span>}
          {messages.length > 0 && <span className="anno-reply-count"><Icon name="forum" />{messages.length}</span>}
        </div>
        <button className="anno-collapse-toggle" type="button" aria-expanded={!collapsed} onClick={(event) => { event.stopPropagation(); if (collapsed) focusAndOpen(); else setCollapsed(true); }} title={collapsed ? "展开批注" : "折叠批注"} aria-label={collapsed ? "展开批注" : "折叠批注"}><Icon name={collapsed ? "expand_more" : "expand_less"} /></button>
        {!collapsed && <button className="icon-delete" onClick={(event) => { event.stopPropagation(); onDelete(); }} title="归档到历史" aria-label="归档批注到历史"><Icon name="archive" /></button>}
      </div>
      {collapsed ? (
        <button className="anno-summary" type="button" onClick={(event) => { event.stopPropagation(); focusAndOpen(); }}>
          {isText && displayQuote && <span className="anno-summary-quote">{displayQuote}</span>}
          <span className={`anno-summary-comment ${item.text?.trim() ? "" : "empty"}`}>{item.text?.trim() || compactText}</span>
          {latestMessage && <span className="anno-summary-reply"><strong>{latestMessage.role === "assistant" ? "AI" : "回复"}</strong>{latestMessage.body}</span>}
        </button>
      ) : (
        <div className="anno-detail">
          {needsRelocation && (
            <button className="annotation-relocate-action" type="button" onClick={(event) => { event.stopPropagation(); onRelocate(); }}>
              <Icon name="text_select_start" />重新选择原文
            </button>
          )}
          {isText && displayQuote && (
            <>
              <blockquote className={`quote-preview ${quoteExpanded ? "expanded" : ""}`}>{displayQuote}</blockquote>
              {quoteNotice && <p className={`quote-note ${quoteNotice.tone}`}>{quoteNotice.text}</p>}
              {quoteCanExpand && (
                <button className="anno-quote-toggle" type="button" aria-expanded={quoteExpanded} onClick={(event) => { event.stopPropagation(); setQuoteExpanded((value) => !value); }}>
                  {quoteExpanded ? "收起原文" : "查看完整原文"}
                </button>
              )}
            </>
          )}
          <textarea ref={textareaRef} rows="1" data-anno-input={item.id} value={item.text || ""} onChange={(event) => onInput(event.target.value)} placeholder="这个位置要改什么..." aria-label={isNote ? "整页批注意见" : `批注 ${index + 1} 的修改意见`} />
          {canExpand && (
            <button className="anno-expand" type="button" aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}>
              <Icon name={expanded ? "expand_less" : "expand_more"} />{expanded ? "收起意见" : "显示完整意见"}
            </button>
          )}
          <div className="anno-detail-foot">
            <small>{coord}</small>
            <AnnotationStateControl value={reviewState} onPick={setUnifiedState} />
          </div>
          <ReviewConversation item={item} thread={thread} onReply={onReply} />
        </div>
      )}
    </div>
  );
}

function ReviewConversation({ item, thread, onReply }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messages = thread?.messages || [];
  const visibleMessages = conversationExpanded ? messages : messages.slice(-1);

  const sendReply = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const sent = await onReply(item.id, draft);
    setSending(false);
    if (sent) {
      setDraft("");
      setReplyOpen(false);
    }
  };

  const actions = (
    <div className="review-actions">
      <button onClick={() => { setReplyOpen((value) => !value); if (!replyOpen && messages.length) setConversationExpanded(true); }}><Icon name="edit_note" />{messages.length ? "继续反馈" : "补充说明"}</button>
    </div>
  );

  return (
    <div className={`review-thread ${messages.length ? "has-messages" : "no-messages"}`} onClick={(event) => event.stopPropagation()}>
      {messages.length > 0 && (
        <div className={`review-messages ${conversationExpanded ? "expanded" : "summary"}`}>
          {visibleMessages.map((message) => <ReviewMessage key={message.id} message={message} />)}
        </div>
      )}
      {messages.length > 0 && (
        <button className="review-conversation-toggle" type="button" aria-expanded={conversationExpanded} onClick={() => setConversationExpanded((value) => !value)}>
          <Icon name={conversationExpanded ? "expand_less" : "expand_more"} />
          {conversationExpanded ? "收起对话" : messages.length > 1 ? `展开全部 ${messages.length} 条回复` : "展开完整回复"}
        </button>
      )}
      {actions}
      {replyOpen && (
        <div className="review-reply-box">
          <textarea rows="3" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="继续说明不满意的地方，AI 下一轮会读取这条回复…" />
          <div>
            <button onClick={() => { setReplyOpen(false); setDraft(""); }}>取消</button>
            <button className="send-reply" disabled={!draft.trim() || sending} onClick={sendReply}>{sending ? "发送中" : "发送给 AI"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewMessage({ message }) {
  const summary = String(message.change?.summary || "").trim();
  const normalizedBody = normalizeSelectedText(message.body).toLocaleLowerCase();
  const normalizedSummary = normalizeSelectedText(summary).toLocaleLowerCase();
  const showSummary = Boolean(summary && !normalizedBody.includes(normalizedSummary));
  const metadata = [message.change?.file, message.change?.section, message.change?.commit].filter(Boolean);
  return (
    <div className={`review-message ${message.role}`}>
      <div><strong>{message.author || (message.role === "assistant" ? "AI" : "用户")}</strong><time>{formatRelative(message.createdAt)}</time></div>
      <p>{message.body}</p>
      {(showSummary || metadata.length > 0) && (
        <div className="review-message-meta">
          {showSummary && <span><Icon name="fact_check" />{summary}</span>}
          {metadata.length > 0 && <small>{metadata.join(" · ")}</small>}
        </div>
      )}
    </div>
  );
}

function HistoryPanel({ history, onCreateSnapshot, onRestoreSnapshot }) {
  return (
    <div className="panel-scroll">
      <div className="history-head">
        <strong>修改与归档</strong>
        <button onClick={onCreateSnapshot}><Icon name="bookmark_add" />创建快照</button>
      </div>
      {history.length === 0 ? (
        <div className="empty-state">
          <Icon name="history_toggle_off" />
          <span>这一页还没有修改或归档记录。</span>
        </div>
      ) : (
        <div className="timeline">
          {history.map((item) => (
            <div key={item.id} className="timeline-item">
              <span className={`timeline-icon ${item.action}`}><Icon name={historyIcon(item.action)} /></span>
              <div className="timeline-content">
                <strong>{item.label}</strong>
                <small>{formatRelative(item.ts)} {item.rev && <em>{item.rev}</em>}</small>
                {item.action === "snapshot" && item.snapshot && (
                  <button className="restore-snapshot" onClick={() => onRestoreSnapshot(item)}><Icon name="restore" />恢复</button>
                )}
                {item.action === "archive" && item.archivedAnnotation && <ArchivedHistoryItem item={item} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedHistoryItem({ item }) {
  const [expanded, setExpanded] = useState(false);
  const annotation = item.archivedAnnotation || {};
  const thread = item.archivedThread;
  const quote = normalizeSelectedText(annotation.quote);
  const comment = String(annotation.text || "").trim();
  const messages = thread?.messages || [];
  const state = annotationReviewState(thread, annotation);
  const stateMeta = ANNOTATION_STATES[state] || ANNOTATION_STATES.pending;
  const typeLabel = { note: "整页备注", pin: "标记", region: "框选", text: "文字批注" }[annotation.type] || "批注";
  const summary = comment || quote || "未填写批注意见";

  return (
    <div className={`archived-history ${expanded ? "expanded" : ""}`}>
      <button className="archived-history-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span>{summary}</span>
        <small>{typeLabel}{item.displayLabel ? ` ${item.displayLabel}` : ""} · {stateMeta.label}{messages.length ? ` · ${messages.length} 条回复` : ""}</small>
        <Icon name={expanded ? "expand_less" : "expand_more"} />
      </button>
      {expanded && (
        <div className="archived-history-detail">
          {quote && <blockquote>{quote}</blockquote>}
          {comment && <p>{comment}</p>}
          {messages.length > 0 && (
            <div className="archived-history-messages">
              {messages.map((message) => <ReviewMessage key={message.id} message={message} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExportModal({ payload, scope, format, pdfPageMode, includeResolved, conversationMode, includeLocalPaths, copied, aiResult, onScope, onFormat, onPdfPageMode, onIncludeResolved, onConversationMode, onIncludeLocalPaths, onClose, onCopy, onDownloadExport, onDownloadHtmlExport, onDownloadPdfExport, onSendAi }) {
  const text = format === "pdf" ? pdfExportDescription(payload, scope, pdfPageMode) : formatExport(payload || {}, format);
  const annotationCount = payload?.pages?.reduce((sum, page) => sum + page.annotations.length, 0) || 0;
  const exportedPageCount = format === "pdf" && scope === "doc" && pdfPageMode === "all"
    ? Number(payload?.document?.pageCount || 0)
    : scope === "page" ? 1 : payload?.pages?.length || 0;
  const downloadName = payload ? exportFileName(payload, format, exportExtension(format)) : "annotations.txt";
  const [downloadUrl, setDownloadUrl] = useState("");
  const dialogRef = useRef(null);
  useDialogKeyboard(dialogRef, onClose);

  useEffect(() => {
    const body = format === "csv" ? `\uFEFF${text}` : text;
    const url = URL.createObjectURL(new Blob([body], { type: `${exportMime(format)};charset=utf-8` }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [text, format]);

  return (
    <div className="modal-backdrop" onPointerDown={(event) => closeDialogFromBackdrop(event, onClose)}>
      <div ref={dialogRef} className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-icon"><Icon name="data_object" /></div>
          <div>
            <strong id="export-dialog-title">导出批注</strong>
            <small>结构化批注 · 可复制、归档或交给后续工具处理</small>
          </div>
          <Segment>
            <button className={scope === "page" ? "active" : ""} onClick={() => onScope("page")}>本页</button>
            <button className={scope === "doc" ? "active" : ""} onClick={() => onScope("doc")}>整份文档</button>
          </Segment>
          <Segment>
            <button className={format === "json" ? "active" : ""} onClick={() => onFormat("json")}>JSON</button>
            <button className={format === "markdown" ? "active" : ""} onClick={() => onFormat("markdown")}>MD</button>
            <button className={format === "csv" ? "active" : ""} onClick={() => onFormat("csv")}>CSV</button>
            <button className={format === "prompt" ? "active" : ""} onClick={() => onFormat("prompt")}>AI 指令</button>
            <button className={format === "html" ? "active" : ""} onClick={() => onFormat("html")}>HTML</button>
            <button className={format === "pdf" ? "active" : ""} onClick={() => onFormat("pdf")}>批注 PDF</button>
          </Segment>
          <button className="plain-icon" onClick={onClose} title="关闭" aria-label="关闭"><Icon name="close" /></button>
        </div>
        {format === "pdf" && scope === "doc" && (
          <div className="pdf-export-options">
            <div>
              <strong>PDF 页面范围</strong>
              <small>批注汇总会紧跟在对应原文页后面</small>
            </div>
            <Segment>
              <button className={pdfPageMode === "annotated" ? "active" : ""} aria-pressed={pdfPageMode === "annotated"} onClick={() => onPdfPageMode("annotated")}>仅有批注页</button>
              <button className={pdfPageMode === "all" ? "active" : ""} aria-pressed={pdfPageMode === "all"} onClick={() => onPdfPageMode("all")}>全部页面</button>
            </Segment>
          </div>
        )}
        <div className="pdf-export-options export-content-options">
          <div>
            <strong>批注内容</strong>
            <small>{includeResolved ? "包含已结束的历史意见" : "默认只交付仍需处理的意见"}</small>
          </div>
          <Segment>
            <button className={!includeResolved ? "active" : ""} aria-pressed={!includeResolved} onClick={() => onIncludeResolved(false)}>仅未解决</button>
            <button className={includeResolved ? "active" : ""} aria-pressed={includeResolved} onClick={() => onIncludeResolved(true)}>包含已解决</button>
          </Segment>
          {format !== "pdf" && (
            <Segment>
              <button className={conversationMode === "latest" ? "active" : ""} aria-pressed={conversationMode === "latest"} onClick={() => onConversationMode("latest")}>最新回复</button>
              <button className={conversationMode === "full" ? "active" : ""} aria-pressed={conversationMode === "full"} onClick={() => onConversationMode("full")}>完整对话</button>
            </Segment>
          )}
        </div>
        {format !== "pdf" && format !== "html" && (
          <div className="pdf-export-options export-path-options">
            <div>
              <strong>本机文件路径</strong>
              <small>{includeLocalPaths ? "导出内容会包含原文件和转换文件的绝对路径" : "默认隐藏本机目录，粘给 AI 时不会带上你的文件夹结构"}</small>
            </div>
            <Segment>
              <button className={!includeLocalPaths ? "active" : ""} aria-pressed={!includeLocalPaths} onClick={() => onIncludeLocalPaths(false)}>隐藏路径</button>
              <button className={includeLocalPaths ? "active" : ""} aria-pressed={includeLocalPaths} onClick={() => onIncludeLocalPaths(true)}>包含路径</button>
            </Segment>
          </div>
        )}
        <pre className="json-box">{text}</pre>
        {aiResult && (
          <div className="ai-result">
            <strong>{aiResult.loading ? "正在整理批注..." : "本地修改清单"}</strong>
            {!aiResult.loading && <span>{aiResult.summary}</span>}
          </div>
        )}
        <div className="modal-foot">
          <span>
            {exportedPageCount} 个原文页 · {annotationCount} 条批注（{scope === "page" ? "当前页" : "整份文档"}）
            {!includeResolved && payload?.summary?.excludedResolvedCount ? ` · 已排除 ${payload.summary.excludedResolvedCount} 条已解决` : ""}
          </span>
          <div className="modal-actions">
            <button className="secondary-action" onClick={onSendAi} aria-label="整理为修改清单"><Icon name="checklist" />整理修改清单</button>
            {format === "html" ? (
              <button className="download-action" onClick={onDownloadHtmlExport} aria-label="下载自包含 HTML"><Icon name="download" />下载 HTML</button>
            ) : format === "pdf" ? (
              <button className="download-action" onClick={onDownloadPdfExport} aria-label="下载带可视批注的 PDF"><Icon name="picture_as_pdf" />下载批注 PDF</button>
            ) : (
              <a className="download-action" href={downloadUrl} download={downloadName} onClick={onDownloadExport} aria-label="下载导出文件"><Icon name="download" />下载文件</a>
            )}
            <button className="copy-action" onClick={onCopy} aria-label="复制导出内容"><Icon name={copied ? "check" : "content_copy"} />{copied ? "已复制" : "复制"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectRenameModal({ value, onValue, onClose, onSubmit }) {
  const dialogRef = useRef(null);
  useDialogKeyboard(dialogRef, onClose);
  return (
    <div className="modal-backdrop" onPointerDown={(event) => closeDialogFromBackdrop(event, onClose)}>
      <form
        ref={dialogRef}
        className="rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="modal-head">
          <div className="modal-icon"><Icon name="edit" /></div>
          <div>
            <strong id="rename-dialog-title">重命名项目</strong>
            <small>修改首页标题和项目列表中的显示名称</small>
          </div>
          <button className="plain-icon" type="button" onClick={onClose} title="关闭" aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className="rename-body">
          <label>
            <span>项目名称</span>
            <input value={value} onChange={(event) => onValue(event.target.value)} autoFocus />
          </label>
        </div>
        <div className="modal-foot">
          <span>{value.trim() ? "按 Enter 保存" : "请输入项目名称"}</span>
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={onClose}>取消</button>
            <button className="copy-action" type="submit" disabled={!value.trim()}><Icon name="check" />保存</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ImportDocumentDialog({ onClose, onImportUrl, onUpload }) {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  useDialogKeyboard(dialogRef, onClose);

  const submit = async (event) => {
    event.preventDefault();
    const value = url.trim();
    if (!value) {
      setError("请输入文件链接。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onImportUrl(value);
    } catch (submitError) {
      setSubmitting(false);
      setError(String(submitError?.message || "导入失败").replace(/^Request failed:\s*/i, ""));
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(event) => closeDialogFromBackdrop(event, submitting ? () => {} : onClose)}>
      <form
        ref={dialogRef}
        className="app-dialog import-document-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-document-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-head">
          <div className="modal-icon"><Icon name="file_upload" /></div>
          <div>
            <strong id="import-document-title">导入文档</strong>
            <small>粘贴链接或本机路径，也可以从本机选择文件</small>
          </div>
          <button className="plain-icon" type="button" disabled={submitting} onClick={onClose} title="关闭" aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className="dialog-body import-document-body">
          <label>
            <span>文件链接或本机路径</span>
            {/* A textarea rather than an input: a single-line input silently strips newlines, so
                pasting two paths would run them together into one path that cannot exist. It starts
                one row tall and grows, so the common single-line case still looks like a field. */}
            <textarea
              className="import-source-input"
              rows={1}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError("");
                event.target.style.height = "auto";
                event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(event) => {
                // Enter imports, as the footer says; Shift+Enter is how you add another line.
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="https://example.com/document.pdf 或 /Users/…/报告.pdf"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              disabled={submitting}
              autoFocus
            />
          </label>
          <p className="import-document-hint">
            支持公开的 HTTP/HTTPS 直接下载链接，或本机文件路径（<code>/Users/…</code>、<code>~/…</code>、
            <code>file://…</code>）。本机文件按原位置跟踪，之后可以直接刷新；链接会下载副本。多行可一次导入多个（Shift+Enter 换行）。
            单个文件最大 100 MB。
          </p>
          {error && <div className="import-document-error" role="alert"><Icon name="error" /><span>{error}</span></div>}
          <div className="import-method-divider"><span>或</span></div>
          <label className="local-file-action" role="button" tabIndex={submitting ? -1 : 0} onKeyDown={submitting ? undefined : activateFileLabel}>
            <Icon name="file_upload" />
            <span><strong>选择本地文件</strong><small>支持 PDF、Office、图片和文本文件</small></span>
            <Icon name="chevron_right" />
            <input type="file" accept={DOCUMENT_ACCEPT} multiple disabled={submitting} onChange={(event) => { onUpload(event.target.files); event.currentTarget.value = ""; }} />
          </label>
        </div>
        <div className="modal-foot dialog-foot">
          <span aria-live="polite">{submitting ? "正在读取文件…" : "按 Enter 导入"}</span>
          <div className="modal-actions">
            <button className="secondary-action" type="button" disabled={submitting} onClick={onClose}>取消</button>
            <button className={`copy-action ${submitting ? "loading" : ""}`} type="submit" disabled={submitting || !url.trim()}><Icon name={submitting ? "refresh" : "link"} />{submitting ? "导入中" : "导入"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function AppDialog({ dialog, onResolve }) {
  const [value, setValue] = useState(dialog.defaultValue || "");
  const [deleteTasks, setDeleteTasks] = useState(dialog.taskCleanupDefault !== false);
  const dialogRef = useRef(null);
  const cancelValue = dialog.type === "prompt" ? null : dialog.type === "choice" ? null : dialog.type === "confirm" ? false : true;

  const resolveConfirmed = () => {
    if (dialog.type === "prompt") {
      const nextValue = value.trim();
      if (!nextValue) return;
      onResolve(nextValue);
      return;
    }
    onResolve(dialog.taskCleanupCount ? { confirmed: true, deleteTasks } : true);
  };

  useDialogKeyboard(dialogRef, () => onResolve(cancelValue), dialog.type === "prompt" ? null : resolveConfirmed);

  const submit = (event) => {
    event.preventDefault();
    resolveConfirmed();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(event) => closeDialogFromBackdrop(event, () => onResolve(cancelValue))}>
      <form
        ref={dialogRef}
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        aria-describedby="app-dialog-message"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-head">
          <div className={`modal-icon ${dialog.destructive ? "danger" : ""}`}><Icon name={dialog.destructive ? "delete" : dialog.type === "prompt" ? "edit" : "fact_check"} /></div>
          <div>
            <strong id="app-dialog-title">{dialog.title}</strong>
            <small>{dialog.type === "prompt" ? "完成后按 Enter 保存" : dialog.type === "choice" ? "请选择一种处理方式" : "请确认后继续"}</small>
          </div>
          <button className="plain-icon" type="button" onClick={() => onResolve(cancelValue)} title="关闭" aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className="dialog-body">
          <p id="app-dialog-message">{dialog.message}</p>
          {dialog.type === "prompt" && (
            <label>
              <span>{dialog.inputLabel || "名称"}</span>
              <input value={value} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} autoFocus />
            </label>
          )}
          {dialog.type === "confirm" && dialog.taskCleanupCount > 0 && (
            <label className="dialog-cleanup-option">
              <input type="checkbox" checked={deleteTasks} onChange={(event) => setDeleteTasks(event.target.checked)} />
              <span>同时删除 {dialog.taskCleanupCount} 个关联审阅任务及其文档快照</span>
            </label>
          )}
        </div>
        <div className="modal-foot dialog-foot">
          <span>{dialog.destructive ? "此操作无法撤销" : ""}</span>
          <div className="modal-actions">
            {dialog.type !== "alert" && <button className="secondary-action" type="button" onClick={() => onResolve(cancelValue)}>取消</button>}
            {dialog.type === "choice"
              ? (dialog.choices || []).map((choice, index) => (
                  <button
                    key={choice.value}
                    className={choice.primary ? "copy-action" : "secondary-action"}
                    type="button"
                    autoFocus={index === 0}
                    data-default-action={choice.primary ? "true" : undefined}
                    onClick={() => onResolve(choice.value)}
                  >
                    {choice.primary && <Icon name="check" />}
                    {choice.label}
                  </button>
                ))
              : (
                <button className={dialog.destructive ? "danger-action" : "copy-action"} type="submit" autoFocus={dialog.type !== "prompt"} data-default-action={dialog.type !== "prompt" ? "true" : undefined} disabled={dialog.type === "prompt" && !value.trim()}>
                  <Icon name={dialog.destructive ? "delete" : "check"} />
                  {dialog.type === "alert" ? "知道了" : dialog.type === "prompt" ? "保存" : "确认"}
                </button>
              )}
          </div>
        </div>
      </form>
    </div>
  );
}

function AnnotationStateControl({ value, onPick, compact = false }) {
  return (
    <div className={`annotation-state-control ${compact ? "compact" : ""}`} role="group" aria-label="批注状态">
      {Object.entries(ANNOTATION_STATES).map(([key, state]) => (
        <button
          type="button"
          key={key}
          className={`${key} ${value === key ? "active" : ""}`}
          aria-pressed={value === key}
          onClick={(event) => {
            event.stopPropagation();
            onPick(key);
          }}
        >
          {state.label}
        </button>
      ))}
    </div>
  );
}

function Segment({ children, className = "", ...props }) {
  return <div className={`segment ${className}`.trim()} {...props}>{children}</div>;
}

function TypeIcon({ type }) {
  const meta = DOCTYPE[type] || DOCTYPE.file;
  return <span className="type-icon" style={{ background: meta.soft, color: meta.fg }}><Icon name={meta.icon} /></span>;
}

function outlineIcon(type) {
  return { figure: "image", table: "table_chart", section: "segment" }[type] || "segment";
}

function Icon({ name }) {
  const Component = ICON_COMPONENTS[name] || Circle;
  return <Component className="material-symbols-rounded" aria-hidden="true" focusable="false" />;
}

const ICON_COMPONENTS = {
  account_tree: GitBranch,
  add: Plus,
  drive_file_move: FolderInput,
  add_location_alt: MapPinPlus,
  archive: Archive,
  arrow_back: ArrowLeft,
  arrow_selector_tool: MousePointer2,
  article: FileText,
  auto_fix_high: WandSparkles,
  bookmark: Bookmark,
  bookmark_add: BookmarkPlus,
  check: Check,
  checklist: ListChecks,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  expand_less: ChevronUp,
  expand_more: ChevronDown,
  close: X,
  co_present: Presentation,
  code: Code2,
  content_copy: Copy,
  create_new_folder: FolderPlus,
  crop_free: Crop,
  data_object: Braces,
  delete: Trash2,
  description: FileText,
  download: Download,
  draft: File,
  edit: Pencil,
  edit_note: MessageSquareText,
  fact_check: ClipboardCheck,
  file_upload: FileUp,
  filter_alt_off: FilterX,
  filter_list: ListFilter,
  fit_screen: Scan,
  folder_open: FolderOpen,
  format_quote: Quote,
  highlight_alt: SquareDashedMousePointer,
  history: History,
  history_toggle_off: History,
  image: ImageIcon,
  info: Info,
  link: Link2,
  link_off: Link2,
  lock: Lock,
  monitor_heart: BadgeAlert,
  more_horiz: Ellipsis,
  new_releases: BadgeAlert,
  error: BadgeAlert,
  picture_as_pdf: FileText,
  playlist_add_check: ListChecks,
  push_pin: Pin,
  rate_review: MessageSquareText,
  redo: Redo2,
  refresh: RefreshCw,
  restart_alt: RotateCcw,
  restore: RotateCcw,
  rotate_left: RotateCcw,
  rotate_right: RotateCw,
  search: Search,
  search_off: SearchX,
  segment: AlignLeft,
  source_path: GitBranch,
  sticky_note_2: StickyNote,
  text_select_start: Quote,
  table_chart: Table2,
  unarchive: ArchiveRestore,
  undo: Undo2,
  upload_file: Upload,
  view_agenda: Rows3,
  zoom_in: ZoomIn,
  zoom_out: ZoomOut
};

function buildExportPayload(project, doc, annotations, reviewThreads, scope, currentPage, options = {}) {
  const includeResolved = Boolean(options.includeResolved);
  const includeLocalPaths = Boolean(options.includeLocalPaths);
  const conversationMode = options.conversationMode === "latest" ? "latest" : "full";
  const pages = [];
  let excludedResolvedCount = 0;
  const pageIndexes = scope === "page" ? [currentPage] : Array.from({ length: doc.pageCount }, (_, index) => index + 1);
  for (const index of pageIndexes) {
    const list = annotations[`${doc.id}:${index}`] || [];
    const meaningful = list.filter((item) => item.text?.trim() || item.type !== "note");
    const markerLabels = annotationMarkerLabels(list);
    const exportable = meaningful.filter((item) => {
      const resolved = annotationReviewState(reviewThreads[item.id], item) === "resolved";
      if (resolved && !includeResolved) excludedResolvedCount += 1;
      return includeResolved || !resolved;
    });
    if (exportable.length === 0) continue;
    const pageData = doc.pages?.[index - 1] || {};
    pages.push({
      index,
      title: pageTitle(doc, index),
      previewUrl: pageData.imageUrl || pageData.sourceUrl || pageData.previewUrl || (doc.renderMode === "pdf" ? `/api/documents/${doc.id}/pages/${index}/preview` : ""),
      textExcerpt: pageData.text ? pageData.text.slice(0, 600) : "",
      annotations: exportable.map((item) => {
        const thread = reviewThreads[item.id];
        const allMessages = (thread?.messages || []).map((message) => ({
          id: message.id,
          role: message.role,
          author: message.author || (message.role === "assistant" ? "AI" : "用户"),
          body: message.body || "",
          createdAt: isoTimestamp(message.createdAt),
          ...(message.change ? { change: cloneValue(message.change) } : {})
        }));
        const base = {
          id: item.id,
          displayLabel: markerLabels[item.id] || "页",
          type: item.type,
          tag: item.tag,
          text: item.text || "",
          locationLabel: annotationLocation(item),
          createdAt: isoTimestamp(item.createdAt),
          updatedAt: isoTimestamp(item.updatedAt || item.createdAt),
          review: {
            status: reviewThreadStatus(thread, item),
            state: annotationReviewState(thread, item),
            createdBy: thread?.createdBy || item.createdBy || "human",
            messages: conversationMode === "latest" ? allMessages.slice(-1) : allMessages
          }
        };
        if (item.type === "pin") base.position = { x: item.x, y: item.y };
        if (item.type === "region") base.rect = { x: item.x, y: item.y, w: item.w, h: item.h };
        if (item.type === "text") {
          base.quote = item.quote || "";
          base.rects = item.rects || [];
          // Pasting into a chat window means the model cannot see the page, so the words around the
          // quote are the only way it can tell where the change goes. The stored anchor keeps a wide
          // window because re-anchoring needs it; pasting that window reproduces most of the page
          // around a one-sentence remark, so the export gets the sentence and nothing more.
          const context = contextForExport({ quote: item.quote, prefix: item.anchor?.prefix, suffix: item.anchor?.suffix });
          if (context.prefix || context.suffix) base.context = context;
          // A refresh could not find this quote in the new version, so the words above describe the
          // document as it used to read. Say so rather than letting the model treat them as current.
          base.anchorStale = item.anchorStatus === "unmatched";
          // Read off the page rather than copied out of the file, so it may differ from the document
          // by a character. The model should weigh it accordingly.
          if (item.quoteSource === "ocr") base.quoteFromImage = true;
        }
        return base;
      })
    });
  }
  return {
    project: { id: project.id, name: project.name },
    document: {
      id: doc.id,
      name: doc.name,
      type: doc.type,
      renderMode: doc.renderMode,
      pageCount: doc.pageCount,
      sourcePath: includeLocalPaths ? (doc.originalPath || doc.sourceLabel || "") : "",
      managedCopyPath: includeLocalPaths ? (doc.sourcePath || "") : "",
      convertedPdfPath: includeLocalPaths ? (doc.convertedPdfPath || "") : "",
      revision: doc.contentHash || "",
      sourceModifiedAt: doc.sourceModifiedAt || 0
    },
    scope,
    options: { includeResolved, conversationMode, includeLocalPaths },
    summary: {
      pageCount: pages.length,
      annotationCount: pages.reduce((sum, page) => sum + page.annotations.length, 0),
      excludedResolvedCount
    },
    exportedAt: new Date().toISOString(),
    pages
  };
}

function formatExport(payload, format) {
  if (format === "markdown") return toMarkdown(payload);
  if (format === "csv") return toCsv(payload);
  if (format === "prompt") return toAiPrompt(payload);
  if (format === "html") return toHtmlExportSummary(payload);
  if (format === "pdf") return toPdfExportSummary(payload);
  return JSON.stringify(payload, null, 2);
}

function exportExtension(format) {
  if (format === "markdown") return "md";
  if (format === "prompt") return "txt";
  if (format === "html") return "html";
  if (format === "pdf") return "pdf";
  return format;
}

function exportMime(format) {
  if (format === "json") return "application/json";
  if (format === "csv") return "text/csv";
  if (format === "prompt") return "text/plain";
  if (format === "html") return "text/html";
  if (format === "pdf") return "application/pdf";
  return "text/markdown";
}

function exportFileName(payload, format, ext) {
  const scope = payload.scope === "doc" ? "document" : `page-${payload.pages?.[0]?.index || "current"}`;
  const docName = slugFileName(payload.document?.name || "annotations");
  const stamp = new Date().toISOString().slice(0, 10);
  return `${docName}-${scope}-${stamp}.${ext || format}`;
}

function slugFileName(value) {
  return String(value)
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "annotations";
}

function toMarkdown(payload) {
  const lines = [
    `# ${payload.document?.name || "批注导出"}`,
    "",
    `- 项目：${payload.project?.name || ""}`,
    `- 原始文件：${payload.document?.sourcePath || payload.document?.name || ""}`,
    `- 范围：${payload.scope === "doc" ? "整份文档" : "当前页"}`,
    `- 导出时间：${payload.exportedAt || ""}`,
    ""
  ];
  for (const page of payload.pages || []) {
    lines.push(`## 第 ${page.index} 页：${page.title || ""}`);
    if (page.previewUrl) lines.push(`预览：${page.previewUrl}`);
    if (page.textExcerpt) lines.push(`文本摘要：${page.textExcerpt}`);
    for (const annotation of page.annotations || []) {
      const loc = annotation.position
        ? ` @ (${annotation.position.x}, ${annotation.position.y})`
        : annotation.rect
          ? ` @ (${annotation.rect.x}, ${annotation.rect.y}, ${annotation.rect.w}x${annotation.rect.h})`
          : annotation.rects?.length
            ? ` @ ${annotation.locationLabel || "文字选区"}`
          : "";
      const label = annotation.locationLabel ? ` ${annotation.locationLabel}` : "";
      const quote = annotation.quote ? `「${annotation.quote}」 ` : "";
      const status = annotation.review?.status ? `；状态：${annotation.review.status}` : "";
      lines.push(`- [${annotation.type}${annotation.tag ? `/${annotation.tag}` : ""}]${label}${loc} ${quote}${annotation.text || ""}${status}`);
      for (const message of annotation.review?.messages || []) {
        lines.push(`  - ${message.author || (message.role === "assistant" ? "AI" : "用户")}：${message.body || ""}`);
        if (message.change?.summary) lines.push(`    修改记录：${message.change.summary}`);
        if (message.change && [message.change.file, message.change.section, message.change.commit].some(Boolean)) {
          lines.push(`    证据：${[message.change.file, message.change.section, message.change.commit].filter(Boolean).join(" · ")}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function toCsv(payload) {
  const rows = [["document", "source_path", "page", "title", "preview_url", "type", "tag", "status", "review_state", "location", "x", "y", "w", "h", "quote", "text", "reply_count", "conversation"]];
  for (const page of payload.pages || []) {
    for (const annotation of page.annotations || []) {
      rows.push([
        payload.document?.name || "",
        payload.document?.sourcePath || "",
        page.index,
        page.title || "",
        page.previewUrl || "",
        annotation.type,
        annotation.tag || "",
        annotation.review?.status || "",
        annotation.review?.state || "",
        annotation.locationLabel || "",
        annotation.position?.x ?? annotation.rect?.x ?? "",
        annotation.position?.y ?? annotation.rect?.y ?? "",
        annotation.rect?.w ?? "",
        annotation.rect?.h ?? "",
        annotation.quote || "",
        annotation.text || "",
        annotation.review?.messages?.length || 0,
        (annotation.review?.messages || []).map((message) => `${message.author || message.role}: ${message.body || ""}`).join("\n")
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

// What gets pasted into a chat window. It used to open with roughly fifty lines of MCP connection
// setup and label the annotations themselves as the fallback, which is backwards for the common way
// this app is used. Coordinates and preview URLs are dropped too: a model reading pasted text cannot
// see the page, so "x=53.2, y=41.8" and a localhost URL are noise that dilutes the actual request.
function toAiPrompt(payload) {
  const annotationCount = (payload.pages || []).reduce((total, page) => total + (page.annotations || []).length, 0);
  const scopeLabel = payload.scope === "doc" ? "整份文档" : `第 ${payload.pages?.[0]?.index ?? ""} 页`;
  const lines = [
    "请根据以下批注意见修改这份文档。保持原有结构和语气；标记为 todo 的优先处理；标记为 question 的先说明需要我确认什么，再给出建议改法。",
    "",
    `文档：${payload.document?.name || ""}（${scopeLabel}，${annotationCount} 条意见）`
  ];
  if (payload.project?.name) lines.push(`项目：${payload.project.name}`);
  if (payload.document?.sourcePath) lines.push(`原始文件：${payload.document.sourcePath}`);
  if (payload.document?.convertedPdfPath) lines.push(`转换后 PDF：${payload.document.convertedPdfPath}`);
  lines.push("");

  if (!payload.pages?.length) {
    lines.push("（这一范围内没有待处理的批注。）");
    return `${lines.join("\n")}\n`;
  }

  for (const page of payload.pages) {
    lines.push("───────────────", "", `第 ${page.index} 页${page.title ? ` · ${page.title}` : ""}`, "");
    for (const annotation of page.annotations || []) {
      const heading = [
        annotation.displayLabel ? `[${annotation.displayLabel}]` : "",
        ANNOTATION_TYPE_LABELS[annotation.type] || annotation.type,
        annotation.tag ? `· ${annotation.tag}` : ""
      ].filter(Boolean).join(" ");
      lines.push(heading);
      if (annotation.quote) {
        // 【】marks exactly what was selected inside the surrounding sentence.
        lines.push("原文：", `  ${quoteWithContext(annotation.quote, annotation.context)}`.trimEnd());
        if (annotation.anchorStale) {
          lines.push("（这段原文出自文档的上一个版本，当前版本里已找不到；请按当前正文的对应位置理解这条意见。）");
        }
        if (annotation.quoteFromImage) {
          lines.push("（这段原文是从页面图像识别出来的，因为这份 PDF 的文字层无法解码，个别字可能有出入。）");
        }
      } else if (annotation.locationLabel && annotation.locationLabel !== "整页") {
        lines.push(`位置：${annotation.locationLabel}`);
      }
      lines.push(`意见：${annotation.text || "（未填写，请结合上下文判断此处需要什么修改）"}`);
      for (const message of annotation.review?.messages || []) {
        lines.push(`  ${message.author || (message.role === "assistant" ? "AI" : "用户")}：${message.body || ""}`);
        if (message.change?.summary) lines.push(`  已改：${message.change.summary}`);
      }
      lines.push("");
    }
  }

  if (payload.summary?.excludedResolvedCount) {
    lines.push(`（另有 ${payload.summary.excludedResolvedCount} 条已解决的意见未包含在内。）`);
  }
  return `${lines.join("\n")}\n`;
}

function toHtmlExportSummary(payload) {
  return [
    "自包含 HTML 导出",
    "",
    "点击“下载 HTML”后，系统会把当前导出范围内的页面预览图转成 base64 并嵌入一个单文件网页。",
    "这个 HTML 可以脱离本 App 打开，适合发给他人审阅或归档。",
    "",
    `文档：${payload.document?.name || ""}`,
    `范围：${payload.scope === "doc" ? "整份文档" : "当前页"}`,
    `已批注页：${payload.pages?.length || 0}`,
    `批注数：${payload.pages?.reduce((sum, page) => sum + page.annotations.length, 0) || 0}`
  ].join("\n");
}

function toPdfExportSummary(payload) {
  return [
    "带可视批注的 PDF",
    "",
    "原始 PDF 页面会保持矢量清晰度，并叠加编号标记、框选和文字高亮。",
    "每一页的具体批注意见会紧跟在对应原文页后面。",
    "",
    `文档：${payload.document?.name || ""}`,
    `范围：${payload.scope === "doc" ? "整份文档" : "当前页"}`,
    `批注数：${payload.pages?.reduce((sum, page) => sum + page.annotations.length, 0) || 0}`
  ].join("\n");
}

function pdfExportDescription(payload, scope, pageMode) {
  const annotatedPages = payload?.pages?.length || 0;
  const sourcePages = scope === "page" ? 1 : pageMode === "annotated" ? annotatedPages : Number(payload?.document?.pageCount || 0);
  return [
    "带可视批注的 PDF",
    "",
    `页面范围：${scope === "page" ? "当前页" : pageMode === "annotated" ? "仅有批注的页面" : "全部页面"}`,
    `原文页数：${sourcePages}`,
    `批注页数：${annotatedPages}`,
    "",
    "输出顺序：",
    "原文页 → 该页批注汇总 → 下一原文页",
    "",
    "没有批注的原文页不会添加空白汇总页。"
  ].join("\n");
}

function csvCell(value) {
  const raw = String(value ?? "");
  const text = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function countDocAnnotations(doc, annotations) {
  return Array.from({ length: doc.pageCount }, (_, index) => index + 1).reduce((sum, page) => sum + (annotations[`${doc.id}:${page}`] || []).length, 0);
}

function reviewThreadStatus(thread, annotation) {
  return thread?.status || (annotation?.tag === "resolved" ? "resolved" : "open");
}

function pageTitle(doc, page) {
  const raw = doc.titles?.[page - 1] || doc.pages?.[page - 1]?.title || "";
  if (doc.type === "pdf") return pdfPageTitle(raw, page);
  return normalizePageNumberTitle(raw, page) || pageLabel(page);
}

function pdfPageTitle(rawTitle, page) {
  const title = String(rawTitle || "").trim();
  if (title && !isBadPdfPageTitle(title)) return title;
  return pageLabel(page);
}

function PageHeading({ doc, page }) {
  const title = normalizePageNumberTitle(pageTitle(doc, page), page);
  const numberedOnly = isPageNumberTitle(title);
  return (
    <div className={`page-heading ${numberedOnly ? "page-heading-number-only" : ""}`}>
      {!numberedOnly && <span>{pageLabel(page)}</span>}
      <strong>{title}</strong>
    </div>
  );
}

function isBadPdfPageTitle(title) {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (/^\d+$/.test(clean)) return true;
  if (clean.length < 4) return true;
  if (clean.endsWith("-")) return true;
  if (/^[a-z]/.test(clean)) return true;
  return false;
}

function pageAspect(pageData) {
  const explicit = Number(pageData?.aspectRatio);
  if (explicit > 0) return explicit;
  const width = Number(pageData?.width);
  const height = Number(pageData?.height);
  if (width > 0 && height > 0) return width / height;
  return 0;
}

function pageStageLayout(pageData, zoom, rotation = 0) {
  const aspect = pageAspect(pageData);
  const orientation = pageOrientation(pageData);
  const stageBaseWidth = orientation === "landscape" ? 1040 : orientation === "portrait" ? 760 : 860;
  const effectiveAspect = aspect || (orientation === "landscape" ? 1.414 : 1 / 1.414);
  const stageBaseHeight = stageBaseWidth / effectiveAspect;
  const pageWidth = stageBaseWidth * zoom;
  const pageHeight = stageBaseHeight * zoom;
  const rotated = rotatedPageSize(pageWidth, pageHeight, rotation);
  const effectiveBaseWidth = rotatedPageSize(stageBaseWidth, stageBaseHeight, rotation).width;
  return {
    aspect,
    orientation,
    stageBaseWidth,
    stageBaseHeight,
    effectiveBaseWidth,
    stageStyle: {
      ...(aspect ? { "--page-aspect": String(aspect) } : {}),
      "--page-layout-width": `${Math.round(pageWidth)}px`,
      "--page-layout-height": `${Math.round(pageHeight)}px`,
      "--rotated-layout-height": `${Math.round(rotated.height)}px`,
      "--stage-width": `${Math.round(rotated.width + 20)}px`
    }
  };
}

function pageOrientation(pageData) {
  const aspect = pageAspect(pageData);
  if (aspect > 1.08) return "landscape";
  if (aspect > 0 && aspect < 0.92) return "portrait";
  return "auto";
}

function rectStyle(rect) {
  return { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` };
}

function paddedRect(rect, pad = 0.8) {
  const x = Math.max(0, Number(rect.x || 0) - pad);
  const y = Math.max(0, Number(rect.y || 0) - pad);
  const right = Math.min(100, Number(rect.x || 0) + Number(rect.w || 0) + pad);
  const bottom = Math.min(100, Number(rect.y || 0) + Number(rect.h || 0) + pad);
  return { x: round1(x), y: round1(y), w: round1(right - x), h: round1(bottom - y) };
}

function boundsFromRects(rects) {
  const x1 = Math.min(...rects.map((rect) => rect.x));
  const y1 = Math.min(...rects.map((rect) => rect.y));
  const x2 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y2 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: round1(x1), y: round1(y1), w: round1(x2 - x1), h: round1(y2 - y1) };
}

function mergeSelectionRects(rects) {
  const sorted = [...rects].sort((a, b) => Math.abs(a.y - b.y) > 0.35 ? a.y - b.y : a.x - b.x);
  const merged = [];
  for (const rect of sorted) {
    const previous = merged.at(-1);
    const sameLine = previous && Math.abs((previous.y + previous.h / 2) - (rect.y + rect.h / 2)) <= Math.max(0.35, Math.min(previous.h, rect.h) * 0.45);
    const horizontalGap = previous ? rect.x - (previous.x + previous.w) : Infinity;
    if (sameLine && horizontalGap <= Math.max(1.2, rect.h * 0.7)) {
      const right = Math.max(previous.x + previous.w, rect.x + rect.w);
      const bottom = Math.max(previous.y + previous.h, rect.y + rect.h);
      previous.y = round3(Math.min(previous.y, rect.y));
      previous.w = round3(right - previous.x);
      previous.h = round3(bottom - previous.y);
    } else {
      merged.push({ ...rect });
    }
  }
  return merged.slice(0, 200);
}

function selectionContextForRange(layer, range) {
  if (!range) return { prefix: "", suffix: "" };
  try {
    const prefixRange = range.cloneRange();
    prefixRange.selectNodeContents(layer);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const suffixRange = range.cloneRange();
    suffixRange.selectNodeContents(layer);
    suffixRange.setStart(range.endContainer, range.endOffset);
    return {
      prefix: rangeText(prefixRange),
      suffix: rangeText(suffixRange)
    };
  } catch {
    return { prefix: "", suffix: "" };
  }
}

function annotationLocation(item) {
  if (item.type === "note") return "整页";
  if (item.type === "pin") return `${axisLabel(item.y, "vertical")}${axisLabel(item.x, "horizontal")}`;
  if (item.type === "region" || item.type === "text") {
    const centerX = Number(item.x || 0) + Number(item.w || 0) / 2;
    const centerY = Number(item.y || 0) + Number(item.h || 0) / 2;
    return `${axisLabel(centerY, "vertical")}${axisLabel(centerX, "horizontal")}${item.type === "text" ? "文字" : "区域"}`;
  }
  return "";
}

function textLength(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

function axisLabel(value, axis) {
  if (axis === "vertical") {
    if (value < 33) return "上";
    if (value > 66) return "下";
    return "中";
  }
  if (value < 33) return "左";
  if (value > 66) return "右";
  return "中";
}

function id(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Number(value.toFixed(1));
}

function round2(value) {
  return Number(value.toFixed(2));
}

function round3(value) {
  return Number(value.toFixed(3));
}

function formatRelative(ts) {
  const diff = Date.now() - Number(ts || Date.now());
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function formatDateTime(ts) {
  if (!ts) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(Number(ts)));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}


function createDefaultProject() {
  return {
    id: "p1",
    name: "我的批注项目",
    path: "本地工作区",
    color: ACCENT,
    docIds: [],
    updated: Date.now()
  };
}

function setAnnotationPage(annotations, key, list) {
  if (list.length > 0) return { ...annotations, [key]: cloneValue(list) };
  const next = { ...annotations };
  delete next[key];
  return next;
}

function setRecordPage(records, key, list) {
  if (list.length > 0) return { ...records, [key]: cloneValue(list) };
  const next = { ...records };
  delete next[key];
  return next;
}

function mergeHistoryMaps(...maps) {
  const merged = {};
  const keys = new Set(maps.flatMap((map) => Object.keys(map || {})));
  for (const key of keys) {
    const entries = new Map();
    for (const map of maps) {
      for (const item of map?.[key] || []) entries.set(item.id || `${item.ts}:${item.action}:${item.label}`, item);
    }
    merged[key] = [...entries.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 200);
  }
  return merged;
}

function mergeHistoryRecords(...lists) {
  const entries = new Map();
  for (const list of lists) {
    for (const item of list || []) entries.set(item.id || `${item.ts}:${item.action}:${item.label}`, item);
  }
  return [...entries.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 200);
}

// navigator.clipboard is refused in some contexts even from a genuine click, so keep the older
// execCommand path as a fallback rather than telling the user copying failed.
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

function pendingChangesSnapshot(annotations, history, dirtyAnnotations, dirtyHistory, pageRevisions) {
  const snapshot = { version: 2, savedAt: Date.now(), annotations: {}, history: {} };
  for (const [key, updatedAt] of dirtyAnnotations.entries()) {
    snapshot.annotations[key] = {
      updatedAt,
      value: cloneValue(annotations[key] || []),
      baseRevision: pageRevisions?.get(key) ?? 0
    };
  }
  for (const [key, updatedAt] of dirtyHistory.entries()) {
    snapshot.history[key] = { updatedAt, value: cloneValue(history[key] || []) };
  }
  return snapshot;
}

function restorePendingMap(remote, pending, documents, dirtyKeys, baseRevisions) {
  const restored = { ...remote };
  for (const [key, entry] of Object.entries(pending || {})) {
    const separator = key.lastIndexOf(":");
    const document = documents[key.slice(0, separator)];
    const page = Number(key.slice(separator + 1));
    const updatedAt = Number(entry?.updatedAt || 0);
    if (!document || !Number.isInteger(page) || page < 1 || page > Number(document.pageCount || 1) || !Array.isArray(entry?.value) || !updatedAt) continue;
    if (entry.value.length) restored[key] = cloneValue(entry.value);
    else delete restored[key];
    dirtyKeys.set(key, updatedAt);
    // Snapshots written before baseRevision existed carry no opinion; leaving the server seed in
    // place is right for them, and overwriting it with 0 would conflict every queued page on upgrade.
    if (baseRevisions && Object.hasOwn(entry, "baseRevision")) baseRevisions.set(key, Number(entry.baseRevision) || 0);
  }
  return restored;
}

function mergeRemotePageMap(local, remote, dirtyKeys) {
  const merged = { ...remote };
  for (const key of dirtyKeys.keys()) {
    if (Object.hasOwn(local, key)) merged[key] = local[key];
    else delete merged[key];
  }
  return merged;
}

function filterHistoryForDocuments(history, documents) {
  return Object.fromEntries(Object.entries(history || {}).filter(([key, items]) => {
    const separator = key.lastIndexOf(":");
    const document = documents[key.slice(0, separator)];
    const page = Number(key.slice(separator + 1));
    return document && Number.isInteger(page) && page >= 1 && page <= Number(document.pageCount || 1) && Array.isArray(items);
  }));
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isoTimestamp(value) {
  const timestamp = Number(value || 0);
  return timestamp > 0 && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function activateFileLabel(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.querySelector('input[type="file"]')?.click();
}

function attachDocumentsToProjects(projects, documents) {
  return projects.map((project) => {
    const docIds = new Set(project.docIds || []);
    for (const document of Object.values(documents)) {
      if (document.projectId === project.id) docIds.add(document.id);
    }
    return { ...project, docIds: Array.from(docIds) };
  });
}

function historyIcon(action) {
  return { create: "add", edit: "edit", delete: "delete", archive: "archive", snapshot: "bookmark", restore: "restore" }[action] || "edit";
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function closeDialogFromBackdrop(event, onClose) {
  if (event.target === event.currentTarget) onClose();
}

function useDialogKeyboard(dialogRef, onClose, onConfirm = null) {
  const onCloseRef = useRef(onClose);
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => {
    onCloseRef.current = onClose;
    onConfirmRef.current = onConfirm;
  }, [onClose, onConfirm]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    const previousFocus = document.activeElement;
    window.requestAnimationFrame(() => (dialog.querySelector("[data-default-action], [autofocus], input, textarea") || focusable()[0])?.focus());
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Enter" && onConfirmRef.current && !event.isComposing) {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement) return;
        const action = target?.closest?.("button, a[href]");
        if (action && !action.matches?.("[data-default-action]")) return;
        event.preventDefault();
        onConfirmRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [dialogRef]);
}

function readSavedWorkspace() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Review Annotation UI error", error, info);
    const message = String(error?.message || error || "");
    const chunkFailure = /dynamically imported module|loading chunk|importing a module script/i.test(message);
    if (chunkFailure && sessionStorage.getItem("review-annotation-chunk-reload") !== "1") {
      sessionStorage.setItem("review-annotation-chunk-reload", "1");
      window.location.reload();
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <div className="fatal-error-icon"><Icon name="new_releases" /></div>
        <h1>当前页面未能正常显示</h1>
        <p>文档和批注数据仍保存在本地。重新载入后可以继续处理。</p>
        <button className="copy-action" onClick={() => { sessionStorage.removeItem("review-annotation-chunk-reload"); window.location.reload(); }}><Icon name="refresh" />重新载入</button>
      </main>
    );
  }
}

const rootElement = document.getElementById("root");
window.setTimeout(() => sessionStorage.removeItem("review-annotation-chunk-reload"), 10000);
document.documentElement.classList.toggle("desktop-shell", Boolean(window.reviewAnnotationDesktop));
const root = window.__reviewAnnotationRoot || createRoot(rootElement);
window.__reviewAnnotationRoot = root;
root.render(<AppErrorBoundary><App /></AppErrorBoundary>);
