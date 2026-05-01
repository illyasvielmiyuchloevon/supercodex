import assert from "node:assert/strict";
import test from "node:test";
import { agentTextareaKeyBindings, isTextareaNewlineKey, type TextareaKeyLike } from "../src/opentui/textarea-keybindings.js";

function actionFor(name: string, modifiers: Partial<TextareaKeyLike> = {}): string | undefined {
  return agentTextareaKeyBindings().find((binding) => (
    binding.name === name &&
    Boolean(binding.ctrl) === Boolean(modifiers.ctrl) &&
    Boolean(binding.meta) === Boolean(modifiers.meta) &&
    Boolean(binding.shift) === Boolean(modifiers.shift)
  ))?.action;
}

test("OpenTUI composer keeps plain Enter for submit and modified Enter for newline", () => {
  assert.equal(actionFor("return"), "submit");
  assert.equal(actionFor("enter"), "submit");
  assert.equal(actionFor("kpenter"), "submit");
  assert.equal(actionFor("return", { shift: true }), "newline");
  assert.equal(actionFor("enter", { shift: true }), "newline");
  assert.equal(actionFor("kpenter", { shift: true }), "newline");
  assert.equal(actionFor("return", { meta: true }), "newline");
  assert.equal(actionFor("return", { ctrl: true }), "newline");
  assert.equal(actionFor("linefeed"), "newline");
  assert.equal(actionFor("j", { ctrl: true }), "newline");
});

test("textarea newline detector matches terminal Enter variants", () => {
  assert.equal(isTextareaNewlineKey({ name: "return" }), false);
  assert.equal(isTextareaNewlineKey({ name: "enter" }), false);
  assert.equal(isTextareaNewlineKey({ name: "kpenter" }), false);
  assert.equal(isTextareaNewlineKey({ name: "return", shift: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "enter", shift: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "kpenter", shift: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "return", meta: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "return", option: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "return", ctrl: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "return", sequence: "\n" }), true);
  assert.equal(isTextareaNewlineKey({ name: "return", raw: "\n" }), true);
  assert.equal(isTextareaNewlineKey({ sequence: "\n" }), true);
  assert.equal(isTextareaNewlineKey({ raw: "\n" }), true);
  assert.equal(isTextareaNewlineKey({ name: "return", sequence: "\r" }), false);
  assert.equal(isTextareaNewlineKey({ name: "linefeed" }), true);
  assert.equal(isTextareaNewlineKey({ name: "j", ctrl: true }), true);
  assert.equal(isTextareaNewlineKey({ name: "j" }), false);
});
