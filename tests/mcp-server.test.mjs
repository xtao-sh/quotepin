import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpServerEntry = path.resolve(process.env.REVIEW_MCP_SERVER_ENTRY || path.join(rootDir, "mcp/review-annotation-server.mjs"));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-mcp-test-"));
process.env.REVIEW_APP_DATA = tempDir;

const { startServer } = await import("../server/index.js");
const apiServer = startServer(0);
const port = await new Promise((resolve) => apiServer.on("listening", () => resolve(apiServer.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;
let taskClient;
let documentClient;
let wrongWorkspaceClient;

try {
  const integration = await request("/api/integrations/ai");
  assert.equal(integration.mcp.serverName, "review-annotation");
  assert.equal(integration.mcp.available, true);
  assert.equal(fs.existsSync(integration.mcp.entryPath), true);
  assert.equal(integration.mcp.apiUrl, baseUrl);
  assert.equal(integration.mcp.jsonConfig.mcpServers["review-annotation"].env.REVIEW_API_URL, baseUrl);
  assert.match(integration.mcp.codexCommand, /codex mcp add/);
  assert.match(integration.mcp.claudeCommand, /claude mcp add/);

  const fixturePath = path.join(tempDir, "page.jpg");
  const secondFixturePath = path.join(tempDir, "page-second.jpg");
  fs.writeFileSync(fixturePath, tinyJpeg());
  fs.writeFileSync(secondFixturePath, Buffer.concat([tinyJpeg(), Buffer.from([0])]));
  await request("/api/projects", "POST", { id: "p-mcp", name: "MCP 批注测试" });
  const imported = await request("/api/documents/import-path", "POST", { path: fixturePath, projectId: "p-mcp" });
  const secondImported = await request("/api/documents/import-path", "POST", { path: secondFixturePath, projectId: "p-mcp" });
  const documentId = imported.document.id;
  const secondDocumentId = secondImported.document.id;
  const annotation = {
    id: "a-mcp",
    type: "pin",
    x: 24,
    y: 31,
    text: "请说明这里具体做了什么修改。",
    tag: "question",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const secondAnnotation = {
    ...annotation,
    id: "a-mcp-other",
    text: "这是另一个文档的批注，不应被当前 AI 看到。"
  };
  await request(`/api/documents/${documentId}/pages/1/annotations`, "PUT", { annotations: [annotation] });
  await request(`/api/documents/${secondDocumentId}/pages/1/annotations`, "PUT", { annotations: [secondAnnotation] });
  const isolatedTask = (await request("/api/review/tasks", "POST", { scope: "document", documentId })).task;
  const otherTask = (await request("/api/review/tasks", "POST", { scope: "document", documentId: secondDocumentId })).task;
  const scopedIntegration = await request(`/api/integrations/ai?taskId=${encodeURIComponent(isolatedTask.id)}`);
  const scopedEnv = scopedIntegration.mcp.jsonConfig.mcpServers[scopedIntegration.mcp.serverName].env;
  assert.equal(scopedIntegration.mcp.taskScoped, true);
  assert.equal(scopedIntegration.mcp.taskId, isolatedTask.id);
  assert.equal(scopedEnv.REVIEW_TASK_ID, isolatedTask.id);
  assert.match(scopedEnv.REVIEW_TASK_TOKEN, /^[a-f0-9]{64}$/);

  taskClient = new Client({ name: "review-annotation-task-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerEntry],
    cwd: rootDir,
    env: { ...process.env, REVIEW_API_URL: baseUrl, REVIEW_TASK_ID: scopedEnv.REVIEW_TASK_ID, REVIEW_TASK_TOKEN: scopedEnv.REVIEW_TASK_TOKEN },
    stderr: "pipe"
  });
  await taskClient.connect(transport);

  const wrongWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-mcp-wrong-workspace-"));
  wrongWorkspaceClient = new Client({ name: "review-annotation-wrong-workspace-test", version: "1.0.0" });
  await wrongWorkspaceClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerEntry],
    cwd: rootDir,
    env: {
      ...process.env,
      REVIEW_API_URL: baseUrl,
      REVIEW_APP_DATA: wrongWorkspaceDir,
      REVIEW_TASK_ID: scopedEnv.REVIEW_TASK_ID,
      REVIEW_TASK_TOKEN: scopedEnv.REVIEW_TASK_TOKEN
    },
    stderr: "pipe"
  }));
  const wrongWorkspaceResult = await wrongWorkspaceClient.callTool({ name: "list_review_tasks", arguments: {} });
  assert.equal(wrongWorkspaceResult.isError, true);
  assert.equal(JSON.parse(wrongWorkspaceResult.content[0].text).error, "review_workspace_mismatch");
  await wrongWorkspaceClient.close();
  wrongWorkspaceClient = null;
  fs.rmSync(wrongWorkspaceDir, { recursive: true, force: true });

  const taskTools = await taskClient.listTools();
  assert.deepEqual(
    taskTools.tools.map((item) => item.name).sort(),
    [
      "get_review_task",
      "get_review_task_checklist",
      "get_task_review_item",
      "list_review_tasks",
      "list_task_review_items",
      "reply_to_task_review_item",
      "update_task_review_item_status"
    ].sort()
  );

  documentClient = new Client({ name: "review-annotation-document-test", version: "1.0.0" });
  await documentClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerEntry],
    cwd: rootDir,
    env: { ...process.env, REVIEW_API_URL: baseUrl },
    stderr: "pipe"
  }));
  const documentTools = await documentClient.listTools();
  assert.deepEqual(
    documentTools.tools.map((item) => item.name).sort(),
    [
      "create_review_thread",
      "get_review_page_text",
      "get_review_thread",
      "list_review_documents",
      "list_review_threads",
      "reply_to_review_thread",
      "update_review_thread_status"
    ].sort()
  );

  const unsetScope = await callError(documentClient, "list_review_threads", { actionableOnly: true });
  assert.equal(unsetScope.error, "review_scope_unset");
  const activeContext = await request("/api/review/context", "PUT", { documentId });
  assert.equal(activeContext.context.documentId, documentId);

  const documents = await call(documentClient, "list_review_documents", {});
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, documentId);
  assert.equal(documents[0].activeReviewScope, true);

  const listed = await call(documentClient, "list_review_threads", { actionableOnly: true });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, annotation.id);
  assert.equal(listed[0].status, "open");

  const crossDocumentList = await callError(documentClient, "list_review_threads", { documentId: secondDocumentId, actionableOnly: true });
  assert.equal(crossDocumentList.error, "review_scope_denied");
  const crossDocumentThread = await callError(documentClient, "get_review_thread", { threadId: secondAnnotation.id });
  assert.equal(crossDocumentThread.error, "review_scope_denied");
  const crossDocumentCreate = await callError(documentClient, "create_review_thread", {
    documentId: secondDocumentId,
    page: 1,
    comment: "不应跨文档创建的问题。",
    annotationType: "note"
  });
  assert.equal(crossDocumentCreate.error, "review_scope_denied");

  await request("/api/review/context", "PUT", { documentId: secondDocumentId });
  const secondListed = await call(documentClient, "list_review_threads", { actionableOnly: true });
  assert.equal(secondListed.length, 1);
  assert.equal(secondListed[0].id, secondAnnotation.id);
  await request("/api/review/context", "PUT", { documentId });

  const inProgress = await call(documentClient, "update_review_thread_status", {
    threadId: annotation.id,
    status: "in_progress",
    expectedRevision: listed[0].revision
  });
  assert.equal(inProgress.status, "in_progress");

  const replied = await call(documentClient, "reply_to_review_thread", {
    threadId: annotation.id,
    body: "已补充定义，并在对应段落解释识别条件。",
    author: "Codex",
    status: "addressed",
    expectedRevision: inProgress.revision,
    change: {
      summary: "补充识别条件的定义和解释",
      file: "paper.tex",
      section: "Identification"
    }
  });
  assert.equal(replied.status, "addressed");
  assert.equal(replied.messages.length, 1);
  assert.equal(replied.messages[0].change.file, "paper.tex");

  const created = await call(documentClient, "create_review_thread", {
    documentId,
    page: 1,
    comment: "AI 发现这一页还缺少数据来源说明。",
    annotationType: "note",
    status: "needs_human"
  });
  assert.equal(created.createdBy, "assistant");
  assert.equal(created.status, "needs_human");

  await request("/api/review/context", "PUT", { documentId: secondDocumentId });
  const tasks = await call(taskClient, "list_review_tasks", { documentId });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, isolatedTask.id);
  const frozenTask = await call(taskClient, "get_review_task", { taskId: isolatedTask.id });
  assert.equal(frozenTask.documentIds[0], documentId);
  assert.equal(frozenTask.items[0].sourceThreadId, annotation.id);
  const crossTask = await callError(taskClient, "get_review_task", { taskId: otherTask.id });
  assert.equal(crossTask.error, "review_task_scope_denied");
  const taskItems = await call(taskClient, "list_task_review_items", { taskId: isolatedTask.id, actionableOnly: true });
  assert.equal(taskItems.length, 1);
  const taskInProgress = await call(taskClient, "update_task_review_item_status", {
    taskId: isolatedTask.id,
    itemId: taskItems[0].id,
    status: "in_progress",
    expectedRevision: taskItems[0].revision
  });
  assert.equal(taskInProgress.status, "in_progress");
  const taskReply = await call(taskClient, "reply_to_task_review_item", {
    taskId: isolatedTask.id,
    itemId: taskItems[0].id,
    body: "该任务仍然只处理第一篇文档。",
    status: "addressed",
    expectedRevision: taskInProgress.revision,
    change: { summary: "按隔离任务继续修改", file: "paper.tex" }
  });
  assert.equal(taskReply.status, "addressed");
  assert.equal(taskReply.documentId, documentId);
  const checklist = await call(taskClient, "get_review_task_checklist", { taskId: isolatedTask.id });
  assert.match(checklist.markdown, /该任务仍然只处理第一篇文档/);

  const workspace = await request("/api/workspace");
  assert.equal(workspace.reviewThreads[annotation.id].messages[0].role, "assistant");
  assert.equal(workspace.reviewThreads[created.id].status, "needs_human");

  console.log("mcp-server.test.mjs passed");
} finally {
  await wrongWorkspaceClient?.close().catch(() => undefined);
  await documentClient?.close().catch(() => undefined);
  await taskClient?.close().catch(() => undefined);
  await new Promise((resolve) => apiServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function call(targetClient, name, args) {
  const result = await targetClient.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text || `${name} failed`);
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

async function callError(targetClient, name, args) {
  const result = await targetClient.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should have been denied`);
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

async function request(url, method = "GET", body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVEAEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAAB9A//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64"
  );
}
