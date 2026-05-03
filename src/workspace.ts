import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  "CLARIFICATIONS.md",
  "ASSUMPTIONS.md",
  "PRD.md",
  "ARCHITECTURE.md",
  "PLAN.md",
  "TRACEABILITY_MATRIX.md",
  "CODE_REVIEW_REPORT.md",
  "FINAL_ACCEPTANCE_REPORT.md",
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

function autoDevStateTemplate(goal: string, timestamp: string, planTasks: PlanTask[] = []): JsonObject {
  const hasGoal = Boolean(goal.trim());
  const completedTaskIds = planTasks.filter((task) => task.status === "done").map((task) => task.id);
  const remainingTasks = planTasks.filter((task) => task.status !== "done");
  const firstRemainingTask = remainingTasks[0] ?? null;
  const hasPlanProgress = planTasks.length > 0;
  const allPlanTasksDone = hasPlanProgress && remainingTasks.length === 0;
  const phase = firstRemainingTask ? "PHASE_4_DEVELOPMENT" : allPlanTasksDone ? "PHASE_6_FINAL_ACCEPTANCE" : hasGoal ? "PHASE_1_PRD" : "PHASE_0_CLARIFICATION";
  const nextAction = firstRemainingTask ? "EXECUTE_NEXT_PLAN_TASK" : allPlanTasksDone ? "RUN_FINAL_ACCEPTANCE" : hasGoal ? "START_PHASE_1_PRD" : "START_PHASE_0";
  const clarificationClosed = hasGoal || hasPlanProgress;
  return {
    schema_version: "1.0",
    cycle: 1,
    phase,
    decision: "IN_PROGRESS",
    last_updated: timestamp,
    final_goal_source: ".supercodex/FINAL_GOAL.md",
    artifacts: {
      final_goal: ".supercodex/FINAL_GOAL.md",
      clarifications: ".supercodex/CLARIFICATIONS.md",
      assumptions: ".supercodex/ASSUMPTIONS.md",
      prd: ".supercodex/PRD.md",
      architecture: ".supercodex/ARCHITECTURE.md",
      plan: ".supercodex/PLAN.md",
      traceability_matrix: ".supercodex/TRACEABILITY_MATRIX.md",
      code_review_report: ".supercodex/CODE_REVIEW_REPORT.md",
      final_acceptance_report: ".supercodex/FINAL_ACCEPTANCE_REPORT.md",
    },
    clarification: {
      status: clarificationClosed ? "CLOSED" : "OPEN",
      asked_count: 0,
      max_questions: 10,
      pending_questions: [],
      answered_questions: [],
      closed_reason: clarificationClosed ? "Initial goal or existing lightweight PLAN was supplied to SuperCodex scaffold." : null,
    },
    plan: {
      current_cycle: "Cycle 1",
      current_stage: firstRemainingTask?.stageId ?? null,
      current_task_id: firstRemainingTask?.id ?? null,
      completed_task_ids: completedTaskIds,
      remaining_task_ids: remainingTasks.map((task) => task.id),
    },
    execution: {
      next_action: nextAction,
    },
    quality: {
      tests_status: "NOT_RUN",
      code_review_status: "NOT_RUN",
    },
    acceptance: {
      status: "NOT_RUN",
      decision: "PENDING",
      remaining_gaps: [],
    },
    delivery: {
      readme_updated: false,
      git_committed: false,
      pr_created: false,
    },
  };
}

export async function ensureScaffold(projectInput: string, goal = ""): Promise<string[]> {
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

  const minimalFiles: Record<string, string> = {
    ".supercodex/progress.md": "# Progress\n\n",
    ".supercodex/checkpoints.md": "# Checkpoints\n\n",
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

  const shouldDeriveStateFromPlan = await pathExists(join(project, supercodexRoot, "PLAN.md"));
  for (const doc of requiredDocs) {
    if (doc === autoDevStateFile) {
      continue;
    }
    const path = join(project, supercodexRoot, doc);
    if (await pathExists(path)) {
      continue;
    }
    const content = governanceArtifactStub(doc, goal);
    if (await writeTextIfMissing(path, content)) {
      created.push(path);
    }
  }

  const timestamp = nowIso();
  const statePath = join(project, ".supercodex", autoDevStateFile);
  if (!(await pathExists(statePath))) {
    const planTasks = shouldDeriveStateFromPlan ? parsePlanTasks(await readText(join(project, supercodexRoot, "PLAN.md"))) : [];
    await writeJsonAtomic(statePath, autoDevStateTemplate(goal, timestamp, planTasks));
    created.push(statePath);
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
  await ensureSupercodexGitignore(project);
  const autoDevState = await readJson<JsonObject>(join(project, ".supercodex", autoDevStateFile), {});
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
    done: autoDevStateDelivered(autoDevState, docsPresent, supervisorSession),
    phaseLocked: autoDevPhaseLocked(autoDevState),
  };
}

export async function loadSnapshotForRun(projectInput: string, runId?: string | null): Promise<ProjectSnapshot> {
  const snapshot = await loadSnapshot(projectInput);
  snapshot.supervisorSession = await loadRecoverableSupervisorSession(snapshot.project, runId);
  snapshot.done = autoDevStateDelivered(snapshot.autoDevState, snapshot.docsPresent, snapshot.supervisorSession);
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
  if (snapshot.done && autoDevStateDelivered(snapshot.autoDevState, snapshot.docsPresent, snapshot.supervisorSession)) {
    return { kind: "done", title: "Project delivered", reason: ".supercodex/AUTO_DEV_STATE.json decision is DELIVERED, final acceptance passed, and Phase 7 delivery is complete.", source: "auto-dev-state" };
  }
  const criticalMissing = snapshot.missingDocs.filter((doc) => doc === autoDevStateFile || doc === "FINAL_GOAL.md" || doc === "PLAN.md");
  if (criticalMissing.length > 0) {
    return {
      kind: "supplement_docs",
      title: "补齐 AGENTS.md 关键治理产物",
      reason: `Missing critical governance artifacts: ${criticalMissing.join(", ")}`,
      source: "docs",
    };
  }
  if (snapshot.missingDocs.length > 0) {
    return {
      kind: "supplement_docs",
      title: "补齐 AGENTS.md 治理产物",
      reason: `Missing governance artifacts: ${snapshot.missingDocs.join(", ")}`,
      source: "docs",
    };
  }
  const autoWork = chooseFromAutoDevState(snapshot.autoDevState, snapshot.planTasks, snapshot.docsPresent, snapshot.supervisorSession);
  if (autoWork) {
    return autoWork;
  }
  for (const task of snapshot.planTasks) {
    if (task.status !== "done") {
      return {
        kind: "task",
        title: task.title,
        stageId: task.stageId,
        taskId: task.id,
        reason: "First unchecked task in .supercodex/PLAN.md",
        source: "plan",
      };
    }
  }
  if (snapshot.planTasks.length > 0) {
    return {
      kind: "stage_gate",
      title: "进入 Phase 6 最终目标验收",
      reason: "All parsed PLAN tasks are checked; AGENTS.md requires FINAL_ACCEPTANCE_REPORT before delivery.",
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

function chooseFromAutoDevState(autoDevState: JsonObject, planTasks: PlanTask[], docsPresent: Record<string, boolean>, supervisorSession: JsonObject): WorkItem | null {
  if (!Object.keys(autoDevState).length) {
    return null;
  }

  const phase = stringValue(autoDevState.phase, "PHASE_0_CLARIFICATION");
  const decision = stringValue(autoDevState.decision, "IN_PROGRESS");
  const clarification = objectValue(autoDevState.clarification);
  const plan = objectValue(autoDevState.plan);
  const execution = objectValue(autoDevState.execution);
  const acceptance = objectValue(autoDevState.acceptance);
  const currentTaskId = stringOrNull(plan.current_task_id);
  const currentStage = normalizeOptionalStageId(plan.current_stage);
  const completed = new Set(stringArray(plan.completed_task_ids));
  const remaining = stringArray(plan.remaining_task_ids).filter((id) => !completed.has(id));
  const nextAction = stringValue(execution.next_action, "");
  const hasOpenPlanWork = Boolean(currentTaskId) || remaining.length > 0 || planTasks.some((task) => task.status !== "done");
  const claimsAcceptanceOrDelivery = decision === "DELIVERED" || decision === "PASS_READY_TO_DELIVER" || acceptancePassed(autoDevState);
  const planReviewComplete = planReviewCompletedForCycle(autoDevState, supervisorSession);

  if (claimsAcceptanceOrDelivery && !planReviewComplete && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "进入 Phase 6 最终目标验收",
      reason: "PLAN is exhausted, but this cycle has not completed a dedicated Phase 6 plan-review thread.",
      source: "final-acceptance",
    };
  }

  if (decision === "DELIVERED" && !autoDevStateDelivered(autoDevState, docsPresent, supervisorSession) && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "补齐最终验收与交付闭环证据",
      reason: "AUTO_DEV_STATE decision is DELIVERED, but final acceptance or README/Git delivery closure evidence is incomplete.",
      source: "auto-dev-state",
    };
  }

  if ((decision === "PASS_READY_TO_DELIVER" || acceptancePassed(autoDevState)) && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "执行 Phase 7 最终交付与 PR",
      reason: "Final acceptance passed; AGENTS.md requires README/Git delivery closure.",
      source: "auto-dev-state",
    };
  }

  if ((decision === "FAIL_CONTINUE_NEXT_CYCLE" || acceptanceFailed(autoDevState)) && !hasOpenPlanWork) {
    return {
      kind: "stage_gate",
      title: "根据最终验收失败创建下一 Cycle",
      reason: "FINAL_ACCEPTANCE_REPORT is failed; update PRD, architecture, PLAN, and TRACEABILITY_MATRIX before continuing.",
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

  if (currentTaskId) {
    return {
      kind: "task",
      title: `执行 Plan task ${currentTaskId}`,
      stageId: currentStage ?? inferStageFromTaskId(currentTaskId),
      taskId: currentTaskId,
      reason: "AUTO_DEV_STATE.json plan.current_task_id",
      source: "auto-dev-state",
    };
  }

  if (remaining.length > 0) {
    const taskId = remaining[0]!;
    return {
      kind: "task",
      title: `执行 Plan task ${taskId}`,
      stageId: currentStage ?? inferStageFromTaskId(taskId),
      taskId,
      reason: "AUTO_DEV_STATE.json plan.remaining_task_ids",
      source: "auto-dev-state",
    };
  }

  if (phase === "PHASE_4_DEVELOPMENT" && planTasks.some((task) => task.status !== "done")) {
    return null;
  }

  if (nextAction) {
    return {
      kind: phase === "PHASE_4_DEVELOPMENT" ? "task" : "stage_gate",
      title: nextActionTitle(nextAction, phase),
      stageId: currentStage,
      reason: `AUTO_DEV_STATE.json execution.next_action=${nextAction}`,
      source: "auto-dev-state",
    };
  }

  return phaseWork(phase, currentStage);
}

function phaseWork(phase: string, stageId: string | null): WorkItem | null {
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
        title: "Phase 3 制定或更新 Plan 与追踪矩阵",
        reason: "AUTO_DEV_STATE phase is PHASE_3_PLAN.",
        source: "auto-dev-state",
      };
    case "PHASE_5_TEST_REVIEW_REPAIR":
      return {
        kind: "stage_gate",
        title: "Phase 5 测试、审查与修复",
        stageId,
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
      "- 恢复方式：重新运行 `supercodex run --project <path>`，循环器会读取 .supercodex/AUTO_DEV_STATE.json 与轻量治理产物后继续。\n\n",
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

function governanceArtifactStub(doc: string, goal: string): string {
  switch (doc) {
    case "FINAL_GOAL.md":
      return `# FINAL_GOAL

## 用户原始目标
${goal || "Not provided yet."}

## 结构化最终目标
- 待 Phase 0 根据用户原始目标补全。

## 明确不做的内容
- 未声明。

## 验收标准
- 待 PRD 与 TRACEABILITY_MATRIX 细化。

## 风险与边界
- 待架构阶段补全。
`;
    case "CLARIFICATIONS.md":
      return "# CLARIFICATIONS\n\nNo blocking clarification has been recorded yet.\n";
    case "ASSUMPTIONS.md":
      return "# ASSUMPTIONS\n\nNo assumptions have been recorded yet.\n";
    case "TRACEABILITY_MATRIX.md":
      return `# TRACEABILITY_MATRIX

| Final Goal | Acceptance Criteria | PRD Requirement | Architecture Component | Plan Task | Test/Review Evidence | Status |
|---|---|---|---|---|---|---|
`;
    case "CODE_REVIEW_REPORT.md":
      return "# CODE_REVIEW_REPORT\n\nNo review has been recorded yet.\n";
    case "FINAL_ACCEPTANCE_REPORT.md":
      return "# FINAL_ACCEPTANCE_REPORT\n\n## Final Goal Coverage\n\n## PRD Coverage\n\n## Test Summary\n\n## Code Review Summary\n\n## Remaining Gaps\n\n## Decision\n- PENDING\n";
    case "ARCHITECTURE.md":
    case "PRD.md":
      return `# ${doc.slice(0, -3)}

This file was created by SuperCodex as a missing AGENTS.md governance artifact.
It should be filled by the active Codex work cycle without recreating the old heavy docs tree.

Goal: ${goal || "Not provided yet."}
`;
    case "PLAN.md":
      return `# PLAN

Goal: ${goal || "Not provided yet."}

## Cycle 1

### Milestone 1: Foundation Capability Closure
- Goal: Fill this milestone from PRD and ARCHITECTURE.
- Stages: Stage 1-3
- Commit boundary: Create a milestone commit after all included stages pass their checks.
- Push policy: Push if a remote is available.
- Thread boundary: Continue in the same plan-cycle thread.

#### Stage 1: Scope and Architecture Alignment
- [ ] Task 1.1: Align PRD, architecture, traceability, and the first implementation slice
  - Goal: Define a concrete, verifiable slice for this milestone.
  - Files: .supercodex/PRD.md, .supercodex/ARCHITECTURE.md, .supercodex/TRACEABILITY_MATRIX.md
  - Steps: Map final-goal requirements to the milestone stages and implementation files.
  - Verify: TRACEABILITY_MATRIX links each planned task to acceptance evidence.

#### Stage 2: Implementation Slice
- [ ] Task 2.1: Implement the milestone capability slice
  - Goal: Deliver meaningful user-visible or system capability.
  - Files: To be filled by Phase 3 planning.
  - Steps: To be filled by Phase 3 planning.
  - Verify: To be filled by Phase 3 planning.

#### Stage 3: Milestone Quality Closure
- [ ] Task 3.1: Close tests, review, traceability, and state for this milestone
  - Goal: Prove this milestone is stable before the intermediate commit.
  - Files: .supercodex/CODE_REVIEW_REPORT.md, .supercodex/TRACEABILITY_MATRIX.md, .supercodex/AUTO_DEV_STATE.json, .supercodex/PLAN.md
  - Steps: Run relevant checks, repair failures, update milestone completion state.
  - Verify: PLAN/TRACEABILITY_MATRIX contain acceptance evidence and AUTO_DEV_STATE points to the next action.

#### Milestone Gate
- [ ] Relevant tests / lint / typecheck / build passed
- [ ] CODE_REVIEW_REPORT / TRACEABILITY_MATRIX updated
- [ ] PLAN / AUTO_DEV_STATE updated
- [ ] Milestone commit created
- [ ] Push attempted if remote is available

### Milestone 2: Next Capability Closure
- Goal: Add the next group of stages after Milestone 1 is clear.
- Stages: Stage 4-7
- Commit boundary: Create a milestone commit after all included stages pass their checks.

#### Stage 4: Next Implementation Slice
- [ ] Task 4.1: Define and implement the next PRD-backed capability slice
  - Goal: To be filled by Phase 3 planning.
  - Files: To be filled by Phase 3 planning.
  - Steps: To be filled by Phase 3 planning.
  - Verify: To be filled by Phase 3 planning.
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

This project is managed by SuperCodex using the lightweight AGENTS.md governance protocol. Before doing work, Codex must read \`.supercodex/AUTO_DEV_STATE.json\`, \`.supercodex/FINAL_GOAL.md\`, \`.supercodex/PLAN.md\`, \`.supercodex/TRACEABILITY_MATRIX.md\`, \`.supercodex/CODE_REVIEW_REPORT.md\`, \`.supercodex/FINAL_ACCEPTANCE_REPORT.md\`, checkpoints, and git status, then continue from the recorded phase/task instead of restarting from scratch.

Use available sub-agent, worker, explorer, tester, or reviewer capabilities when they materially help: independent exploration, disjoint implementation ownership, repeated failure analysis, parallel testing, code review, security review, or final-goal coverage review. Do not use them for tiny tasks or overlapping write scopes. The main agent remains responsible for integration, verification, and governance updates.

Required durable governance artifacts:

- \`.supercodex/AUTO_DEV_STATE.json\`
- \`.supercodex/FINAL_GOAL.md\`
- \`.supercodex/CLARIFICATIONS.md\`
- \`.supercodex/ASSUMPTIONS.md\`
- \`.supercodex/PRD.md\`
- \`.supercodex/ARCHITECTURE.md\`
- \`.supercodex/PLAN.md\`
- \`.supercodex/TRACEABILITY_MATRIX.md\`
- \`.supercodex/CODE_REVIEW_REPORT.md\`
- \`.supercodex/FINAL_ACCEPTANCE_REPORT.md\`

\`.supercodex/AUTO_DEV_STATE.json\` is the machine-readable scheduling source. Markdown files are the human-readable goal, plan, traceability, review, and final acceptance artifacts. Do not recreate old heavy docs trees unless the user explicitly asks for them.

Only Phase 0 may ask the user blocking clarification questions. After Phase 0, fix errors autonomously, keep AUTO_DEV_STATE valid JSON through atomic writes, and do not claim delivery until FINAL_ACCEPTANCE_REPORT says PASS and Phase 7 delivery is complete.

\`.supercodex/PLAN.md\` should group Stage tasks inside Cycle and Milestone sections. Stage remains the execution unit; Milestone is the intermediate commit/push boundary. Do not create a fresh Codex thread for Stage changes, Milestone commits, or pushes. Phase 7 still owns the final commit/PR closure after final acceptance passes.
`;
}

function normalizeAutoDevState(autoDevState: JsonObject): JsonObject {
  const phase = stringValue(autoDevState.phase, "PHASE_0_CLARIFICATION");
  const plan = objectValue(autoDevState.plan);
  return {
    ...autoDevState,
    mode: modeFromPhase(phase),
    phase,
    currentStageId: normalizeOptionalStageId(plan.current_stage),
    currentTaskId: stringOrNull(plan.current_task_id),
    phaseLocked: autoDevPhaseLocked(autoDevState),
    done: false,
  };
}

function autoDevPhaseLocked(autoDevState: JsonObject): boolean {
  const phase = stringValue(autoDevState.phase, "PHASE_0_CLARIFICATION");
  const clarification = objectValue(autoDevState.clarification);
  return phase !== "PHASE_0_CLARIFICATION" || stringValue(clarification.status, "") === "CLOSED";
}

function autoDevStateDelivered(autoDevState: JsonObject, docsPresent: Record<string, boolean>, supervisorSession: JsonObject): boolean {
  const delivery = objectValue(autoDevState.delivery);
  return (
    stringValue(autoDevState.decision, "") === "DELIVERED" &&
    Boolean(docsPresent["FINAL_ACCEPTANCE_REPORT.md"]) &&
    planReviewCompletedForCycle(autoDevState, supervisorSession) &&
    acceptancePassed(autoDevState) &&
    Boolean(delivery.readme_updated) &&
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
  return new Set(["PASS", "PASSED"]).has(stringValue(acceptance.decision, "")) || new Set(["PASS", "PASSED"]).has(stringValue(acceptance.status, ""));
}

function acceptanceFailed(autoDevState: JsonObject): boolean {
  const acceptance = objectValue(autoDevState.acceptance);
  return new Set(["FAIL", "FAILED"]).has(stringValue(acceptance.decision, "")) || new Set(["FAIL", "FAILED"]).has(stringValue(acceptance.status, ""));
}

function nextActionTitle(nextAction: string, phase: string): string {
  const cleaned = nextAction.replaceAll("_", " ").toLowerCase();
  return `执行 ${phase}: ${cleaned}`;
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
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
