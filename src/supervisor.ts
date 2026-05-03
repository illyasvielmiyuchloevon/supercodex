import { resolve } from "node:path";
import { CodexAuthManager } from "./auth.js";
import { defaultAppServerOptions, AppServerRunner, type AppServerOptions } from "./app-server.js";
import { markControlHandled, readPendingControls } from "./control.js";
import { buildPrompt } from "./prompts.js";
import {
  chooseNextWork,
  ensureScaffold,
  loadSnapshotForRun,
  recordCheckpoint,
  recordProgress,
  saveSupervisorSession,
} from "./workspace.js";
import {
  consumeForceFreshNext,
  consumePendingAuthName,
  patchSupervisorSettings,
  readSupervisorSettings,
  sanitizeRunId,
  type SupervisorRuntimeSettings,
} from "./settings.js";
import type { CodexRunResult, WorkItem } from "./types.js";
import { isRecoverableClassification, isRunOk } from "./types.js";

export interface SupervisorConfig {
  project: string;
  goal: string;
  maxCycles: number;
  maxRetries: number;
  networkTransientMaxRetries: number;
  remoteCompactionMaxRetries: number;
  sameSessionRetryLimit: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  dryRun: boolean;
  appServerOptions: AppServerOptions;
  authManager?: CodexAuthManager | null;
  operatorIntervention?: boolean;
  runId?: string | null;
  supervisorConsole: boolean;
}

export interface Runner {
  run(input: {
    prompt: string;
    project: string;
    threadId?: string | null;
    resume?: boolean;
    runId?: string | null;
    stageId?: string | null;
    taskId?: string | null;
    workKind?: string | null;
  }): Promise<CodexRunResult>;
}

export function defaultSupervisorConfig(project: string): SupervisorConfig {
  return {
    project,
    goal: "",
    maxCycles: Number.POSITIVE_INFINITY,
    maxRetries: 10,
    networkTransientMaxRetries: 10,
    remoteCompactionMaxRetries: 20,
    sameSessionRetryLimit: 10,
    retryBaseSeconds: 5,
    retryMaxSeconds: 60,
    dryRun: false,
    appServerOptions: defaultAppServerOptions,
    authManager: null,
    operatorIntervention: false,
    runId: "default",
    supervisorConsole: true,
  };
}

export class DryRunRunner implements Runner {
  constructor(private readonly options: AppServerOptions = defaultAppServerOptions) {}

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
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { nowIso } = await import("./fs-utils.js");
    const project = resolve(input.project);
    const logDir = join(project, ".supercodex", "logs", "supercodex");
    await mkdir(logDir, { recursive: true });
    const stamp = nowIso().replaceAll(":", "-");
    const promptPath = join(logDir, `${stamp}-dry-run-prompt.md`);
    const eventLogPath = join(logDir, `${stamp}-dry-run-app-server.jsonl`);
    const stderrPath = join(logDir, `${stamp}-dry-run-stderr.log`);
    await writeFile(promptPath, input.prompt, "utf8");
    await writeFile(
      eventLogPath,
      `dry-run: app-server was not invoked\nwould-run: ${this.options.codexBin} app-server --listen stdio://\nresume=${Boolean(
        input.resume,
      )} thread=${input.threadId ?? "fresh"}\n`,
      "utf8",
    );
    await writeFile(stderrPath, "", "utf8");
    return {
      returnCode: 0,
      classification: "success",
      promptPath,
      eventLogPath,
      stderrPath,
      threadId: input.threadId ?? null,
      durationSeconds: 0,
      command: [this.options.codexBin, "app-server", "--listen", "stdio://"],
    };
  }
}

export class Supervisor {
  private readonly injectedRunner?: Runner;

  constructor(
    private readonly config: SupervisorConfig,
    runner?: Runner,
    private readonly sleeper: (seconds: number) => Promise<void> = sleep,
  ) {
    this.injectedRunner = runner;
  }

  async run(): Promise<number> {
    const project = resolve(this.config.project);
    const runId = sanitizeRunId(this.config.runId);
    await ensureScaffold(project, this.config.goal);

    let previousResult: CodexRunResult | null = null;
    let consecutiveFailures = 0;
    let consecutiveNetworkTransientFailures = 0;
    let consecutiveRemoteCompactionFailures = 0;
    let sameSessionFailures = 0;
    let consecutiveAuthFailures = 0;
    let pendingOperatorMessage: string | null = null;

    for (let cycle = 1; cycle <= this.config.maxCycles; cycle++) {
      pendingOperatorMessage = joinOperatorMessages(pendingOperatorMessage, await this.handleQueuedControlsBeforeTurn(project, runId));
      await this.waitWhilePaused(project, runId);

      const snapshot = await loadSnapshotForRun(project, runId);
      const selectedWork = chooseNextWork(snapshot);
      const hasOperatorMessage = Boolean(pendingOperatorMessage?.trim());
      const work = hasOperatorMessage && (this.config.operatorIntervention || shouldPrioritizeOperatorIntervention(selectedWork))
        ? operatorInterventionWork(selectedWork)
        : selectedWork;
      if (work.kind === "done") {
        await recordProgress(project, "done", "Project state is marked done; SuperCodex stopped.");
        return 0;
      }

      const sessionState = snapshot.supervisorSession;
      await this.applyPendingAuth(project, runId);
      const latestSettings = await readSupervisorSettings(project, runId);
      const runtimeOptions = this.applySettingsToOptions(this.config.appServerOptions, latestSettings);
      await this.applyCodexRuntimeConfig(project, runtimeOptions);
      const storedThreadId = resumableThreadId(sessionState);
      const forceFreshRequested = await consumeForceFreshNext(project, runId);
      const planReviewBoundary = shouldStartFreshPlanReviewThread(sessionState, work);
      const forceFresh = forceFreshRequested || planReviewBoundary || sameSessionFailures >= this.config.sameSessionRetryLimit;
      const resume = shouldResumeStoredThread(sessionState, forceFresh);
      const threadId = forceFresh ? null : storedThreadId;

      const prompt = buildPrompt({
        snapshot,
        work,
        previousResult,
        forceFreshSession: forceFresh,
        operatorMessage: pendingOperatorMessage,
      });
      const currentOperatorMessage: string | null = pendingOperatorMessage;
      pendingOperatorMessage = null;

      await recordProgress(
        project,
        "cycle",
        `Cycle ${cycle}: work=${work.kind} stage=${work.stageId ?? "none"} task=${work.taskId ?? "none"} resume=${resume} fresh=${forceFresh} operatorMessage=${Boolean(
          currentOperatorMessage,
        )}`,
      );
      this.log(
        `[supercodex] cycle=${cycle}/${formatMaxCycles(this.config.maxCycles)} work=${work.kind} stage=${
          work.stageId ?? "none"
        } task=${work.taskId ?? "none"} resume=${resume} fresh=${forceFresh}`,
      );
      this.log(`[supercodex] title=${work.title}`);
      if (latestSettings.model || latestSettings.reasoningEffort || latestSettings.sandbox || latestSettings.approvalPolicy) {
        this.log(
          `[supercodex] settings model=${latestSettings.model ?? "codex-config"} reasoning=${
            latestSettings.reasoningEffort ?? "codex-config"
          } sandbox=${runtimeOptions.sandbox} approval=${runtimeOptions.approvalPolicy} run=${runId}`,
        );
      }

      const runner = this.createRunner(runtimeOptions);
      const result = await runner.run({ prompt, project, threadId, resume, runId, stageId: work.stageId, taskId: work.taskId, workKind: work.kind });
      const command = result.command.join(" ");
      const planReviewSucceeded = isPlanReviewWork(work) && isRunOk(result);
      const planReviewCycle = planReviewSucceeded ? autoDevCycleKey(snapshot.autoDevState) : stringValue(sessionState.plan_review_cycle, "");
      const planReviewThreadId = planReviewSucceeded ? result.threadId ?? null : stringValue(sessionState.plan_review_thread_id, "");
      this.log(
        `[supercodex] cycle=${cycle} finished classification=${result.classification} returncode=${
          result.returnCode
        } duration=${result.durationSeconds.toFixed(1)}s`,
      );

      const sessionPayload = {
        thread_id: result.threadId ?? null,
        session_id: result.threadId ?? null,
        turn_id: result.turnId ?? null,
        stage_id: work.stageId ?? null,
        task_id: work.taskId ?? null,
        work_kind: work.kind,
        thread_scope: threadScopeForWork(work),
        lastClassification: result.classification,
        lastReturnCode: result.returnCode,
        lastEventLog: result.eventLogPath,
        lastStderrLog: result.stderrPath,
        lastPromptLog: result.promptPath,
        lastCommand: command,
        consecutiveFailures: isRunOk(result) ? consecutiveFailures : consecutiveFailures + 1,
        plan_review_completed: planReviewSucceeded || Boolean(sessionState.plan_review_completed) || undefined,
        plan_review_cycle: planReviewCycle || undefined,
        plan_review_thread_id: planReviewThreadId || undefined,
        dryRun: this.config.dryRun || undefined,
      };
      await saveSupervisorSession(project, sessionPayload, runId);

      if (result.classification === "operator_interrupt") {
        const interruptMessage = operatorInterruptMessage(result);
        previousResult = result;
        consecutiveFailures = 0;
        consecutiveNetworkTransientFailures = 0;
        consecutiveRemoteCompactionFailures = 0;
        sameSessionFailures = 0;
        consecutiveAuthFailures = 0;
        if (!interruptMessage?.trim()) {
          await recordProgress(project, "operator-stop", "Codex turn was stopped by the operator; SuperCodex will not start a replacement turn automatically.");
          await checkpoint(project, work, command, "operator_interrupt", "Stopped current Codex turn after operator stop.", "Run /start or provide a new instruction when you want to continue.");
          return result.returnCode || 130;
        }
        pendingOperatorMessage = interruptMessage;
        await recordProgress(project, "operator-interrupt", "Codex turn was interrupted; retrying with the supplied intervention prompt.");
        await checkpoint(project, work, command, "operator_interrupt", "Stopped current Codex turn after operator interrupt.", "Resume with the operator intervention prompt.");
        continue;
      }

      if (isRunOk(result)) {
        previousResult = null;
        consecutiveFailures = 0;
        consecutiveNetworkTransientFailures = 0;
        consecutiveRemoteCompactionFailures = 0;
        sameSessionFailures = 0;
        consecutiveAuthFailures = 0;
        await checkpoint(project, work, command, "None recorded by SuperCodex.", `SuperCodex cycle ${cycle} completed successfully.`, "Reload state and select the next unfinished task or gate.");
        continue;
      }

      previousResult = result;
      if (result.classification === "remote_compaction_failed") {
        consecutiveRemoteCompactionFailures++;
        consecutiveNetworkTransientFailures = 0;
        consecutiveFailures = 0;
        sameSessionFailures = 0;
        consecutiveAuthFailures = 0;
        await checkpoint(
          project,
          work,
          command,
          result.classification,
          `Supervisor cycle ${cycle} hit remote pre-sampling compaction failure ${consecutiveRemoteCompactionFailures}/${remoteCompactionRetryLimit(this.config)}.`,
          "Retry the same Codex thread until the remote compaction retry threshold is exceeded; then continue with a fresh Codex thread in the same SuperCodex run.",
        );
        const delay = Math.min(this.config.retryMaxSeconds, this.config.retryBaseSeconds * 2 ** Math.max(0, consecutiveRemoteCompactionFailures - 1));
        if (consecutiveRemoteCompactionFailures >= remoteCompactionRetryLimit(this.config)) {
          await patchSupervisorSettings(project, { forceFreshNext: true }, runId);
          await recordProgress(
            project,
            "remote-compaction-escalate",
            `Remote pre-sampling compaction failed ${consecutiveRemoteCompactionFailures}/${remoteCompactionRetryLimit(this.config)} times. SuperCodex will keep run '${runId}' and continue with a fresh Codex thread after ${delay.toFixed(1)}s.`,
          );
          consecutiveRemoteCompactionFailures = 0;
          await this.sleeper(delay);
          continue;
        }
        await recordProgress(
          project,
          "remote-compaction-retry",
          `Remote pre-sampling compaction failed ${consecutiveRemoteCompactionFailures}/${remoteCompactionRetryLimit(this.config)}; retrying the same Codex thread after ${delay.toFixed(1)}s.`,
        );
        await this.sleeper(delay);
        continue;
      }
      consecutiveRemoteCompactionFailures = 0;
      if (result.classification === "network_transient") {
        consecutiveNetworkTransientFailures++;
        consecutiveFailures = 0;
        sameSessionFailures = 0;
        consecutiveAuthFailures = 0;
        await checkpoint(
          project,
          work,
          command,
          result.classification,
          `Supervisor cycle ${cycle} hit network transient failure ${consecutiveNetworkTransientFailures}/${networkTransientRetryLimit(this.config)}.`,
          "Retry the same Codex thread until the network transient retry threshold is exceeded; then continue with a fresh Codex thread in the same SuperCodex run.",
        );
        const delay = Math.min(this.config.retryMaxSeconds, this.config.retryBaseSeconds * 2 ** Math.max(0, consecutiveNetworkTransientFailures - 1));
        if (consecutiveNetworkTransientFailures >= networkTransientRetryLimit(this.config)) {
          await patchSupervisorSettings(project, { forceFreshNext: true }, runId);
          await recordProgress(
            project,
            "network-transient-escalate",
            `Network transient failure reached ${consecutiveNetworkTransientFailures}/${networkTransientRetryLimit(this.config)}. SuperCodex will keep run '${runId}' and continue with a fresh Codex thread after ${delay.toFixed(1)}s.`,
          );
          consecutiveNetworkTransientFailures = 0;
          await this.sleeper(delay);
          continue;
        }
        await recordProgress(
          project,
          "network-transient-retry",
          `Network transient failure ${consecutiveNetworkTransientFailures}/${networkTransientRetryLimit(this.config)}; retrying the same Codex thread after ${delay.toFixed(1)}s.`,
        );
        await this.sleeper(delay);
        continue;
      }
      consecutiveNetworkTransientFailures = 0;
      consecutiveFailures++;
      if (!isAuthFailureClassification(result.classification)) {
        consecutiveAuthFailures = 0;
      }
      if (resume || threadId) {
        sameSessionFailures++;
      }
      await checkpoint(project, work, command, result.classification, `Supervisor cycle ${cycle} stopped with ${result.classification}.`, "Retry recoverable failures, otherwise start a fresh thread with persisted state.");

      if (isAuthFailureClassification(result.classification)) {
        const manager = this.config.authManager;
        const accounts = manager ? await manager.listAccounts() : [];
        if (!manager || accounts.length < 2) {
          await recordProgress(project, "stop", `Codex auth failure '${result.classification}' and fewer than two SuperCodex-managed auth accounts are configured.`);
          return result.returnCode || 1;
        }
        consecutiveAuthFailures++;
        if (consecutiveAuthFailures >= accounts.length) {
          await recordProgress(project, "stop", `Codex auth failure '${result.classification}' reached each configured auth account in this run; stopping to avoid a tight retry loop.`);
          return result.returnCode || 1;
        }
        const nextAccount = await manager.rotateAfterAuthFailure(result.classification);
        if (!nextAccount) {
          await recordProgress(project, "stop", `Codex auth failure '${result.classification}' and no alternate auth account is available.`);
          return result.returnCode || 1;
        }
        consecutiveFailures = 0;
        sameSessionFailures = 0;
        const delay = Math.min(this.config.retryMaxSeconds, this.config.retryBaseSeconds);
        await recordProgress(project, "auth-rotate", `Codex auth failure '${result.classification}'; switched to auth account '${nextAccount}' and will retry after ${delay.toFixed(1)}s.`);
        this.log(`[supercodex] ${result.classification}; switched Codex auth to ${nextAccount}`);
        await this.sleeper(delay);
        continue;
      }

      if (!isRecoverableClassification(result.classification) && consecutiveFailures >= this.config.maxRetries) {
        await recordProgress(project, "stop", `Non-recoverable failure after ${consecutiveFailures} attempts.`);
        return result.returnCode || 1;
      }
      if (consecutiveFailures >= this.config.maxRetries) {
        const delay = Math.min(this.config.retryMaxSeconds, this.config.retryBaseSeconds * 2 ** Math.max(0, consecutiveFailures - 1));
        await patchSupervisorSettings(project, { forceFreshNext: true }, runId);
        await recordProgress(
          project,
          "retry-escalate",
          `Recoverable failure reached retry threshold (${consecutiveFailures}/${this.config.maxRetries}): ${result.classification}. SuperCodex will force a fresh Codex thread and continue after ${delay.toFixed(1)}s.`,
        );
        consecutiveFailures = 0;
        sameSessionFailures = 0;
        await this.sleeper(delay);
        continue;
      }
      const delay = Math.min(this.config.retryMaxSeconds, this.config.retryBaseSeconds * 2 ** Math.max(0, consecutiveFailures - 1));
      await recordProgress(project, "retry", `Retrying after ${delay.toFixed(1)}s due to ${result.classification}.`);
      await this.sleeper(delay);
    }

    await recordProgress(project, "pause", `Reached max_cycles=${formatMaxCycles(this.config.maxCycles)}; run again to continue.`);
    return 0;
  }

  private createRunner(options: AppServerOptions): Runner {
    if (this.injectedRunner) {
      return this.injectedRunner;
    }
    return this.config.dryRun ? new DryRunRunner(options) : new AppServerRunner(options, this.config.authManager);
  }

  private applySettingsToOptions(options: AppServerOptions, settings: SupervisorRuntimeSettings): AppServerOptions {
    return {
      ...options,
      model: typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : options.model,
      reasoningEffort: settings.reasoningEffort ?? options.reasoningEffort ?? null,
      sandbox: settings.sandbox ?? options.sandbox,
      approvalPolicy: settings.approvalPolicy ?? options.approvalPolicy,
    };
  }

  private async applyPendingAuth(project: string, runId: string): Promise<void> {
    const pendingAuth = await consumePendingAuthName(project, runId);
    if (!pendingAuth) {
      return;
    }
    const manager = this.config.authManager as (CodexAuthManager & { useAccount?: (name: string) => Promise<string> }) | null | undefined;
    if (!manager?.useAccount) {
      await recordProgress(project, "auth-switch-skipped", `Requested auth '${pendingAuth}' but no auth manager is configured.`);
      return;
    }
    await manager.useAccount(pendingAuth);
    await recordProgress(project, "auth-switch", `Applied requested Codex auth account '${pendingAuth}' before starting the next turn.`);
  }

  private async applyCodexRuntimeConfig(project: string, options: AppServerOptions): Promise<void> {
    const manager = this.config.authManager as
      | (CodexAuthManager & { ensureHighAccessConfig?: (project?: string | null, runtime?: { model?: string | null; reasoningEffort?: AppServerOptions["reasoningEffort"]; sandbox?: AppServerOptions["sandbox"]; approvalPolicy?: AppServerOptions["approvalPolicy"] }) => Promise<string> })
      | null
      | undefined;
    if (!manager?.ensureHighAccessConfig) {
      return;
    }
    await manager.ensureHighAccessConfig(project, {
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: options.sandbox,
      approvalPolicy: options.approvalPolicy,
    });
  }

  private async handleQueuedControlsBeforeTurn(project: string, runId: string): Promise<string | null> {
    let operatorMessage: string | null = null;
    for (const pending of await readPendingControls(project, runId)) {
      if ((pending.action === "steer" || pending.action === "interrupt") && typeof pending.message === "string" && pending.message.trim()) {
        operatorMessage = joinOperatorMessages(operatorMessage, pending.message.trim());
        await markControlHandled(project, pending, runId);
        continue;
      }
      if (pending.action === "set_settings" && typeof pending.settings === "object" && pending.settings !== null) {
        await patchSupervisorSettings(project, pending.settings as SupervisorRuntimeSettings, runId);
        await markControlHandled(project, pending, runId);
        continue;
      }
      if (pending.action === "auth_use" && typeof pending.authName === "string" && pending.authName.trim()) {
        await patchSupervisorSettings(project, { pendingAuthName: pending.authName.trim() }, runId);
        await markControlHandled(project, pending, runId);
        continue;
      }
      if (pending.action === "fresh_next") {
        await patchSupervisorSettings(project, { forceFreshNext: true }, runId);
        await markControlHandled(project, pending, runId);
        continue;
      }
      if (pending.action === "pause" || pending.action === "resume") {
        await patchSupervisorSettings(project, { paused: pending.action === "pause" }, runId);
        await markControlHandled(project, pending, runId);
      }
    }
    return operatorMessage;
  }

  private async waitWhilePaused(project: string, runId: string): Promise<void> {
    let announced = false;
    while ((await readSupervisorSettings(project, runId)).paused) {
      if (!announced) {
        this.log(`[supercodex] run=${runId} paused; use supercodex attach and /resume to continue.`);
        announced = true;
      }
      await this.sleeper(2);
      await this.handleQueuedControlsBeforeTurn(project, runId);
    }
  }

  private log(message: string): void {
    if (this.config.supervisorConsole) {
      console.log(message);
    }
  }
}

function formatMaxCycles(value: number): string {
  return Number.isFinite(value) ? String(value) : "until-done";
}

function shouldPrioritizeOperatorIntervention(work: WorkItem): boolean {
  if (work.kind === "done") {
    return true;
  }
  return work.kind === "stage_gate" && !work.stageId && !work.taskId && (work.source === "plan" || work.source === "objective-audit" || work.source === "final-acceptance");
}

function operatorInterventionWork(previousWork: WorkItem): WorkItem {
  return {
    kind: "operator_intervention",
    title: "处理 TUI 用户消息或变更请求",
    stageId: null,
    taskId: null,
    reason:
      previousWork.kind === "done"
        ? "Project is marked done, but the operator supplied a new runtime message; handle it as a change request or answer without reopening synthetic Stage Gate state."
        : `Operator supplied a runtime message while the selected work was '${previousWork.title}'; prioritize the user message instead of a synthetic final gate.`,
    source: "control",
  };
}

function operatorInterruptMessage(result: CodexRunResult): string | null {
  const message = result.operatorMessage?.trim();
  return message ? message : null;
}

export function resumableThreadId(sessionState: Record<string, unknown>): string | null {
  if (sessionState.dryRun) {
    return null;
  }
  const classification = typeof sessionState.lastClassification === "string" ? sessionState.lastClassification : null;
  if (
    classification &&
    !new Set(["success", "context_compaction_failed", "context_window_exceeded", "network_transient", "operator_interrupt", "remote_compaction_failed", "timeout", "usage_limit", "unauthorized"]).has(classification)
  ) {
    return null;
  }
  const candidate = typeof sessionState.thread_id === "string" ? sessionState.thread_id : typeof sessionState.session_id === "string" ? sessionState.session_id : null;
  return candidate?.trim() ? candidate : null;
}

export function shouldResumeStoredThread(sessionState: Record<string, unknown>, forceFresh = false): boolean {
  const storedThreadId = resumableThreadId(sessionState);
  if (!storedThreadId || forceFresh) {
    return false;
  }
  return true;
}

export function shouldStartFreshPlanReviewThread(sessionState: Record<string, unknown>, work: WorkItem): boolean {
  if (!isPlanReviewWork(work) || !resumableThreadId(sessionState)) {
    return false;
  }
  return stringValue(sessionState.thread_scope, "") !== "plan-review";
}

function threadScopeForWork(work: WorkItem): string {
  return isPlanReviewWork(work) ? "plan-review" : "plan-cycle";
}

function isPlanReviewWork(work: WorkItem): boolean {
  if (work.kind !== "stage_gate") {
    return false;
  }
  return (
    work.source === "final-acceptance" ||
    work.title.includes("最终目标验收") ||
    work.reason.includes("RUN_FINAL_ACCEPTANCE") ||
    work.reason.includes("PHASE_6_FINAL_ACCEPTANCE")
  );
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function autoDevCycleKey(autoDevState: Record<string, unknown>): string {
  const cycle = autoDevState.cycle;
  if (typeof cycle === "number" && Number.isFinite(cycle)) {
    return String(cycle);
  }
  if (typeof cycle === "string" && cycle.trim()) {
    return cycle.trim();
  }
  const plan = typeof autoDevState.plan === "object" && autoDevState.plan !== null ? (autoDevState.plan as Record<string, unknown>) : {};
  const currentCycle = stringValue(plan.current_cycle, "");
  const match = currentCycle.match(/\d+/);
  return match?.[0] ?? "";
}

function isAuthFailureClassification(classification: string): classification is "usage_limit" | "unauthorized" {
  return classification === "usage_limit" || classification === "unauthorized";
}

function networkTransientRetryLimit(config: SupervisorConfig): number {
  return Math.max(1, Math.floor(config.networkTransientMaxRetries));
}

function remoteCompactionRetryLimit(config: SupervisorConfig): number {
  return Math.max(1, Math.floor(config.remoteCompactionMaxRetries));
}

async function checkpoint(project: string, work: WorkItem, command: string, risk: string, completed: string, nextStep: string): Promise<void> {
  await recordCheckpoint(project, {
    mode: risk === "None recorded by SuperCodex." ? "execution" : "repair",
    phase: "execution",
    stageId: work.stageId,
    taskId: work.taskId,
    completed,
    nextStep,
    lastCommand: command,
    risk,
  });
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
}

function joinOperatorMessages(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return `${left}\n\n${right}`;
}
