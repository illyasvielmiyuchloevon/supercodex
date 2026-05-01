import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TuiTranscriptSource } from "../src/tui-transcript.js";

test("tui transcript source loads the complete existing app-server log before following new output", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-transcript-"));
  const eventLogPath = join(project, "app-server.jsonl");
  const stderrPath = join(project, "app-server-stderr.log");
  const eventLines = [
    jsonLine({ method: "turn/started", params: {} }),
    jsonLine({ method: "item/agentMessage/delta", params: { delta: "first-visible-from-start\n" } }),
  ];
  for (let index = 0; index < 1200; index++) {
    eventLines.push(jsonLine({ method: "item/agentMessage/delta", params: { delta: `history-${index}\n` } }));
  }
  eventLines.push(jsonLine({ method: "item/started", params: { item: { type: "commandExecution", command: "npm test" } } }));
  eventLines.push(jsonLine({ method: "item/commandExecution/outputDelta", params: { delta: "command-output\n" } }));
  await writeFile(eventLogPath, eventLines.join(""), "utf8");
  await writeFile(stderrPath, "stderr-from-start\n", "utf8");

  const transcript = new TuiTranscriptSource({ maxLines: 2000 });
  await transcript.sync({ eventLogPath, stderrPath });

  const firstSnapshot = transcript.snapshot();
  assert.equal(firstSnapshot.lines.some((line) => line.includes("first-visible-from-start")), true);
  assert.equal(firstSnapshot.lines.some((line) => line.includes("[codex command] npm test")), true);
  assert.equal(firstSnapshot.lines.some((line) => line.includes("command-output")), false);
  assert.equal(firstSnapshot.lines.some((line) => line.includes("[codex app-server] stderr-from-start")), true);
  assert.equal(firstSnapshot.messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.text.includes("first-visible-from-start"))), true);
  assert.equal(firstSnapshot.messages.some((message) => message.role === "command" && message.parts.some((part) => part.text.includes("npm test"))), true);
  assert.equal(firstSnapshot.messages.some((message) => message.role === "command" && message.parts.some((part) => part.type === "status" && part.text.includes("output hidden"))), true);
  assert.equal(firstSnapshot.messages.some((message) => message.role === "error" && message.parts.some((part) => part.text.includes("stderr-from-start"))), true);

  await appendFile(eventLogPath, jsonLine({ method: "item/agentMessage/delta", params: { delta: "new-output-after-attach\n" } }), "utf8");
  await transcript.sync({ eventLogPath, stderrPath });

  assert.equal(transcript.snapshot().lines.some((line) => line.includes("new-output-after-attach")), true);
});

test("tui transcript source preserves prior turn transcript when the runtime log path changes", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-transcript-"));
  const first = join(project, "first-app-server.jsonl");
  const second = join(project, "second-app-server.jsonl");
  await writeFile(first, jsonLine({ method: "item/agentMessage/delta", params: { delta: "first-turn-output\n" } }), "utf8");
  await writeFile(second, jsonLine({ method: "item/agentMessage/delta", params: { delta: "second-turn-output\n" } }), "utf8");

  const transcript = new TuiTranscriptSource();
  await transcript.sync({ eventLogPath: first });
  await transcript.sync({ eventLogPath: second });

  const lines = transcript.snapshot().lines;
  assert.equal(lines.some((line) => line.includes("first-turn-output")), true);
  assert.equal(lines.some((line) => line.includes("second-turn-output")), true);
});

test("tui transcript source buffers partial JSONL lines before projecting assistant text", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-transcript-"));
  const eventLogPath = join(project, "app-server.jsonl");
  const first = jsonLine({ method: "item/agentMessage/delta", params: { itemId: "assistant-partial", delta: "第一段\n\n" } });
  const second = jsonLine({ method: "item/agentMessage/delta", params: { itemId: "assistant-partial", delta: "第二段" } });
  const splitAt = Math.floor(first.length / 2);
  await writeFile(eventLogPath, first.slice(0, splitAt), "utf8");

  const transcript = new TuiTranscriptSource();
  await transcript.sync({ eventLogPath });

  let snapshot = transcript.snapshot();
  assert.equal(snapshot.lines.some((line) => line.includes("第一段")), false);
  assert.equal(snapshot.lines.some((line) => line.includes("[codex app-server]")), false);

  await appendFile(eventLogPath, `${first.slice(splitAt)}${second}`, "utf8");
  await transcript.sync({ eventLogPath });

  snapshot = transcript.snapshot();
  const firstIndex = snapshot.lines.findIndex((line) => line.includes("第一段"));
  const secondIndex = snapshot.lines.findIndex((line) => line.includes("第二段"));
  assert.notEqual(firstIndex, -1);
  assert.notEqual(secondIndex, -1);
  assert.equal(firstIndex < secondIndex, true);
  const message = snapshot.messages.find((entry) => entry.id === "assistant-partial");
  assert.ok(message);
  assert.equal(message.parts.some((part) => part.text.includes("第一段\n\n第二段")), true);
});

test("tui transcript source loads Codex native session JSONL history", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-transcript-"));
  const nativeSessionPath = join(project, "codex-session.jsonl");
  const eventLogPath = join(project, "app-server.jsonl");
  const callId = "call_native_shell";
  await writeFile(
    nativeSessionPath,
    [
      jsonLine({ type: "session_meta", payload: { id: "019native", cwd: project, base_instructions: { text: "do not show me" } } }),
      jsonLine({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "developer-only" }] } }),
      jsonLine({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续修复 /resume" }] } }),
      jsonLine({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "我来加载历史。" }] } }),
      jsonLine({ type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "npm test", workdir: project }), call_id: callId } }),
      jsonLine({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output: "tests passed\n" } }),
    ].join(""),
    "utf8",
  );
  await writeFile(eventLogPath, jsonLine({ method: "item/agentMessage/delta", params: { delta: "continued-output\n" } }), "utf8");

  const transcript = new TuiTranscriptSource({ maxLines: 1000 });
  await transcript.sync({ nativeSessionPath });
  await transcript.sync({ nativeSessionPath });
  await transcript.sync({ nativeSessionPath, eventLogPath });

  const snapshot = transcript.snapshot();
  assert.equal(snapshot.lines.some((line) => line.includes("[user] 继续修复 /resume")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("[assistant] 我来加载历史。")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("[codex command] npm test")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("tests passed")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("continued-output")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("developer-only")), false);
  assert.equal(snapshot.lines.filter((line) => line.includes("[user] 继续修复 /resume")).length, 1);
  assert.equal(snapshot.messages.some((message) => message.role === "user" && message.parts.some((part) => part.text === "继续修复 /resume")), true);
  assert.equal(snapshot.messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.text === "我来加载历史。")), true);
  const commandMessage = snapshot.messages.find((message) => message.role === "command" && message.parts.some((part) => part.text === "npm test"));
  assert.ok(commandMessage);
  assert.equal(commandMessage.parts.some((part) => part.type === "command-output" && part.text.includes("tests passed")), true);
});

test("tui transcript source projects local operator input as a visible user message", () => {
  const transcript = new TuiTranscriptSource();
  transcript.appendUser("请继续修复 TUI");

  const snapshot = transcript.snapshot();
  assert.equal(snapshot.lines.some((line) => line.includes("[operator] 请继续修复 TUI")), true);
  assert.equal(snapshot.messages.some((message) => message.role === "user" && message.parts.some((part) => part.text === "请继续修复 TUI")), true);
});

test("tui transcript source hides noisy Codex model refresh timeout stderr", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-transcript-"));
  const stderrPath = join(project, "app-server-stderr.log");
  await writeFile(
    stderrPath,
    [
      "2026-05-01T14:42:24.247447Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
      "real stderr",
      "",
    ].join("\n"),
    "utf8",
  );

  const transcript = new TuiTranscriptSource();
  await transcript.sync({ stderrPath });

  const snapshot = transcript.snapshot();
  assert.equal(snapshot.lines.some((line) => line.includes("failed to refresh available models")), false);
  assert.equal(snapshot.lines.some((line) => line.includes("real stderr")), true);
  assert.equal(snapshot.messages.some((message) => message.parts.some((part) => part.text.includes("failed to refresh available models"))), false);
  assert.equal(snapshot.messages.some((message) => message.parts.some((part) => part.text.includes("real stderr"))), true);
});

test("tui transcript source compacts large native tool output", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-transcript-"));
  const nativeSessionPath = join(project, "codex-session.jsonl");
  const callId = "call_large_read";
  const largeOutput = Array.from({ length: 60 }, (_, index) => `line ${index.toString().padStart(2, "0")} ${"x".repeat(40)}`).join("\n");
  await writeFile(
    nativeSessionPath,
    [
      jsonLine({ type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "Get-Content src/large.ts" }), call_id: callId } }),
      jsonLine({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output: largeOutput } }),
    ].join(""),
    "utf8",
  );

  const transcript = new TuiTranscriptSource();
  await transcript.sync({ nativeSessionPath });

  const snapshot = transcript.snapshot();
  assert.equal(snapshot.lines.some((line) => line.includes("Get-Content src/large.ts")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("[output hidden: 60 lines")), true);
  assert.equal(snapshot.lines.some((line) => line.includes("line 59")), false);
});

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
