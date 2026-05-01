import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  answerInteraction,
  captureInteractionRequest,
  chooseInteraction,
  isInteractionRequest,
  markInteractionHandled,
  readInteractionResponses,
  readPendingInteractions,
} from "../src/interactions.js";

test("captures command approval request and writes selected response", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-interaction-"));
  const request = {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "npm test",
      cwd: project,
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
  };

  assert.equal(isInteractionRequest(request), true);
  const record = await captureInteractionRequest(project, request, "run-a");
  assert.equal(record.title, "Command Approval");
  assert.equal(record.choices.map((choice) => choice.id).join(","), "accept,accept-session,decline");

  const response = await chooseInteraction(project, record.id, "accept-session", "run-a");
  assert.deepEqual(response.response, { decision: "acceptForSession" });

  const responses = await readInteractionResponses(project, "run-a");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.requestId, 42);

  await markInteractionHandled(project, responses[0]!, "run-a");
  assert.equal((await readInteractionResponses(project, "run-a")).length, 0);
  assert.equal((await readPendingInteractions(project, "run-a")).length, 0);
});

test("answers request_user_input with freeform response", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-user-input-"));
  await captureInteractionRequest(
    project,
    {
      id: "request-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{ id: "direction", header: "Direction", question: "Choose direction", isOther: true, isSecret: false, options: null }],
      },
    },
    "default",
  );

  const response = await answerInteraction(project, "继续当前 Stage，但先补测试", null, "default");
  assert.deepEqual(response.response, {
    answers: {
      direction: {
        answers: ["继续当前 Stage，但先补测试"],
      },
    },
  });
});
