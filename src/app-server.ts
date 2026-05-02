import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CodexAuthManager } from "./auth.js";
import { markControlHandled, markControlObserved, readPendingControls } from "./control.js";
import { appendLog, nowIso, writeTextAtomic } from "./fs-utils.js";
import {
  captureInteractionRequest,
  isInteractionRequest,
  markInteractionHandled,
  readInteractionResponses,
  summarizeInteraction,
} from "./interactions.js";
import { summarizeAppServerNotification } from "./app-server-events.js";
import { shouldSuppressCodexStderr } from "./codex-stderr.js";
import { patchSupervisorSettings } from "./settings.js";
import type { CodexApprovalPolicy, CodexRunResult, CodexSandboxMode, JsonObject, ReasoningEffort } from "./types.js";
import { saveSupervisorRuntime } from "./workspace.js";

export { summarizeAppServerNotification } from "./app-server-events.js";

export interface AppServerOptions {
  codexBin: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  timeoutSeconds?: number | null;
  idleTimeoutSeconds?: number | null;
  startupTimeoutSeconds?: number | null;
  streamConsole: boolean;
}

export const defaultAppServerOptions: AppServerOptions = {
  codexBin: "codex",
  model: null,
  reasoningEffort: null,
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  startupTimeoutSeconds: 180,
  streamConsole: true,
};

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type RequestId = string | number;

export class AppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRequest>();
  private notificationHandlers: Array<(message: JsonObject) => void> = [];
  private serverRequestHandlers: Array<(message: JsonObject) => void | Promise<void>> = [];
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private readonly stderrTail: string[] = [];
  private lastActivityAt = performance.now();
  private lastActivityKind = "spawn";

  constructor(
    private readonly options: AppServerOptions,
    private readonly project: string,
    private readonly stderrPath: string,
    private readonly eventLogPath: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  command(): string[] {
    return [this.options.codexBin, "app-server", "--listen", "stdio://"];
  }

  spawnCommand(): string[] {
    const invocation = resolveCodexInvocation(this.options.codexBin);
    return [invocation.command, ...invocation.argsPrefix, "app-server", "--listen", "stdio://"];
  }

  async start(): Promise<JsonObject> {
    await mkdir(join(this.project, ".supercodex", "logs", "supercodex"), { recursive: true });
    const command = this.spawnCommand();
    const bin = command[0]!;
    const args = command.slice(1);
    const proc = spawn(bin, args, {
      cwd: this.project,
      env: this.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;
    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`codex app-server exited before completing request. ${this.exitSummary()}\n${this.stderrText()}`));
      }
      this.pending.clear();
    });

    createInterface({ input: proc.stdout }).on("line", (line) => {
      void this.handleLine(line).catch((error) => {
        if (this.options.streamConsole) {
          console.error(`[supercodex] failed to process app-server output: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    });
    createInterface({ input: proc.stderr }).on("line", (line) => {
      const suppress = shouldSuppressCodexStderr(line);
      if (!suppress) {
        this.recordActivity("stderr");
        this.recordStderrLine(line);
      }
      void appendLog(this.stderrPath, `${line}\n`).catch(() => undefined);
      if (this.options.streamConsole && !suppress) {
        console.error(`[codex app-server] ${line}`);
      }
    });

    const init = await this.request(
      "initialize",
      {
        clientInfo: { name: "supercodex", title: "SuperCodex", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      },
      (this.options.startupTimeoutSeconds ?? 180) * 1000,
    );
    this.notify("initialized");
    return init;
  }

  onNotification(handler: (message: JsonObject) => void): void {
    this.notificationHandlers.push(handler);
  }

  onServerRequest(handler: (message: JsonObject) => void | Promise<void>): void {
    this.serverRequestHandlers.push(handler);
  }

  request(method: string, params?: unknown, timeoutMs = 300_000): Promise<JsonObject> {
    if (!this.process?.stdin.writable) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for app-server response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.process!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }
    const payload = params === undefined ? { method } : { method, params };
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id: RequestId, result: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      return;
    }
    if (!proc.killed) {
      proc.kill();
    }
    this.process = null;
  }

  hasExited(): boolean {
    return this.exited;
  }

  exitSummary(): string {
    if (!this.exited) {
      return "codex app-server is still running";
    }
    return `codex app-server exited code=${this.exitCode ?? "null"} signal=${this.exitSignal ?? "null"}`;
  }

  stderrText(): string {
    return this.stderrTail.join("\n");
  }

  idleSeconds(): number {
    return (performance.now() - this.lastActivityAt) / 1000;
  }

  lastActivitySummary(): string {
    return this.lastActivityKind;
  }

  private async handleLine(line: string): Promise<void> {
    this.recordActivity("stdout");
    await appendLog(this.eventLogPath, `${line}\n`);
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      if (this.options.streamConsole) {
        console.log(`[codex app-server] ${line}`);
      }
      return;
    }
    this.recordActivity(typeof message.method === "string" ? message.method : typeof message.id === "number" ? "response" : "stdout-json");
    if (typeof message.id === "number" || typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve((message.result ?? {}) as JsonObject);
        }
        return;
      }
      if (typeof message.method === "string") {
        for (const handler of this.serverRequestHandlers) {
          await handler(message);
        }
      }
      return;
    }
    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  private recordStderrLine(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 200) {
      this.stderrTail.shift();
    }
  }

  private recordActivity(kind: string): void {
    this.lastActivityAt = performance.now();
    this.lastActivityKind = kind;
  }
}

export class AppServerRunner {
  constructor(
    private readonly options: AppServerOptions = defaultAppServerOptions,
    private readonly authManager?: CodexAuthManager | null,
  ) {}

  async run(input: {
    prompt: string;
    project: string;
    threadId?: string | null;
    resume?: boolean;
    runId?: string | null;
    stageId?: string | null;
    taskId?: string | null;
    workKind?: string | null;
  }): Promise<CodexRunResult> {
    const project = resolve(input.project);
    const logDir = join(project, ".supercodex", "logs", "supercodex");
    await mkdir(logDir, { recursive: true });
    const stamp = nowIso().replaceAll(":", "-");
    const promptPath = join(logDir, `${stamp}-prompt.md`);
    const eventLogPath = join(logDir, `${stamp}-app-server.jsonl`);
    const stderrPath = join(logDir, `${stamp}-app-server-stderr.log`);
    await writeTextAtomic(promptPath, input.prompt);
    await writeFile(eventLogPath, "", "utf8");
    await writeFile(stderrPath, "", "utf8");

    const env = this.authManager
      ? await this.authManager.prepareEnvironment(process.env, project, {
          model: this.options.model,
          reasoningEffort: this.options.reasoningEffort,
          sandbox: this.options.sandbox,
          approvalPolicy: this.options.approvalPolicy,
        })
      : process.env;
    const client = new AppServerClient(this.options, project, stderrPath, eventLogPath, env);
    const started = performance.now();
    let activeThreadId = input.threadId ?? null;
    let activeTurnId: string | null = null;
    let classification = "failed";
    let returnCode = 1;
    let operatorMessage: string | null = null;
    let controlId: string | null = null;
    let completion: JsonObject | null = null;
    const command = client.command();

    if (this.options.streamConsole) {
      console.log(`[supercodex] codex app-server command: ${formatCommand(command)}`);
      console.log(`[supercodex] prompt log: ${promptPath}`);
      console.log(`[supercodex] event log: ${eventLogPath}`);
      console.log(`[supercodex] stderr log: ${stderrPath}`);
      if (env.CODEX_HOME) {
        console.log(`[supercodex] CODEX_HOME: ${env.CODEX_HOME}`);
      }
    }

    try {
      await saveSupervisorRuntime(
        project,
        {
          status: "starting",
          thread_id: activeThreadId,
          turn_id: activeTurnId,
          eventLogPath,
          stderrPath,
          promptPath,
          command: formatCommand(command),
          stage_id: input.stageId ?? null,
          task_id: input.taskId ?? null,
          work_kind: input.workKind ?? null,
          startedAt: nowIso(),
        },
        input.runId,
      );
      await client.start();
      client.onServerRequest(async (message) => {
        if (!isInteractionRequest(message)) {
          if (this.options.streamConsole) {
            console.error(`[codex interaction] unsupported server request ${String(message.method ?? "unknown")}`);
          }
          return;
        }
        const interaction = await captureInteractionRequest(project, message, input.runId);
        if (this.options.streamConsole) {
          console.error(`[codex interaction] ${summarizeInteraction(interaction)}`);
          console.error(`[codex interaction] respond in TUI with /approve, /approve-session, /deny, /cancel, or /answer <text>`);
        }
      });
      client.onNotification((message) => {
        if (message.method === "turn/completed" && isPlainObject(message.params)) {
          const turn = isPlainObject(message.params.turn) ? message.params.turn : null;
          if (!activeTurnId || turn?.id === activeTurnId) {
            completion = message.params;
          }
        }
        if (this.options.streamConsole) {
          streamNotificationSummary(message);
        }
        if (message.method === "item/agentMessage/delta" && this.options.streamConsole && isPlainObject(message.params)) {
          const delta = typeof message.params.delta === "string" ? message.params.delta : "";
          if (delta) {
            process.stdout.write(delta);
          }
        }
      });

      const threadResponse = input.resume && input.threadId
        ? await client.request("thread/resume", this.threadResumeParams(input.threadId, project))
        : await client.request("thread/start", this.threadStartParams(project));
      const thread = isPlainObject(threadResponse.thread) ? threadResponse.thread : {};
      activeThreadId = typeof thread.id === "string" ? thread.id : activeThreadId;
      if (!activeThreadId) {
        throw new Error("app-server did not return a thread id");
      }
      await saveSupervisorRuntime(
        project,
        {
          status: "thread-started",
          thread_id: activeThreadId,
          turn_id: activeTurnId,
          eventLogPath,
          stderrPath,
          promptPath,
          command: formatCommand(command),
          stage_id: input.stageId ?? null,
          task_id: input.taskId ?? null,
          work_kind: input.workKind ?? null,
          startedAt: nowIso(),
        },
        input.runId,
      );

      const turnResponse = await client.request("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
      });
      const turn = isPlainObject(turnResponse.turn) ? turnResponse.turn : {};
      activeTurnId = typeof turn.id === "string" ? turn.id : null;
      if (!activeTurnId) {
        throw new Error("app-server did not return a turn id");
      }
      await saveSupervisorRuntime(
        project,
        {
          status: "running",
          thread_id: activeThreadId,
          turn_id: activeTurnId,
          eventLogPath,
          stderrPath,
          promptPath,
          command: formatCommand(command),
          stage_id: input.stageId ?? null,
          task_id: input.taskId ?? null,
          work_kind: input.workKind ?? null,
          startedAt: nowIso(),
        },
        input.runId,
      );

      completion = await this.waitForTurnCompletion({
        client,
        project,
        runId: input.runId,
        threadId: activeThreadId,
        turnId: activeTurnId,
        initialCompletion: completion,
        setOperator: (message, id) => {
          operatorMessage = message;
          controlId = id;
        },
      });
      const completedTurn = isPlainObject(completion.turn) ? completion.turn : {};
      const status = String(completedTurn.status ?? "");
      if (status === "completed") {
        classification = "success";
        returnCode = 0;
      } else if (status === "interrupted") {
        classification = "operator_interrupt";
        returnCode = 130;
      } else {
        classification = classifyAppServerFailure(completedTurn.error ?? completion);
        returnCode = 1;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await appendLog(stderrPath, `${text}\n`).catch(() => undefined);
      const diagnosticText = `${text}\n${client.stderrText()}`;
      classification = classifyAppServerFailure(diagnosticText);
      if (this.options.streamConsole) {
        console.error(`[supercodex] app-server error: ${text}`);
      }
      returnCode = classification === "session_not_found" ? 2 : 1;
    } finally {
      await saveSupervisorRuntime(
        project,
        {
          status: "finished",
          classification,
          returnCode,
          thread_id: activeThreadId,
          turn_id: activeTurnId,
          eventLogPath,
          stderrPath,
          promptPath,
          command: formatCommand(command),
          durationSeconds: (performance.now() - started) / 1000,
        },
        input.runId,
      ).catch(() => undefined);
      await client.stop();
    }

    return {
      returnCode,
      classification,
      promptPath,
      eventLogPath,
      stderrPath,
      threadId: activeThreadId,
      turnId: activeTurnId,
      durationSeconds: (performance.now() - started) / 1000,
      command,
      operatorMessage,
      controlId,
    };
  }

  private threadStartParams(project: string): JsonObject {
    return {
      cwd: project,
      model: this.options.model ?? null,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandbox,
      serviceName: "supercodex",
      sessionStartSource: "startup",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
  }

  private threadResumeParams(threadId: string, project: string): JsonObject {
    return {
      threadId,
      cwd: project,
      model: this.options.model ?? null,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandbox,
      persistExtendedHistory: true,
    };
  }

  private async waitForTurnCompletion(input: {
    client: AppServerClient;
    project: string;
    runId?: string | null;
    threadId: string;
    turnId: string;
    initialCompletion?: JsonObject | null;
    setOperator: (message: string | null, id: string | null) => void;
  }): Promise<JsonObject> {
    const started = performance.now();
    let nextHeartbeat = started + 30_000;
    let completed: JsonObject | null = input.initialCompletion ?? null;
    input.client.onNotification((message) => {
      if (message.method === "turn/completed" && isPlainObject(message.params)) {
        const turn = isPlainObject(message.params.turn) ? message.params.turn : null;
        if (turn?.id === input.turnId) {
          completed = message.params;
        }
      }
    });
    while (!completed) {
      const interactionResponses = await readInteractionResponses(input.project, input.runId);
      for (const response of interactionResponses) {
        input.client.respond(response.requestId, response.response);
        await markInteractionHandled(input.project, response, input.runId);
        if (this.options.streamConsole) {
          console.log(`[supercodex] answered Codex interaction ${response.id} with ${response.choiceId ?? "response"}`);
        }
      }

      const pendingControls = await readPendingControls(input.project, input.runId);
      for (const pending of pendingControls) {
        const observed = await markControlObserved(input.project, pending, input.runId);
        if (observed.action === "steer" && typeof observed.message === "string" && observed.message.trim()) {
          await input.client.request("turn/steer", {
            threadId: input.threadId,
            expectedTurnId: input.turnId,
            input: [{ type: "text", text: observed.message, text_elements: [] }],
          });
          await markControlHandled(input.project, pending, input.runId);
          continue;
        }
        if (observed.action === "interrupt") {
          input.setOperator(typeof observed.message === "string" ? observed.message : null, observed.id);
          await input.client.request("turn/interrupt", { threadId: input.threadId, turnId: input.turnId }).catch(() => ({}));
          await markControlHandled(input.project, pending, input.runId);
          return { turn: { id: input.turnId, status: "interrupted" } };
        }
        if (observed.action === "set_settings" && isPlainObject(observed.settings)) {
          await patchSupervisorSettings(input.project, observed.settings, input.runId);
          await markControlHandled(input.project, pending, input.runId);
          if (this.options.streamConsole) {
            console.log("[supercodex] settings updated; they will apply on the next Codex turn.");
          }
          continue;
        }
        if (observed.action === "auth_use" && typeof observed.authName === "string" && observed.authName.trim()) {
          await patchSupervisorSettings(input.project, { pendingAuthName: observed.authName.trim() }, input.runId);
          await markControlHandled(input.project, pending, input.runId);
          if (this.options.streamConsole) {
            console.log(`[supercodex] auth switch queued for next Codex turn: ${observed.authName.trim()}`);
          }
          continue;
        }
        if (observed.action === "fresh_next") {
          await patchSupervisorSettings(input.project, { forceFreshNext: true }, input.runId);
          await markControlHandled(input.project, pending, input.runId);
          continue;
        }
        if (observed.action === "pause" || observed.action === "resume") {
          await patchSupervisorSettings(input.project, { paused: observed.action === "pause" }, input.runId);
          await markControlHandled(input.project, pending, input.runId);
          continue;
        }
      }
      const elapsedMs = performance.now() - started;
      if (this.options.timeoutSeconds && elapsedMs >= this.options.timeoutSeconds * 1000) {
        await input.client.request("turn/interrupt", { threadId: input.threadId, turnId: input.turnId }).catch(() => ({}));
        return { turn: { id: input.turnId, status: "failed", error: { message: "Timed out while waiting for Codex turn." } } };
      }
      if (this.options.idleTimeoutSeconds && input.client.idleSeconds() >= this.options.idleTimeoutSeconds) {
        await input.client.request("turn/interrupt", { threadId: input.threadId, turnId: input.turnId }).catch(() => ({}));
        return {
          turn: {
            id: input.turnId,
            status: "failed",
            error: {
              message: `Idle timeout while waiting for Codex turn: no app-server activity for ${Math.round(
                input.client.idleSeconds(),
              )}s; last activity=${input.client.lastActivitySummary()}.`,
            },
          },
        };
      }
      if (input.client.hasExited()) {
        return {
          turn: {
            id: input.turnId,
            status: "failed",
            error: {
              message: `${input.client.exitSummary()}\n${input.client.stderrText()}`,
            },
          },
        };
      }
      if (this.options.streamConsole && performance.now() >= nextHeartbeat) {
        console.log(
          `[supercodex] waiting for Codex app-server turn... elapsed=${Math.round(elapsedMs / 1000)}s idle=${Math.round(
            input.client.idleSeconds(),
          )}s last=${input.client.lastActivitySummary()}`,
        );
        nextHeartbeat = performance.now() + 30_000;
      }
      await sleep(500);
    }
    return completed;
  }
}

export function classifyAppServerFailure(value: unknown): string {
  const code = extractCodexErrorCode(value);
  if (code === "usageLimitExceeded") {
    return "usage_limit";
  }
  if (code === "contextWindowExceeded") {
    return "context_window_exceeded";
  }
  if (
    code === "httpConnectionFailed" ||
    code === "responseStreamConnectionFailed" ||
    code === "responseStreamDisconnected" ||
    code === "responseTooManyFailedAttempts" ||
    code === "serverOverloaded"
  ) {
    return "network_transient";
  }
  if (code === "unauthorized") {
    return "unauthorized";
  }

  const text = JSON.stringify(value).toLowerCase();
  if (
    text.includes("401 unauthorized") ||
    text.includes("token_invalidated") ||
    text.includes("refresh_token_reused") ||
    text.includes("authentication token has been invalidated")
  ) {
    return "unauthorized";
  }
  if (text.includes("usage limit") || text.includes("codex/settings/usage")) {
    return "usage_limit";
  }
  if (/\b(thread|session|conversation)\b.*\bnot found\b/.test(text)) {
    return "session_not_found";
  }
  if (
    text.includes("remote compact task") ||
    text.includes("pre-sampling compact") ||
    text.includes("compact_remote") ||
    text.includes("/responses/compact")
  ) {
    return "remote_compaction_failed";
  }
  if (
    text.includes("context compaction failed") ||
    text.includes("contextcompaction") ||
    text.includes("context window")
  ) {
    return "context_compaction_failed";
  }
  if (
    ["econnreset", "etimedout", "enotfound", "network", "socket", "stream disconnected", "gateway timeout"].some(
      (pattern) => text.includes(pattern),
    )
  ) {
    return "network_transient";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    if (text.includes("idle timeout") || text.includes("no app-server activity")) {
      return "idle_timeout";
    }
    return "timeout";
  }
  return "failed";
}

export function resolveCodexInvocation(codexBin: string): { command: string; argsPrefix: string[] } {
  if (process.platform !== "win32") {
    return { command: codexBin, argsPrefix: [] };
  }

  const normalizedBase = basename(codexBin).toLowerCase();
  const candidateRoots: string[] = [];
  if (isAbsolute(codexBin)) {
    candidateRoots.push(dirname(codexBin));
  }
  if (normalizedBase === "codex" || normalizedBase === "codex.cmd" || normalizedBase === "codex.ps1") {
    const appData = process.env.APPDATA;
    if (appData) {
      candidateRoots.push(join(appData, "npm"));
    }
  }
  for (const root of candidateRoots) {
    const candidate = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(candidate)) {
      return { command: process.execPath, argsPrefix: [candidate] };
    }
  }
  return { command: codexBin, argsPrefix: [] };
}

function extractCodexErrorCode(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const info = value.codexErrorInfo ?? (isPlainObject(value.error) ? value.error.codexErrorInfo : null);
  if (typeof info === "string") {
    return info;
  }
  if (isPlainObject(info)) {
    return Object.keys(info)[0] ?? null;
  }
  return null;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function streamNotificationSummary(message: JsonObject): void {
  const summary = summarizeAppServerNotification(message);
  if (!summary) {
    return;
  }
  const target = summary.stream === "stderr" ? process.stderr : process.stdout;
  target.write(summary.text);
  if (summary.inline && !summary.text.endsWith("\n")) {
    return;
  }
}

function formatCommand(command: string[]): string {
  return command.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
