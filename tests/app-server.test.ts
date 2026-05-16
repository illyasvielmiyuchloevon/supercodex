import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppServerClient, AppServerRunner, classifyAppServerFailure, summarizeAppServerNotification } from "../src/app-server.js";
import { requestSteer } from "../src/control.js";

test("classifyAppServerFailure maps structured Codex errors", () => {
  assert.equal(classifyAppServerFailure({ codexErrorInfo: "usageLimitExceeded" }), "usage_limit");
  assert.equal(classifyAppServerFailure({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }), "network_transient");
  assert.equal(classifyAppServerFailure({ codexErrorInfo: "contextWindowExceeded" }), "context_window_exceeded");
});

test("classifyAppServerFailure recognizes remote pre-sampling compaction failures", () => {
  const text = [
    'Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)',
    "codex_core::compact_remote: remote compaction failed",
    "codex_core::session::turn: Failed to run pre-sampling compact",
  ].join("\n");

  assert.equal(classifyAppServerFailure({ error: { message: text, codexErrorInfo: "other" } }), "remote_compaction_failed");
});

test("classifyAppServerFailure promotes deterministic remote compaction overflow to context window exceeded", () => {
  const text = [
    "codex_core::compact_remote: remote compaction failed",
    "all_history_items_model_visible_bytes=2513704",
    "estimated_tokens_of_items_added_since_last_successful_api_response=253095",
    "model_context_window_tokens=Some(258400)",
    "failing_compaction_request_model_visible_bytes=2535051",
  ].join("\n");

  assert.equal(classifyAppServerFailure({ error: { message: text, codexErrorInfo: "other" } }), "context_window_exceeded");
});

test("classifyAppServerFailure keeps text fallbacks for session and usage failures", () => {
  assert.equal(classifyAppServerFailure("thread 123 not found"), "session_not_found");
  assert.equal(classifyAppServerFailure("You've hit your usage limit"), "usage_limit");
  assert.equal(classifyAppServerFailure("401 Unauthorized: token_invalidated"), "unauthorized");
  assert.equal(classifyAppServerFailure("refresh_token_reused"), "unauthorized");
});

test("runner failure classification promotes usage-limit hints from stderr over remote compaction fallback", () => {
  const runner = new AppServerRunner();
  const classify = (runner as unknown as {
    classifyFailureWithDiagnostics(primary: unknown, stderrText: string): string;
  }).classifyFailureWithDiagnostics.bind(runner);

  assert.equal(
    classify(
      { message: "Failed to run pre-sampling compact" },
      "https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
    ),
    "usage_limit",
  );
});

test("runner failure classification keeps nested usageLimitExceeded code when diagnostics are wrapped", () => {
  const runner = new AppServerRunner();
  const classify = (runner as unknown as {
    classifyFailureWithDiagnostics(primary: unknown, stderrText: string): string;
  }).classifyFailureWithDiagnostics.bind(runner);

  const primary = {
    error: {
      message: "Error running remote compact task",
      codexErrorInfo: "usageLimitExceeded",
    },
  };
  const stderr = [
    "codex_core::compact_remote: remote compaction failed",
    "model_context_window_tokens=Some(258400)",
    "failing_compaction_request_model_visible_bytes=1027309",
  ].join("\n");
  assert.equal(classify(primary, stderr), "usage_limit");
});

test("waitForTurnCompletion accepts a completion event observed before waiter registration", async () => {
  const runner = new AppServerRunner();
  const wait = (runner as unknown as {
    waitForTurnCompletion(input: {
      client: {
        onNotification(handler: (message: unknown) => void): void;
        request(): Promise<unknown>;
        hasExited(): boolean;
        exitSummary(): string;
        stderrText(): string;
        idleSeconds(): number;
        lastActivitySummary(): string;
      };
      project: string;
      threadId: string;
      turnId: string;
      initialCompletion: unknown;
      setOperator(message: string | null, id: string | null): void;
    }): Promise<unknown>;
  }).waitForTurnCompletion.bind(runner);

  const completion = { turn: { id: "turn-1", status: "completed" } };
  const result = await wait({
    client: {
      onNotification() {},
      hasExited() {
        return false;
      },
      exitSummary() {
        return "still running";
      },
      stderrText() {
        return "";
      },
      idleSeconds() {
        return 0;
      },
      lastActivitySummary() {
        return "test";
      },
      async request() {
        throw new Error("request should not be called after initial completion");
      },
    },
    project: ".",
    threadId: "thread-1",
    turnId: "turn-1",
    initialCompletion: completion,
    setOperator() {},
  });
  assert.equal(result, completion);
});

test("waitForTurnCompletion returns stderr diagnostics when app-server exits mid-turn", async () => {
  const runner = new AppServerRunner(undefined, null);
  const wait = (runner as unknown as {
    waitForTurnCompletion(input: {
      client: {
        onNotification(handler: (message: unknown) => void): void;
        request(): Promise<unknown>;
        hasExited(): boolean;
        exitSummary(): string;
        stderrText(): string;
        idleSeconds(): number;
        lastActivitySummary(): string;
      };
      project: string;
      threadId: string;
      turnId: string;
      initialCompletion: unknown;
      setOperator(message: string | null, id: string | null): void;
    }): Promise<Record<string, unknown>>;
  }).waitForTurnCompletion.bind(runner);
  const project = await mkdtemp(join(tmpdir(), "supercodex-wait-"));

  const result = await wait({
    client: {
      onNotification() {},
      async request() {
        throw new Error("request should not be called after app-server exit");
      },
      hasExited() {
        return true;
      },
      exitSummary() {
        return "codex app-server exited code=1 signal=null";
      },
      stderrText() {
        return "401 Unauthorized: token_invalidated";
      },
      idleSeconds() {
        return 0;
      },
      lastActivitySummary() {
        return "test";
      },
    },
    project,
    threadId: "thread-1",
    turnId: "turn-1",
    initialCompletion: null,
    setOperator() {},
  });
  assert.equal(classifyAppServerFailure(result), "unauthorized");
});

test("waitForTurnCompletion fast-fails usage-limit compaction loops and interrupts turn", async () => {
  const runner = new AppServerRunner(undefined, null);
  const wait = (runner as unknown as {
    waitForTurnCompletion(input: {
      client: {
        onNotification(handler: (message: unknown) => void): void;
        request(method: string, params: unknown): Promise<unknown>;
        hasExited(): boolean;
        exitSummary(): string;
        stderrText(): string;
        idleSeconds(): number;
        lastActivitySummary(): string;
      };
      project: string;
      threadId: string;
      turnId: string;
      initialCompletion: unknown;
      setOperator(message: string | null, id: string | null): void;
    }): Promise<Record<string, unknown>>;
  }).waitForTurnCompletion.bind(runner);

  const requests: string[] = [];
  const result = await wait({
    client: {
      onNotification() {},
      async request(method) {
        requests.push(method);
        return {};
      },
      hasExited() {
        return false;
      },
      exitSummary() {
        return "still running";
      },
      stderrText() {
        return [
          "codex_core::session::turn: Failed to run pre-sampling compact",
          '[codex error] {"error":{"message":"Error running remote compact task: You\'ve hit your usage limit.","codexErrorInfo":"usageLimitExceeded"}}',
        ].join("\n");
      },
      idleSeconds() {
        return 0;
      },
      lastActivitySummary() {
        return "stderr";
      },
    },
    project: ".",
    threadId: "thread-usage",
    turnId: "turn-usage",
    initialCompletion: null,
    setOperator() {},
  });

  const turn = result.turn as { status?: string; error?: { message?: string } };
  assert.equal(turn.status, "failed");
  assert.match(turn.error?.message ?? "", /usage limit/i);
  assert.deepEqual(requests, ["turn/interrupt"]);
});

test("waitForTurnCompletion can interrupt an explicitly configured idle turn", async () => {
  const runner = new AppServerRunner({ ...undefinedDefaultOptions(), idleTimeoutSeconds: 1 }, null);
  const wait = (runner as unknown as {
    waitForTurnCompletion(input: {
      client: {
        onNotification(handler: (message: unknown) => void): void;
        request(method: string, params?: unknown): Promise<unknown>;
        hasExited(): boolean;
        exitSummary(): string;
        stderrText(): string;
        idleSeconds(): number;
        lastActivitySummary(): string;
      };
      project: string;
      threadId: string;
      turnId: string;
      initialCompletion: unknown;
      setOperator(message: string | null, id: string | null): void;
    }): Promise<Record<string, unknown>>;
  }).waitForTurnCompletion.bind(runner);
  const project = await mkdtemp(join(tmpdir(), "supercodex-idle-"));
  const requests: string[] = [];

  const result = await wait({
    client: {
      onNotification() {},
      async request(method) {
        requests.push(method);
        return {};
      },
      hasExited() {
        return false;
      },
      exitSummary() {
        return "still running";
      },
      stderrText() {
        return "";
      },
      idleSeconds() {
        return 2;
      },
      lastActivitySummary() {
        return "item/completed";
      },
    },
    project,
    threadId: "thread-1",
    turnId: "turn-1",
    initialCompletion: null,
    setOperator() {},
  });

  assert.deepEqual(requests, ["turn/interrupt"]);
  assert.equal(classifyAppServerFailure(result), "idle_timeout");
});

test("waitForTurnCompletion forwards active steering text directly to Codex app-server", async () => {
  const runner = new AppServerRunner(undefined, null);
  const wait = (runner as unknown as {
    waitForTurnCompletion(input: {
      client: {
        onNotification(handler: (message: unknown) => void): void;
        request(method: string, params?: unknown): Promise<unknown>;
        hasExited(): boolean;
        exitSummary(): string;
        stderrText(): string;
        idleSeconds(): number;
        lastActivitySummary(): string;
      };
      project: string;
      runId?: string | null;
      threadId: string;
      turnId: string;
      initialCompletion: unknown;
      setOperator(message: string | null, id: string | null): void;
    }): Promise<Record<string, unknown>>;
  }).waitForTurnCompletion.bind(runner);
  const project = await mkdtemp(join(tmpdir(), "supercodex-steer-"));
  const steerText = "运行中这句话应直接发送";
  await requestSteer(project, steerText, "default");
  const requests: Array<{ method: string; params?: unknown }> = [];
  let notify: ((message: unknown) => void) | null = null;

  const result = await wait({
    client: {
      onNotification(handler) {
        notify = handler;
      },
      async request(method, params) {
        requests.push({ method, params });
        if (method === "turn/steer") {
          notify?.({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
        }
        return {};
      },
      hasExited() {
        return false;
      },
      exitSummary() {
        return "still running";
      },
      stderrText() {
        return "";
      },
      idleSeconds() {
        return 0;
      },
      lastActivitySummary() {
        return "test";
      },
    },
    project,
    runId: "default",
    threadId: "thread-1",
    turnId: "turn-1",
    initialCompletion: null,
    setOperator() {},
  });

  assert.equal((result.turn as { status?: string }).status, "completed");
  assert.deepEqual(requests, [
    {
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: steerText, text_elements: [] }],
      },
    },
  ]);
});

test("thread/start uses Codex app-server startup source accepted by stable CLI", () => {
  const runner = new AppServerRunner();
  const params = (runner as unknown as { threadStartParams(project: string): Record<string, unknown> }).threadStartParams(".");
  assert.equal(params.sessionStartSource, "startup");
});

test("thread/resume params reopen the saved Codex app-server thread", () => {
  const runner = new AppServerRunner();
  const params = (runner as unknown as { threadResumeParams(threadId: string, project: string): Record<string, unknown> }).threadResumeParams("thr_saved", ".");
  assert.equal(params.threadId, "thr_saved");
  assert.equal(params.persistExtendedHistory, true);
  assert.equal(params.sandbox, "danger-full-access");
  assert.equal(params.approvalPolicy, "never");
});

test("goal-mode retry on a resumed thread continues without replaying /goal prompt", async () => {
  const runner = new AppServerRunner(undefinedDefaultOptions(), null);
  const calls: Array<{ method: string; params?: unknown }> = [];
  const input = await (
    runner as unknown as {
      turnStartInputForThread(
        client: { request(method: string, params?: unknown): Promise<Record<string, unknown>> },
        input: { threadId: string; prompt: string; resume: boolean },
      ): Promise<Array<Record<string, unknown>>>;
    }
  ).turnStartInputForThread(
    {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/goal/get") {
          return { goal: { threadId: "thr_saved", objective: "Build all", status: "active" } };
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
    { threadId: "thr_saved", prompt: "/goal Build all", resume: true },
  );

  assert.deepEqual(calls, [{ method: "thread/goal/get", params: { threadId: "thr_saved" } }]);
  assert.deepEqual(input, []);
});

test("goal-mode retry reactivates paused goal before continuing", async () => {
  const runner = new AppServerRunner(undefinedDefaultOptions(), null);
  const calls: Array<{ method: string; params?: unknown }> = [];
  const input = await (
    runner as unknown as {
      turnStartInputForThread(
        client: { request(method: string, params?: unknown): Promise<Record<string, unknown>> },
        input: { threadId: string; prompt: string; resume: boolean },
      ): Promise<Array<Record<string, unknown>>>;
    }
  ).turnStartInputForThread(
    {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/goal/get") {
          return { goal: { threadId: "thr_saved", objective: "Build all", status: "paused" } };
        }
        if (method === "thread/goal/set") {
          return { goal: { threadId: "thr_saved", objective: "Build all", status: "active" } };
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
    { threadId: "thr_saved", prompt: "/goal Build all", resume: true },
  );

  assert.deepEqual(calls, [
    { method: "thread/goal/get", params: { threadId: "thr_saved" } },
    { method: "thread/goal/set", params: { threadId: "thr_saved", status: "active" } },
  ]);
  assert.deepEqual(input, []);
});

test("goal-mode retry falls back to /goal prompt replay when goal API is unavailable", async () => {
  const runner = new AppServerRunner(undefinedDefaultOptions(), null);
  const calls: Array<{ method: string; params?: unknown }> = [];
  const input = await (
    runner as unknown as {
      turnStartInputForThread(
        client: { request(method: string, params?: unknown): Promise<Record<string, unknown>> },
        input: { threadId: string; prompt: string; resume: boolean },
      ): Promise<Array<Record<string, unknown>>>;
    }
  ).turnStartInputForThread(
    {
      async request(method, params) {
        calls.push({ method, params });
        throw new Error('{"code":-32601,"message":"Method not found"}');
      },
    },
    { threadId: "thr_saved", prompt: "/goal Build all", resume: true },
  );

  assert.deepEqual(calls, [{ method: "thread/goal/get", params: { threadId: "thr_saved" } }]);
  assert.deepEqual(input, [{ type: "text", text: "/goal Build all", text_elements: [] }]);
});

test("waitForGoalContinuationTurn attaches to an auto-resumed in-progress goal turn", async () => {
  const runner = new AppServerRunner(undefinedDefaultOptions(), null);
  let reads = 0;
  const turnId = await (
    runner as unknown as {
      waitForGoalContinuationTurn(
        client: { request(method: string, params?: unknown): Promise<Record<string, unknown>> },
        threadId: string,
        timeoutMs?: number,
        intervalMs?: number,
      ): Promise<string | null>;
    }
  ).waitForGoalContinuationTurn(
    {
      async request(method, params) {
        assert.equal(method, "thread/read");
        assert.deepEqual(params, { threadId: "thr_saved", includeTurns: true });
        reads += 1;
        if (reads < 2) {
          return { thread: { turns: [] } };
        }
        return { thread: { turns: [{ id: "turn_goal", status: "inProgress" }] } };
      },
    },
    "thr_saved",
    50,
    0,
  );

  assert.equal(turnId, "turn_goal");
  assert.equal(reads >= 2, true);
});

test("waitForGoalContinuationTurn returns null when no in-progress turn appears", async () => {
  const runner = new AppServerRunner(undefinedDefaultOptions(), null);
  const turnId = await (
    runner as unknown as {
      waitForGoalContinuationTurn(
        client: { request(method: string, params?: unknown): Promise<Record<string, unknown>> },
        threadId: string,
        timeoutMs?: number,
        intervalMs?: number,
      ): Promise<string | null>;
    }
  ).waitForGoalContinuationTurn(
    {
      async request(method, params) {
        assert.equal(method, "thread/read");
        assert.deepEqual(params, { threadId: "thr_saved", includeTurns: true });
        return { thread: { turns: [{ id: "turn_done", status: "completed" }] } };
      },
    },
    "thr_saved",
    20,
    0,
  );

  assert.equal(turnId, null);
});

function undefinedDefaultOptions() {
  return {
    codexBin: "codex",
    model: null,
    reasoningEffort: null,
    sandbox: "danger-full-access" as const,
    approvalPolicy: "never" as const,
    timeoutSeconds: null,
    idleTimeoutSeconds: null,
    startupTimeoutSeconds: 180,
    streamConsole: true,
  };
}

test("summarizeAppServerNotification renders command progress for console streaming", () => {
  assert.deepEqual(
    summarizeAppServerNotification({
      method: "item/started",
      params: { item: { type: "commandExecution", command: "npm test" } },
    }),
    { text: "[codex command] npm test\n" },
  );
  assert.deepEqual(
    summarizeAppServerNotification({
      method: "item/completed",
      params: { item: { type: "commandExecution", command: "npm test", exitCode: 0, durationMs: 12 } },
    }),
    { text: "[codex command] completed exit=0 durationMs=12\n" },
  );
  assert.deepEqual(
    summarizeAppServerNotification({
      method: "item/commandExecution/outputDelta",
      params: { delta: "ok\n" },
    }),
    { text: "ok\n", inline: true },
  );
  assert.deepEqual(
    summarizeAppServerNotification({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          status: "completed",
          changes: [
            { type: "modified", path: "src/a.ts" },
            { type: "created", path: "src/new.ts" },
            { type: "deleted", path: "src/old.ts" },
          ],
        },
      },
    }),
    { text: "[codex fileChange] completed status=completed changes=3\nM src/a.ts\nA src/new.ts\nD src/old.ts\n" },
  );
});

test("AppServerClient routes app-server server requests instead of dropping unknown ids", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-server-request-"));
  const client = new AppServerClient(undefinedDefaultOptions(), project, join(project, "stderr.log"), join(project, "events.jsonl"));
  const captured: unknown[] = [];
  client.onServerRequest((message) => {
    captured.push(message);
  });

  await (client as unknown as { handleLine(line: string): Promise<void> }).handleLine(
    JSON.stringify({
      id: "request-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", reason: "need write access" },
    }),
  );

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    id: "request-1",
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", reason: "need write access" },
  });
});
