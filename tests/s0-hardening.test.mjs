import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-s0-test-"));
process.env.REVIEW_APP_DATA = tempDir;
process.env.REVIEW_API_TOKEN = "b".repeat(64);
const authHeaders = { "X-Review-Api-Token": process.env.REVIEW_API_TOKEN };

const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => {
  server.on("listening", () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixtureDir = path.join(tempDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });

  await postJson(`${baseUrl}/api/projects`, { id: "p-s0", name: "S0 加固", path: fixtureDir });

  // Content-Security-Policy: the app speaks SSE, never WebSocket, and no form may navigate.
  const health = await fetch(`${baseUrl}/api/health`);
  const csp = health.headers.get("content-security-policy");
  assert.ok(csp, "缺少 Content-Security-Policy 响应头");
  assert.equal(/\bws:/.test(csp), false, `connect-src 仍然放行 ws:：${csp}`);
  assert.match(csp, /connect-src 'self';/);
  assert.match(csp, /form-action 'none';/);

  // A multi-byte capability arrives percent-encoded on ?cap= and must be refused cleanly:
  // comparing JS string length instead of byte length made timingSafeEqual throw a RangeError.
  const multiByteCap = await fetch(`${baseUrl}/?cap=${encodeURIComponent("口".repeat(64))}`, { redirect: "manual" });
  assert.equal(multiByteCap.status, 403, `多字节 cap 返回了 ${multiByteCap.status}`);
  assert.match(await multiByteCap.text(), /Invalid local app capability/);

  // The genuine capability still bootstraps a cookie.
  const bootstrap = await fetch(`${baseUrl}/?cap=${process.env.REVIEW_API_TOKEN}`, { redirect: "manual" });
  assert.equal(bootstrap.status, 302);

  // Malformed JSON reaches the terminal error handler as JSON, not an HTML stack trace.
  const malformed = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: "{ not json"
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("content-type") || "", /application\/json/);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.ok, false);
  assert.equal(malformedBody.error, "invalid_request");

  // A text document exposes its stored page text through the shared text-layer path,
  // so MCP page text and review-thread creation work for non-PDF documents.
  const textPath = path.join(fixtureDir, "笔记.txt");
  fs.writeFileSync(textPath, "第一页的正文内容，用于验证文字层回退。", "utf8");
  const textImport = await postJson(`${baseUrl}/api/documents/import-path`, { path: textPath, projectId: "p-s0" });
  const textDocument = textImport.document;
  assert.equal(textDocument.renderMode, "text");
  const textLayer = await getJson(`${baseUrl}/api/documents/${textDocument.id}/pages/1/text`);
  assert.match(textLayer.text, /第一页的正文内容/);

  // Multipart filenames are decoded as UTF-8 rather than latin1.
  const form = new FormData();
  form.append("projectId", "p-s0");
  form.append("file", new Blob(["上传内容"], { type: "text/plain" }), "中文文件名.txt");
  const uploadResponse = await fetch(`${baseUrl}/api/documents/upload`, { method: "POST", headers: authHeaders, body: form });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.ok, true, JSON.stringify(uploaded));
  assert.match(uploaded.document.name, /中文文件名/);

  // An annotation that disappears from a page save must not take its review conversation with it.
  const uploadedId = uploaded.document.id;
  const thread = await postJson(`${baseUrl}/api/review/threads`, {
    documentId: uploadedId,
    page: 1,
    comment: "AI 提出的意见，必须可恢复。",
    annotation: { id: "ai-archive-me", type: "note", text: "AI 提出的意见，必须可恢复。" }
  });
  assert.equal(thread.thread.id, "ai-archive-me");
  await postJson(`${baseUrl}/api/review/threads/ai-archive-me/messages`, {
    role: "human",
    body: "用户的回复，也必须可恢复。"
  });

  // Closing a review item belongs to the user. The assistant is refused on every write path it has.
  const assistantCloseAttempts = [
    ["POST", `/api/review/threads/ai-archive-me/messages`, { role: "assistant", body: "我改完了。", status: "resolved" }],
    ["POST", `/api/review/threads/ai-archive-me/messages`, { role: "assistant", body: "这条不成立。", status: "rejected" }],
    ["PATCH", `/api/review/threads/ai-archive-me`, { status: "resolved" }],
    ["PATCH", `/api/review/threads/ai-archive-me`, { status: "rejected" }]
  ];
  for (const [method, endpoint, payload] of assistantCloseAttempts) {
    const refused = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(refused.status, 403, `${method} ${endpoint} ${payload.status} 返回了 ${refused.status}`);
    assert.equal((await refused.json()).error, "status_requires_human");
  }

  // Omitting the role must not be a way around the guard: both message routes used to default the
  // role to "human", so the identical refused call succeeded with the field simply dropped.
  const roleOmitted = await fetch(`${baseUrl}/api/review/threads/ai-archive-me/messages`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ body: "不声明角色就想关闭。", status: "resolved" })
  });
  assert.equal(roleOmitted.status, 403, `省略 role 时返回了 ${roleOmitted.status}`);
  assert.equal((await roleOmitted.json()).error, "status_requires_human");

  // A task-scoped capability proves the caller is an isolated agent, so declaring role "human"
  // must not help it. This half of the guard is bound to the credential, not to a body field.
  const task = (await postJson(`${baseUrl}/api/review/tasks`, { scope: "document", documentId: uploadedId })).task;
  const taskIntegration = await getJson(`${baseUrl}/api/integrations/ai?taskId=${encodeURIComponent(task.id)}`);
  const taskToken = taskIntegration.mcp.jsonConfig.mcpServers[taskIntegration.mcp.serverName].env.REVIEW_TASK_TOKEN;
  const taskHeaders = { "X-Review-Task-Id": task.id, "X-Review-Task-Token": taskToken, "Content-Type": "application/json" };
  const taskItemId = task.items[0].id;

  for (const payload of [{ status: "resolved" }, { status: "resolved", role: "human" }, { status: "rejected", role: "human" }]) {
    const refused = await fetch(`${baseUrl}/api/review/tasks/${task.id}/items/${taskItemId}`, {
      method: "PATCH",
      headers: taskHeaders,
      body: JSON.stringify(payload)
    });
    assert.equal(refused.status, 403, `任务令牌 + ${JSON.stringify(payload)} 返回了 ${refused.status}`);
    assert.equal((await refused.json()).error, "status_requires_human");
  }

  // The isolated agent can still do its actual job.
  const taskProgress = await fetch(`${baseUrl}/api/review/tasks/${task.id}/items/${taskItemId}`, {
    method: "PATCH",
    headers: taskHeaders,
    body: JSON.stringify({ status: "addressed" })
  });
  assert.equal(taskProgress.ok, true, await taskProgress.clone().text());

  // A thread cannot be created already closed, and an isolated agent cannot end its own task.
  const bornClosed = await postJson(`${baseUrl}/api/review/threads`, {
    documentId: uploadedId,
    page: 1,
    comment: "生来就已解决？",
    annotation: { id: "ai-born-closed", type: "note", text: "生来就已解决？" },
    status: "resolved"
  });
  assert.equal(bornClosed.thread.status, "needs_human", "线程被允许以已解决状态创建");

  const selfComplete = await fetch(`${baseUrl}/api/review/tasks/${task.id}`, {
    method: "PATCH",
    headers: taskHeaders,
    body: JSON.stringify({ status: "completed" })
  });
  assert.equal(selfComplete.status, 403, `任务令牌自标 completed 返回了 ${selfComplete.status}`);

  // The assistant may still report progress.
  await postJson(`${baseUrl}/api/review/threads/ai-archive-me/messages`, {
    role: "assistant",
    body: "已按意见修改，等待确认。",
    status: "addressed"
  });

  // And the user's own paths still close it: the reply route with an explicit human role,
  // and the state route the app itself uses.
  const humanState = await fetch(`${baseUrl}/api/review/threads/ai-archive-me/state`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolved", tag: "resolved" })
  });
  assert.equal(humanState.ok, true, await humanState.clone().text());
  assert.equal((await humanState.json()).thread.status, "resolved");

  // Closing the live thread must carry through to the task item cut from it. Without this, taking
  // "resolved" away from the agent would leave a task that can never reach "completed".
  const closedTask = (await getJson(`${baseUrl}/api/review/tasks/${task.id}`)).task;
  assert.equal(closedTask.items[0].status, "resolved", "用户关闭线程后，任务项没有跟随");
  assert.equal(closedTask.status, "completed", `任务状态是 ${closedTask.status}，应为 completed`);

  // Simulate an undo / "keep local" overwrite: the same page saved without that annotation.
  const overwrite = await fetch(`${baseUrl}/api/documents/${uploadedId}/pages/1/annotations`, {
    method: "PUT",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ annotations: [], updatedAt: Date.now() + 5000 })
  });
  assert.equal(overwrite.ok, true, await overwrite.clone().text());

  const afterOverwrite = await getJson(`${baseUrl}/api/workspace`);
  assert.equal(afterOverwrite.reviewThreads["ai-archive-me"], undefined, "线程应已从活动集合中移除");
  const archivedPage = afterOverwrite.history[`${uploadedId}:1`] || [];
  const archivedRecord = archivedPage.find((record) => record.archivedAnnotation?.id === "ai-archive-me");
  assert.ok(archivedRecord, "被覆盖的批注没有写入页面历史");
  assert.ok(archivedRecord.archivedThread, "归档记录里缺少 archivedThread，会话已经丢失");
  assert.equal(
    archivedRecord.archivedThread.messages.some((message) => /用户的回复/.test(message.body || "")),
    true,
    "归档的会话没有保留全部消息"
  );

  // The archive must survive the client's own history flush, which is a full-array replace of a
  // record set the client never saw. It must also not 409 that flush by moving the history revision.
  const clientHistory = [{ id: "h-client", action: "snapshot", label: "客户端快照", ts: Date.now() }];
  const historyPut = await fetch(`${baseUrl}/api/documents/${uploadedId}/pages/1/history`, {
    method: "PUT",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ history: clientHistory, updatedAt: Date.now() })
  });
  assert.equal(historyPut.status, 200, `历史保存返回了 ${historyPut.status}，归档不应制造 409`);

  const afterHistory = await getJson(`${baseUrl}/api/workspace`);
  const finalPage = afterHistory.history[`${uploadedId}:1`] || [];
  assert.equal(
    finalPage.some((record) => record.id === "h-client"),
    true,
    "客户端自己的历史记录丢失了"
  );
  const survivor = finalPage.find((record) => record.archivedAnnotation?.id === "ai-archive-me");
  assert.ok(survivor, "客户端的历史保存把归档记录覆盖掉了");
  assert.ok(survivor.archivedThread, "归档记录还在，但会话被剥掉了");

  // An out-of-range page is rejected instead of silently clamped onto page 1.
  const outOfRange = await fetch(`${baseUrl}/api/documents/${textDocument.id}/pages/9999/annotations`, { method: "DELETE", headers: authHeaders });
  assert.equal(outOfRange.status, 400);
  assert.equal((await outOfRange.json()).error, "invalid_page");
  const zeroPage = await fetch(`${baseUrl}/api/documents/${textDocument.id}/pages/0/annotations`, { method: "DELETE", headers: authHeaders });
  assert.equal(zeroPage.status, 400);

  // Deleting a document reclaims its retained version copies.
  const versionDir = path.join(tempDir, "versions", textDocument.id);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, "v1.bin"), "旧版本副本");
  assert.equal(fs.existsSync(versionDir), true);

  const deleted = await fetch(`${baseUrl}/api/documents/${textDocument.id}`, { method: "DELETE", headers: authHeaders });
  assert.equal(deleted.ok, true, await deleted.clone().text());
  assert.equal(fs.existsSync(versionDir), false, "删除文档后 versions/<id> 仍然存在");

  // A desktop app launched from Finder inherits no shell environment, so PYTHON= cannot reach it and
  // a packaged bundle has no .venv inside. runtime.json is the way to name an interpreter.
  const runtimeConfigPath = path.join(tempDir, "runtime.json");
  fs.writeFileSync(runtimeConfigPath, JSON.stringify({ python: process.execPath }));
  const { configuredRuntimePathForTest } = await import("../server/index.js");
  if (typeof configuredRuntimePathForTest === "function") {
    assert.equal(configuredRuntimePathForTest("python"), process.execPath);
    fs.writeFileSync(runtimeConfigPath, JSON.stringify({ python: "/nonexistent/python3" }));
    assert.equal(configuredRuntimePathForTest("python"), "", "配置了不存在的路径时不应采用");
    fs.writeFileSync(runtimeConfigPath, "{ 坏掉的 json");
    assert.equal(configuredRuntimePathForTest("python"), "", "配置文件损坏时不应抛出");
  }
  fs.rmSync(runtimeConfigPath, { force: true });

  console.log("s0-hardening.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url, { headers: authHeaders });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}
