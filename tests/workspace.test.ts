import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseNextWork, ensureScaffold, loadSnapshot, parsePlanTasks, resetSupercodexGoalState } from "../src/workspace.js";

test("ensureScaffold preserves existing PRD and PLAN while adding gitignore rules", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-"));
  await writeFile(join(project, "docs-plan-placeholder"), "");
  await ensureScaffold(project, "goal");
  await writeFile(join(project, ".supercodex", "PRD.md"), "# Existing PRD\n", "utf8");
  await writeFile(join(project, ".supercodex", "PLAN.md"), "# Existing PLAN\n\n- [ ] Task 1.1: First task\n", "utf8");

  await ensureScaffold(project, "new goal");

  assert.equal(await readFile(join(project, ".supercodex", "PRD.md"), "utf8"), "# Existing PRD\n");
  assert.match(await readFile(join(project, ".gitignore"), "utf8"), /^\.supercodex\/$/m);
});

test("ensureScaffold includes lightweight AGENTS.md governance artifacts", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-final-artifacts-"));

  await ensureScaffold(project, "goal");

  assert.match(await readFile(join(project, ".supercodex", "FINAL_GOAL.md"), "utf8"), /# FINAL_GOAL/);
  assert.match(await readFile(join(project, ".supercodex", "FINAL_GOAL.md"), "utf8"), /goal/);
  assert.match(await readFile(join(project, ".supercodex", "TRACEABILITY_MATRIX.md"), "utf8"), /TRACEABILITY_MATRIX/);
  assert.match(await readFile(join(project, ".supercodex", "FINAL_ACCEPTANCE_REPORT.md"), "utf8"), /FINAL_ACCEPTANCE_REPORT/);
  const plan = await readFile(join(project, ".supercodex", "PLAN.md"), "utf8");
  assert.match(plan, /## Cycle 1/);
  assert.match(plan, /### Milestone 1:/);
  assert.match(plan, /#### Stage 1:/);
  assert.match(plan, /#### Milestone Gate/);
  assert.match(plan, /Milestone commit created/);
  const state = JSON.parse(await readFile(join(project, ".supercodex", "AUTO_DEV_STATE.json"), "utf8")) as { schema_version?: string; phase?: string; clarification?: { status?: string } };
  assert.equal(state.schema_version, "1.0");
  assert.equal(state.phase, "PHASE_1_PRD");
  assert.equal(state.clarification?.status, "CLOSED");
});

test("/goal reset removes stale SuperCodex state and writes the new FINAL_GOAL", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-goal-reset-"));
  await ensureScaffold(project, "old goal");
  await writeFile(join(project, ".supercodex", "stale.txt"), "stale\n", "utf8");

  await resetSupercodexGoalState(project, "build the full product");

  await assert.rejects(readFile(join(project, ".supercodex", "stale.txt"), "utf8"));
  assert.match(await readFile(join(project, ".supercodex", "FINAL_GOAL.md"), "utf8"), /build the full product/);
  const state = JSON.parse(await readFile(join(project, ".supercodex", "AUTO_DEV_STATE.json"), "utf8")) as { phase?: string };
  assert.equal(state.phase, "PHASE_1_PRD");
});

test("ensureScaffold creates project AGENTS.md once and preserves existing project guidance", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-agents-"));

  const created = await ensureScaffold(project, "goal");
  const agentsPath = join(project, "AGENTS.md");
  const generatedAgents = await readFile(agentsPath, "utf8");

  assert.ok(created.includes(agentsPath));
  assert.match(generatedAgents, /AGENTS\.md/);
  assert.match(generatedAgents, /SuperCodex|supercodex|Codex/);

  await writeFile(agentsPath, "# Custom Project Rules\n", "utf8");
  const secondCreated = await ensureScaffold(project, "new goal");

  assert.equal(await readFile(agentsPath, "utf8"), "# Custom Project Rules\n");
  assert.ok(!secondCreated.includes(agentsPath));
});

test("ensureScaffold ignores legacy .agent and external docs", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-legacy-ignored-"));
  await mkdir(join(project, ".agent", "supervisor"), { recursive: true });
  await mkdir(join(project, ".agent", "logs", "supervisor"), { recursive: true });
  await mkdir(join(project, "docs"), { recursive: true });
  await writeFile(join(project, ".agent", "state.json"), "{\"done\":true}\n", "utf8");
  await writeFile(join(project, ".agent", "supervisor", "session.json"), "{\"thread_id\":\"legacy\"}\n", "utf8");
  await writeFile(join(project, ".agent", "logs", "supervisor", "legacy.log"), "legacy\n", "utf8");
  await writeFile(join(project, "docs", "PRD.md"), "# Legacy PRD\n", "utf8");

  await ensureScaffold(project, "goal");

  await assert.rejects(readFile(join(project, ".supercodex", "state.json"), "utf8"));
  await assert.rejects(readFile(join(project, ".supercodex", "runtime", "session.json"), "utf8"));
  assert.equal(await readFile(join(project, ".agent", "state.json"), "utf8"), "{\"done\":true}\n");
  assert.notEqual(await readFile(join(project, ".supercodex", "PRD.md"), "utf8"), "# Legacy PRD\n");
  assert.match(await readFile(join(project, ".gitignore"), "utf8"), /^\.supercodex\/$/m);
});

test("ensureScaffold ignores legacy .supercodex/docs state and starts new AUTO_DEV_STATE", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-legacy-docs-ignored-"));
  await mkdir(join(project, ".supercodex", "docs"), { recursive: true });
  await writeFile(join(project, ".supercodex", "docs", "PRD.md"), "# Legacy PRD\n", "utf8");
  await writeFile(join(project, ".supercodex", "docs", "ARCHITECTURE.md"), "# Legacy Architecture\n", "utf8");
  await writeFile(join(project, ".supercodex", "docs", "PLAN.md"), "# Legacy PLAN\n\n## Stage 5: Resume\n\n- [x] Task 5.1: Done\n- [ ] Task 5.2: Continue\n", "utf8");
  await writeFile(join(project, ".supercodex", "state.json"), JSON.stringify({ currentStageId: "stage-99", currentTaskId: "99.1" }), "utf8");
  await writeFile(join(project, ".supercodex", "backlog.json"), JSON.stringify({ stages: [{ id: "stage-99" }] }), "utf8");

  await ensureScaffold(project, "goal");

  assert.notEqual(await readFile(join(project, ".supercodex", "PRD.md"), "utf8"), "# Legacy PRD\n");
  assert.notEqual(await readFile(join(project, ".supercodex", "ARCHITECTURE.md"), "utf8"), "# Legacy Architecture\n");
  assert.notEqual(await readFile(join(project, ".supercodex", "PLAN.md"), "utf8"), "# Legacy PLAN\n\n## Stage 5: Resume\n\n- [x] Task 5.1: Done\n- [ ] Task 5.2: Continue\n");
  const state = JSON.parse(await readFile(join(project, ".supercodex", "AUTO_DEV_STATE.json"), "utf8")) as {
    phase?: string;
    plan?: { current_stage?: string | null; current_task_id?: string | null; completed_task_ids?: string[]; remaining_task_ids?: string[] };
    execution?: { next_action?: string };
  };
  assert.equal(state.phase, "PHASE_1_PRD");
  assert.equal(state.plan?.current_stage, null);
  assert.equal(state.plan?.current_task_id, null);
  assert.deepEqual(state.plan?.completed_task_ids, []);
  assert.deepEqual(state.plan?.remaining_task_ids, []);
  assert.equal(state.execution?.next_action, "START_PHASE_1_PRD");

  const snapshot = await loadSnapshot(project);
  const work = chooseNextWork(snapshot);
  assert.equal(work.kind, "stage_gate");
  assert.equal(work.title, "执行 PHASE_1_PRD: start phase 1 prd");
  assert.equal(work.source, "auto-dev-state");
});

test("ensureScaffold derives AUTO_DEV_STATE from existing lightweight PLAN only", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-plan-done-"));
  await mkdir(join(project, ".supercodex"), { recursive: true });
  await writeFile(join(project, ".supercodex", "PLAN.md"), "# PLAN\n\n## Stage 1: Done\n\n- [x] Task 1.1: Done\n", "utf8");

  await ensureScaffold(project, "goal");

  const state = JSON.parse(await readFile(join(project, ".supercodex", "AUTO_DEV_STATE.json"), "utf8")) as {
    phase?: string;
    plan?: { current_task_id?: string | null; completed_task_ids?: string[]; remaining_task_ids?: string[] };
    execution?: { next_action?: string };
  };
  assert.equal(state.phase, "PHASE_6_FINAL_ACCEPTANCE");
  assert.equal(state.plan?.current_task_id, null);
  assert.deepEqual(state.plan?.completed_task_ids, ["1.1"]);
  assert.deepEqual(state.plan?.remaining_task_ids, []);
  assert.equal(state.execution?.next_action, "RUN_FINAL_ACCEPTANCE");
});

test("parsePlanTasks and chooseNextWork recover unchecked PLAN tasks", async () => {
  const tasks = parsePlanTasks("## Stage 7: Example\n\n- [x] Task 7.1: Done\n- [ ] Task 7.2: Next\n");
  assert.equal(tasks.length, 2);
  const milestoneTasks = parsePlanTasks("## Cycle 1\n\n### Milestone 1: Slice\n\n#### Stage 2: Work\n- [ ] Task 2.1: Next\n");
  assert.equal(milestoneTasks[0]?.stageId, "stage-2");
  const work = chooseNextWork({
    project: ".",
    state: {},
    autoDevState: {},
    docsPresent: {
      "AUTO_DEV_STATE.json": true,
      "FINAL_GOAL.md": true,
      "CLARIFICATIONS.md": true,
      "ASSUMPTIONS.md": true,
      "PRD.md": true,
      "ARCHITECTURE.md": true,
      "PLAN.md": true,
      "TRACEABILITY_MATRIX.md": true,
      "CODE_REVIEW_REPORT.md": true,
      "FINAL_ACCEPTANCE_REPORT.md": true,
    },
    missingDocs: [],
    planTasks: tasks,
    supervisorSession: {},
    done: false,
    phaseLocked: true,
  });
  assert.equal(work.kind, "task");
  assert.equal(work.taskId, "7.2");
  assert.equal(work.stageId, "stage-7");
});

test("chooseNextWork requires a Phase 6 plan-review marker before delivery can stop", () => {
  const base = {
    project: ".",
    missingDocs: [],
    planTasks: [{ id: "1.1", title: "Done", status: "done", stageId: "stage-1", source: "plan" as const }],
    supervisorSession: {},
    done: false,
    phaseLocked: true,
  };

  const auditRequired = chooseNextWork({
    ...base,
    state: {},
    autoDevState: { decision: "DELIVERED", acceptance: { decision: "PENDING" } },
    docsPresent: { "AUTO_DEV_STATE.json": true, "FINAL_GOAL.md": true, "CLARIFICATIONS.md": true, "ASSUMPTIONS.md": true, "PRD.md": true, "ARCHITECTURE.md": true, "PLAN.md": true, "TRACEABILITY_MATRIX.md": true, "CODE_REVIEW_REPORT.md": true, "FINAL_ACCEPTANCE_REPORT.md": true },
  });
  assert.equal(auditRequired.kind, "stage_gate");
  assert.equal(auditRequired.source, "final-acceptance");

  const prematureDelivery = chooseNextWork({
    ...base,
    done: true,
    state: {},
    autoDevState: { cycle: 1, decision: "DELIVERED", acceptance: { decision: "PASS" }, delivery: { readme_updated: true, git_committed: true } },
    docsPresent: { "AUTO_DEV_STATE.json": true, "FINAL_GOAL.md": true, "CLARIFICATIONS.md": true, "ASSUMPTIONS.md": true, "PRD.md": true, "ARCHITECTURE.md": true, "PLAN.md": true, "TRACEABILITY_MATRIX.md": true, "CODE_REVIEW_REPORT.md": true, "FINAL_ACCEPTANCE_REPORT.md": true },
  });
  assert.equal(prematureDelivery.kind, "stage_gate");
  assert.equal(prematureDelivery.source, "final-acceptance");

  const complete = chooseNextWork({
    ...base,
    done: true,
    state: {},
    supervisorSession: { plan_review_completed: true, plan_review_cycle: "1" },
    autoDevState: { cycle: 1, decision: "DELIVERED", acceptance: { decision: "PASS" }, delivery: { readme_updated: true, git_committed: true } },
    docsPresent: { "AUTO_DEV_STATE.json": true, "FINAL_GOAL.md": true, "CLARIFICATIONS.md": true, "ASSUMPTIONS.md": true, "PRD.md": true, "ARCHITECTURE.md": true, "PLAN.md": true, "TRACEABILITY_MATRIX.md": true, "CODE_REVIEW_REPORT.md": true, "FINAL_ACCEPTANCE_REPORT.md": true },
  });
  assert.equal(complete.kind, "done");
});

test("chooseNextWork maps final acceptance pass and fail decisions to Phase 7 or next cycle", () => {
  const base = {
    project: ".",
    state: {},
    missingDocs: [],
    planTasks: [],
    supervisorSession: { plan_review_completed: true, plan_review_cycle: "1" },
    done: false,
    phaseLocked: true,
    docsPresent: { "AUTO_DEV_STATE.json": true, "FINAL_GOAL.md": true, "CLARIFICATIONS.md": true, "ASSUMPTIONS.md": true, "PRD.md": true, "ARCHITECTURE.md": true, "PLAN.md": true, "TRACEABILITY_MATRIX.md": true, "CODE_REVIEW_REPORT.md": true, "FINAL_ACCEPTANCE_REPORT.md": true },
  };

  const passWork = chooseNextWork({
    ...base,
    autoDevState: { phase: "PHASE_6_FINAL_ACCEPTANCE", decision: "PASS_READY_TO_DELIVER", acceptance: { decision: "PASS" } },
  });
  assert.equal(passWork.kind, "stage_gate");
  assert.equal(passWork.title, "执行 Phase 7 最终交付与 PR");

  const failWork = chooseNextWork({
    ...base,
    autoDevState: { phase: "PHASE_6_FINAL_ACCEPTANCE", decision: "FAIL_CONTINUE_NEXT_CYCLE", acceptance: { decision: "FAIL" } },
  });
  assert.equal(failWork.kind, "stage_gate");
  assert.equal(failWork.title, "根据最终验收失败创建下一 Cycle");

  const failWithoutReview = chooseNextWork({
    ...base,
    supervisorSession: {},
    autoDevState: { cycle: 1, phase: "PHASE_6_FINAL_ACCEPTANCE", decision: "FAIL_CONTINUE_NEXT_CYCLE", acceptance: { decision: "FAIL" } },
  });
  assert.equal(failWithoutReview.kind, "stage_gate");
  assert.equal(failWithoutReview.source, "final-acceptance");
  assert.equal(failWithoutReview.title, "进入 Phase 6 最终目标验收");
});

test("loadSnapshot marks delivered only after Phase 7 delivery closure", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-delivery-"));
  await mkdir(join(project, ".supercodex"), { recursive: true });
  for (const doc of ["FINAL_GOAL.md", "CLARIFICATIONS.md", "ASSUMPTIONS.md", "PRD.md", "ARCHITECTURE.md", "PLAN.md", "TRACEABILITY_MATRIX.md", "CODE_REVIEW_REPORT.md", "FINAL_ACCEPTANCE_REPORT.md"]) {
    await writeFile(join(project, ".supercodex", doc), "# doc\n", "utf8");
  }

  const state = {
    schema_version: "1.0",
    phase: "PHASE_7_DELIVERY_PR",
    decision: "DELIVERED",
    clarification: { status: "CLOSED" },
    plan: { completed_task_ids: ["1.1"], remaining_task_ids: [] },
    acceptance: { decision: "PASS" },
    delivery: { readme_updated: false, git_committed: false, pr_created: false },
  };
  await writeFile(join(project, ".supercodex", "AUTO_DEV_STATE.json"), JSON.stringify(state), "utf8");

  const incomplete = await loadSnapshot(project);
  assert.equal(incomplete.done, false);
  const repairWork = chooseNextWork(incomplete);
  assert.equal(repairWork.kind, "stage_gate");
  assert.equal(repairWork.source, "final-acceptance");

  await writeFile(
    join(project, ".supercodex", "AUTO_DEV_STATE.json"),
    JSON.stringify({
      ...state,
      delivery: { readme_updated: true, git_committed: true, pr_created: false },
    }),
    "utf8",
  );

  const withoutReview = await loadSnapshot(project);
  assert.equal(withoutReview.done, false);
  assert.equal(chooseNextWork(withoutReview).source, "final-acceptance");

  await mkdir(join(project, ".supercodex", "runtime"), { recursive: true });
  await writeFile(
    join(project, ".supercodex", "runtime", "session.json"),
    JSON.stringify({ thread_id: "review-thread", lastClassification: "success", plan_review_completed: true, plan_review_cycle: "1" }),
    "utf8",
  );

  const complete = await loadSnapshot(project);
  assert.equal(complete.done, true);
  assert.equal(chooseNextWork(complete).kind, "done");
});
