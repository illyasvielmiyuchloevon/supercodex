import { test } from "node:test";
import assert from "node:assert/strict";
import { TuiMessageProjection, messagesToTranscriptLines } from "../src/opentui/message-projection.js";

test("message projection builds user, assistant, command, file, and error messages", () => {
  const projection = new TuiMessageProjection();

  projection.consumeEvent({
    method: "item/completed",
    params: {
      item: {
        type: "userMessage",
        id: "user-1",
        content: [{ type: "text", text: "hello codex" }],
      },
    },
  });
  projection.consumeEvent({
    method: "item/started",
    params: { item: { type: "agentMessage", id: "assistant-1", phase: "commentary", text: "" } },
  });
  projection.consumeEvent({
    method: "item/agentMessage/delta",
    params: { itemId: "assistant-1", delta: "working" },
  });
  projection.consumeEvent({
    method: "item/agentMessage/delta",
    params: { itemId: "assistant-1", delta: " now" },
  });
  projection.consumeEvent({
    method: "item/started",
    params: { item: { type: "commandExecution", id: "cmd-1", command: "npm test" } },
  });
  projection.consumeEvent({
    method: "item/commandExecution/outputDelta",
    params: { itemId: "cmd-1", delta: "pass\n" },
  });
  projection.consumeEvent({
    method: "item/completed",
    params: { item: { type: "commandExecution", id: "cmd-1", command: "npm test", exitCode: 0 } },
  });
  projection.consumeEvent({
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "file-1",
        status: "completed",
        changes: [
          { type: "modified", path: "src/a.ts" },
          { type: "created", path: "src/new.ts" },
          { type: "deleted", path: "src/old.ts" },
        ],
      },
    },
  });
  projection.consumeEvent({ method: "warning", params: { message: "careful" } });

  const messages = projection.snapshot().messages;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "command", "file", "error"]);
  assert.equal(messages[0]?.parts[0]?.text, "hello codex");
  assert.equal(messages[1]?.parts[0]?.text, "working now");
  assert.equal(messages[2]?.parts.some((part) => part.type === "command" && part.text === "npm test"), true);
  assert.equal(messages[2]?.parts.some((part) => part.type === "status" && part.text.includes("output hidden")), true);
  assert.equal(messages[2]?.parts.some((part) => part.type === "command-output" && part.text.includes("pass")), false);
  assert.equal(messages[3]?.parts.some((part) => part.text.includes("changes=3")), true);
  assert.equal(messages[3]?.parts.some((part) => part.type === "file-change" && part.text.includes("M src/a.ts")), true);
  assert.equal(messages[3]?.parts.some((part) => part.type === "file-change" && part.text.includes("A src/new.ts")), true);
  assert.equal(messages[3]?.parts.some((part) => part.type === "file-change" && part.text.includes("D src/old.ts")), true);
  assert.equal(messages[4]?.parts[0]?.type, "error");

  const lines = messagesToTranscriptLines(messages);
  assert.equal(lines.some((line) => line.includes("[assistant] working now")), true);
  assert.equal(lines.some((line) => line.includes("[codex command] npm test")), true);
  assert.equal(lines.some((line) => line.includes("[codex fileChange] M src/a.ts")), true);
});

test("message projection exposes local and stderr messages", () => {
  const projection = new TuiMessageProjection();
  projection.appendLocal("local ready");
  projection.appendStderr("stderr line");

  const messages = projection.snapshot().messages;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "error");
  assert.equal(messages[1]?.parts[0]?.type, "stderr");
});

test("message projection merges completed assistant text with streamed deltas", () => {
  const projection = new TuiMessageProjection();
  projection.consumeEvent({
    method: "item/agentMessage/delta",
    params: { itemId: "assistant-merge", delta: "第一段\n\n" },
  });
  projection.consumeEvent({
    method: "item/agentMessage/delta",
    params: { itemId: "assistant-merge", delta: "第二段" },
  });
  projection.consumeEvent({
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        id: "assistant-merge",
        phase: "final",
        text: "第一段\n\n第二段\n\n第三段",
      },
    },
  });

  const message = projection.snapshot().messages.find((entry) => entry.id === "assistant-merge");
  assert.ok(message);
  assert.equal(message.parts.filter((part) => part.type === "text").length, 1);
  assert.equal(message.parts[0]?.text, "第一段\n\n第二段\n\n第三段");
});
