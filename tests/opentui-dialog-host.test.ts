import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDialog, pushDialog, replaceDialog, type AgentDialogRecord } from "../src/opentui/dialog-stack.js";

test("dialog stack helpers push, replace, and close dialogs predictably", () => {
  const first: AgentDialogRecord = { id: "first", title: "First", body: "one" };
  const second: AgentDialogRecord = { id: "second", title: "Second", body: "two" };
  const replacement: AgentDialogRecord = { id: "replacement", title: "Replacement", body: "three" };

  let stack = pushDialog([], first);
  stack = pushDialog(stack, second);
  assert.deepEqual(stack.map((dialog) => dialog.id), ["first", "second"]);

  stack = replaceDialog(stack, replacement);
  assert.deepEqual(stack.map((dialog) => dialog.id), ["first", "replacement"]);

  stack = closeDialog(stack);
  assert.deepEqual(stack.map((dialog) => dialog.id), ["first"]);

  stack = closeDialog(stack, "first");
  assert.deepEqual(stack, []);
});
