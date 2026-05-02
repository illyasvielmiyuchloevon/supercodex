import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Supervisor, defaultSupervisorConfig, resumableThreadId, type Runner } from "../src/supervisor.js";
import type { CodexAuthManager } from "../src/auth.js";
import { requestSteer } from "../src/control.js";
import type { CodexRunResult } from "../src/types.js";

test("resumableThreadId rejects dry-run and non-recoverable sessions", () => {
  assert.equal(resumableThreadId({ dryRun: true, thread_id: "thr_1" }), null);
  assert.equal(resumableThreadId({ lastClassification: "failed", thread_id: "thr_1" }), null);
  assert.equal(resumableThreadId({ lastClassification: "network_transient", thread_id: "thr_1" }), "thr_1");
  assert.equal(resumableThreadId({ lastClassification: "remote_compaction_failed", thread_id: "thr_1" }), "thr_1");
  assert.equal(resumableThreadId({ lastClassification: "success", thread_id: "thr_1" }), "thr_1");
});

test("default supervisor config runs until done unless explicitly capped", () => {
  const config = defaultSupervisorConfig(".");
  assert.equal(config.maxCycles, Number.POSITIVE_INFINITY);
  assert.equal(config.maxRetries, 10);
  assert.equal(config.networkTransientMaxRetries, 10);
  assert.equal(config.remoteCompactionMaxRetries, 20);
  assert.equal(config.sameSessionRetryLimit, 10);
});

test("stage change keeps the active PLAN in the same app-server thread", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-"));
  await writeProjectState(project);
  await writeFile(
    join(project, ".supercodex", "runtime", "session.json"),
    JSON.stringify({ thread_id: "thr_old", stage_id: "stage-1", lastClassification: "network_transient" }),
    "utf8",
  );
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      return result("thr_new");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 1, retryBaseSeconds: 0, retryMaxSeconds: 0 };
  const code = await new Supervisor(config, runner, async () => undefined).run();
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ threadId: "thr_old", resume: true }]);
});

test("plan completion starts one fresh global acceptance review thread", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-plan-review-"));
  await writePlanCompleteProjectState(project);
  await writeFile(
    join(project, ".supercodex", "runtime", "session.json"),
    JSON.stringify({ thread_id: "thr_plan", stage_id: "stage-2", thread_scope: "plan-cycle", lastClassification: "success" }),
    "utf8",
  );
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      return result("thr_review");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 1, retryBaseSeconds: 0, retryMaxSeconds: 0 };
  const code = await new Supervisor(config, runner, async () => undefined).run();
  const saved = JSON.parse(await readFile(join(project, ".supercodex", "runtime", "session.json"), "utf8")) as { thread_scope?: string };

  assert.equal(code, 0);
  assert.deepEqual(calls, [{ threadId: null, resume: false }]);
  assert.equal(saved.thread_scope, "plan-review");
});

test("global acceptance review resumes its review thread until it updates the next cycle", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-plan-review-resume-"));
  await writePlanCompleteProjectState(project);
  await writeFile(
    join(project, ".supercodex", "runtime", "session.json"),
    JSON.stringify({ thread_id: "thr_review", thread_scope: "plan-review", lastClassification: "success" }),
    "utf8",
  );
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      return result("thr_review");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 1, retryBaseSeconds: 0, retryMaxSeconds: 0 };
  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.deepEqual(calls, [{ threadId: "thr_review", resume: true }]);
});

test("saved PLAN session resumes the stored thread instead of opening a fresh session", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-resume-"));
  await writeProjectState(project);
  await writeFile(
    join(project, ".supercodex", "runtime", "session.json"),
    JSON.stringify({ thread_id: "thr_saved", stage_id: "stage-2", lastClassification: "network_transient" }),
    "utf8",
  );
  const calls: Array<{ threadId?: string | null; resume?: boolean; runId?: string | null }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume, runId: input.runId });
      return result("thr_saved");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 1, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.deepEqual(calls, [{ threadId: "thr_saved", resume: true, runId: "default" }]);
});

test("active runtime thread from an interrupted process is recoverable by /start", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-runtime-resume-"));
  await writeProjectState(project);
  await writeFile(
    join(project, ".supercodex", "runtime", "runtime.json"),
    JSON.stringify({
      status: "running",
      thread_id: "thr_running",
      turn_id: "turn_running",
      stage_id: "stage-2",
      task_id: "stage-2-task-1",
      work_kind: "task",
      updatedAt: "2026-05-01T10:00:00.000Z",
    }),
    "utf8",
  );
  const calls: Array<{ threadId?: string | null; resume?: boolean; runId?: string | null }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume, runId: input.runId });
      return result("thr_running");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 1, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.deepEqual(calls, [{ threadId: "thr_running", resume: true, runId: "default" }]);
});

test("unauthorized auth failures rotate accounts and retry the same thread", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-"));
  await writeProjectState(project);
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const rotations: string[] = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      return calls.length === 1 ? failedResult("thr_auth", "unauthorized") : result("thr_auth");
    },
  };
  const authManager = {
    async listAccounts() {
      return ["account-1", "account-2"];
    },
    async rotateAfterAuthFailure(reason: "usage_limit" | "unauthorized") {
      rotations.push(reason);
      return "account-2";
    },
  } as unknown as CodexAuthManager;
  const config = {
    ...defaultSupervisorConfig(project),
    maxCycles: 2,
    retryBaseSeconds: 0,
    retryMaxSeconds: 0,
    authManager,
  };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.deepEqual(rotations, ["unauthorized"]);
  assert.deepEqual(calls, [
    { threadId: null, resume: false },
    { threadId: "thr_auth", resume: true },
  ]);
});

test("operator stop without a message interrupts once and does not start a replacement turn", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-stop-"));
  await writeProjectState(project);
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      return interruptedResult("thr_stop");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 3, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 130);
  assert.deepEqual(calls, [{ threadId: null, resume: false }]);
});

test("operator stop during an operator-message turn does not replay the original message", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-stop-message-turn-"));
  await writeProjectState(project);
  await requestSteer(project, "start this supervised operator task", "default");
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      assert.match(input.prompt, /start this supervised operator task/);
      return interruptedResult("thr_stop", { controlId: "stop-request" });
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 3, operatorIntervention: true, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 130);
  assert.deepEqual(calls, [{ threadId: null, resume: false }]);
});

test("operator interrupt with a supplied message resumes with that message", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-interrupt-message-"));
  await writeProjectState(project);
  const prompts: string[] = [];
  const runner: Runner = {
    async run(input) {
      prompts.push(input.prompt);
      if (prompts.length === 1) {
        return interruptedResult("thr_interrupted", { controlId: "interrupt-request", operatorMessage: "inspect this failure before continuing" });
      }
      return result("thr_interrupted");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 2, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /inspect this failure before continuing/);
});

test("ordinary recoverable failures retry same Codex thread ten times before fresh thread", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-recoverable-retry-"));
  await writeProjectState(project);
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      if (calls.length <= 10) {
        return failedResult("thr_compaction", "context_compaction_failed");
      }
      return result("thr_fresh");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 11, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.equal(calls.length, 11);
  assert.deepEqual(calls[0], { threadId: null, resume: false });
  for (const call of calls.slice(1, 10)) {
    assert.deepEqual(call, { threadId: "thr_compaction", resume: true });
  }
  assert.deepEqual(calls[10], { threadId: null, resume: false });
});

test("network transient failures retry same Codex thread ten times before fresh thread", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-network-transient-retry-"));
  await writeProjectState(project);
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      if (calls.length <= 10) {
        return failedResult("thr_network_transient", "network_transient");
      }
      return result("thr_fresh_after_network_transient");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 11, maxRetries: 3, sameSessionRetryLimit: 2, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.equal(calls.length, 11);
  assert.deepEqual(calls[0], { threadId: null, resume: false });
  for (const call of calls.slice(1, 10)) {
    assert.deepEqual(call, { threadId: "thr_network_transient", resume: true });
  }
  assert.deepEqual(calls[10], { threadId: null, resume: false });
});

test("remote pre-sampling compaction retries same Codex thread twenty times before fresh thread", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-remote-compaction-retry-"));
  await writeProjectState(project);
  const calls: Array<{ threadId?: string | null; resume?: boolean }> = [];
  const runner: Runner = {
    async run(input) {
      calls.push({ threadId: input.threadId, resume: input.resume });
      if (calls.length <= 20) {
        return failedResult("thr_remote_compaction", "remote_compaction_failed");
      }
      return result("thr_fresh_after_remote_compaction");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 21, maxRetries: 3, sameSessionRetryLimit: 2, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.equal(calls.length, 21);
  assert.deepEqual(calls[0], { threadId: null, resume: false });
  for (const call of calls.slice(1, 20)) {
    assert.deepEqual(call, { threadId: "thr_remote_compaction", resume: true });
  }
  assert.deepEqual(calls[20], { threadId: null, resume: false });
});

test("operator message on a done project runs as supervised intervention without reopening final gate", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-done-intervention-"));
  await writeDoneProjectState(project);
  const message = "请处理新的 TUI 变更请求";
  await requestSteer(project, message, "default");
  let capturedPrompt = "";
  const runner: Runner = {
    async run(input) {
      capturedPrompt = input.prompt;
      return result("thr_intervention");
    },
  };
  const config = { ...defaultSupervisorConfig(project), maxCycles: 1, retryBaseSeconds: 0, retryMaxSeconds: 0 };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.match(capturedPrompt, /External Supervisor Prompt/);
  assert.match(capturedPrompt, /Runtime Operator Intervention/);
  assert.match(capturedPrompt, /AUTO_DEV_STATE\.json/);
  assert.match(capturedPrompt, /FINAL_ACCEPTANCE_REPORT\.md/);
  assert.match(capturedPrompt, /Continuity and State Rule/);
  assert.match(capturedPrompt, /TRACEABILITY_MATRIX/);
  assert.match(capturedPrompt, /Sub-Agent Collaboration Policy/);
  assert.match(capturedPrompt, /disjoint implementation ownership/);
  assert.doesNotMatch(capturedPrompt, /Do not replace PRD, do not rewrite PLAN into a new strategy, and do not replan completed or in-progress work\./);
  assert.match(capturedPrompt, /kind: operator_intervention/);
  assert.match(capturedPrompt, new RegExp(message));
  const state = JSON.parse(await readFile(join(project, ".supercodex", "AUTO_DEV_STATE.json"), "utf8")) as { decision?: string };
  assert.equal(state.decision, "DELIVERED");
});

test("fresh TUI operator mode wraps the message while prioritizing it over unfinished plan work", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-fresh-intervention-"));
  await writeProjectState(project);
  const message = "这是一次新的普通输入，不是 /start 续跑";
  await requestSteer(project, message, "session-fresh");
  let capturedPrompt = "";
  const runner: Runner = {
    async run(input) {
      capturedPrompt = input.prompt;
      return result("thr_fresh");
    },
  };
  const config = {
    ...defaultSupervisorConfig(project),
    maxCycles: 1,
    operatorIntervention: true,
    retryBaseSeconds: 0,
    retryMaxSeconds: 0,
    runId: "session-fresh",
  };

  const code = await new Supervisor(config, runner, async () => undefined).run();

  assert.equal(code, 0);
  assert.match(capturedPrompt, /External Supervisor Prompt/);
  assert.match(capturedPrompt, /Runtime Operator Intervention/);
  assert.match(capturedPrompt, /kind: operator_intervention/);
  assert.match(capturedPrompt, new RegExp(message));
  assert.doesNotMatch(capturedPrompt, /kind: task/);
});

async function writeProjectState(project: string): Promise<void> {
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(join(project, ".supercodex", "runtime"), { recursive: true });
    await mkdir(join(project, ".supercodex"), { recursive: true });
  });
  await writeFile(
    join(project, ".supercodex", "AUTO_DEV_STATE.json"),
    JSON.stringify({
      schema_version: "1.0",
      cycle: 1,
      phase: "PHASE_4_DEVELOPMENT",
      decision: "IN_PROGRESS",
      clarification: { status: "CLOSED", asked_count: 0, max_questions: 10, pending_questions: [], answered_questions: [] },
      plan: { current_cycle: "Cycle 1", current_stage: "stage-2", current_task_id: null, completed_task_ids: ["stage-1-task-1"], remaining_task_ids: ["stage-2-task-1"] },
      execution: { next_action: "EXECUTE_NEXT_PLAN_TASK" },
      quality: { tests_status: "NOT_RUN", code_review_status: "NOT_RUN" },
      acceptance: { status: "NOT_RUN", decision: "PENDING", remaining_gaps: [] },
      delivery: { readme_updated: false, git_committed: false, pr_created: false },
    }),
    "utf8",
  );
  for (const doc of ["FINAL_GOAL.md", "CLARIFICATIONS.md", "ASSUMPTIONS.md", "PRD.md", "ARCHITECTURE.md", "PLAN.md", "TRACEABILITY_MATRIX.md", "CODE_REVIEW_REPORT.md", "FINAL_ACCEPTANCE_REPORT.md"]) {
    await writeFile(join(project, ".supercodex", doc), "# doc\n", "utf8");
  }
}

async function writePlanCompleteProjectState(project: string): Promise<void> {
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(join(project, ".supercodex", "runtime"), { recursive: true });
    await mkdir(join(project, ".supercodex"), { recursive: true });
  });
  await writeFile(
    join(project, ".supercodex", "AUTO_DEV_STATE.json"),
    JSON.stringify({
      schema_version: "1.0",
      cycle: 1,
      phase: "PHASE_6_FINAL_ACCEPTANCE",
      decision: "IN_PROGRESS",
      clarification: { status: "CLOSED", asked_count: 0, max_questions: 10, pending_questions: [], answered_questions: [] },
      plan: { current_cycle: "Cycle 1", current_stage: null, current_task_id: null, completed_task_ids: ["1.1"], remaining_task_ids: [] },
      execution: { next_action: "RUN_FINAL_ACCEPTANCE" },
      quality: { tests_status: "PASS", code_review_status: "PASS" },
      acceptance: { status: "NOT_RUN", decision: "PENDING", remaining_gaps: [] },
      delivery: { readme_updated: false, git_committed: false, pr_created: false },
    }),
    "utf8",
  );
  const donePlan = "# PLAN\n\n## Stage 1: Done\n\n- [x] Task 1.1: Done\n";
  for (const doc of ["FINAL_GOAL.md", "CLARIFICATIONS.md", "ASSUMPTIONS.md", "PRD.md", "ARCHITECTURE.md", "TRACEABILITY_MATRIX.md", "CODE_REVIEW_REPORT.md", "FINAL_ACCEPTANCE_REPORT.md"]) {
    await writeFile(join(project, ".supercodex", doc), "# doc\n", "utf8");
  }
  await writeFile(join(project, ".supercodex", "PLAN.md"), donePlan, "utf8");
}

async function writeDoneProjectState(project: string): Promise<void> {
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(join(project, ".supercodex", "runtime"), { recursive: true });
    await mkdir(join(project, ".supercodex"), { recursive: true });
  });
  await writeFile(
    join(project, ".supercodex", "AUTO_DEV_STATE.json"),
    JSON.stringify({
      schema_version: "1.0",
      cycle: 1,
      phase: "PHASE_7_DELIVERY_PR",
      decision: "DELIVERED",
      clarification: { status: "CLOSED", asked_count: 0, max_questions: 10, pending_questions: [], answered_questions: [] },
      plan: { current_cycle: "Cycle 1", current_stage: null, current_task_id: null, completed_task_ids: ["1.1"], remaining_task_ids: [] },
      execution: { next_action: "DONE" },
      quality: { tests_status: "PASS", code_review_status: "PASS" },
      acceptance: { status: "PASS", decision: "PASS", remaining_gaps: [] },
      delivery: { readme_updated: true, git_committed: true, pr_created: false },
    }),
    "utf8",
  );
  const donePlan = "# PLAN\n\n## Stage 1: Done\n\n- [x] Task 1.1: Done\n";
  for (const doc of ["FINAL_GOAL.md", "CLARIFICATIONS.md", "ASSUMPTIONS.md", "PRD.md", "ARCHITECTURE.md", "TRACEABILITY_MATRIX.md", "CODE_REVIEW_REPORT.md", "FINAL_ACCEPTANCE_REPORT.md"]) {
    await writeFile(join(project, ".supercodex", doc), "# doc\n", "utf8");
  }
  await writeFile(join(project, ".supercodex", "PLAN.md"), donePlan, "utf8");
}

function result(threadId: string): CodexRunResult {
  return {
    returnCode: 0,
    classification: "success",
    promptPath: "prompt",
    eventLogPath: "events",
    stderrPath: "stderr",
    threadId,
    durationSeconds: 0,
    command: ["codex", "app-server", "--listen", "stdio://"],
  };
}

function failedResult(threadId: string, classification: string): CodexRunResult {
  return {
    returnCode: 1,
    classification,
    promptPath: "prompt",
    eventLogPath: "events",
    stderrPath: "stderr",
    threadId,
    durationSeconds: 0,
    command: ["codex", "app-server", "--listen", "stdio://"],
  };
}

function interruptedResult(threadId: string, overrides: Partial<CodexRunResult> = {}): CodexRunResult {
  return {
    returnCode: 130,
    classification: "operator_interrupt",
    promptPath: "prompt",
    eventLogPath: "events",
    stderrPath: "stderr",
    threadId,
    durationSeconds: 0,
    command: ["codex", "app-server", "--listen", "stdio://"],
    ...overrides,
  };
}
