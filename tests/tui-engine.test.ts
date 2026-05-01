import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTuiFrame, renderFrameDiff, transcriptWindow } from "../src/tui-engine.js";
import type { InteractionRecord } from "../src/interactions.js";

test("tui engine builds named regions with sidebar and command palette", () => {
  const screen = buildTuiFrame({
    columns: 120,
    rows: 40,
    modeLabel: "managed",
    runId: "default",
    project: "C:\\repo",
    logs: ["first event", "second event"],
    logScrollOffset: 0,
    status: {
      done: false,
      mode: "execution",
      phase: "execution",
      stage: "stage-18",
      task: "S18-T1",
      nextWork: "TUI engine",
      runtimeStatus: "running",
      threadId: "thread-123456",
      turnId: "turn-123456",
      settings: { model: "gpt-5.5", reasoningEffort: "xhigh" },
      activeAuth: "main",
      interactions: [],
    },
    suggestions: [
      {
        name: "model",
        usage: "/model <name>",
        description: "Queue model for the next turn.",
        score: 3,
      },
    ],
    commandSelection: 0,
    interaction: null,
    interactionSelection: 0,
    inputPrompt: "> ",
    inputBuffer: "/mod",
    inputCursor: 4,
  });

  assert.equal(screen.layout.sideWidth > 0, true);
  assert.equal(screen.layout.paletteHeight > 0, true);
  assert.equal(screen.frame.lines.some((line) => line.includes("Commands")), true);
  assert.equal(screen.frame.lines.some((line) => line.includes("model: gpt-5.5")), true);
  assert.equal(screen.frame.cursorRow <= 40, true);
  assert.equal(screen.frame.cursorColumn > 1, true);
});

test("tui engine scrolls transcript without forcing full-screen redraw", () => {
  const logs = Array.from({ length: 20 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`);
  const window = transcriptWindow(logs, 30, 5, 3);
  assert.equal(window.effectiveScrollOffset, 3);
  assert.deepEqual(window.lines, ["line-13", "line-14", "line-15", "line-16", "line-17"]);

  const tail = buildTuiFrame({
    columns: 80,
    rows: 20,
    modeLabel: "attach-only",
    runId: "default",
    project: ".",
    logs,
    logScrollOffset: 0,
    status: {},
    suggestions: [],
    commandSelection: 0,
    interaction: null,
    interactionSelection: 0,
    inputPrompt: "attach> ",
    inputBuffer: "",
    inputCursor: 0,
  }).frame;
  const scrolled = buildTuiFrame({
    columns: 80,
    rows: 20,
    modeLabel: "attach-only",
    runId: "default",
    project: ".",
    logs,
    logScrollOffset: 3,
    status: {},
    suggestions: [],
    commandSelection: 0,
    interaction: null,
    interactionSelection: 0,
    inputPrompt: "attach> ",
    inputBuffer: "",
    inputCursor: 0,
  }).frame;

  const patch = renderFrameDiff(tail, scrolled);
  assert.doesNotMatch(patch, /\x1b\[2J|\x1b\[J/);
  assert.match(scrolled.lines[1] ?? "", /view=scroll-3/);
});

test("tui engine renders interaction panel only when command palette is closed", () => {
  const interaction: InteractionRecord = {
    id: "interaction-1",
    requestId: 1,
    method: "item/commandExecution/requestApproval",
    status: "pending",
    title: "Command Approval",
    summary: "npm test",
    choices: [
      { id: "accept", label: "accept", response: { decision: "accept" } },
      { id: "decline", label: "decline", response: { decision: "decline" } },
    ],
    params: {},
    createdAt: "2026-04-30T00:00:00.000Z",
    respondedAt: null,
    handledAt: null,
  };

  const withInteraction = buildTuiFrame({
    columns: 90,
    rows: 24,
    modeLabel: "managed",
    runId: "default",
    project: ".",
    logs: [],
    logScrollOffset: 0,
    status: { interactions: [interaction] },
    suggestions: [],
    commandSelection: 0,
    interaction,
    interactionSelection: 1,
    inputPrompt: "> ",
    inputBuffer: "",
    inputCursor: 0,
  });
  assert.equal(withInteraction.frame.lines.some((line) => line.includes("Interaction Required")), true);
  assert.equal(withInteraction.frame.lines.some((line) => line.includes("decline")), true);

  const withPalette = buildTuiFrame({
    columns: 90,
    rows: 24,
    modeLabel: "managed",
    runId: "default",
    project: ".",
    logs: [],
    logScrollOffset: 0,
    status: { interactions: [interaction] },
    suggestions: [{ name: "help", usage: "/help", description: "Show help.", score: 1 }],
    commandSelection: 0,
    interaction,
    interactionSelection: 1,
    inputPrompt: "> ",
    inputBuffer: "/",
    inputCursor: 1,
  });
  assert.equal(withPalette.frame.lines.some((line) => line.includes("Interaction Required")), false);
  assert.equal(withPalette.frame.lines.some((line) => line.includes("Commands")), true);
});
