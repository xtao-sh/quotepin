import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import unzipper from "unzipper";
import { isRecord, validAnnotationList, validHistoryList, validReviewTask, validReviewThread } from "./workspace-validation.js";

const BACKUP_FORMAT = "review-annotation-backup";
const BACKUP_VERSION = 2;
const MAX_ENTRY_COUNT = 20000;
export const MAX_BACKUP_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const RESTORE_JOURNAL_NAME = ".restore-transaction.json";
const MAX_BACKUP_SOURCE_BYTES = Number(process.env.REVIEW_MAX_BACKUP_SOURCE_BYTES || 1900 * 1024 * 1024);
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 128 * 1024 * 1024;
const PRE_RESTORE_BACKUP_RETENTION = 10;

export function backupFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `批注工作台完整备份-${stamp}.reviewbackup`;
}

export async function streamFullBackup(response, { dataDir, workspace, appVersion = "0.0.0" }) {
  const prepared = inspectFullBackup({ dataDir, workspace });
  const fileName = backupFileName();
  response.setHeader("Content-Type", "application/zip");
  response.setHeader("Content-Disposition", contentDisposition(fileName));
  await writeFullBackup(response, { dataDir, workspace, appVersion }, prepared);
}

export async function writeFullBackupFile(destination, options) {
  const prepared = inspectFullBackup(options);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(destination, { flags: "wx" });
  try {
    await writeFullBackup(output, options, prepared);
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
  return destination;
}

export async function restoreFullBackup({ archivePath, dataDir, store, appVersion = "0.0.0" }) {
  recoverInterruptedFullRestore(dataDir);
  const restoreId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const stagingDir = path.join(dataDir, `.restore-staging-${restoreId}`);
  const rollbackDir = path.join(dataDir, `.restore-rollback-${restoreId}`);
  const backupsDir = path.join(dataDir, "backups");
  const automaticBackup = path.join(backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.reviewbackup`);
  const journalPath = path.join(dataDir, RESTORE_JOURNAL_NAME);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    await extractBackup(archivePath, stagingDir);
    const manifest = readJsonRequired(path.join(stagingDir, "manifest.json"), "invalid_manifest");
    if (manifest.format !== BACKUP_FORMAT || Number(manifest.version) !== BACKUP_VERSION) {
      throw backupError("unsupported_backup", "This backup format is not supported.");
    }
    await verifyManifest(stagingDir, manifest);
    const portableWorkspace = readJsonRequired(path.join(stagingDir, "workspace.json"), "invalid_workspace");
    const workspace = restorePortableWorkspace(portableWorkspace, dataDir);
    validateWorkspace(workspace);
    validateWorkspaceAssets(workspace, stagingDir, dataDir);

    await writeFullBackupFile(automaticBackup, { dataDir, workspace: store.getState(), appVersion });
    pruneAutomaticBackups(backupsDir);
    fs.mkdirSync(rollbackDir, { recursive: true });
    const previousState = store.getState();
    const swapped = [];
    const workspaceBackupPath = path.join(rollbackDir, "workspace.json");
    const workspacePath = path.join(dataDir, "workspace.json");
    if (fs.existsSync(workspacePath)) fs.copyFileSync(workspacePath, workspaceBackupPath);
    const journal = {
      version: 1,
      phase: "prepared",
      restoreId,
      stagingDir,
      rollbackDir,
      workspaceBackupPath,
      workspaceExisted: fs.existsSync(workspacePath),
      directories: []
    };
    writeRestoreJournal(journalPath, journal);

    try {
      for (const directory of ["uploads", "renders", "review-tasks", "versions"]) {
        const current = path.join(dataDir, directory);
        const incoming = path.join(stagingDir, directory);
        const previous = path.join(rollbackDir, directory);
        journal.directories.push({ name: directory, originalExisted: fs.existsSync(current) });
        writeRestoreJournal(journalPath, journal);
        if (fs.existsSync(current)) {
          fs.renameSync(current, previous);
          swapped.push({ current, previous });
        }
        if (fs.existsSync(incoming)) fs.renameSync(incoming, current);
        else fs.mkdirSync(current, { recursive: true });
      }
      store.replaceWorkspace(workspace);
      journal.phase = "committed";
      writeRestoreJournal(journalPath, journal);
      fs.rmSync(rollbackDir, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
    } catch (error) {
      for (const directory of ["uploads", "renders", "review-tasks", "versions"]) {
        fs.rmSync(path.join(dataDir, directory), { recursive: true, force: true });
      }
      for (const item of swapped.reverse()) {
        if (fs.existsSync(item.previous)) fs.renameSync(item.previous, item.current);
      }
      store.replaceWorkspace(previousState);
      fs.rmSync(journalPath, { force: true });
      throw error;
    }

    return { workspace: store.getWorkspace(), automaticBackup };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(rollbackDir, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
  }
}

export function recoverInterruptedFullRestore(dataDir) {
  const journalPath = path.join(dataDir, RESTORE_JOURNAL_NAME);
  if (!fs.existsSync(journalPath)) return { recovered: false };
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    fs.rmSync(journalPath, { force: true });
    return { recovered: false, discardedInvalidJournal: true };
  }
  const stagingDir = safeRestoreInternalPath(dataDir, journal.stagingDir, ".restore-staging-");
  const rollbackDir = safeRestoreInternalPath(dataDir, journal.rollbackDir, ".restore-rollback-");
  if (journal.phase === "prepared" && rollbackDir) {
    for (const entry of Array.isArray(journal.directories) ? journal.directories : []) {
      if (!["uploads", "renders", "review-tasks", "versions"].includes(entry?.name)) continue;
      const current = path.join(dataDir, entry.name);
      const previous = path.join(rollbackDir, entry.name);
      if (fs.existsSync(previous)) {
        fs.rmSync(current, { recursive: true, force: true });
        fs.renameSync(previous, current);
      } else if (entry.originalExisted === false) {
        fs.rmSync(current, { recursive: true, force: true });
      }
    }
    const workspaceBackupPath = path.join(rollbackDir, "workspace.json");
    if (fs.existsSync(workspaceBackupPath)) atomicCopyFile(workspaceBackupPath, path.join(dataDir, "workspace.json"));
    else if (journal.workspaceExisted === false) fs.rmSync(path.join(dataDir, "workspace.json"), { force: true });
  }
  if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  if (rollbackDir) fs.rmSync(rollbackDir, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
  return { recovered: journal.phase === "prepared", committedCleanup: journal.phase === "committed" };
}

function writeRestoreJournal(journalPath, journal) {
  const temporary = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, journalPath);
}

function atomicCopyFile(source, destination) {
  const temporary = `${destination}.${process.pid}.restore.tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

function safeRestoreInternalPath(dataDir, candidate, prefix) {
  const absolute = path.resolve(String(candidate || ""));
  const base = path.resolve(dataDir);
  return absolute.startsWith(`${base}${path.sep}`) && path.basename(absolute).startsWith(prefix) ? absolute : "";
}

export function inspectFullBackup({ dataDir, workspace, maxSourceBytes = MAX_BACKUP_SOURCE_BYTES }) {
  validateWorkspace(workspace?.workspace || workspace);
  const { files, pathOverrides } = collectAssetFiles(dataDir, workspace);
  if (files.length + 2 > MAX_ENTRY_COUNT) {
    throw backupError("backup_too_large", `完整备份包含 ${files.length + 2} 个文件，超过 ${MAX_ENTRY_COUNT} 个文件的恢复上限。`);
  }
  const portableWorkspace = makePortableWorkspace(workspace, dataDir, pathOverrides);
  const workspaceBuffer = Buffer.from(`${JSON.stringify(portableWorkspace, null, 2)}\n`);
  const sourceBytes = files.reduce((total, file) => {
    const stat = fs.statSync(file.absolutePath);
    if (!stat.isFile()) throw backupError("source_missing", `${file.archivePath} 不是可读取文件。`);
    return total + stat.size;
  }, workspaceBuffer.length);
  if (!Number.isFinite(maxSourceBytes) || maxSourceBytes < 1) throw backupError("backup_limit_invalid", "完整备份体积上限配置无效。");
  if (sourceBytes > maxSourceBytes) {
    throw backupError(
      "backup_too_large",
      `完整备份源数据约 ${formatBackupBytes(sourceBytes)}，超过 ${formatBackupBytes(maxSourceBytes)} 的可恢复上限。请先删除不再需要的审阅任务快照。`
    );
  }
  return { files, pathOverrides, portableWorkspace, workspaceBuffer, sourceBytes };
}

async function writeFullBackup(output, { dataDir, workspace, appVersion }, prepared = inspectFullBackup({ dataDir, workspace })) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completion = new Promise((resolve, reject) => {
    output.once("close", resolve);
    output.once("finish", resolve);
    output.once("error", reject);
    archive.once("error", reject);
  });
  archive.pipe(output);

  const { files, workspaceBuffer } = prepared;
  const fileRecords = [fileRecord("workspace.json", workspaceBuffer)];
  for (const file of files) fileRecords.push({ path: file.archivePath, ...(await hashFile(file.absolutePath)) });
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    createdAt: new Date().toISOString(),
    files: fileRecords
  };

  archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "manifest.json" });
  archive.append(workspaceBuffer, { name: "workspace.json" });
  for (const file of files) archive.file(file.absolutePath, { name: file.archivePath });
  await archive.finalize();
  await completion;
}

async function extractBackup(archivePath, stagingDir) {
  let directory;
  try {
    directory = await unzipper.Open.file(archivePath);
  } catch {
    throw backupError("invalid_archive", "The selected file is not a readable backup archive.");
  }
  if (directory.files.length > MAX_ENTRY_COUNT) throw backupError("backup_too_large", "The backup contains too many files.");
  let totalSize = 0;
  let actualSize = 0;
  for (const entry of directory.files) {
    const entryPath = safeArchivePath(entry.path);
    totalSize += Number(entry.uncompressedSize || 0);
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw backupError("backup_too_large", "The backup is too large to restore.");
    if (!allowedArchivePath(entryPath)) throw backupError("invalid_archive_path", `Unexpected backup entry: ${entryPath}`);
    const destination = path.join(stagingDir, ...entryPath.split("/"));
    if (entry.type === "Directory") {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let entryBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        entryBytes += chunk.length;
        actualSize += chunk.length;
        const entryLimit = entryPath === "manifest.json" ? MAX_MANIFEST_BYTES
          : entryPath === "workspace.json" ? MAX_WORKSPACE_BYTES
            : MAX_UNCOMPRESSED_BYTES;
        if (entryBytes > entryLimit || actualSize > MAX_UNCOMPRESSED_BYTES) {
          callback(backupError("backup_too_large", "The backup is too large to restore."));
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(entry.stream(), limiter, fs.createWriteStream(destination, { flags: "wx" }));
  }
}

async function verifyManifest(stagingDir, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw backupError("invalid_manifest", "Backup file list is missing.");
  const expectedPaths = new Set(manifest.files.map((record) => safeArchivePath(record.path)));
  for (const required of ["workspace.json"]) {
    if (!expectedPaths.has(required)) throw backupError("invalid_manifest", `${required} is missing from the backup manifest.`);
  }
  for (const record of manifest.files) {
    const entryPath = safeArchivePath(record.path);
    if (!allowedArchivePath(entryPath) || entryPath === "manifest.json") throw backupError("invalid_manifest", `Invalid manifest path: ${entryPath}`);
    const absolutePath = path.join(stagingDir, ...entryPath.split("/"));
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) throw backupError("missing_backup_file", `${entryPath} is missing.`);
    const actual = await hashFile(absolutePath);
    if (actual.size !== Number(record.size) || actual.sha256 !== record.sha256) {
      throw backupError("backup_checksum_failed", `${entryPath} failed integrity verification.`);
    }
  }
  const actualPaths = new Set(listRelativeFiles(stagingDir).filter((entryPath) => entryPath !== "manifest.json"));
  if (actualPaths.size !== expectedPaths.size || [...actualPaths].some((entryPath) => !expectedPaths.has(entryPath))) {
    throw backupError("unexpected_backup_file", "Backup contains files that are not declared in its manifest.");
  }
}

function makePortableWorkspace(workspace, dataDir, pathOverrides = new Map()) {
  const normalized = workspace?.workspace || workspace || {};
  return {
    schemaVersion: Number(normalized.schemaVersion || 0),
    groups: Array.isArray(normalized.groups) ? normalized.groups : [],
    projects: Array.isArray(normalized.projects) ? normalized.projects : [],
    documents: (Array.isArray(normalized.documents) ? normalized.documents : []).map((document) => {
      const overrides = pathOverrides.get(document.id) || {};
      return {
        ...document,
        sourcePath: overrides.sourcePath ? `data:${overrides.sourcePath}` : portableManagedPath(document.sourcePath, dataDir),
        convertedPdfPath: overrides.convertedPdfPath ? `data:${overrides.convertedPdfPath}` : portableManagedPath(document.convertedPdfPath, dataDir),
        originalPath: "",
        sourceTrackingNeedsRebind: Boolean(document.originalPath && !isInsideDataDirectory(document.originalPath, dataDir))
      };
    }),
    annotations: normalized.annotations && typeof normalized.annotations === "object" ? normalized.annotations : {},
    history: normalized.history && typeof normalized.history === "object" ? normalized.history : {},
    reviewThreads: normalized.reviewThreads && typeof normalized.reviewThreads === "object" ? normalized.reviewThreads : {},
    reviewTasks: normalized.reviewTasks && typeof normalized.reviewTasks === "object"
      ? Object.fromEntries(Object.entries(normalized.reviewTasks).map(([taskId, task]) => [taskId, { ...task, accessToken: "" }]))
      : {},
    annotationRevisions: normalized.annotationRevisions && typeof normalized.annotationRevisions === "object" ? normalized.annotationRevisions : {},
    historyRevisions: normalized.historyRevisions && typeof normalized.historyRevisions === "object" ? normalized.historyRevisions : {},
    exports: Array.isArray(normalized.exports) ? normalized.exports : []
  };
}

function restorePortableWorkspace(workspace, dataDir) {
  return {
    schemaVersion: Number(workspace.schemaVersion || 0),
    groups: Array.isArray(workspace.groups) ? workspace.groups : [],
    projects: workspace.projects,
    documents: workspace.documents.map((document) => ({
      ...document,
      sourcePath: resolvePortablePath(document.sourcePath, dataDir),
      originalPath: "",
      convertedPdfPath: resolvePortablePath(document.convertedPdfPath, dataDir),
      // Rebinding a tracked source is the user's action after restoring, not something a backup
      // file gets to choose.
      workingArtifactPath: sanitizeRestoredLocation(document.workingArtifactPath),
      versions: (document.versions || []).map((version) => ({
        ...version,
        relativePath: assertVersionRelativePath(version.relativePath, document.id)
      }))
    })),
    annotations: workspace.annotations || {},
    history: workspace.history || {},
    reviewThreads: workspace.reviewThreads || {},
    reviewTasks: Object.fromEntries(Object.entries(workspace.reviewTasks || {}).map(([taskId, task]) => [taskId, {
      ...task,
      accessToken: "",
      // allowedPaths is what an agent is told it may edit; a restored file must not be able to
      // nominate arbitrary locations on this machine.
      projectRootPath: sanitizeRestoredLocation(task.projectRootPath),
      allowedPaths: [],
      documents: (task.documents || []).map((document) => ({
        ...document,
        workingArtifactPath: sanitizeRestoredLocation(document.workingArtifactPath)
      }))
    }])),
    annotationRevisions: workspace.annotationRevisions || {},
    historyRevisions: workspace.historyRevisions || {},
    exports: Array.isArray(workspace.exports) ? workspace.exports : []
  };
}

function assertVersionRelativePath(relativePath, documentId) {
  const relative = safeArchivePath(String(relativePath || ""));
  if (!relative.startsWith(`versions/${documentId}/`)) {
    throw backupError("invalid_workspace", "备份中的历史版本路径无效。");
  }
  return relative;
}

function validateWorkspaceAssets(workspace, stagingDir, dataDir) {
  for (const document of workspace.documents) {
    for (const [label, filePath] of [["source", document.sourcePath], ["converted PDF", document.convertedPdfPath]]) {
      if (!filePath || !isInsideDataDirectory(filePath, dataDir)) continue;
      const relative = path.relative(dataDir, filePath);
      const stagedPath = path.join(stagingDir, relative);
      if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) {
        throw backupError("missing_backup_asset", `${document.name || document.id} ${label} is missing from the backup.`);
      }
    }
    for (const version of document.versions || []) {
      const relative = safeArchivePath(version.relativePath || "");
      const expectedPrefix = `versions/${document.id}/`;
      if (!relative.startsWith(expectedPrefix)) throw backupError("invalid_workspace", `Document ${document.id} has an invalid version path.`);
      const stagedPath = path.join(stagingDir, ...relative.split("/"));
      if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) {
        throw backupError("missing_backup_asset", `${document.name || document.id} 的版本 ${version.id || ""} 缺少源文件。`);
      }
    }
  }
  for (const task of Object.values(workspace.reviewTasks || {})) {
    for (const document of task.documents || []) {
      if (!document.snapshotRelativePath) continue;
      const stagedPath = path.join(stagingDir, ...safeArchivePath(document.snapshotRelativePath).split("/"));
      if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) {
        throw backupError("missing_backup_asset", `${task.id} 缺少文档快照 ${document.name || document.id}。`);
      }
    }
  }
}

export function validateWorkspace(workspace) {
  if (!workspace || !Array.isArray(workspace.projects) || !Array.isArray(workspace.documents)) {
    throw backupError("invalid_workspace", "Workspace projects or documents are missing.");
  }
  if (workspace.projects.length === 0) throw backupError("empty_workspace", "The backup contains no projects.");
  for (const [label, value] of [
    ["annotations", workspace.annotations],
    ["history", workspace.history],
    ["reviewThreads", workspace.reviewThreads || {}],
    ["reviewTasks", workspace.reviewTasks || {}],
    ["annotationRevisions", workspace.annotationRevisions || {}],
    ["historyRevisions", workspace.historyRevisions || {}]
  ]) {
    if (!isRecord(value)) throw backupError("invalid_workspace", `${label} data is invalid.`);
  }
  if (workspace.exports !== undefined && !Array.isArray(workspace.exports)) throw backupError("invalid_workspace", "Export history is invalid.");
  // Groups are optional: an archive written before they existed restores as a flat sidebar rather
  // than as a failure.
  if (workspace.groups !== undefined && !Array.isArray(workspace.groups)) throw backupError("invalid_workspace", "Group data is invalid.");
  const groupIds = workspace.groups === undefined ? new Set() : uniqueIds(workspace.groups, "group");
  const projectIds = uniqueIds(workspace.projects, "project");
  const documentIds = uniqueIds(workspace.documents, "document");
  for (const project of workspace.projects) {
    if (project.groupId && !groupIds.has(project.groupId)) {
      throw backupError("invalid_workspace", `Project ${project.id} names a group that is not in the archive.`);
    }
    if (project.parentId && !projectIds.has(project.parentId)) {
      throw backupError("invalid_workspace", `Project ${project.id} names a parent that is not in the archive.`);
    }
  }
  for (const document of workspace.documents) {
    if (!projectIds.has(document.projectId)) throw backupError("invalid_workspace", `Document ${document.id} has no project.`);
    if (!Number.isInteger(Number(document.pageCount)) || Number(document.pageCount) < 1) throw backupError("invalid_workspace", `Document ${document.id} has an invalid page count.`);
    if (document.versions !== undefined) {
      if (!Array.isArray(document.versions) || document.versions.length > 5) throw backupError("invalid_workspace", `Document ${document.id} has invalid versions.`);
      for (const version of document.versions) {
        const relative = safeArchivePath(version?.relativePath || "");
        if (!version?.id || !relative.startsWith(`versions/${document.id}/`)) throw backupError("invalid_workspace", `Document ${document.id} has an invalid version.`);
      }
    }
  }
  for (const project of workspace.projects) {
    if (!Array.isArray(project.docIds)) throw backupError("invalid_workspace", `Project ${project.id} has an invalid document list.`);
    if (project.docIds.some((id) => !documentIds.has(id))) throw backupError("invalid_workspace", `Project ${project.id} references a missing document.`);
  }
  for (const [key, list] of Object.entries(workspace.annotations)) {
    validatePageRecord(key, list, documentIds, workspace.documents, "annotations");
    if (!validAnnotationList(list)) throw backupError("invalid_workspace", `Invalid annotation data: ${key}`);
  }
  for (const [key, list] of Object.entries(workspace.history)) {
    validatePageRecord(key, list, documentIds, workspace.documents, "history");
    if (!validHistoryList(list)) throw backupError("invalid_workspace", `Invalid history data: ${key}`);
  }
  const annotationIds = new Set(Object.values(workspace.annotations).flatMap((list) => list.map((annotation) => annotation.id)));
  for (const [annotationId, thread] of Object.entries(workspace.reviewThreads || {})) {
    if (annotationId !== thread?.annotationId || !annotationIds.has(annotationId) || !documentIds.has(thread?.documentId) || !validReviewThread(thread)) {
      throw backupError("invalid_workspace", `Invalid review thread: ${annotationId}`);
    }
  }
  for (const [taskId, task] of Object.entries(workspace.reviewTasks || {})) {
    if (taskId !== task?.id || !validReviewTask(task)) throw backupError("invalid_workspace", `Invalid review task: ${taskId}`);
  }
  validateRevisionMap(workspace.annotationRevisions || {}, documentIds, workspace.documents, "annotation revisions");
  validateRevisionMap(workspace.historyRevisions || {}, documentIds, workspace.documents, "history revisions");
  return workspace;
}

function validateRevisionMap(revisions, documentIds, documents, label) {
  for (const [key, revision] of Object.entries(revisions)) {
    validatePageRecord(key, [], documentIds, documents, label);
    if (!Number.isFinite(Number(revision)) || Number(revision) < 0) throw backupError("invalid_workspace", `Invalid ${label}: ${key}`);
  }
}

function validatePageRecord(key, list, documentIds, documents, label) {
  const separator = key.lastIndexOf(":");
  const documentId = key.slice(0, separator);
  const page = Number(key.slice(separator + 1));
  const document = documents.find((item) => item.id === documentId);
  if (separator < 1 || !documentIds.has(documentId) || !Number.isInteger(page) || page < 1 || page > Number(document.pageCount) || !Array.isArray(list)) {
    throw backupError("invalid_workspace", `Invalid ${label} record: ${key}`);
  }
}

function collectAssetFiles(dataDir, workspace) {
  const filesByPath = new Map();
  const pathOverrides = new Map();
  for (const directory of ["uploads", "renders", "review-tasks", "versions"]) {
    const root = path.join(dataDir, directory);
    walkFiles(root, (absolutePath) => {
      const archivePath = path.relative(dataDir, absolutePath).split(path.sep).join("/");
      filesByPath.set(archivePath, { absolutePath, archivePath });
    });
  }

  for (const document of workspace?.documents || []) {
    const overrides = {};
    if (document.sourcePath && !isInsideDataDirectory(document.sourcePath, dataDir)) {
      if (!fs.existsSync(document.sourcePath) || !fs.statSync(document.sourcePath).isFile()) {
        throw backupError("source_missing", `${document.name || document.id} has no readable source file.`);
      }
      const extension = path.extname(document.sourcePath) || `.${String(document.ext || "file").toLowerCase()}`;
      const archivePath = `uploads/${document.id}${extension}`;
      filesByPath.set(archivePath, { absolutePath: document.sourcePath, archivePath });
      overrides.sourcePath = archivePath;
    }
    if (document.convertedPdfPath && !isInsideDataDirectory(document.convertedPdfPath, dataDir)) {
      if (!fs.existsSync(document.convertedPdfPath) || !fs.statSync(document.convertedPdfPath).isFile()) {
        throw backupError("converted_pdf_missing", `${document.name || document.id} has no readable converted PDF.`);
      }
      const archivePath = `renders/${document.id}/converted/${path.basename(document.convertedPdfPath)}`;
      filesByPath.set(archivePath, { absolutePath: document.convertedPdfPath, archivePath });
      overrides.convertedPdfPath = archivePath;
    }
    if (Object.keys(overrides).length > 0) pathOverrides.set(document.id, overrides);
  }

  return {
    files: [...filesByPath.values()].sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
    pathOverrides
  };
}

function walkFiles(directory, visit) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(absolutePath, visit);
    else if (entry.isFile()) visit(absolutePath);
  }
}

function listRelativeFiles(root) {
  const files = [];
  walkFiles(root, (absolutePath) => files.push(path.relative(root, absolutePath).split(path.sep).join("/")));
  return files;
}

function pruneAutomaticBackups(backupsDir) {
  if (!fs.existsSync(backupsDir)) return;
  const backups = fs.readdirSync(backupsDir)
    .filter((name) => name.startsWith("pre-restore-") && name.endsWith(".reviewbackup"))
    .map((name) => {
      const filePath = path.join(backupsDir, name);
      return { filePath, mtime: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const backup of backups.slice(PRE_RESTORE_BACKUP_RETENTION)) fs.rmSync(backup.filePath, { force: true });
}

function fileRecord(entryPath, buffer) {
  return { path: entryPath, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

function portableManagedPath(filePath, dataDir) {
  if (!isInsideDataDirectory(filePath, dataDir)) return filePath || "";
  return `data:${path.relative(dataDir, path.resolve(filePath)).split(path.sep).join("/")}`;
}

function resolvePortablePath(filePath, dataDir) {
  const value = String(filePath || "");
  if (!value) return "";
  if (!value.startsWith("data:")) {
    throw backupError("invalid_workspace", "备份中的文件路径必须是备份自带的资源，不能指向本机的其他位置。");
  }
  const relative = safeArchivePath(value.slice(5));
  if (!relative.startsWith("uploads/") && !relative.startsWith("renders/")) throw backupError("invalid_workspace", "Managed asset path is invalid.");
  return path.join(dataDir, ...relative.split("/"));
}

// Paths that are metadata rather than managed assets: they must stay inert strings, never something
// the app will open, copy, or hand to an agent as an editable location.
function sanitizeRestoredLocation(value) {
  return "";
}

function isInsideDataDirectory(filePath, dataDir) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const root = path.resolve(dataDir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function safeArchivePath(value) {
  const raw = String(value || "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) throw backupError("invalid_archive_path", "Backup contains an absolute path.");
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) throw backupError("invalid_archive_path", "Backup contains a parent path.");
  return normalized.replace(/^\.\//, "");
}

function allowedArchivePath(entryPath) {
  return entryPath === "manifest.json" || entryPath === "workspace.json" ||
    entryPath === "uploads" || entryPath.startsWith("uploads/") ||
    entryPath === "renders" || entryPath.startsWith("renders/") ||
    entryPath === "review-tasks" || entryPath.startsWith("review-tasks/") ||
    entryPath === "versions" || entryPath.startsWith("versions/");
}

function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) throw backupError("invalid_workspace", `Invalid or duplicate ${label} id.`);
    ids.add(item.id);
  }
  return ids;
}

function readJsonRequired(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw backupError(code, `Unable to read ${path.basename(filePath)}.`);
  }
}

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatBackupBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function contentDisposition(fileName) {
  const encoded = encodeURIComponent(fileName).replaceAll("'", "%27");
  return `attachment; filename="review-annotation-backup.reviewbackup"; filename*=UTF-8''${encoded}`;
}
