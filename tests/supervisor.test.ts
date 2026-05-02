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

test("stage change forces a fresh app-server thread", async () => {
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
  assert.deepEqual(calls, [{ threadId: null, resume: false }]);
});

test("saved same-stage session resumes the stored thread instead of opening a fresh session", async () => {
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
  assert.match(capturedPrompt, /kind: operator_intervention/);
  assert.match(capturedPrompt, new RegExp(message));
  const state = JSON.parse(await readFile(join(project, ".supercodex", "state.json"), "utf8")) as { done?: boolean };
  assert.equal(state.done, true);
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
    await mkdir(join(project, ".supercodex", "docs"), { recursive: true });
  });
  await writeFile(join(project, ".supercodex", "state.json"), JSON.stringify({ done: false, currentStageId: "stage-2" }), "utf8");
  await writeFile(
    join(project, ".supercodex", "backlog.json"),
    JSON.stringify({
      stages: [
        { id: "stage-1", status: "done", tasks: [{ id: "stage-1-task-1", status: "done" }], gate: { testsPassed: true, reviewPassed: true, gapReviewed: true, prCreatedOrDocumented: true } },
        { id: "stage-2", status: "todo", tasks: [{ id: "stage-2-task-1", title: "Next", status: "todo", dependencies: [] }] },
      ],
    }),
    "utf8",
  );
  for (const doc of ["PRD.md", "ARCHITECTURE.md", "PLAN.md", "ACCEPTANCE_MATRIX.md", "GAP_REPORT.md", "QA_REPORT.md", "REVIEW_REPORT.md", "DELIVERY_REPORT.md", "BLOCKERS.md", "REQUIREMENTS.md"]) {
    await writeFile(join(project, ".supercodex", "docs", doc), "# doc\n", "utf8");
  }
}

async function writeDoneProjectState(project: string): Promise<void> {
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(join(project, ".supercodex", "runtime"), { recursive: true });
    await mkdir(join(project, ".supercodex", "docs"), { recursive: true });
  });
  await writeFile(join(project, ".supercodex", "state.json"), JSON.stringify({ done: true, mode: "done", phase: "delivery" }), "utf8");
  await writeFile(
    join(project, ".supercodex", "backlog.json"),
    JSON.stringify({
      stages: [
        {
          id: "stage-1",
          status: "done",
          tasks: [{ id: "stage-1-task-1", title: "Done", status: "done", dependencies: [] }],
          gate: { testsPassed: true, reviewPassed: true, gapReviewed: true, prCreatedOrDocumented: true },
        },
      ],
    }),
    "utf8",
  );
  const donePlan = "# PLAN\n\n## Stage 1: Done\n\n- [x] Task S1-T1: Done\n";
  for (const doc of ["PRD.md", "ARCHITECTURE.md", "ACCEPTANCE_MATRIX.md", "GAP_REPORT.md", "QA_REPORT.md", "REVIEW_REPORT.md", "DELIVERY_REPORT.md", "BLOCKERS.md", "REQUIREMENTS.md"]) {
    await writeFile(join(project, ".supercodex", "docs", doc), "# doc\n", "utf8");
  }
  await writeFile(join(project, ".supercodex", "docs", "PLAN.md"), donePlan, "utf8");
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

function interruptedResult(threadId: string): CodexRunResult {
  return {
    returnCode: 130,
    classification: "operator_interrupt",
    promptPath: "prompt",
    eventLogPath: "events",
    stderrPath: "stderr",
    threadId,
    durationSeconds: 0,
    command: ["codex", "app-server", "--listen", "stdio://"],
  };
}
