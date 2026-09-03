import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-annotation-sse-test-"));
process.env.REVIEW_APP_DATA = tempDir;
const { startServer } = await import("../server/index.js");
const server = startServer(0);
const port = await new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const fixturePath = path.join(tempDir, "fixture.jpg");
  fs.writeFileSync(fixturePath, tinyJpeg());
  await postJson("/api/projects", { id: "p-sse", name: "事件重放测试" });
  const document = (await postJson("/api/documents/import-path", { path: fixturePath, projectId: "p-sse" })).document;

  const firstConnection = openEventStream();
  await firstConnection.ready;
  await putAnnotations(document.id, "a-first", "第一次修改");
  const firstEvent = await firstConnection.next((event) => event.type === "annotations.updated");
  assert.ok(firstEvent.id > 0);
  firstConnection.close();

  await putAnnotations(document.id, "a-second", "离线期间修改");
  const replay = openEventStream(firstEvent.id);
  await replay.ready;
  const replayedEvent = await replay.next((event) => event.type === "annotations.updated" && event.data.annotations?.[0]?.id === "a-second");
  assert.ok(replayedEvent.id > firstEvent.id);
  replay.close();
  console.log("sse-replay.test.mjs passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function openEventStream(lastEventId = 0) {
  const controller = new AbortController();
  let reader;
  let buffer = "";
  const queue = [];
  let notify = null;
  const ready = fetch(`${baseUrl}/api/events`, {
    headers: lastEventId ? { "Last-Event-ID": String(lastEventId) } : undefined,
    signal: controller.signal
  }).then((response) => {
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    pump();
  });

  async function pump() {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        buffer += Buffer.from(result.value).toString("utf8");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseEvent(block);
          if (event) queue.push(event);
        }
        notify?.();
      }
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }

  return {
    ready,
    async next(predicate) {
      await ready;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = queue.findIndex(predicate);
        if (index >= 0) return queue.splice(index, 1)[0];
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50);
          notify = () => {
            clearTimeout(timer);
            notify = null;
            resolve();
          };
        });
      }
      throw new Error("Timed out waiting for SSE event");
    },
    close() {
      controller.abort();
    }
  };
}

function parseEvent(block) {
  const lines = block.split("\n");
  const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const id = Number(lines.find((line) => line.startsWith("id:"))?.slice(3).trim() || 0);
  const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!type || !dataText) return null;
  return { id, type, data: JSON.parse(dataText) };
}

async function putAnnotations(documentId, annotationId, text) {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/pages/1/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annotations: [{ id: annotationId, type: "pin", x: 30, y: 40, text, createdAt: Date.now() }],
      updatedAt: Date.now()
    })
  });
  assert.equal(response.ok, true, await response.text());
}

async function postJson(url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
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
