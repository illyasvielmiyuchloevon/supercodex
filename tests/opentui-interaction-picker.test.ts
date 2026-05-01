import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelActionForInteraction } from "../src/opentui/interaction-dialog.js";
import { interactionPickerRecord } from "../src/opentui/interaction-picker-record.js";
import type { InteractionRecord } from "../src/interactions.js";

test("interaction picker maps approval choices to picker options", () => {
  const interaction: InteractionRecord = {
    id: "abc",
    requestId: 7,
    method: "item/commandExecution/requestApproval",
    status: "pending",
    title: "Command Approval",
    summary: "npm test",
    choices: [
      { id: "accept", label: "accept", response: { decision: "accept" } },
      { id: "decline", label: "decline", response: { decision: "decline" } },
      { id: "cancel", label: "cancel", response: { decision: "cancel" } },
    ],
    params: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    respondedAt: null,
    handledAt: null,
  };

  const picker = interactionPickerRecord(interaction);
  assert.equal(picker.id, "interaction:abc");
  assert.equal(picker.title, "Command Approval");
  assert.equal(picker.subtitle, "npm test");
  assert.equal(picker.placement, "bottom");
  assert.deepEqual(picker.options.map((option) => [option.id, option.variant]), [
    ["accept", "primary"],
    ["decline", "danger"],
    ["cancel", "muted"],
  ]);
  assert.equal(cancelActionForInteraction(interaction)?.id, "cancel");
});
