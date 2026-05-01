import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join, resolve } from "node:path";
import { CodexAuthManager, readEffectiveCodexConfig } from "./auth.js";
import { requestSteer, requestTurnInterrupt } from "./control.js";
import { defaultAppServerOptions, type AppServerOptions } from "./app-server.js";
import { summarizeAppServerNotification } from "./app-server-events.js";
import { shouldSuppressCodexStderr } from "./codex-stderr.js";
import { defaultSupervisorConfig, Supervisor } from "./supervisor.js";
import {
  answerInteraction,
  chooseInteraction,
  readPendingInteractions,
  summarizeInteraction,
  type InteractionRecord,
} from "./interactions.js";
import {
  copySupervisorSessionPreferences,
  parseApprovalPolicy,
  parsePermissionSetting,
  parseReasoningEffort,
  parseSandboxMode,
  patchSupervisorSettings,
  readSupervisorSettings,
  sanitizeRunId,
} from "./settings.js";
import { formatRunSessions, listRunSessions, prepareRunSessionForResume, resolveRunSessionSelector, runSessionsPayload } from "./run-sessions.js";
import { chooseNextWork, loadSnapshotForRun, loadSupervisorRuntime } from "./workspace.js";
import { canonicalSlashCommandName, slashCommandSuggestions, slashHelpText, type SlashCommandSuggestion } from "./tui-commands.js";
import { buildTuiFrame } from "./tui-engine.js";
import { TuiTranscriptSource } from "./tui-transcript.js";
import { runOpenTuiFrontend } from "./opentui-launcher.js";
import { isTextareaNewlineKey } from "./opentui/textarea-keybindings.js";
import type { JsonObject } from "./types.js";

export interface AttachOptions {
  project: string;
  runId?: string | null;
  authManager: CodexAuthManager;
  appServerOptions?: AppServerOptions;
  managed?: boolean;
  pollMs?: number;
}

export async function runAttach(options: AttachOptions): Promise<number> {
  if (input.isTTY && output.isTTY) {
    return await runOpenTuiFrontend(options);
  }
  return await runLineAttach(options);
}

async function runLineAttach(options: AttachOptions): Promise<number> {
  const project = resolve(options.project);
  const resumeRunId = sanitizeRunId(options.runId);
  let activeRunId = options.managed ? createFreshRunId() : resumeRunId;
  let activeRunStarted = !options.managed;
  let activeRunIsResume = false;
  let tail = new LogTail();
  let currentEventLog: string | null = null;
  let currentStderrLog: string | null = null;
  let supervisorPromise: Promise<number> | null = null;

  console.log(options.managed ? "supercodex" : "supercodex attach");
  console.log(`project: ${project}`);
  console.log(`run: ${activeRunId}`);
  console.log(
    options.managed
      ? "Type a message to start a fresh session, or /start [run-id] to resume. Type /help for commands."
      : "Type /help for commands. Plain text is sent as a Codex steering message.",
  );
  printSlashHelp();
  await printAttachStatus(project, activeRunId, options.authManager, { freshIdle: Boolean(options.managed) });

  const interval = setInterval(() => {
    void (async () => {
      const runtime = await loadSupervisorRuntime(project, activeRunId);
      currentEventLog = typeof runtime.eventLogPath === "string" ? runtime.eventLogPath : currentEventLog;
      currentStderrLog = typeof runtime.stderrPath === "string" ? runtime.stderrPath : currentStderrLog;
      if (currentEventLog) {
        await tail.poll(currentEventLog, renderEventLogLine);
      }
      if (currentStderrLog) {
        await tail.poll(currentStderrLog, (line) => {
          if (line.trim() && !shouldSuppressCodexStderr(line)) {
            output.write(`\n[codex app-server] ${line}\n`);
          }
        });
      }
    })().catch((error) => {
      output.write(`\n[supercodex attach] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, options.pollMs ?? 1000);

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = await rl.question(`\nsupercodex:${activeRunId} (/help)> `);
      if (options.managed) {
        const newRequest = parseNewRequest(line);
        if (newRequest !== null) {
          if (supervisorPromise) {
            console.log("[supercodex] run is already active; interrupt or wait before starting a new session.");
            continue;
          }
          const previousRunId = activeRunId;
          activeRunId = createFreshRunId();
          activeRunStarted = false;
          activeRunIsResume = false;
          currentEventLog = null;
          currentStderrLog = null;
          tail = new LogTail();
          await copySupervisorSessionPreferences(project, previousRunId, activeRunId);
          console.log(`[supercodex] new session ${activeRunId}.`);
          if (!newRequest.trim()) {
            continue;
          }
          activeRunStarted = true;
          const started = await startManagedSupervisor({
            project,
            runId: activeRunId,
            goalOrInstruction: newRequest,
            operatorIntervention: true,
            authManager: options.authManager,
            appServerOptions: options.appServerOptions ?? defaultAppServerOptions,
            current: supervisorPromise,
          });
          supervisorPromise = started.task;
          void started.task?.finally(() => {
            if (supervisorPromise === started.task) {
              supervisorPromise = null;
            }
          });
          continue;
        }
        const startRequest = parseStartRequest(line);
        if (startRequest !== null) {
          if (!supervisorPromise) {
            activeRunId = startRequest.trim() ? sanitizeRunId(startRequest) : resumeRunId;
            activeRunStarted = true;
            activeRunIsResume = true;
            currentEventLog = null;
            currentStderrLog = null;
            tail = new LogTail();
          }
          const started = await startManagedSupervisor({
            project,
            runId: activeRunId,
            goalOrInstruction: "",
            operatorIntervention: false,
            authManager: options.authManager,
            appServerOptions: options.appServerOptions ?? defaultAppServerOptions,
            current: supervisorPromise,
          });
          supervisorPromise = started.task;
          void started.task?.finally(() => {
            if (supervisorPromise === started.task) {
              supervisorPromise = null;
            }
          });
          continue;
        }
        const resumeRequest = parseResumeRequest(line);
        if (resumeRequest !== null) {
          const selector = resumeRequest.trim();
          if (selector === "current" || selector === "--current") {
            await patchSupervisorSettings(project, { paused: false }, activeRunId);
            console.log("[supercodex] current run resumed from pause.");
            continue;
          }
          const sessions = await listRunSessions(project);
          if (!selector) {
            console.log(formatRunSessions(sessions));
            continue;
          }
          const selected = resolveRunSessionSelector(sessions, selector);
          if (!selected) {
            console.log(`No saved session matched "${selector}".`);
            console.log(formatRunSessions(sessions));
            continue;
          }
          if (supervisorPromise) {
            console.log("[supercodex] run is already active; wait for it to stop or interrupt it before switching sessions.");
            continue;
          }
          const prepared = await prepareRunSessionForResume(project, selected);
          activeRunId = prepared.runId;
          activeRunStarted = true;
          activeRunIsResume = true;
          currentEventLog = null;
          currentStderrLog = null;
          tail = new LogTail();
          await printNativeSessionTranscript(prepared.nativePath);
          console.log(resumeSelectionMessage(activeRunId));
          continue;
        }
        if (line.trim() && !line.trim().startsWith("/")) {
          if (
            shouldCreateFreshRunForManagedMessage({
              supervisorRunning: Boolean(supervisorPromise),
              activeRunStarted,
              activeRunIsResume,
            })
          ) {
            activeRunId = createFreshRunId();
            activeRunStarted = false;
            activeRunIsResume = false;
            currentEventLog = null;
            currentStderrLog = null;
            tail = new LogTail();
          }
          const request = await requestSteer(project, line.trim(), activeRunId);
          activeRunStarted = true;
          console.log(`[supercodex] queued operator message ${request.id}`);
          if (!supervisorPromise) {
            const started = await startManagedSupervisor({
              project,
              runId: activeRunId,
              goalOrInstruction: "",
              operatorIntervention: true,
              authManager: options.authManager,
              appServerOptions: options.appServerOptions ?? defaultAppServerOptions,
              current: supervisorPromise,
            });
            supervisorPromise = started.task;
            void started.task?.finally(() => {
              if (supervisorPromise === started.task) {
                supervisorPromise = null;
              }
            });
          }
          continue;
        }
      }
      const shouldExit = await handleAttachInput(project, activeRunId, line, options.authManager, { supervisorRunning: Boolean(supervisorPromise) });
      if (shouldExit) {
        return 0;
      }
    }
  } finally {
    clearInterval(interval);
    rl.close();
  }
}

async function startManagedSupervisor(input: {
  project: string;
  runId: string;
  goalOrInstruction: string;
  authManager: CodexAuthManager;
  appServerOptions: AppServerOptions;
  current: Promise<number> | null;
  operatorIntervention?: boolean;
  report?: (message: string) => void;
}): Promise<{ task: Promise<number> | null }> {
  const report = input.report ?? ((message: string) => console.log(message));
  if (input.current) {
    report("[supercodex] run is already active; plain text will steer the active turn.");
    if (input.goalOrInstruction.trim()) {
      await requestSteer(input.project, input.goalOrInstruction.trim(), input.runId);
    }
    return { task: input.current };
  }
  const instruction = input.goalOrInstruction.trim();
  if (instruction) {
    await requestSteer(input.project, instruction, input.runId);
  }
  const config = {
    ...defaultSupervisorConfig(input.project),
    goal: instruction,
    runId: input.runId,
    authManager: input.authManager,
    operatorIntervention: Boolean(input.operatorIntervention),
    appServerOptions: { ...input.appServerOptions, streamConsole: false },
    supervisorConsole: false,
  };
  report(input.operatorIntervention ? `[supercodex] starting fresh session ${input.runId}.` : `[supercodex] starting/resuming run ${input.runId}.`);
  const promise = (async () => {
    try {
      const code = await new Supervisor(config).run();
      report(`[supercodex] run stopped with code=${code}`);
      return code;
    } catch (error) {
      report(`[supercodex] run failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  })();
  return { task: promise };
}

export function parseStartRequest(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }
  if (!line.startsWith("/")) {
    return null;
  }
  const parsed = parseSlashCommand(line);
  if (parsed.command === "start") {
    return parsed.arg;
  }
  return null;
}

export function parseNewRequest(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }
  if (!line.startsWith("/")) {
    return null;
  }
  const parsed = parseSlashCommand(line);
  if (parsed.command === "new") {
    return parsed.arg;
  }
  return null;
}

export function parseResumeRequest(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }
  if (!line.startsWith("/")) {
    return null;
  }
  const parsed = parseSlashCommand(line);
  if (parsed.command === "resume") {
    return parsed.arg;
  }
  return null;
}

export function createFreshRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return sanitizeRunId(`session-${stamp}-${randomUUID().slice(0, 8)}`);
}

export function shouldCreateFreshRunForManagedMessage(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): boolean {
  return !input.supervisorRunning && input.activeRunStarted && !input.activeRunIsResume;
}

class TerminalTui {
  private readonly project: string;
  private readonly resumeRunId: string;
  private activeRunId: string;
  private activeRunIsResume: boolean;
  private readonly transcript = new TuiTranscriptSource();
  private inputBuffer = "";
  private cursor = 0;
  private commandSelection = 0;
  private interactionSelection = 0;
  private currentEventLog: string | null = null;
  private currentStderrLog: string | null = null;
  private activeRunStarted: boolean;
  private supervisorPromise: Promise<number> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private keypressHandler: ((str: string, key: TuiKey) => void) | null = null;
  private rawDataHandler: ((chunk: Buffer) => void) | null = null;
  private status: JsonObject = {};
  private closed = false;
  private suppressKeypressForPaste = false;
  private bracketedPasteBuffer: string | null = null;
  private lastFrame: TerminalFrame | null = null;
  private forceFullRender = true;
  private logScrollOffset = 0;

  constructor(private readonly options: AttachOptions) {
    this.project = resolve(options.project);
    this.resumeRunId = sanitizeRunId(options.runId);
    this.activeRunId = options.managed ? createFreshRunId() : this.resumeRunId;
    this.activeRunStarted = !options.managed;
    this.activeRunIsResume = false;
  }

  async run(): Promise<number> {
    await this.refreshStatus();
    this.enterScreen();
    await this.pollLogs();
    this.addLog(this.options.managed ? "Managed TUI ready. Type a message to start a fresh session, or /start [run-id] to resume. Type / for commands." : "Attach-only TUI ready. Type / for commands or plain text to steer.");
    this.startPolling();
    this.render();

    return await new Promise<number>((resolvePromise) => {
      const finish = (code: number) => {
        if (this.closed) {
          return;
        }
        this.closed = true;
        this.stopPolling();
        this.leaveScreen();
        resolvePromise(code);
      };
      this.keypressHandler = (str, key) => {
        void this.handleKeypress(str, key, finish).catch((error) => {
          this.addLog(`[ui error] ${error instanceof Error ? error.message : String(error)}`);
          this.render();
        });
      };
      this.rawDataHandler = (chunk) => this.handleRawInputData(chunk);
      input.on("data", this.rawDataHandler);
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", this.keypressHandler);
    });
  }

  private enterScreen(): void {
    this.forceFullRender = true;
    this.lastFrame = null;
    output.write("\x1b[?1049h\x1b[?2004h\x1b[?25l");
  }

  private leaveScreen(): void {
    if (this.keypressHandler) {
      input.removeListener("keypress", this.keypressHandler);
    }
    if (this.rawDataHandler) {
      input.removeListener("data", this.rawDataHandler);
    }
    this.lastFrame = null;
    this.forceFullRender = true;
    input.setRawMode(false);
    output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.pollLogs().catch((error) => this.addLog(`[log poll error] ${error instanceof Error ? error.message : String(error)}`));
    }, this.options.pollMs ?? 1000);
    this.statusTimer = setInterval(() => {
      void this.refreshStatus().then(() => this.render()).catch((error) => this.addLog(`[status error] ${error instanceof Error ? error.message : String(error)}`));
    }, 1500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
    }
  }

  private async pollLogs(): Promise<void> {
    const snapshot = await loadSnapshotForRun(this.project, this.activeRunId);
    const runtime = await loadSupervisorRuntime(this.project, this.activeRunId);
    const session = snapshot.supervisorSession;
    const nativeSessionPath = firstString(session.nativeSessionPath, runtime.nativeSessionPath);
    const eventLogPath = firstString(runtime.eventLogPath, session.lastEventLog, this.currentEventLog);
    const stderrPath = firstString(runtime.stderrPath, session.lastStderrLog, this.currentStderrLog);
    this.currentEventLog = eventLogPath;
    this.currentStderrLog = stderrPath;
    const changed = await this.transcript.sync({ nativeSessionPath, eventLogPath, stderrPath });
    await this.refreshStatus();
    if (changed) {
      this.render();
    }
  }

  private async refreshStatus(): Promise<void> {
    if (this.options.managed && !this.activeRunStarted && !this.supervisorPromise) {
      this.status = await freshIdleStatus(this.project, this.activeRunId, this.options.authManager);
      return;
    }
    const snapshot = await loadSnapshotForRun(this.project, this.activeRunId);
    const runtime = await loadSupervisorRuntime(this.project, this.activeRunId);
    const settings = await readSupervisorSettings(this.project, this.activeRunId);
    const work = chooseNextWork(snapshot);
    this.status = {
      done: snapshot.done,
      mode: snapshot.state.mode ?? null,
      phase: snapshot.state.phase ?? null,
      runId: this.activeRunId,
      stage: snapshot.supervisorSession.stage_id ?? snapshot.state.currentStageId ?? work.stageId ?? null,
      task: snapshot.supervisorSession.task_id ?? snapshot.state.currentTaskId ?? work.taskId ?? null,
      nextWork: work.title,
      runtimeStatus: runtime.status ?? null,
      threadId: runtime.thread_id ?? null,
      turnId: runtime.turn_id ?? null,
      settings,
      effectiveCodexConfig: await readEffectiveCodexConfig(this.options.authManager),
      activeAuth: await this.options.authManager.activeAccount(),
      authAccounts: await this.options.authManager.listAccounts(),
      interactions: await readPendingInteractions(this.project, this.activeRunId),
    };
  }

  private async handleKeypress(str: string, key: TuiKey, finish: (code: number) => void): Promise<void> {
    if (this.suppressKeypressForPaste) {
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.addLog("[supercodex] Ctrl+C is reserved for copy in the TUI; use /exit to leave.");
      this.render();
      return;
    }
    if (isPasteKey(str, key)) {
      await this.pasteClipboard();
      this.render();
      return;
    }
    if (isTextareaNewlineKey(key)) {
      this.insertInputText("\n");
      this.render();
      return;
    }
    const logScrollDelta = transcriptScrollDelta(key, output.rows ?? 30);
    if (logScrollDelta !== 0) {
      this.logScrollOffset = Math.max(0, this.logScrollOffset + logScrollDelta);
      this.render();
      return;
    }
    const suggestions = this.suggestions();
    if (suggestions.length > 0) {
      if (key.name === "up") {
        this.commandSelection = (this.commandSelection + suggestions.length - 1) % suggestions.length;
        this.render();
        return;
      }
      if (key.name === "down") {
        this.commandSelection = (this.commandSelection + 1) % suggestions.length;
        this.render();
        return;
      }
      if (key.name === "tab" || key.name === "return") {
        await this.selectSuggestion(suggestions[this.commandSelection] ?? suggestions[0]!);
        this.render();
        return;
      }
      if (key.name === "escape") {
        this.inputBuffer = "";
        this.cursor = 0;
        this.commandSelection = 0;
        this.render();
        return;
      }
    }
    const interaction = this.currentInteraction();
    if (!this.inputBuffer && interaction) {
      const visibleChoiceCount = Math.min(interaction.choices.length, 6);
      if (this.interactionSelection >= visibleChoiceCount) {
        this.interactionSelection = 0;
      }
      if (key.name === "up" && visibleChoiceCount > 0) {
        this.interactionSelection = (this.interactionSelection + visibleChoiceCount - 1) % visibleChoiceCount;
        this.render();
        return;
      }
      if (key.name === "down" && visibleChoiceCount > 0) {
        this.interactionSelection = (this.interactionSelection + 1) % visibleChoiceCount;
        this.render();
        return;
      }
      const choice = interactionChoiceForKey(str, key, interaction, this.interactionSelection);
      if (choice) {
        const response = await chooseInteraction(this.project, interaction.id, choice, this.activeRunId);
        this.addLog(`[supercodex] answered interaction ${interaction.id} with ${response.choiceId ?? choice}`);
        this.interactionSelection = 0;
        await this.refreshStatus();
        this.render();
        return;
      }
    } else if (!interaction) {
      this.interactionSelection = 0;
    }
    if (key.name === "return") {
      const line = this.inputBuffer;
      this.inputBuffer = "";
      this.cursor = 0;
      this.commandSelection = 0;
      const shouldExit = await this.submit(line);
      if (shouldExit) {
        finish(0);
        return;
      }
      this.render();
      return;
    }
    if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.cursor - 1) + this.inputBuffer.slice(this.cursor);
        this.cursor--;
      }
      this.commandSelection = 0;
      this.render();
      return;
    }
    if (key.name === "delete") {
      if (this.cursor < this.inputBuffer.length) {
        this.inputBuffer = this.inputBuffer.slice(0, this.cursor) + this.inputBuffer.slice(this.cursor + 1);
      }
      this.commandSelection = 0;
      this.render();
      return;
    }
    if (key.name === "left") {
      this.cursor = Math.max(0, this.cursor - 1);
      this.render();
      return;
    }
    if (key.name === "right") {
      this.cursor = Math.min(this.inputBuffer.length, this.cursor + 1);
      this.render();
      return;
    }
    if (key.name === "home") {
      this.cursor = 0;
      this.render();
      return;
    }
    if (key.name === "end") {
      this.cursor = this.inputBuffer.length;
      this.render();
      return;
    }
    if (key.name === "escape") {
      this.inputBuffer = "";
      this.cursor = 0;
      this.commandSelection = 0;
      this.render();
      return;
    }
    if (str && !key.ctrl && !key.meta && isTextInputKey(key)) {
      const text = normalizePastedText(str);
      if (text) {
        this.insertInputText(text);
      }
      this.render();
    }
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const text = normalizePastedText(await readSystemClipboardText());
      if (!text) {
        this.addLog("[supercodex] clipboard is empty or text paste is unavailable");
        return;
      }
      this.insertInputText(text);
    } catch (error) {
      this.addLog(`[supercodex] paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleRawInputData(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (!text) {
      return;
    }
    if (this.bracketedPasteBuffer !== null) {
      this.suppressPasteKeypresses();
      this.bracketedPasteBuffer += text;
      if (this.bracketedPasteBuffer.includes("\u001b[201~")) {
        const pasted = normalizePastedText(this.bracketedPasteBuffer);
        this.bracketedPasteBuffer = null;
        if (pasted) {
          this.insertInputText(pasted);
          this.render();
        }
      }
      return;
    }
    if (text.includes("\u001b[200~")) {
      this.suppressPasteKeypresses();
      if (text.includes("\u001b[201~")) {
        const pasted = normalizePastedText(text);
        if (pasted) {
          this.insertInputText(pasted);
          this.render();
        }
      } else {
        this.bracketedPasteBuffer = text;
      }
      return;
    }
    if (!shouldTreatRawInputAsPaste(text)) {
      return;
    }
    this.suppressPasteKeypresses();
    const pasted = normalizePastedText(text);
    if (pasted) {
      this.insertInputText(pasted);
      this.render();
    }
  }

  private suppressPasteKeypresses(): void {
    this.suppressKeypressForPaste = true;
    setImmediate(() => {
      this.suppressKeypressForPaste = false;
    });
  }

  private insertInputText(text: string): void {
    this.inputBuffer = this.inputBuffer.slice(0, this.cursor) + text + this.inputBuffer.slice(this.cursor);
    this.cursor += text.length;
    this.commandSelection = 0;
  }

  private async selectSuggestion(suggestion: SlashCommandSuggestion): Promise<void> {
    if (suggestion.insertText) {
      this.inputBuffer = suggestion.insertText;
      this.cursor = this.inputBuffer.length;
      this.commandSelection = 0;
      return;
    }
    this.inputBuffer = "";
    this.cursor = 0;
    this.commandSelection = 0;
    await this.submit(`/${suggestion.name}`);
  }

  private async submit(rawLine: string): Promise<boolean> {
    const line = rawLine.trim();
    if (this.options.managed) {
      const newRequest = parseNewRequest(rawLine);
      if (newRequest !== null) {
        await this.startNewSession(newRequest);
        return false;
      }
      const startRequest = parseStartRequest(rawLine);
      if (startRequest !== null) {
        if (!this.supervisorPromise) {
          this.switchActiveRun(startRequest.trim() ? sanitizeRunId(startRequest) : this.resumeRunId, "resume");
        }
        const started = await startManagedSupervisor({
          project: this.project,
          runId: this.activeRunId,
          goalOrInstruction: "",
          operatorIntervention: false,
          authManager: this.options.authManager,
          appServerOptions: this.options.appServerOptions ?? defaultAppServerOptions,
          current: this.supervisorPromise,
          report: (message) => {
            this.addLog(message);
            this.render();
          },
        });
        this.supervisorPromise = started.task;
        void started.task?.finally(() => {
          if (this.supervisorPromise === started.task) {
            this.supervisorPromise = null;
          }
          void this.refreshStatus().then(() => this.render());
        });
        return false;
      }
      const resumeRequest = parseResumeRequest(rawLine);
      if (resumeRequest !== null) {
        const selector = resumeRequest.trim();
        if (selector === "current" || selector === "--current") {
          await patchSupervisorSettings(this.project, { paused: false }, this.activeRunId);
          this.addLog("[supercodex] current run resumed from pause.");
          return false;
        }
        const sessions = await listRunSessions(this.project);
        if (!selector) {
          this.addLog(formatRunSessions(sessions));
          return false;
        }
        const selected = resolveRunSessionSelector(sessions, selector);
        if (!selected) {
          this.addLog(`No saved session matched "${selector}".`);
          this.addLog(formatRunSessions(sessions));
          return false;
        }
        if (this.supervisorPromise) {
          this.addLog("[supercodex] run is already active; wait for it to stop or interrupt it before switching sessions.");
          return false;
        }
        const prepared = await prepareRunSessionForResume(this.project, selected);
        this.switchActiveRun(prepared.runId, "resume");
        await this.transcript.sync({ nativeSessionPath: prepared.nativePath });
        this.addLog(resumeSelectionMessage(this.activeRunId));
        this.render();
        return false;
      }
      if (line && !line.startsWith("/")) {
        if (
          shouldCreateFreshRunForManagedMessage({
            supervisorRunning: Boolean(this.supervisorPromise),
            activeRunStarted: this.activeRunStarted,
            activeRunIsResume: this.activeRunIsResume,
          })
        ) {
          this.switchActiveRun(createFreshRunId(), "fresh");
        }
        const request = await requestSteer(this.project, line, this.activeRunId);
        this.activeRunStarted = true;
        this.addLog(`[supercodex] queued operator message ${request.id}`);
        if (!this.supervisorPromise) {
          const started = await startManagedSupervisor({
            project: this.project,
            runId: this.activeRunId,
            goalOrInstruction: "",
            operatorIntervention: true,
            authManager: this.options.authManager,
            appServerOptions: this.options.appServerOptions ?? defaultAppServerOptions,
            current: this.supervisorPromise,
            report: (message) => {
              this.addLog(message);
              this.render();
            },
          });
          this.supervisorPromise = started.task;
          void started.task?.finally(() => {
            if (this.supervisorPromise === started.task) {
              this.supervisorPromise = null;
            }
            void this.refreshStatus().then(() => this.render());
          });
        }
        return false;
      }
    }
    if (!line) {
      return false;
    }
    if (!line.startsWith("/")) {
      const request = await requestSteer(this.project, line, this.activeRunId);
      this.addLog(`[supercodex] queued steering message ${request.id}`);
      return false;
    }
    return await this.submitSlash(line);
  }

  private switchActiveRun(runId: string, mode: "fresh" | "resume"): void {
    this.activeRunId = sanitizeRunId(runId);
    this.activeRunStarted = mode === "resume";
    this.activeRunIsResume = mode === "resume";
    this.currentEventLog = null;
    this.currentStderrLog = null;
    this.logScrollOffset = 0;
    this.transcript.reset();
    this.forceFullRender = true;
    this.addLog(mode === "fresh" ? `[supercodex] new session ${this.activeRunId}` : `[supercodex] selected run ${this.activeRunId}`);
  }

  private async startNewSession(prompt: string): Promise<void> {
    if (!this.options.managed) {
      this.addLog("Attach mode cannot create a new session. Use `supercodex` or `supercodex tui` for managed mode.");
      return;
    }
    if (this.supervisorPromise) {
      this.addLog("[supercodex] run is already active; interrupt or wait before starting a new session.");
      return;
    }
    const previousRunId = this.activeRunId;
    this.switchActiveRun(createFreshRunId(), "fresh");
    await copySupervisorSessionPreferences(this.project, previousRunId, this.activeRunId);
    const value = prompt.trim();
    if (!value) {
      return;
    }
    this.transcript.appendUser(value);
    this.activeRunStarted = true;
    const started = await startManagedSupervisor({
      project: this.project,
      runId: this.activeRunId,
      goalOrInstruction: value,
      operatorIntervention: true,
      authManager: this.options.authManager,
      appServerOptions: this.options.appServerOptions ?? defaultAppServerOptions,
      current: this.supervisorPromise,
      report: (message) => {
        this.addLog(message);
        this.render();
      },
    });
    this.supervisorPromise = started.task;
    void started.task?.finally(() => {
      if (this.supervisorPromise === started.task) {
        this.supervisorPromise = null;
      }
      void this.refreshStatus().then(() => this.render());
    });
  }

  private async submitSlash(line: string): Promise<boolean> {
    const { command, arg } = parseSlashCommand(line);
    switch (command) {
      case "":
      case "help":
        this.addLog(slashHelpText());
        return false;
      case "exit":
      case "quit":
        return true;
      case "status":
        await this.refreshStatus();
        this.addLog(JSON.stringify(this.status, null, 2));
        return false;
      case "runs":
        this.addLog(JSON.stringify(await runSessionsPayload(this.project), null, 2));
        return false;
      case "interactions":
        this.addLog(JSON.stringify(await readPendingInteractions(this.project, this.activeRunId), null, 2));
        return false;
      case "approve": {
        const response = await chooseInteraction(this.project, arg || "accept", arg ? "accept" : null, this.activeRunId);
        this.addLog(`[supercodex] answered interaction ${response.id} with ${response.choiceId ?? "accept"}`);
        await this.refreshStatus();
        return false;
      }
      case "approve-session": {
        const response = await chooseInteraction(this.project, arg || "accept-session", arg ? "accept-session" : null, this.activeRunId);
        this.addLog(`[supercodex] answered interaction ${response.id} with ${response.choiceId ?? "accept-session"}`);
        await this.refreshStatus();
        return false;
      }
      case "deny": {
        const response = await chooseInteraction(this.project, arg || "decline", arg ? "decline" : null, this.activeRunId);
        this.addLog(`[supercodex] answered interaction ${response.id} with ${response.choiceId ?? "decline"}`);
        await this.refreshStatus();
        return false;
      }
      case "cancel": {
        const response = await chooseInteraction(this.project, arg || "cancel", arg ? "cancel" : null, this.activeRunId);
        this.addLog(`[supercodex] answered interaction ${response.id} with ${response.choiceId ?? "cancel"}`);
        await this.refreshStatus();
        return false;
      }
      case "answer": {
        if (!arg) {
          this.addLog("Usage: /answer <text-or-json>");
          return false;
        }
        const response = await answerInteraction(this.project, arg, null, this.activeRunId);
        this.addLog(`[supercodex] answered interaction ${response.id} with freeform input`);
        await this.refreshStatus();
        return false;
      }
      case "start":
        this.addLog("This TUI is attach-only. Use `supercodex` or `supercodex tui` to start a managed run from the TUI.");
        return false;
      case "new":
        await this.startNewSession(arg);
        return false;
      case "model":
        if (!arg) {
          this.addLog(JSON.stringify(await readSupervisorSettings(this.project, this.activeRunId), null, 2));
          return false;
        }
        await patchSupervisorSettings(this.project, { model: arg }, this.activeRunId);
        this.addLog(`[supercodex] model set for next turn: ${arg}`);
        return false;
      case "reasoning":
        if (!arg) {
          this.addLog(JSON.stringify(await readSupervisorSettings(this.project, this.activeRunId), null, 2));
          return false;
        }
        await patchSupervisorSettings(this.project, { reasoningEffort: parseReasoningEffort(arg) }, this.activeRunId);
        this.addLog(`[supercodex] reasoning set for next turn: ${arg}`);
        return false;
      case "auth":
        if (!arg) {
          this.addLog(JSON.stringify({ accounts: await this.options.authManager.listAccounts(), active: await this.options.authManager.activeAccount() }, null, 2));
          return false;
        }
        if (await shouldApplyAuthImmediately(this.project, this.activeRunId, Boolean(this.supervisorPromise))) {
          await this.options.authManager.useAccount(arg);
          await patchSupervisorSettings(this.project, { pendingAuthName: null }, this.activeRunId);
          await this.refreshStatus();
          this.addLog(`[supercodex] auth switched immediately: ${this.status.activeAuth ?? arg}`);
          return false;
        }
        await patchSupervisorSettings(this.project, { pendingAuthName: arg }, this.activeRunId);
        this.addLog(`[supercodex] auth set for next turn: ${arg}`);
        return false;
      case "permissions":
      case "permission":
      case "perms":
        if (!arg) {
          this.addLog(formatPermissionsHelp(await readSupervisorSettings(this.project, this.activeRunId)));
          return false;
        }
        {
          const next = await patchSupervisorSettings(this.project, parsePermissionSetting(arg), this.activeRunId);
          await persistCodexRuntimePreferences(this.project, this.options.authManager, next);
          this.addLog(`[supercodex] permissions set for next turn: sandbox=${next.sandbox ?? defaultAppServerOptions.sandbox} approval=${next.approvalPolicy ?? defaultAppServerOptions.approvalPolicy}`);
        }
        return false;
      case "sandbox":
        if (!arg) {
          this.addLog(formatPermissionsHelp(await readSupervisorSettings(this.project, this.activeRunId)));
          return false;
        }
        {
          const next = await patchSupervisorSettings(this.project, { sandbox: parseSandboxMode(arg) }, this.activeRunId);
          await persistCodexRuntimePreferences(this.project, this.options.authManager, next);
          this.addLog(`[supercodex] sandbox set for next turn: ${next.sandbox}`);
        }
        return false;
      case "approval":
      case "ask-for-approval":
        if (!arg) {
          this.addLog(formatPermissionsHelp(await readSupervisorSettings(this.project, this.activeRunId)));
          return false;
        }
        {
          const next = await patchSupervisorSettings(this.project, { approvalPolicy: parseApprovalPolicy(arg) }, this.activeRunId);
          await persistCodexRuntimePreferences(this.project, this.options.authManager, next);
          this.addLog(`[supercodex] approval set for next turn: ${next.approvalPolicy}`);
        }
        return false;
      case "fresh-next":
        await patchSupervisorSettings(this.project, { forceFreshNext: true }, this.activeRunId);
        this.addLog("[supercodex] next cycle will start a fresh Codex thread.");
        return false;
      case "interrupt": {
        const request = await requestTurnInterrupt(this.project, arg, this.activeRunId);
        this.addLog(`[supercodex] interrupt queued ${request.id}`);
        return false;
      }
      case "pause":
        await patchSupervisorSettings(this.project, { paused: true }, this.activeRunId);
        this.addLog("[supercodex] run will pause before the next turn.");
        return false;
      case "resume":
        if (arg === "current" || arg === "--current") {
          await patchSupervisorSettings(this.project, { paused: false }, this.activeRunId);
          this.addLog("[supercodex] current run resumed from pause.");
          return false;
        }
        {
          const sessions = await listRunSessions(this.project);
          if (!arg) {
            this.addLog(formatRunSessions(sessions));
            return false;
          }
          const selected = resolveRunSessionSelector(sessions, arg);
          if (!selected) {
            this.addLog(`No saved session matched "${arg}".`);
            this.addLog(formatRunSessions(sessions));
            return false;
          }
          if (!this.options.managed) {
            this.addLog("Attach mode can inspect sessions, but only managed TUI can resume one.");
            return false;
          }
          if (this.supervisorPromise) {
            this.addLog("[supercodex] run is already active; wait for it to stop or interrupt it before switching sessions.");
            return false;
          }
          const prepared = await prepareRunSessionForResume(this.project, selected);
          this.switchActiveRun(prepared.runId, "resume");
          await this.transcript.sync({ nativeSessionPath: prepared.nativePath });
          this.addLog(resumeSelectionMessage(this.activeRunId));
          this.render();
        }
        return false;
      default:
        this.addLog(`Unknown command: /${command}`);
        this.addLog(slashHelpText());
        return false;
    }
  }

  private suggestions(): SlashCommandSuggestion[] {
    return slashCommandSuggestions(this.inputBuffer, this.cursor).slice(0, 10);
  }

  private currentInteraction(): (InteractionRecord & { path?: string }) | null {
    const interactions = Array.isArray(this.status.interactions) ? this.status.interactions : [];
    const first = interactions.find(isObject);
    return first ? (first as InteractionRecord & { path?: string }) : null;
  }

  private addLog(message: string): void {
    this.transcript.appendLocal(message);
  }

  private render(): void {
    const columns = Math.max(60, output.columns ?? 100);
    const rows = Math.max(20, output.rows ?? 30);
    const suggestions = this.suggestions();
    const interaction = suggestions.length === 0 ? this.currentInteraction() : null;
    if (this.commandSelection >= suggestions.length) {
      this.commandSelection = 0;
    }
    if (interaction) {
      this.interactionSelection = clampSelection(this.interactionSelection, Math.min(interaction.choices.length, 6));
    } else {
      this.interactionSelection = 0;
    }
    const prompt = this.options.managed ? "> " : "attach> ";
    const screen = buildTuiFrame({
      columns,
      rows,
      modeLabel: this.options.managed ? "managed" : "attach-only",
      runId: this.activeRunId,
      project: this.project,
      logs: this.transcript.snapshot().lines,
      logScrollOffset: this.logScrollOffset,
      status: this.status,
      suggestions,
      commandSelection: this.commandSelection,
      interaction,
      interactionSelection: this.interactionSelection,
      inputPrompt: prompt,
      inputBuffer: this.inputBuffer,
      inputCursor: this.cursor,
    });
    const frame = screen.frame;
    const patch = renderFrameDiff(this.lastFrame, frame, this.forceFullRender);
    if (patch) {
      output.write(patch);
    }
    this.lastFrame = frame;
    this.forceFullRender = false;
  }

  private sidePanel(width: number): string[] {
    const settings = isObject(this.status.settings) ? this.status.settings : {};
    const effectiveCodexConfig = isObject(this.status.effectiveCodexConfig) ? this.status.effectiveCodexConfig : {};
    const interactions = Array.isArray(this.status.interactions) ? this.status.interactions : [];
    const model = String(settings.model ?? effectiveCodexConfig.model ?? "unset");
    const reasoning = String(settings.reasoningEffort ?? effectiveCodexConfig.reasoningEffort ?? "unset");
    return [
      "Status",
      `done: ${String(this.status.done ?? false)}`,
      `mode: ${String(this.status.mode ?? "unknown")}`,
      `phase: ${String(this.status.phase ?? "unknown")}`,
      `stage: ${String(this.status.stage ?? "none")}`,
      `task: ${String(this.status.task ?? "none")}`,
      `next: ${String(this.status.nextWork ?? "none")}`,
      "",
      "Runtime",
      `status: ${String(this.status.runtimeStatus ?? "idle")}`,
      `thread: ${shorten(String(this.status.threadId ?? "none"), width - 8)}`,
      `turn: ${shorten(String(this.status.turnId ?? "none"), width - 6)}`,
      `requests: ${interactions.length}`,
      "",
      "Settings",
      `model: ${shorten(model, width - 7)}`,
      `reasoning: ${shorten(reasoning, width - 11)}`,
      `auth: ${String(this.status.activeAuth ?? "none")}`,
      "",
      "Commands",
      "/start [run-id]",
      "/model <name>",
      "/reasoning xhigh",
      "/auth <name>",
      "/interrupt [prompt]",
      "/approve  /deny",
      "/answer <text>",
      "/pause  /resume",
      "/exit",
    ];
  }

  private interactionPanel(interaction: InteractionRecord, columns: number): string[] {
    const lines = [
      horizontal(columns),
      padRight(color(" Interaction Required ", "yellow"), columns),
      padRight(shorten(`${interaction.title}: ${interaction.summary}`, columns), columns),
    ];
    const choices = interaction.choices.slice(0, 6);
    for (const [index, choice] of choices.entries()) {
      const hotkey = index + 1;
      const description = choice.description ? ` - ${choice.description}` : "";
      const marker = index === this.interactionSelection ? "> " : "  ";
      const clipped = shorten(`${marker}${hotkey}. ${choice.label}${description}`, columns);
      lines.push(padRight(index === this.interactionSelection ? invert(clipped) : clipped, columns));
    }
    lines.push(padRight(shorten("Up/Down choose, Enter confirms. 1-6, A=approve, S=session, D=deny, C=cancel. Or /answer <text-or-json>.", columns), columns));
    return lines;
  }
}

export async function handleAttachInput(
  projectInput: string,
  runIdInput: string | null | undefined,
  rawLine: string,
  authManager: CodexAuthManager,
  options: { supervisorRunning?: boolean } = {},
): Promise<boolean> {
  const project = resolve(projectInput);
  const runId = sanitizeRunId(runIdInput);
  const line = rawLine.trim();
  if (!line) {
    return false;
  }
  if (!line.startsWith("/")) {
    const request = await requestSteer(project, line, runId);
    console.log(`[supercodex] queued steering message ${request.id}`);
    return false;
  }

  const { command, arg } = parseSlashCommand(line);
  switch (command) {
    case "":
    case "help":
      printSlashHelp();
      return false;
    case "exit":
    case "quit":
      return true;
    case "status":
      await printAttachStatus(project, runId, authManager);
      return false;
    case "runs":
      await printRuns(project);
      return false;
    case "interactions":
      console.log(JSON.stringify(await readPendingInteractions(project, runId), null, 2));
      return false;
    case "approve":
    case "approve-session":
    case "deny":
    case "cancel": {
      const choice = command === "approve" ? "accept" : command === "approve-session" ? "accept-session" : command === "deny" ? "decline" : "cancel";
      const response = await chooseInteraction(project, arg || choice, arg ? choice : null, runId);
      console.log(`[supercodex] answered interaction ${response.id} with ${response.choiceId ?? choice}`);
      return false;
    }
    case "answer": {
      if (!arg) {
        console.log("Usage: /answer <text-or-json>");
        return false;
      }
      const response = await answerInteraction(project, arg, null, runId);
      console.log(`[supercodex] answered interaction ${response.id} with freeform input`);
      return false;
    }
    case "start":
      console.log("This TUI is attach-only. Use `supercodex` or `supercodex tui` to start a managed run from the TUI.");
      return false;
    case "new":
      console.log("This TUI is attach-only. Use `supercodex` or `supercodex tui` to create a new managed session with /new.");
      return false;
    case "model":
      if (!arg) {
        console.log(JSON.stringify(await readSupervisorSettings(project, runId), null, 2));
        return false;
      }
      await patchSupervisorSettings(project, { model: arg }, runId);
      console.log(`[supercodex] model set for next turn: ${arg}`);
      return false;
    case "reasoning":
      if (!arg) {
        console.log(JSON.stringify(await readSupervisorSettings(project, runId), null, 2));
        return false;
      }
      await patchSupervisorSettings(project, { reasoningEffort: parseReasoningEffort(arg) }, runId);
      console.log(`[supercodex] reasoning set for next turn: ${arg}`);
      return false;
    case "auth":
      if (!arg) {
        console.log(JSON.stringify({ accounts: await authManager.listAccounts(), active: await authManager.activeAccount() }, null, 2));
        return false;
      }
      if (await shouldApplyAuthImmediately(project, runId, Boolean(options.supervisorRunning))) {
        await authManager.useAccount(arg);
        await patchSupervisorSettings(project, { pendingAuthName: null }, runId);
        console.log(`[supercodex] auth switched immediately: ${await authManager.activeAccount()}`);
        return false;
      }
      await patchSupervisorSettings(project, { pendingAuthName: arg }, runId);
      console.log(`[supercodex] auth set for next turn: ${arg}`);
      return false;
    case "permissions":
    case "permission":
    case "perms":
      if (!arg) {
        console.log(formatPermissionsHelp(await readSupervisorSettings(project, runId)));
        return false;
      }
      {
        const next = await patchSupervisorSettings(project, parsePermissionSetting(arg), runId);
        await persistCodexRuntimePreferences(project, authManager, next);
        console.log(`[supercodex] permissions set for next turn: sandbox=${next.sandbox ?? defaultAppServerOptions.sandbox} approval=${next.approvalPolicy ?? defaultAppServerOptions.approvalPolicy}`);
      }
      return false;
    case "sandbox":
      if (!arg) {
        console.log(formatPermissionsHelp(await readSupervisorSettings(project, runId)));
        return false;
      }
      {
        const next = await patchSupervisorSettings(project, { sandbox: parseSandboxMode(arg) }, runId);
        await persistCodexRuntimePreferences(project, authManager, next);
        console.log(`[supercodex] sandbox set for next turn: ${next.sandbox}`);
      }
      return false;
    case "approval":
    case "ask-for-approval":
      if (!arg) {
        console.log(formatPermissionsHelp(await readSupervisorSettings(project, runId)));
        return false;
      }
      {
        const next = await patchSupervisorSettings(project, { approvalPolicy: parseApprovalPolicy(arg) }, runId);
        await persistCodexRuntimePreferences(project, authManager, next);
        console.log(`[supercodex] approval set for next turn: ${next.approvalPolicy}`);
      }
      return false;
    case "fresh-next":
      await patchSupervisorSettings(project, { forceFreshNext: true }, runId);
      console.log("[supercodex] next cycle will start a fresh Codex thread.");
      return false;
    case "interrupt": {
      const request = await requestTurnInterrupt(project, arg, runId);
      console.log(`[supercodex] interrupt queued ${request.id}`);
      return false;
    }
    case "pause":
      await patchSupervisorSettings(project, { paused: true }, runId);
      console.log("[supercodex] run will pause before the next turn.");
      return false;
    case "resume":
      if (arg === "current" || arg === "--current") {
        await patchSupervisorSettings(project, { paused: false }, runId);
        console.log("[supercodex] current run resumed from pause.");
        return false;
      }
      {
        const sessions = await listRunSessions(project);
        if (!arg) {
          console.log(formatRunSessions(sessions));
          return false;
        }
        const selected = resolveRunSessionSelector(sessions, arg);
        if (!selected) {
          console.log(`No saved session matched "${arg}".`);
          console.log(formatRunSessions(sessions));
          return false;
        }
        console.log(`Selected session ${selected.runId}. Launch managed TUI and run /resume ${selected.runId} to restore it.`);
      }
      return false;
    default:
      console.log(`Unknown command: /${command}`);
      printSlashHelp();
      return false;
  }
}

function renderEventLogLine(line: string): void {
  if (!line.trim()) {
    return;
  }
  let message: JsonObject;
  try {
    message = JSON.parse(line) as JsonObject;
  } catch {
    output.write(`\n[codex app-server] ${line}\n`);
    return;
  }
  const method = typeof message.method === "string" ? message.method : "";
  const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? (message.params as JsonObject) : {};
  if (method === "item/agentMessage/delta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (delta) {
      output.write(delta);
    }
    return;
  }
  if (isBulkOutputMethod(method)) {
    return;
  }
  const summary = summarizeAppServerNotification(message);
  if (summary) {
    output.write(summary.text);
  }
}

async function printAttachStatus(project: string, runId: string, authManager: CodexAuthManager, options: { freshIdle?: boolean } = {}): Promise<void> {
  if (options.freshIdle) {
    console.log(JSON.stringify(await freshIdleStatus(project, runId, authManager), null, 2));
    return;
  }
  const snapshot = await loadSnapshotForRun(project, runId);
  const runtime = await loadSupervisorRuntime(project, runId);
  const settings = await readSupervisorSettings(project, runId);
  const effectiveCodexConfig = await readEffectiveCodexConfig(authManager);
  console.log(
    JSON.stringify(
      {
        done: snapshot.done,
        runId,
        stage: snapshot.supervisorSession.stage_id ?? snapshot.state.currentStageId ?? null,
        task: snapshot.supervisorSession.task_id ?? snapshot.state.currentTaskId ?? null,
        runtime: {
          status: runtime.status ?? null,
          threadId: runtime.thread_id ?? null,
          turnId: runtime.turn_id ?? null,
        },
        settings,
        effectiveCodexConfig,
        auth: {
          active: await authManager.activeAccount(),
          accounts: await authManager.listAccounts(),
        },
        interactions: summarizeInteractions(await readPendingInteractions(project, runId)),
      },
      null,
      2,
    ),
  );
}

async function freshIdleStatus(project: string, runId: string, authManager: CodexAuthManager): Promise<JsonObject> {
  return {
    done: false,
    mode: "fresh",
    phase: "idle",
    runId,
    stage: null,
    task: null,
    nextWork: "等待输入新消息创建新 session",
    runtimeStatus: "idle",
    threadId: null,
    turnId: null,
    settings: await readSupervisorSettings(project, runId),
    effectiveCodexConfig: await readEffectiveCodexConfig(authManager),
    activeAuth: await authManager.activeAccount(),
    auth: {
      active: await authManager.activeAccount(),
      accounts: await authManager.listAccounts(),
    },
    interactions: summarizeInteractions(await readPendingInteractions(project, runId)),
  };
}

async function persistCodexRuntimePreferences(project: string, authManager: CodexAuthManager, settings: { model?: string | null; reasoningEffort?: AppServerOptions["reasoningEffort"] | null; sandbox?: AppServerOptions["sandbox"] | null; approvalPolicy?: AppServerOptions["approvalPolicy"] | null }): Promise<void> {
  await authManager.ensureHighAccessConfig(project, {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    sandbox: settings.sandbox,
    approvalPolicy: settings.approvalPolicy,
  });
}

function formatPermissionsHelp(settings: { sandbox?: string | null; approvalPolicy?: string | null }): string {
  const sandbox = settings.sandbox ?? defaultAppServerOptions.sandbox;
  const approval = settings.approvalPolicy ?? defaultAppServerOptions.approvalPolicy;
  return [
    `current permissions: ${formatPermissionModeLabel(settings)}; sandbox=${sandbox} approval=${approval}`,
    "modes: /permissions default | auto-review | full-access",
    "labels: Default permissions | Auto-review | Full access",
    "advanced: /sandbox <mode> | /approval <policy>",
    "sandbox values: read-only, workspace-write, danger-full-access",
    "approval values: never, on-failure, on-request, untrusted",
  ].join("\n");
}

function formatPermissionModeLabel(settings: { sandbox?: string | null; approvalPolicy?: string | null }): string {
  const sandbox = settings.sandbox ?? defaultAppServerOptions.sandbox;
  const approval = settings.approvalPolicy ?? defaultAppServerOptions.approvalPolicy;
  if (!settings.sandbox && !settings.approvalPolicy) {
    return "Default permissions";
  }
  if (sandbox === "danger-full-access" && approval === "never") {
    return "Full access";
  }
  if (sandbox === "workspace-write" && approval === "on-request") {
    return "Auto-review";
  }
  return "Custom";
}

function summarizeInteractions(interactions: InteractionRecord[]): JsonObject[] {
  return interactions.map((interaction) => ({
    id: interaction.id,
    title: interaction.title,
    summary: interaction.summary,
    choices: interaction.choices.map((choice) => choice.id),
  }));
}

async function printRuns(project: string): Promise<void> {
  console.log(JSON.stringify(await runSessionsPayload(project), null, 2));
}

function printSlashHelp(): void {
  console.log(slashHelpText());
}

function parseSlashCommand(line: string): { command: string; arg: string } {
  const trimmed = line.slice(1).trim();
  const space = trimmed.search(/\s/);
  if (space < 0) {
    return { command: canonicalSlashCommandName(trimmed), arg: "" };
  }
  return { command: canonicalSlashCommandName(trimmed.slice(0, space)), arg: trimmed.slice(space).trim() };
}

async function shouldApplyAuthImmediately(project: string, runId: string, supervisorRunning: boolean): Promise<boolean> {
  if (supervisorRunning) {
    return false;
  }
  const runtime = await loadSupervisorRuntime(project, runId);
  return !isActiveRuntimeStatus(runtime.status);
}

function isActiveRuntimeStatus(value: unknown): boolean {
  return value === "starting" || value === "thread-started" || value === "running";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export interface TuiKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export interface TerminalFrame {
  columns: number;
  rows: number;
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

function summarizeEventLogLine(line: string): string[] {
  if (!line.trim()) {
    return [];
  }
  let message: JsonObject;
  try {
    message = JSON.parse(line) as JsonObject;
  } catch {
    return [`[codex app-server] ${line}`];
  }
  const method = typeof message.method === "string" ? message.method : "";
  const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? (message.params as JsonObject) : {};
  if (method === "item/agentMessage/delta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    return delta ? [delta] : [];
  }
  if (isBulkOutputMethod(method)) {
    return [];
  }
  const summary = summarizeAppServerNotification(message);
  return summary ? [summary.text.trimEnd()] : [];
}

function isBulkOutputMethod(method: string): boolean {
  return method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta" || method === "item/fileChange/outputDelta";
}

export function resumeSelectionMessage(runId: string): string {
  return `[supercodex] selected saved session ${sanitizeRunId(runId)}. Type a message to continue it, or use /start ${sanitizeRunId(runId)} to auto-run saved work.`;
}

export function interactionChoiceForKey(
  str: string,
  key: TuiKey,
  interaction: Pick<InteractionRecord, "choices">,
  selectedIndex = 0,
): string | null {
  if (key.name === "return") {
    return interaction.choices[clampSelection(selectedIndex, interaction.choices.length)]?.id ?? null;
  }
  if (key.name && /^[1-6]$/.test(key.name)) {
    return interaction.choices[Number(key.name) - 1]?.id ?? null;
  }
  const value = str.toLowerCase();
  if (value === "a") {
    return "accept";
  }
  if (value === "s") {
    return "accept-session";
  }
  if (value === "d") {
    return "decline";
  }
  if (value === "c") {
    return "cancel";
  }
  return null;
}

function clampSelection(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (!Number.isFinite(index) || index < 0) {
    return 0;
  }
  return Math.min(index, length - 1);
}

function isPasteKey(str: string, key: TuiKey): boolean {
  return Boolean(key.ctrl && key.name?.toLowerCase() === "v") || str === "\u0016" || key.sequence === "\u0016";
}

function isTextInputKey(key: TuiKey): boolean {
  if (!key.name) {
    return true;
  }
  return !new Set(["up", "down", "left", "right", "home", "end", "return", "backspace", "delete", "escape", "tab"]).has(key.name);
}

function transcriptScrollDelta(key: TuiKey, terminalRows: number): number {
  const page = Math.max(3, Math.floor(terminalRows / 2));
  if (key.name === "pageup" || (key.ctrl && key.name?.toLowerCase() === "u")) {
    return page;
  }
  if (key.name === "pagedown" || (key.ctrl && key.name?.toLowerCase() === "d")) {
    return -page;
  }
  return 0;
}

export function shouldTreatRawInputAsPaste(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes("\u001b[200~") || value.includes("\u001b[201~")) {
    return true;
  }
  if (value === "\u0016" || value === "\r" || value === "\n") {
    return false;
  }
  if (/^\u001b\[[0-9;?]*[A-Za-z~]$/.test(value)) {
    return false;
  }
  const normalized = normalizePastedText(value);
  if (!normalized) {
    return false;
  }
  if (value.includes("\r") || value.includes("\n")) {
    return normalized.trim().length > 0;
  }
  return Array.from(value).length > 1 && !value.includes("\u001b");
}

export function normalizePastedText(value: string): string {
  const withoutBracketedPaste = value.replace(/\u001b\[200~/g, "").replace(/\u001b\[201~/g, "");
  const withoutTrailingBreaks = withoutBracketedPaste.replace(/(?:\r\n|\r|\n)+$/g, "");
  return withoutTrailingBreaks
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function inputViewport(prompt: string, inputText: string, cursor: number, columns: number): { line: string; cursorColumn: number } {
  const boundedCursor = Math.max(0, Math.min(cursor, inputText.length));
  const visibleText = inputText.replace(/\n/g, "\\n");
  const visibleCursor = inputText.slice(0, boundedCursor).replace(/\n/g, "\\n").length;
  const available = Math.max(1, columns - prompt.length - 1);
  const start = Math.max(0, visibleCursor - available);
  const visible = visibleText.slice(start, start + available);
  const cursorColumn = Math.max(1, Math.min(columns, prompt.length + (visibleCursor - start) + 1));
  return { line: `${prompt}${visible}`.slice(0, columns), cursorColumn };
}

export function createTerminalFrame(input: {
  lines: string[];
  columns: number;
  rows: number;
  cursorRow: number;
  cursorColumn: number;
}): TerminalFrame {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const lines: string[] = [];
  for (let index = 0; index < rows; index++) {
    lines.push(padRight(input.lines[index] ?? "", columns));
  }
  return {
    columns,
    rows,
    lines,
    cursorRow: Math.max(1, Math.min(rows, Math.floor(input.cursorRow))),
    cursorColumn: Math.max(1, Math.min(columns, Math.floor(input.cursorColumn))),
  };
}

export function renderFrameDiff(previous: TerminalFrame | null, next: TerminalFrame, forceFull = false): string {
  const cursor = `\x1b[${next.cursorRow};${next.cursorColumn}H`;
  const full = forceFull || !previous || previous.columns !== next.columns || previous.rows !== next.rows;
  if (full) {
    return `\x1b[?25l\x1b[2J\x1b[H${next.lines.join("\n")}${cursor}\x1b[?25h`;
  }
  const chunks: string[] = [];
  for (let index = 0; index < next.rows; index++) {
    if (previous.lines[index] !== next.lines[index]) {
      chunks.push(`\x1b[${index + 1};1H${next.lines[index] ?? ""}`);
    }
  }
  const cursorChanged = previous.cursorRow !== next.cursorRow || previous.cursorColumn !== next.cursorColumn;
  if (chunks.length === 0 && !cursorChanged) {
    return "";
  }
  return `\x1b[?25l${chunks.join("")}${cursor}\x1b[?25h`;
}

async function readSystemClipboardText(): Promise<string> {
  const candidates = clipboardCommands();
  const errors: string[] = [];
  for (const [command, args] of candidates) {
    try {
      return await execFileText(command, args);
    } catch (error) {
      errors.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.length > 0 ? errors.join("; ") : "no clipboard command available");
}

function clipboardCommands(): Array<[string, string[]]> {
  if (process.platform === "win32") {
    const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw";
    return [
      ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]],
      ["pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script]],
    ];
  }
  if (process.platform === "darwin") {
    return [["pbpaste", []]];
  }
  return [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-out"]],
    ["xsel", ["--clipboard", "--output"]],
  ];
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 4, timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function horizontal(width: number): string {
  return "-".repeat(Math.max(0, width));
}

function padRight(value: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const visibleLength = ansiVisibleLength(value);
  if (visibleLength >= safeWidth) {
    return truncateAnsiVisible(value, safeWidth);
  }
  return value + " ".repeat(safeWidth - visibleLength);
}

function wrapLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const clean = stripAnsi(line).replace(/\t/g, "  ");
    if (!clean) {
      result.push("");
      continue;
    }
    for (let index = 0; index < clean.length; index += width) {
      result.push(clean.slice(index, index + width));
    }
  }
  return result;
}

function shorten(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}

function invert(value: string): string {
  return `\x1b[7m${value}\x1b[27m`;
}

function color(value: string, name: "cyan" | "yellow"): string {
  const code = name === "cyan" ? 36 : 33;
  return `\x1b[${code}m${value}\x1b[39m`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function ansiVisibleLength(value: string): number {
  return stripAnsi(value).length;
}

function truncateAnsiVisible(value: string, width: number): string {
  if (width <= 0) {
    return value.includes("\x1b[") ? "\x1b[0m" : "";
  }
  let visible = 0;
  let outputText = "";
  let sawAnsi = false;
  for (let index = 0; index < value.length; ) {
    if (value[index] === "\x1b" && value[index + 1] === "[") {
      const match = value.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        sawAnsi = true;
        outputText += match[0];
        index += match[0].length;
        continue;
      }
    }
    if (visible >= width) {
      break;
    }
    outputText += value[index] ?? "";
    visible++;
    index++;
  }
  return sawAnsi ? `${outputText}\x1b[0m` : outputText;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function printNativeSessionTranscript(nativeSessionPath?: string | null): Promise<void> {
  if (!nativeSessionPath) {
    return;
  }
  const transcript = new TuiTranscriptSource({ maxLines: 5000 });
  await transcript.sync({ nativeSessionPath });
  const lines = transcript.snapshot().lines;
  if (lines.length > 0) {
    output.write(`\n[supercodex] loaded Codex session history from ${nativeSessionPath}\n${lines.join("\n")}\n`);
  }
}

class LogTail {
  private readonly offsets = new Map<string, number>();

  async poll(path: string, render: (line: string) => void): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    const previous = this.offsets.get(path);
    const start = previous === undefined ? Math.max(0, size - 64 * 1024) : previous;
    if (size <= start) {
      this.offsets.set(path, size);
      return;
    }
    const handle = await open(path, "r");
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      this.offsets.set(path, size);
      for (const line of buffer.toString("utf8").split(/\r?\n/)) {
        if (line) {
          render(line);
        }
      }
    } finally {
      await handle.close();
    }
  }
}
