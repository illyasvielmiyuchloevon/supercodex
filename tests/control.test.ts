import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleAttachInput,
  inputViewport,
  interactionChoiceForKey,
  createFreshRunId,
  createTerminalFrame,
  normalizePastedText,
  parseResumeRequest,
  parseNewRequest,
  parseStartRequest,
  resumeSelectionMessage,
  renderFrameDiff,
  managedPlainTextAction,
  shouldCreateFreshRunForManagedMessage,
  shouldTreatRawInputAsPaste,
} from "../src/tui.js";
import { controlPath, readPendingControls, requestSteer, markControlHandled } from "../src/control.js";
import { formatRunSessions, listRunSessions, prepareRunSessionForResume, resolveRunSessionSelector } from "../src/run-sessions.js";
import { readSupervisorSettings } from "../src/settings.js";
import { shouldShowSlashPalette, slashCommandSuggestions } from "../src/tui-commands.js";
import { saveSupervisorRuntime } from "../src/workspace.js";
import type { CodexAuthManager } from "../src/auth.js";
import { displayCellWidth } from "../src/display-width.js";

test("control queue stores and handles run-scoped steering requests", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-control-"));
  const request = await requestSteer(project, "stop and inspect the failing test", "run-a");

  const pending = await readPendingControls(project, "run-a");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.id, request.id);
  assert.equal(pending[0]!.message, "stop and inspect the failing test");

  await markControlHandled(project, pending[0]!, "run-a");
  assert.equal((await readPendingControls(project, "run-a")).length, 0);
});

test("control queue still reads legacy default control.json interrupts", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-legacy-control-"));
  await mkdir(join(project, ".supercodex", "runtime"), { recursive: true });
  await writeFile(
    controlPath(project),
    JSON.stringify({
      id: "legacy-1",
      action: "interrupt",
      status: "pending",
      message: "legacy message",
      createdAt: "2026-04-30T00:00:00.000Z",
      observedAt: null,
      handledAt: null,
    }),
    "utf8",
  );

  const pending = await readPendingControls(project, "default");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.action, "steer");
  assert.equal(pending[0]!.message, "legacy message");
});

test("attach slash commands update next-turn settings and immediately switch auth when idle", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-attach-"));
  const usedAccounts: string[] = [];
  const authManager = {
    async listAccounts() {
      return ["account-1", "account-2"];
    },
    async activeAccount() {
      return usedAccounts.at(-1) ?? "account-1";
    },
    async useAccount(name: string) {
      usedAccounts.push(name);
      return join(project, "auth", name);
    },
  } as unknown as CodexAuthManager;

  assert.equal(await handleAttachInput(project, "default", "/model gpt-5.5", authManager), false);
  assert.equal(await handleAttachInput(project, "default", "/reasoning xhigh", authManager), false);
  assert.equal(await handleAttachInput(project, "default", "/auth account-2", authManager), false);

  const settings = await readSupervisorSettings(project, "default");
  assert.equal(settings.model, "gpt-5.5");
  assert.equal(settings.reasoningEffort, "xhigh");
  assert.equal(settings.pendingAuthName, null);
  assert.deepEqual(usedAccounts, ["account-2"]);
});

test("attach slash auth queues next-turn switch while a run is active", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-attach-running-"));
  const usedAccounts: string[] = [];
  const authManager = {
    async listAccounts() {
      return ["account-1", "account-2"];
    },
    async activeAccount() {
      return "account-1";
    },
    async useAccount(name: string) {
      usedAccounts.push(name);
      return join(project, "auth", name);
    },
  } as unknown as CodexAuthManager;
  await saveSupervisorRuntime(project, { status: "running" }, "default");

  assert.equal(await handleAttachInput(project, "default", "/auth account-2", authManager), false);

  const settings = await readSupervisorSettings(project, "default");
  assert.equal(settings.pendingAuthName, "account-2");
  assert.deepEqual(usedAccounts, []);
});

test("attach slash help and plain steering work without an active run", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-attach-help-"));
  const authManager = {
    async listAccounts() {
      return [];
    },
    async activeAccount() {
      return null;
    },
  } as unknown as CodexAuthManager;

  assert.equal(await handleAttachInput(project, "default", "/", authManager), false);
  assert.equal(await handleAttachInput(project, "default", "/help", authManager), false);
  assert.equal(await handleAttachInput(project, "default", "stop and inspect the current plan", authManager), false);

  const pending = await readPendingControls(project, "default");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.message, "stop and inspect the current plan");
});

test("slash command palette opens while typing a leading slash", () => {
  assert.equal(shouldShowSlashPalette("/", 1), true);
  assert.equal(shouldShowSlashPalette("/mod", 4), true);
  assert.equal(shouldShowSlashPalette(" /mod", 5), false);
  assert.equal(shouldShowSlashPalette("/model gpt-5.5", 7), false);

  const all = slashCommandSuggestions("/");
  assert.ok(all.some((item) => item.name === "model"));
  assert.ok(all.some((item) => item.name === "reasoning"));
  assert.ok(all.some((item) => item.name === "new"));
  assert.equal(slashCommandSuggestions("/mod")[0]?.name, "model");
  assert.equal(slashCommandSuggestions("/think")[0]?.name, "reasoning");
  assert.equal(slashCommandSuggestions("/cl")[0]?.name, "new");
});

test("interaction keyboard helper confirms selected choice with enter and preserves shortcuts", () => {
  const interaction = {
    choices: [
      { id: "accept", label: "Approve", response: { decision: "accept" } },
      { id: "accept-session", label: "Approve for session", response: { decision: "acceptForSession" } },
      { id: "decline", label: "Deny", response: { decision: "decline" } },
      { id: "cancel", label: "Cancel", response: { decision: "cancel" } },
    ],
  };

  assert.equal(interactionChoiceForKey("", { name: "return" }, interaction, 1), "accept-session");
  assert.equal(interactionChoiceForKey("2", { name: "2" }, interaction, 0), "accept-session");
  assert.equal(interactionChoiceForKey("a", { name: "a" }, interaction, 2), "accept");
  assert.equal(interactionChoiceForKey("s", { name: "s" }, interaction, 0), "accept-session");
  assert.equal(interactionChoiceForKey("d", { name: "d" }, interaction, 0), "decline");
  assert.equal(interactionChoiceForKey("c", { name: "c" }, interaction, 0), "cancel");
  assert.equal(interactionChoiceForKey("", { name: "return" }, interaction, 99), "cancel");
});

test("paste normalization keeps text input single-line and strips bracketed paste controls", () => {
  assert.equal(normalizePastedText("\u001b[200~第一行\r\n第二行\n\u001b[201~"), "第一行 第二行");
  assert.equal(normalizePastedText("\uFEFFhello\u0000 world\n"), "hello world");
});

test("raw input paste detection catches terminal paste chunks without swallowing controls", () => {
  assert.equal(shouldTreatRawInputAsPaste("第一行\r\n第二行\r\n"), true);
  assert.equal(shouldTreatRawInputAsPaste("plain pasted sentence"), true);
  assert.equal(shouldTreatRawInputAsPaste("\u001b[200~plain\r\npaste\u001b[201~"), true);
  assert.equal(shouldTreatRawInputAsPaste("\r"), false);
  assert.equal(shouldTreatRawInputAsPaste("\u0016"), false);
  assert.equal(shouldTreatRawInputAsPaste("\u001b[A"), false);
});

test("managed tui requires explicit /start for empty resume", () => {
  assert.equal(parseStartRequest(""), null);
  assert.equal(parseStartRequest("   "), null);
  assert.equal(parseStartRequest("/start"), "");
  assert.equal(parseStartRequest("/run default"), "default");
  assert.equal(parseStartRequest("/start walnut-main"), "walnut-main");
  assert.equal(parseStartRequest("implement the next stage"), null);
});

test("managed tui parses /new and its Codex-style alias as a fresh session request", () => {
  assert.equal(parseNewRequest(""), null);
  assert.equal(parseNewRequest("/new"), "");
  assert.equal(parseNewRequest("/new inspect the next task"), "inspect the next task");
  assert.equal(parseNewRequest("/clear"), "");
  assert.equal(parseNewRequest("/start default"), null);
});

test("managed tui parses /resume as a session picker or manual selector", () => {
  assert.equal(parseResumeRequest(""), null);
  assert.equal(parseResumeRequest("/resume"), "");
  assert.equal(parseResumeRequest("/resume 2"), "2");
  assert.equal(parseResumeRequest("/resume session-2026-05-01"), "session-2026-05-01");
  assert.equal(parseResumeRequest("/start default"), null);
});

test("run session discovery lists current project sessions and resolves manual selectors", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-sessions-"));
  await mkdir(join(project, ".supercodex", "runtime", "runs", "session-a"), { recursive: true });
  await mkdir(join(project, ".supercodex", "runtime", "runs", "session-b"), { recursive: true });
  await writeFile(
    join(project, ".supercodex", "runtime", "session.json"),
    JSON.stringify({ thread_id: "thr-default", lastClassification: "success", updatedAt: "2026-05-01T01:00:00.000Z" }),
    "utf8",
  );
  await writeFile(
    join(project, ".supercodex", "runtime", "runs", "session-a", "session.json"),
    JSON.stringify({ thread_id: "thr-a", turn_id: "turn-a", lastClassification: "success", updatedAt: "2026-05-01T02:00:00.000Z" }),
    "utf8",
  );
  await writeFile(
    join(project, ".supercodex", "runtime", "runs", "session-b", "session.json"),
    JSON.stringify({ thread_id: "thr-b", turn_id: "turn-b", lastClassification: "failed", updatedAt: "2026-05-01T03:00:00.000Z" }),
    "utf8",
  );

  const sessions = await listRunSessions(project);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0]!.runId, "session-b");
  assert.equal(resolveRunSessionSelector(sessions, "1")?.runId, "session-b");
  assert.equal(resolveRunSessionSelector(sessions, "session-a")?.threadId, "thr-a");
  assert.equal(resolveRunSessionSelector(sessions, "thr-default")?.runId, "default");
  assert.match(formatRunSessions(sessions), /Found 3 saved Codex\/SuperCodex session/);
  assert.match(formatRunSessions(sessions), /without auto-running/);
  assert.match(resumeSelectionMessage("session-a"), /Type a message to continue it/);
});

test("run session discovery does not invent a default session for a fresh project", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-empty-sessions-"));
  assert.deepEqual(await listRunSessions(project), []);
  assert.match(formatRunSessions([]), /No saved Codex\/SuperCodex sessions/);
});

test("run session discovery includes Codex native sessions scoped to the current project", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-native-project-"));
  const otherProject = await mkdtemp(join(tmpdir(), "supercodex-native-other-"));
  const codexHome = await mkdtemp(join(tmpdir(), "supercodex-codex-home-"));
  const sessionsDir = join(codexHome, "sessions", "2026", "05", "01");
  const nativeId = "019de35e-43c2-7f23-b549-d6670ab52a01";
  const otherId = "019de35e-43c2-7f23-b549-d6670ab52a02";
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `rollout-2026-05-01T19-48-19-${nativeId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-05-01T19:48:19.000Z",
      type: "session_meta",
      payload: {
        id: nativeId,
        timestamp: "2026-05-01T19:48:19.000Z",
        cwd: project,
        originator: "codex",
        source: "vscode",
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(sessionsDir, `rollout-2026-05-01T19-49-19-${otherId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-05-01T19:49:19.000Z",
      type: "session_meta",
      payload: {
        id: otherId,
        timestamp: "2026-05-01T19:49:19.000Z",
        cwd: otherProject,
        originator: "codex",
        source: "vscode",
      },
    })}\n`,
    "utf8",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const sessions = await listRunSessions(project);
    assert.equal(sessions.length, 1);
    const native = sessions[0]!;
    assert.equal(native.source, "codex");
    assert.equal(native.threadId, nativeId);
    assert.equal(native.runId, `codex-${nativeId}`);
    assert.equal(resolveRunSessionSelector(sessions, nativeId.slice(0, 8))?.runId, native.runId);
    assert.match(formatRunSessions(sessions), /codex/);

    const prepared = await prepareRunSessionForResume(project, native);
    assert.equal(prepared.hasSession, true);
    const stub = JSON.parse(await readFile(join(project, ".supercodex", "runtime", "runs", native.runId, "session.json"), "utf8"));
    assert.equal(stub.thread_id, nativeId);
    assert.equal(stub.importedFrom, "codex-session");
    const merged = (await listRunSessions(project)).filter((session) => session.threadId === nativeId);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.nativePath, native.nativePath);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test("fresh managed sessions use sanitized unique run IDs", () => {
  const first = createFreshRunId();
  const second = createFreshRunId();
  assert.match(first, /^session-[A-Za-z0-9_.-]+$/);
  assert.notEqual(first, second);
});

test("managed plain input keeps a /start-selected run instead of opening fresh", () => {
  assert.equal(
    managedPlainTextAction({
      supervisorRunning: false,
      activeRunStarted: false,
      activeRunIsResume: false,
    }),
    "initial_goal",
  );
  assert.equal(
    managedPlainTextAction({
      supervisorRunning: false,
      activeRunStarted: true,
      activeRunIsResume: false,
    }),
    "new_goal",
  );
  assert.equal(
    managedPlainTextAction({
      supervisorRunning: false,
      activeRunStarted: true,
      activeRunIsResume: true,
    }),
    "steer",
  );
  assert.equal(
    managedPlainTextAction({
      supervisorRunning: true,
      activeRunStarted: true,
      activeRunIsResume: false,
    }),
    "steer",
  );

  assert.equal(
    shouldCreateFreshRunForManagedMessage({
      supervisorRunning: false,
      activeRunStarted: false,
      activeRunIsResume: false,
    }),
    false,
  );
  assert.equal(
    shouldCreateFreshRunForManagedMessage({
      supervisorRunning: false,
      activeRunStarted: true,
      activeRunIsResume: false,
    }),
    true,
  );
  assert.equal(
    shouldCreateFreshRunForManagedMessage({
      supervisorRunning: false,
      activeRunStarted: true,
      activeRunIsResume: true,
    }),
    false,
  );
  assert.equal(
    shouldCreateFreshRunForManagedMessage({
      supervisorRunning: true,
      activeRunStarted: true,
      activeRunIsResume: true,
    }),
    false,
  );
});

test("input viewport keeps long pasted text on one rendered row with visible cursor", () => {
  const view = inputViewport("> ", "0123456789abcdefghijklmnopqrstuvwxyz", 36, 12);
  assert.equal(view.line.length <= 12, true);
  assert.match(view.line, /^> /);
  assert.equal(view.line.endsWith("z"), true);
  assert.equal(view.cursorColumn <= 12, true);
});

test("input viewport escapes embedded newlines in fallback mode", () => {
  const view = inputViewport("> ", "first\nsecond", 6, 24);
  assert.equal(view.line, "> first\\nsecond");
  assert.equal(view.cursorColumn, 10);
});

test("terminal frame diff avoids clearing unchanged full-screen TUI frames", () => {
  const first = createTerminalFrame({
    lines: ["header", "body", "> input"],
    columns: 12,
    rows: 4,
    cursorRow: 3,
    cursorColumn: 8,
  });
  const same = createTerminalFrame({
    lines: ["header", "body", "> input"],
    columns: 12,
    rows: 4,
    cursorRow: 3,
    cursorColumn: 8,
  });
  const changed = createTerminalFrame({
    lines: ["header", "body changed", "> input"],
    columns: 12,
    rows: 4,
    cursorRow: 3,
    cursorColumn: 8,
  });

  assert.match(renderFrameDiff(null, first, true), /\x1b\[2J/);
  assert.equal(renderFrameDiff(first, same), "");
  const patch = renderFrameDiff(first, changed);
  assert.doesNotMatch(patch, /\x1b\[2J|\x1b\[J/);
  assert.doesNotMatch(patch, /\x1b\[1;1H/);
  assert.match(patch, /\x1b\[2;1H/);
});

test("terminal frame keeps ANSI resets when clipping full-width styled rows", () => {
  const styledHeader = "\x1b[36m\x1b[7m" + " SuperCodex ".padEnd(12, " ") + "\x1b[27m\x1b[39m";
  const frame = createTerminalFrame({
    lines: [styledHeader, "plain"],
    columns: 12,
    rows: 2,
    cursorRow: 2,
    cursorColumn: 1,
  });
  const output = renderFrameDiff(null, frame, true);

  assert.match(frame.lines[0] ?? "", /\x1b\[0m$/);
  assert.match(output, /\x1b\[0m\nplain/);
});

test("terminal frame clips mixed Chinese and ASCII by display cells", () => {
  const line = "对齐结果里有一个实际不一致： `.supercodex` 已标记交付并记录 commit/push";
  const frame = createTerminalFrame({
    lines: [line],
    columns: 40,
    rows: 1,
    cursorRow: 1,
    cursorColumn: 1,
  });

  assert.equal(displayCellWidth(frame.lines[0] ?? ""), 40);
  assert.equal(frame.lines[0]?.includes("对齐结果里"), true);
});
