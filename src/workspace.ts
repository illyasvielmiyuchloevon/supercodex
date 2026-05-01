import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorDataRoot } from "./settings.js";
import type { JsonObject, PlanTask, ProjectSnapshot, WorkItem } from "./types.js";
import {
  appendLogBestEffort,
  ensureDir,
  nowIso,
  pathExists,
  readJson,
  readText,
  writeJsonAtomic,
  writeTextIfMissing,
} from "./fs-utils.js";

export const requiredDocs = [
  "REQUIREMENTS.md",
  "PRD.md",
  "ARCHITECTURE.md",
  "PLAN.md",
  "ACCEPTANCE_MATRIX.md",
  "GAP_REPORT.md",
  "QA_REPORT.md",
  "REVIEW_REPORT.md",
  "DELIVERY_REPORT.md",
  "BLOCKERS.md",
] as const;

const supercodexRoot = ".supercodex";
const supercodexDocsRoot = ".supercodex/docs";
const legacyAgentRoot = ".agent";
const legacyDocsRoot = "docs";

const agentDirs = [
  ".supercodex/logs/terminal",
  ".supercodex/logs/tests",
  ".supercodex/logs/review",
  ".supercodex/logs/git",
  ".supercodex/logs/repair",
  ".supercodex/logs/supercodex",
  ".supercodex/runtime",
  ".supercodex/docs/pr",
] as const;

const supercodexGitignoreRules = [".supercodex/"] as const;

const stateTemplate: JsonObject = {
  version: 1,
  goal: "",
  mode: "planning",
  phase: "plan",
  executionLock: false,
  canAskUser: true,
  currentStageId: null,
  currentTaskId: null,
  planIteration: 1,
  stageIteration: 0,
  repairAttemptsForCurrentTask: 0,
  lastCompletedStageId: null,
  lastCompletedTaskId: null,
  lastCommand: null,
  lastGitBranch: null,
  lastCommitHash: null,
  lastPushStatus: null,
  lastPrUrlOrDoc: null,
  lastError: null,
  done: false,
  createdAt: "",
  updatedAt: "",
};

export async function ensureScaffold(projectInput: string, goal = ""): Promise<string[]> {
  const project = resolve(projectInput);
  const created: string[] = [];

  await migrateLegacyProjectLayout(project, created);
  const projectAgentsPath = await ensureProjectAgentsMd(project);
  if (projectAgentsPath) {
    created.push(projectAgentsPath);
  }
  if (await ensureSupercodexGitignore(project)) {
    created.push(join(project, ".gitignore"));
  }

  for (const rel of agentDirs) {
    const path = join(project, rel);
    if (await ensureDir(path)) {
      created.push(path);
    }
  }

  const timestamp = nowIso();
  const statePath = join(project, ".supercodex", "state.json");
  if (!(await pathExists(statePath))) {
    await writeJsonAtomic(statePath, {
      ...stateTemplate,
      goal,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    created.push(statePath);
  }

  const lockPath = join(project, ".supercodex", "execution-lock.json");
  if (
    await writeTextIfMissing(
      lockPath,
      `${JSON.stringify(
        {
          executionLock: false,
          canAskUser: true,
          enteredAt: null,
          reason: "Planning documents are not fully validated yet.",
        },
        null,
        2,
      )}\n`,
    )
  ) {
    created.push(lockPath);
  }

  const minimalFiles: Record<string, string> = {
    ".supercodex/progress.md": "# Progress\n\n",
    ".supercodex/checkpoints.md": "# Checkpoints\n\n",
    ".supercodex/decisions.md": "# Decisions\n\n",
    ".supercodex/assumptions.md": "# Assumptions\n\n",
    ".supercodex/recovery.md": "# Recovery\n\n",
    ".supercodex/last-error.md": "# Last Error\n\nNone.\n",
    ".supercodex/last-action.md": "# Last Action\n\nBootstrap scaffold created.\n",
  };
  for (const [rel, content] of Object.entries(minimalFiles)) {
    const path = join(project, rel);
    if (await writeTextIfMissing(path, content)) {
      created.push(path);
    }
  }

  for (const doc of requiredDocs) {
    const path = join(project, supercodexDocsRoot, doc);
    if (await pathExists(path)) {
      continue;
    }
    const content = doc === "PRD.md" || doc === "PLAN.md" ? planningDocStub(doc, goal) : supplementDocStub(doc, goal);
    if (await writeTextIfMissing(path, content)) {
      created.push(path);
    }
  }

  await recordProgress(project, "bootstrap", "Scaffold checked; missing files were supplemented only.");
  return created;
}

export async function ensureSupervisorGitignore(project: string): Promise<boolean> {
  return ensureSupercodexGitignore(project);
}

export async function ensureProjectAgentsMd(projectInput: string): Promise<string | null> {
  const project = resolve(projectInput);
  const target = join(project, "AGENTS.md");
  return (await writeTextIfMissing(target, await readProjectAgentsTemplate())) ? target : null;
}

export async function ensureSupercodexGitignore(project: string): Promise<boolean> {
  const gitignore = join(project, ".gitignore");
  const existing = await readText(gitignore, "");
  const existingLines = existing.split(/\r?\n/);
  const normalizedExisting = new Set(existingLines.map(normalizeGitignoreRule));
  const missing = supercodexGitignoreRules.filter((rule) => !normalizedExisting.has(normalizeGitignoreRule(rule)));
  if (missing.length === 0) {
    return false;
  }

  const additions: string[] = [];
  if (existing && !existing.endsWith("\n") && !existing.endsWith("\r")) {
    additions.push("");
  }
  if (!existingLines.some((line) => normalizeGitignoreRule(line) === "# supercodex runtime state")) {
    additions.push("# supercodex runtime state");
  }
  additions.push(...missing);
  await mkdir(project, { recursive: true });
  await writeFile(gitignore, `${existing}${additions.join("\n")}\n`, "utf8");
  return true;
}

export async function loadSnapshot(projectInput: string): Promise<ProjectSnapshot> {
  const project = resolve(projectInput);
  await migrateLegacyProjectLayout(project, []);
  await ensureSupercodexGitignore(project);
  const state = await readJson<JsonObject>(join(project, ".supercodex", "state.json"), {});
  const backlog = await readJson<JsonObject>(join(project, ".supercodex", "backlog.json"), {});
  const docsPresent: Record<string, boolean> = {};
  const missingDocs: string[] = [];
  for (const doc of requiredDocs) {
    const present = await pathExists(join(project, supercodexDocsRoot, doc));
    docsPresent[doc] = present;
    if (!present) {
      missingDocs.push(doc);
    }
  }
  const planTasks = parsePlanTasks(await readText(join(project, supercodexDocsRoot, "PLAN.md")));
  const supervisorSession = await loadRecoverableSupervisorSession(project);
  return {
    project,
    state,
    backlog,
    docsPresent,
    missingDocs,
    planTasks,
    supervisorSession,
    done: Boolean(state.done),
    executionLocked: Boolean(state.executionLock),
  };
}

export async function loadSnapshotForRun(projectInput: string, runId?: string | null): Promise<ProjectSnapshot> {
  const snapshot = await loadSnapshot(projectInput);
  snapshot.supervisorSession = await loadRecoverableSupervisorSession(snapshot.project, runId);
  return snapshot;
}

export function parsePlanTasks(planText: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  let currentStage: string | null = null;
  const stageRe = /^#{2,6}\s+.*?\bStage\s+([A-Za-z0-9_-]+)/i;
  const taskRe = /^\s*-\s+\[(?<mark>[ xX])\]\s*Task\s+(?<id>[A-Za-z0-9_-]+)\s*:\s*(?<title>.+?)\s*$/;
  for (const line of planText.split(/\r?\n/)) {
    const stageMatch = line.match(stageRe);
    if (stageMatch?.[1]) {
      currentStage = normalizeStageId(stageMatch[1]);
      continue;
    }
    const taskMatch = line.match(taskRe);
    if (!taskMatch?.groups) {
      continue;
    }
    const id = taskMatch.groups.id ?? "";
    tasks.push({
      id,
      title: (taskMatch.groups.title ?? "").trim(),
      status: (taskMatch.groups.mark ?? "").toLowerCase() === "x" ? "done" : "todo",
      stageId: currentStage ?? inferStageFromTaskId(id),
      source: "plan",
    });
  }
  return tasks;
}

export function chooseNextWork(snapshot: ProjectSnapshot): WorkItem {
  if (snapshot.done) {
    return { kind: "done", title: "Project marked done", reason: ".supercodex/state.json.done is true", source: "state" };
  }
  const criticalMissing = snapshot.missingDocs.filter((doc) => doc === "PRD.md" || doc === "PLAN.md");
  if (criticalMissing.length > 0) {
    return {
      kind: "supplement_docs",
      title: "补齐缺失的 PRD/PLAN 文档",
      reason: `Missing critical planning documents: ${criticalMissing.join(", ")}`,
      source: "docs",
    };
  }
  if (snapshot.missingDocs.length > 0) {
    return {
      kind: "supplement_docs",
      title: "补齐缺失的非核心状态文档",
      reason: `Missing supplemental documents: ${snapshot.missingDocs.join(", ")}`,
      source: "docs",
    };
  }
  const backlogWork = chooseFromBacklog(snapshot.backlog, snapshot.state);
  if (backlogWork) {
    return backlogWork;
  }
  for (const task of snapshot.planTasks) {
    if (task.status !== "done") {
      return {
        kind: "task",
        title: task.title,
        stageId: task.stageId,
        taskId: task.id,
        reason: "First unchecked task in .supercodex/docs/PLAN.md",
        source: "plan",
      };
    }
  }
  if (snapshot.planTasks.length > 0) {
    return {
      kind: "stage_gate",
      title: "执行剩余 Stage Gate 或最终审查",
      reason: "All parsed PLAN tasks are checked but final done flag is not true.",
      source: "plan",
    };
  }
  return {
    kind: "bootstrap",
    title: "建立外部循环器项目规划",
    reason: "No actionable backlog or PLAN tasks were found.",
    source: "bootstrap",
  };
}

export function chooseFromBacklog(backlog: JsonObject, state: JsonObject = {}): WorkItem | null {
  const stages = Array.isArray(backlog.stages) ? backlog.stages : null;
  if (!stages) {
    return null;
  }
  const preferredStageId = normalizeOptionalStageId(
    state.currentStageId ?? state.currentStage ?? state.phase,
  );
  const doneTasks = new Set<string>();
  for (const stage of stages) {
    if (!isObject(stage) || !Array.isArray(stage.tasks)) {
      continue;
    }
    for (const task of stage.tasks) {
      if (isObject(task) && isDoneStatus(task.status) && typeof task.id === "string") {
        doneTasks.add(task.id);
      }
    }
  }
  for (const stage of orderStagesForResume(stages, preferredStageId)) {
    if (!isObject(stage)) {
      continue;
    }
    const stageId = typeof stage.id === "string" ? stage.id : "";
    if (isDoneStatus(stage.status)) {
      continue;
    }
    const tasks = Array.isArray(stage.tasks) ? stage.tasks : [];
    for (const task of tasks) {
      if (!isObject(task) || isDoneStatus(task.status)) {
        continue;
      }
      const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
      if (deps.length > 0 && !deps.every((dep) => typeof dep === "string" && doneTasks.has(dep))) {
        continue;
      }
      return {
        kind: "task",
        title: String(task.title ?? task.id ?? "Untitled task"),
        stageId: stageId || null,
        taskId: String(task.id ?? ""),
        reason: "Next dependency-satisfied task in .supercodex/backlog.json",
        source: "backlog",
      };
    }
    if (tasks.length > 0 && tasks.every((task) => isObject(task) && isDoneStatus(task.status))) {
      const gate = isObject(stage.gate) ? stage.gate : {};
      const gateComplete =
        Boolean(gate.testsPassed) &&
        Boolean(gate.reviewPassed) &&
        Boolean(gate.gapReviewed) &&
        Boolean(gate.prCreatedOrDocumented);
      if (!gateComplete || !isDoneStatus(stage.status)) {
        return {
          kind: "stage_gate",
          title: `完成 ${stageId} 的 Stage Gate`,
          stageId: stageId || null,
          reason: "Stage tasks are done but gate/status is incomplete.",
          source: "backlog",
        };
      }
    }
  }
  return null;
}

export function supervisorSessionPath(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "session.json");
}

export function supervisorRuntimePath(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "runtime.json");
}

export async function saveSupervisorSession(project: string, data: JsonObject, runId?: string | null): Promise<void> {
  await writeJsonAtomic(supervisorSessionPath(project, runId), { ...data, updatedAt: nowIso() });
}

export async function loadSupervisorRuntime(project: string, runId?: string | null): Promise<JsonObject> {
  return normalizeLoadedRuntimeData(project, await readJson<JsonObject>(supervisorRuntimePath(project, runId), {}));
}

export async function saveSupervisorRuntime(project: string, data: JsonObject, runId?: string | null): Promise<void> {
  await writeJsonAtomic(supervisorRuntimePath(project, runId), { ...data, updatedAt: nowIso() });
}

async function loadRecoverableSupervisorSession(project: string, runId?: string | null): Promise<JsonObject> {
  const session = normalizeLoadedRuntimeData(project, await readJson<JsonObject>(supervisorSessionPath(project, runId), {}));
  const runtime = normalizeLoadedRuntimeData(project, await readJson<JsonObject>(supervisorRuntimePath(project, runId), {}));
  if (!isObject(runtime)) {
    return session;
  }
  const runtimeThread = firstRuntimeString(runtime.thread_id, runtime.session_id);
  const runtimeStatus = firstRuntimeString(runtime.status);
  const activeRuntime = Boolean(runtimeThread && runtimeStatus && new Set(["starting", "thread-started", "running"]).has(runtimeStatus));
  if (!activeRuntime) {
    return session;
  }
  return {
    ...session,
    ...runtime,
    thread_id: runtimeThread,
    session_id: firstRuntimeString(runtime.session_id, runtime.thread_id),
    turn_id: firstRuntimeString(runtime.turn_id),
    stage_id: firstRuntimeString(runtime.stage_id),
    task_id: firstRuntimeString(runtime.task_id),
    work_kind: firstRuntimeString(runtime.work_kind, session.work_kind),
    recoveredFromRuntime: true,
  };
}

export async function recordProgress(project: string, event: string, message: string): Promise<void> {
  await appendLogBestEffort(
    join(project, ".supercodex", "progress.md"),
    `## ${nowIso()} - ${event}\n\n${message}\n\n`,
    project,
  );
}

export async function recordCheckpoint(
  project: string,
  input: {
    mode: string;
    phase: string;
    stageId?: string | null;
    taskId?: string | null;
    completed: string;
    nextStep: string;
    lastCommand?: string | null;
    risk: string;
  },
): Promise<void> {
  await appendLogBestEffort(
    join(project, ".supercodex", "checkpoints.md"),
    `## Checkpoint: ${nowIso()}\n\n` +
      `- 当前 mode：${input.mode}\n` +
      `- 当前 phase：${input.phase}\n` +
      `- 当前 Stage：${input.stageId ?? "none"}\n` +
      `- 当前 Task：${input.taskId ?? "none"}\n` +
      `- 已完成：${input.completed}\n` +
      `- 下一步：${input.nextStep}\n` +
      `- 最近命令：${input.lastCommand ?? "none"}\n` +
      `- 最近风险：${input.risk}\n` +
      "- 恢复方式：重新运行 `supercodex run --project <path>`，循环器会读取 .supercodex 与 .supercodex/docs 后继续。\n\n",
    project,
  );
}

export function normalizeStageId(value: string): string {
  const cleaned = value.trim().toLowerCase();
  if (/^\d+$/.test(cleaned)) {
    return `stage-${cleaned}`;
  }
  return cleaned.startsWith("stage-") ? cleaned : `stage-${cleaned}`;
}

export function inferStageFromTaskId(taskId: string): string | null {
  const match = taskId.match(/^S(\d+)-T\d+/i) ?? taskId.match(/^stage-(\d+)-task-\d+/i);
  return match?.[1] ? `stage-${match[1]}` : null;
}

export function normalizeOptionalStageId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const match = value.match(/stage[-_\s]*(\d+)/i);
  return match?.[1] ? `stage-${match[1]}` : normalizeStageId(value);
}

export function isDoneStatus(value: unknown): boolean {
  return new Set(["done", "completed", "complete", "passed"]).has(String(value ?? "").trim().toLowerCase());
}

function orderStagesForResume(stages: unknown[], preferredStageId: string | null): unknown[] {
  if (!preferredStageId) {
    return stages;
  }
  const index = stages.findIndex((stage) => isObject(stage) && String(stage.id ?? "").toLowerCase() === preferredStageId);
  return index >= 0 ? [...stages.slice(index), ...stages.slice(0, index)] : stages;
}

function normalizeGitignoreRule(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function normalizeLoadedRuntimeData(project: string, data: JsonObject): JsonObject {
  const normalized = normalizeRuntimeValue(project, data);
  return isObject(normalized) ? normalized : data;
}

function normalizeRuntimeValue(project: string, value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeRuntimePathString(project, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeValue(project, item));
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeRuntimeValue(project, item)]));
  }
  return value;
}

function normalizeRuntimePathString(project: string, value: string): string {
  const legacyAgent = join(project, ".agent");
  const nextRoot = join(project, ".supercodex");
  return value
    .replaceAll(legacyAgent, nextRoot)
    .replaceAll(legacyAgent.replaceAll("\\", "/"), nextRoot.replaceAll("\\", "/"))
    .replaceAll(".supercodex\\logs\\supervisor", ".supercodex\\logs\\supercodex")
    .replaceAll(".supercodex/logs/supervisor", ".supercodex/logs/supercodex")
    .replaceAll(".supercodex\\supervisor", ".supercodex\\runtime")
    .replaceAll(".supercodex/supervisor", ".supercodex/runtime");
}

async function migrateLegacyProjectLayout(project: string, created: string[]): Promise<void> {
  const nextRoot = join(project, supercodexRoot);
  const legacyAgent = join(project, legacyAgentRoot);
  if (!(await pathExists(nextRoot)) && (await pathExists(legacyAgent))) {
    await rename(legacyAgent, nextRoot);
    created.push(nextRoot);
  }

  const nextDocs = join(project, supercodexDocsRoot);
  const legacyDocs = join(project, legacyDocsRoot);
  if (!(await pathExists(nextDocs)) && (await pathExists(legacyDocs))) {
    await mkdir(nextRoot, { recursive: true });
    await rename(legacyDocs, nextDocs);
    created.push(nextDocs);
  }

  const nextRuntime = join(project, supercodexRoot, "runtime");
  const legacyRuntime = join(project, supercodexRoot, "supervisor");
  if (!(await pathExists(nextRuntime)) && (await pathExists(legacyRuntime))) {
    await rename(legacyRuntime, nextRuntime);
    created.push(nextRuntime);
  }

  const nextLogs = join(project, supercodexRoot, "logs", "supercodex");
  const legacyLogs = join(project, supercodexRoot, "logs", "supervisor");
  if (!(await pathExists(nextLogs)) && (await pathExists(legacyLogs))) {
    await mkdir(join(project, supercodexRoot, "logs"), { recursive: true });
    await rename(legacyLogs, nextLogs);
    created.push(nextLogs);
  }
}

function planningDocStub(doc: string, goal: string): string {
  const title = basename(doc, ".md");
  return `# ${title}\n\nThis file was created by supercodex as a missing planning artifact.\nIf an existing project already has PRD or PLAN content elsewhere, move or merge it here; SuperCodex will not overwrite existing planning documents.\n\nGoal: ${
    goal || "Not provided yet."
  }\n`;
}

function supplementDocStub(doc: string, goal: string): string {
  const title = basename(doc, ".md").replaceAll("_", " ");
  return `# ${title}\n\nSupplemental placeholder created because the project was missing this required artifact.\nDo not treat this as a replacement for existing PRD or PLAN content.\n\nGoal: ${
    goal || "Inherited from existing project state."
  }\n`;
}

async function readProjectAgentsTemplate(): Promise<string> {
  for (const candidate of projectAgentsTemplateCandidates()) {
    const content = await readText(candidate, "");
    if (content.trim()) {
      return content.endsWith("\n") ? content : `${content}\n`;
    }
  }
  return fallbackProjectAgentsTemplate();
}

function projectAgentsTemplateCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.SUPERCODEX_AGENTS_TEMPLATE?.trim() ?? "",
    join(moduleDir, "..", "AGENTS.md"),
    join(moduleDir, "..", "..", "AGENTS.md"),
  ].filter(Boolean);
}

function fallbackProjectAgentsTemplate(): string {
  return `# AGENTS.md - SuperCodex Project Instructions

This project is managed by SuperCodex. Before doing work, Codex must read the project state, preserve existing PRD/PLAN/backlog/checkpoints, inspect git status, and resume from the next unfinished task instead of restarting from scratch.

Required durable state:

- \`.supercodex/state.json\`
- \`.supercodex/backlog.json\`
- \`.supercodex/checkpoints.md\`
- \`.supercodex/docs/PRD.md\`
- \`.supercodex/docs/PLAN.md\`
- \`.supercodex/docs/ACCEPTANCE_MATRIX.md\`
- \`.supercodex/docs/GAP_REPORT.md\`

If execution is blocked by external credentials, network, or remote Git permission, record the blocker in \`.supercodex/docs/BLOCKERS.md\` and continue all unblocked local work. Do not claim tests, build, push, PR, or final delivery succeeded unless they were actually run and recorded.
`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRuntimeString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
