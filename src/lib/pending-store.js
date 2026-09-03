const DATABASE_NAME = "review-annotation-client";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-changes";
const SNAPSHOT_KEY = "current";

export async function loadPendingChanges() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => reject(request.error || new Error("pending_changes_read_failed"));
    transaction.oncomplete = () => database.close();
  });
}

export async function savePendingChanges(value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    if (hasPendingChanges(value)) store.put({ id: SNAPSHOT_KEY, value });
    else store.delete(SNAPSHOT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("pending_changes_write_failed"));
    };
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexeddb_unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
  });
}

// Counts what is queued locally so the app can say so when the workspace will not load, instead of
// leaving the user to guess whether unsynced edits still exist.
export function pendingChangeSummary(value) {
  const annotationPages = Object.keys(value?.annotations || {});
  const historyPages = Object.keys(value?.history || {});
  const annotationCount = annotationPages.reduce((total, key) => total + (value.annotations[key]?.length || 0), 0);
  const documentIds = new Set([...annotationPages, ...historyPages].map((key) => key.split(":")[0]));
  return {
    pageCount: annotationPages.length,
    annotationCount,
    documentCount: documentIds.size,
    hasPending: annotationPages.length > 0 || historyPages.length > 0
  };
}

function hasPendingChanges(value) {
  return Boolean(Object.keys(value?.annotations || {}).length || Object.keys(value?.history || {}).length);
}
