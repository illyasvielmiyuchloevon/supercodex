import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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
  "AUTO_DEV_STATE.json",
  "FINAL_GOAL.md",
  "PRD.md",
  "ARCHITECTURE.md",
  "PLAN.md",
] as const;

const supercodexRoot = ".supercodex";
const autoDevStateFile = "AUTO_DEV_STATE.json";

const agentDirs = [
  ".supercodex/logs/terminal",
  ".supercodex/logs/tests",
  ".supercodex/logs/review",
  ".supercodex/logs/git",
  ".supercodex/logs/repair",
  ".supercodex/logs/supercodex",
  ".supercodex/runtime",
] as const;

const supercodexGitignoreRules = [".supercodex/"] as const;

function autoDevStateTemplate(goal: string, timestamp: string, planTasks: PlanTask[] = [], options: { goalMode?: boolean } = {}): JsonObject {
  const hasGoal = Boolean(goal.trim());
  const goalMode = options.goalMode ?? hasGoal;
  const hasPlanProgress = planTasks.length > 0;
  const allPlanTasksDone = hasPlanProgress && planTasks.every((task) => task.status === "done");
  const phase = hasPlanProgress && !allPlanTasksDone ? "PHASE_4_DEVELOPMENT" : allPlanTasksDone ? "PHASE_6_FINAL_ACCEPTANCE" : hasGoal ? "PHASE_1_PRD" : "PHASE_0_CLARIFICATION";
  const clarificationClosed = hasGoal || hasPlanProgress;
  return {
    schema_version: "1.0",
    goal_mode: goalMode,
    cycle: 1,
    phase,
    decision: "IN_PROGRESS",
    last_updated: timestamp,
    clarification: {
      status: clarificationClosed ? "CLOSED" : "OPEN",
      asked_count: 0,
    },
    acceptance: {
      decision: "PENDING",
    },
    delivery: {
      git_committed: false,
    },
  };
}

export async function ensureScaffold(projectInput: string, goal = "", options: { goalMode?: boolean } = {}): Promise<string[]> {
  const project = resolve(projectInput);
  const created: string[] = [];

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

  const shouldDeriveStateFromPlan = await pathExists(join(project, supercodexRoot, "PLAN.md"));
  for (const doc of requiredDocs) {
    if (doc === autoDevStateFile) {
      continue;
    }
    const path = join(project, supercodexRoot, doc);
    if (await pathExists(path)) {
      continue;
    }
    const content = requiredFileStub(doc, goal);
    if (await writeTextIfMissing(path, content)) {
      created.push(path);
    }
  }

  const timestamp = nowIso();
  const statePath = join(project, ".supercodex", autoDevStateFile);
  if (!(await pathExists(statePath))) {
    const planTasks = shouldDeriveStateFromPlan ? parsePlanTasks(await readText(join(project, supercodexRoot, "PLAN.md"))) : [];
    await writeJsonAtomic(statePath, autoDevStateTemplate(goal, timestamp, planTasks, options));
    created.push(statePath);
  }

  await recordProgress(project, "bootstrap", "Scaffold checked; missing files were supplemented only.");
  return created;
}

export async function resetSupercodexGoalState(projectInput: string, goal: string): Promise<string[]> {
  const project = resolve(projectInput);
  const target = resolve(project, supercodexRoot);
  if (!target.startsWith(`${project}${sep}`)) {
    throw new Error(`Refusing to reset unsafe SuperCodex path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
  return ensureScaffold(project, goal, { goalMode: true });
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
  await ensureSupercodexGitignore(project);
  const autoDevState = withExplicitGoalModeDefaults(await readJson<JsonObject>(join(project, ".supercodex", autoDevStateFile), {}));
  const state = normalizeAutoDevState(autoDevState);
  const docsPresent: Record<string, boolean> = {};
  const missingDocs: string[] = [];
  for (const doc of requiredDocs) {
    const present = doc === autoDevStateFile ? await pathExists(join(project, ".supercodex", doc)) : await pathExists(join(project, supercodexRoot, doc));
    docsPresent[doc] = present;
    if (!present) {
      missingDocs.push(doc);
    }
  }
  const planTasks = parsePlanTasks(await readText(join(project, supercodexRoot, "PLAN.md")));
  const supervisorSession = await loadRecoverableSupervisorSession(project);
  return {
    project,
    state,
    autoDevState,
    docsPresent,
    missingDocs,
    planTasks,
    supervisorSession,
    done: autoDevStateDelivered(autoDevState, supervisorSession),
    phaseLocked: autoDevPhaseLocked(autoDevState),
  };
}

export async function loadSnapshotForRun(projectInput: string, runId?: string | null): Promise<ProjectSnapshot> {
  const snapshot = await loadSnapshot(projectInput);
  snapshot.supervisorSession = await loadRecoverableSupervisorSession(snapshot.project, runId);
  snapshot.done = autoDevStateDelivered(snapshot.autoDevState, snapshot.supervisorSession);
  return snapshot;
}

export function parsePlanTasks(planText: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  let currentStage: string | null = null;
  const stageRe = /^#{2,6}\s+.*?\bStage\s+([A-Za-z0-9_-]+)/i;
  const taskRe = /^\s*-\s+\[(?<mark>[ xX])\]\s*Task\s+(?<id>[A-Za-z0-9_.-]+)\s*:\s*(?<title>.+?)\s*$/;
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
  if (snapshot.done && autoDevStateDelivered(snapshot.autoDevState, snapshot.supervisorSession)) {
    return { kind: "done", title: "Project delivered", reason: ".supercodex/AUTO_DEV_STATE.json decision is DELIVERED, final acceptance passed, and Phase 7 delivery is complete.", source: "auto-dev-state" };
  }
  const criticalMissing = snapshot.missingDocs.filter((doc) => doc === autoDevStateFile || doc === "FINAL_GOAL.md" || doc === "PLAN.md");
  if (criticalMissing.length > 0) {
    return {
      kind: "supplement_docs",
      title: "补齐 AGENTS.md 关键文件",
      reason: `Missing critical required files: ${criticalMissing.join(", ")}`,
      source: "docs",
    };
  }
  if (snapshot.missingDocs.length > 0) {
    return {
      kind: "supplement_docs",
      title: "补齐 AGENTS.md 必需文件",
      reason: `Missing required files: ${snapshot.missingDocs.join(", ")}`,
      source: "docs",
    };
  }
  const autoWork = chooseFromAutoDevState(snapshot.autoDevState, snapshot.planTasks, snapshot.supervisorSession);
  if (autoWork) {
    return autoWork;
  }
  const hasOpenPlanWork = snapshot.planTasks.some((task) => task.status !== "done");
  if (hasOpenPlanWork) {
    return continuePlanWork("Unfinished checklist items exist in .supercodex/PLAN.md.", "plan");
  }
  if (snapshot.planTasks.length > 0) {
    return {
      kind: "stage_gate",
      title: "进入 Phase 6 最终目标验收",
      reason: "All parsed PLAN tasks are checked; AGENTS.md requires Phase 6 final acceptance before delivery.",
      source: "final-acceptance",
    };
  }
  return {
    kind: "bootstrap",
    title: "建立 AGENTS.md 轻量治理规划",
    reason: "No actionable AUTO_DEV_STATE or PLAN tasks were found.",
    source: "bootstrap",
  };
}

function chooseFromAutoDevState(autoDevState: JsonObject, planTasks: PlanTask[], supervisorSession: JsonObject): WorkItem | null {
  if (!Object.keys(autoDevState).length) {
    return null;
  }

  const phase = stringValue(autoDevState.phase, "PHASE_0_CLARIFICATION");
  const decision = stringValue(autoDevState.decision, "IN_PROGRESS");
  const clarification = objectValue(autoDevState.clarification);
  const acceptance = objectValue(autoDevState.acceptance);
  const hasOpenPlanWork = planTasks.some((task) => task.status !== "done");
  const claimsFinalAcceptanceDecision =
    (decision === "DELIVERED" ||
      decision === "PASS_READY_TO_DELIVER" ||
      decision === "FAIL_CONTINUE_NEXT_CYCLE" ||
      acceptancePassed(autoDevState) ||
      acceptanceFailed(autoDevState));
  const planReviewComplete = planReviewCompletedForCycle(autoDevState, supervisorSession);

  if (claimsFinalAcceptanceDecision && !planReviewComplete && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "进入 Phase 6 最终目标验收",
      reason: "PLAN is exhausted, but this cycle has not completed a dedicated Phase 6 plan-review thread.",
      source: "final-acceptance",
    };
  }

  if (decision === "DELIVERED" && !autoDevStateDelivered(autoDevState, supervisorSession) && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "补齐最终验收与交付闭环状态",
      reason: "AUTO_DEV_STATE decision is DELIVERED, but final acceptance or Git delivery state is incomplete.",
      source: "auto-dev-state",
    };
  }

  if ((decision === "PASS_READY_TO_DELIVER" || acceptancePassed(autoDevState)) && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "执行 Phase 7 最终交付与 PR",
      reason: "Final acceptance passed; AGENTS.md requires Git delivery closure.",
      source: "auto-dev-state",
    };
  }

  if ((decision === "FAIL_CONTINUE_NEXT_CYCLE" || acceptanceFailed(autoDevState)) && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "根据最终验收失败创建下一 Cycle",
      reason: "AUTO_DEV_STATE.acceptance is failed; update FINAL_GOAL, PRD, architecture, PLAN, and AUTO_DEV_STATE status parameters before continuing.",
      source: "auto-dev-state",
    };
  }

  if (stringValue(clarification.status, "") === "WAITING_FOR_USER") {
    return {
      kind: "stage_gate",
      title: "处理 Phase 0 需求澄清回复",
      reason: "clarification.status is WAITING_FOR_USER; only Phase 0 may wait for or process a user clarification.",
      source: "auto-dev-state",
    };
  }

  if (phase === "PHASE_4_DEVELOPMENT") {
    if (hasOpenPlanWork || planTasks.length === 0) {
      return continuePlanWork("AUTO_DEV_STATE phase is PHASE_4_DEVELOPMENT; Codex should read PLAN.md and continue the plan.", "auto-dev-state");
    }
    return {
      kind: "stage_gate",
      title: "进入 Phase 6 最终目标验收",
      reason: "PLAN checklist is exhausted; AGENTS.md requires Phase 6 final acceptance before delivery.",
      source: "final-acceptance",
    };
  }

  return phaseWork(phase);
}

function continuePlanWork(reason: string, source: string): WorkItem {
  return {
    kind: "stage_gate",
    title: "继续 Phase 4 自动开发执行",
    reason,
    source,
  };
}

function phaseWork(phase: string): WorkItem | null {
  switch (phase) {
    case "PHASE_0_CLARIFICATION":
      return {
        kind: "stage_gate",
        title: "Phase 0 需求澄清与目标锁定",
        reason: "AUTO_DEV_STATE phase is PHASE_0_CLARIFICATION.",
        source: "auto-dev-state",
      };
    case "PHASE_1_PRD":
      return {
        kind: "stage_gate",
        title: "Phase 1 编写或更新 PRD",
        reason: "AUTO_DEV_STATE phase is PHASE_1_PRD.",
        source: "auto-dev-state",
      };
    case "PHASE_2_ARCHITECTURE":
      return {
        kind: "stage_gate",
        title: "Phase 2 编写或更新架构设计",
        reason: "AUTO_DEV_STATE phase is PHASE_2_ARCHITECTURE.",
        source: "auto-dev-state",
      };
    case "PHASE_3_PLAN":
      return {
        kind: "stage_gate",
        title: "Phase 3 制定或更新 Plan 与覆盖状态",
        reason: "AUTO_DEV_STATE phase is PHASE_3_PLAN.",
        source: "auto-dev-state",
      };
    case "PHASE_5_TEST_REVIEW_REPAIR":
      return {
        kind: "stage_gate",
        title: "Phase 5 测试、审查与修复",
        reason: "AUTO_DEV_STATE phase is PHASE_5_TEST_REVIEW_REPAIR.",
        source: "auto-dev-state",
      };
    case "PHASE_6_FINAL_ACCEPTANCE":
      return {
        kind: "stage_gate",
        title: "Phase 6 最终目标验收",
        reason: "AUTO_DEV_STATE phase is PHASE_6_FINAL_ACCEPTANCE.",
        source: "auto-dev-state",
      };
    case "PHASE_7_DELIVERY_PR":
      return {
        kind: "stage_gate",
        title: "Phase 7 最终交付与 PR",
        reason: "AUTO_DEV_STATE phase is PHASE_7_DELIVERY_PR.",
        source: "auto-dev-state",
      };
    default:
      return null;
  }
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
    join(project, ".supercodex", "logs", "supercodex", "progress.jsonl"),
    `${JSON.stringify({ timestamp: nowIso(), event, message })}\n`,
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
    join(project, ".supercodex", "runtime", "checkpoints.jsonl"),
    `${JSON.stringify({
      timestamp: nowIso(),
      mode: input.mode,
      phase: input.phase,
      stageId: input.stageId ?? null,
      taskId: input.taskId ?? null,
      completed: input.completed,
      nextStep: input.nextStep,
      lastCommand: input.lastCommand ?? null,
      risk: input.risk,
    })}\n`,
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
  const match = taskId.match(/^S(\d+)-T\d+/i) ?? taskId.match(/^stage-(\d+)-task-\d+/i) ?? taskId.match(/^(\d+)\.\d+/);
  return match?.[1] ? `stage-${match[1]}` : null;
}

export function normalizeOptionalStageId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const match = value.match(/stage[-_\s]*(\d+)/i);
  return match?.[1] ? `stage-${match[1]}` : normalizeStageId(value);
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
  void project;
  return value;
}

function requiredFileStub(doc: string, goal: string): string {
  switch (doc) {
    case "FINAL_GOAL.md":
      return `# FINAL_GOAL

## 用户原始目标
${goal || "Not provided yet."}

## 最终澄清后的目标
- 待 Phase 0 根据用户原始目标、澄清回答和合理假设补全。

## 澄清记录与回答
- 暂无。

## 合理假设
- 暂无。

## 验收标准
- 待 PRD 与验收状态细化。

## 明确不做的内容
- 未声明。

## 风险与边界
- 待架构阶段补全。
`;
    case "ARCHITECTURE.md":
    case "PRD.md":
      return `# ${doc.slice(0, -3)}

This file was created by SuperCodex as a missing required file.
It should be filled by the active Codex work cycle using the lightweight SuperCodex docs.

Request/Goal: ${goal || "Not provided yet."}
`;
    case "PLAN.md":
      return `# PLAN

Goal: ${goal || "Not provided yet."}

## Cycle 1

### Milestone 1: Foundation Capability Closure

#### Stage 1: Scope and Architecture Alignment
- [ ] Task 1.1: Align PRD, architecture, and the first implementation slice

#### Stage 2: Implementation Slice
- [ ] Task 2.1: Implement the milestone capability slice

#### Stage 3: Milestone Quality Closure
- [ ] Task 3.1: Close tests, review, and state for this milestone

#### Milestone Gate
- [ ] Necessary checks passed
- [ ] PLAN progress updated

### Milestone 2: Next Capability Closure

#### Stage 4: Next Implementation Slice
- [ ] Task 4.1: Define and implement the next PRD-backed capability slice
`;
    default:
      return `# ${doc.replaceAll("_", " ").replace(/\.md$/i, "")}\n\nCreated by SuperCodex AGENTS.md scaffold.\n`;
  }
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

This project is managed by SuperCodex using the lightweight AGENTS.md protocol. Before doing work, Codex must read \`.supercodex/AUTO_DEV_STATE.json\`, \`.supercodex/FINAL_GOAL.md\`, \`.supercodex/PRD.md\`, \`.supercodex/ARCHITECTURE.md\`, \`.supercodex/PLAN.md\`, and git status, then continue from the recorded Phase and the plan itself.

Use available sub-agent, worker, explorer, tester, or reviewer capabilities when they materially help: independent exploration, disjoint implementation ownership, repeated failure analysis, parallel testing, code review, security review, or final-goal coverage review. The main agent remains responsible for integration, verification, and required doc updates.

Required durable files:

- \`.supercodex/AUTO_DEV_STATE.json\`
- \`.supercodex/FINAL_GOAL.md\`
- \`.supercodex/PRD.md\`
- \`.supercodex/ARCHITECTURE.md\`
- \`.supercodex/PLAN.md\`

\`.supercodex/AUTO_DEV_STATE.json\` is the machine-readable scheduling source. \`.supercodex/FINAL_GOAL.md\` stores the original user input, final clarified goal, clarification answers, and assumptions. Markdown files are FINAL_GOAL, PRD, ARCHITECTURE, and PLAN. SuperCodex may record runtime logs automatically.

Phase 0 handles blocking clarification questions. After Phase 0, fix errors autonomously, keep AUTO_DEV_STATE valid JSON through atomic writes, and deliver after AUTO_DEV_STATE.acceptance.decision says PASS and Phase 7 delivery is complete.

\`.supercodex/PLAN.md\` is Codex's execution plan and progress record. AUTO_DEV_STATE remains the Phase-level scheduling state. When the PLAN is exhausted, SuperCodex must run the full-project Phase 6 final acceptance before Phase 7.
`;
}

function normalizeAutoDevState(autoDevState: JsonObject): JsonObject {
  const phase = stringValue(autoDevState.phase, "PHASE_0_CLARIFICATION");
  return {
    ...autoDevState,
    mode: modeFromPhase(phase),
    phase,
    currentStageId: null,
    currentTaskId: null,
    phaseLocked: autoDevPhaseLocked(autoDevState),
    done: false,
  };
}

function withExplicitGoalModeDefaults(autoDevState: JsonObject): JsonObject {
  return {
    ...autoDevState,
    goal_mode: autoDevState.goal_mode === true,
  };
}

function autoDevPhaseLocked(autoDevState: JsonObject): boolean {
  const phase = stringValue(autoDevState.phase, "PHASE_0_CLARIFICATION");
  const clarification = objectValue(autoDevState.clarification);
  return phase !== "PHASE_0_CLARIFICATION" || stringValue(clarification.status, "") === "CLOSED";
}

function autoDevStateDelivered(autoDevState: JsonObject, supervisorSession: JsonObject): boolean {
  const delivery = objectValue(autoDevState.delivery);
  return (
    stringValue(autoDevState.decision, "") === "DELIVERED" &&
    planReviewCompletedForCycle(autoDevState, supervisorSession) &&
    acceptancePassed(autoDevState) &&
    Boolean(delivery.git_committed)
  );
}

function planReviewCompletedForCycle(autoDevState: JsonObject, supervisorSession: JsonObject): boolean {
  if (!Boolean(supervisorSession.plan_review_completed)) {
    return false;
  }
  const cycleKey = autoDevCycleKey(autoDevState);
  if (!cycleKey) {
    return true;
  }
  return stringValue(supervisorSession.plan_review_cycle, "") === cycleKey;
}

function autoDevCycleKey(autoDevState: JsonObject): string {
  const cycle = autoDevState.cycle;
  if (typeof cycle === "number" && Number.isFinite(cycle)) {
    return String(cycle);
  }
  if (typeof cycle === "string" && cycle.trim()) {
    return cycle.trim();
  }
  const plan = objectValue(autoDevState.plan);
  const currentCycle = stringValue(plan.current_cycle, "");
  const match = currentCycle.match(/\d+/);
  return match?.[0] ?? "";
}

function acceptancePassed(autoDevState: JsonObject): boolean {
  const acceptance = objectValue(autoDevState.acceptance);
  return new Set(["PASS", "PASSED"]).has(stringValue(acceptance.decision, ""));
}

function acceptanceFailed(autoDevState: JsonObject): boolean {
  const acceptance = objectValue(autoDevState.acceptance);
  return new Set(["FAIL", "FAILED"]).has(stringValue(acceptance.decision, ""));
}

function modeFromPhase(phase: string): string {
  switch (phase) {
    case "PHASE_0_CLARIFICATION":
      return "clarification";
    case "PHASE_1_PRD":
    case "PHASE_2_ARCHITECTURE":
    case "PHASE_3_PLAN":
      return "planning";
    case "PHASE_5_TEST_REVIEW_REPAIR":
      return "repair";
    case "PHASE_6_FINAL_ACCEPTANCE":
      return "review";
    case "PHASE_7_DELIVERY_PR":
      return "delivery";
    default:
      return "execution";
  }
}

function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
