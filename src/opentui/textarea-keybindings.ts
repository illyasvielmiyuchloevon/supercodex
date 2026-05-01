import type { KeyBinding } from "@opentui/core";

export type TextareaKeyLike = {
  name?: string | null;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
  raw?: string;
  sequence?: string;
};

const TEXTAREA_ACTIONS = [
  "move-left",
  "move-right",
  "move-up",
  "move-down",
  "select-left",
  "select-right",
  "select-up",
  "select-down",
  "line-home",
  "line-end",
  "select-line-home",
  "select-line-end",
  "visual-line-home",
  "visual-line-end",
  "select-visual-line-home",
  "select-visual-line-end",
  "buffer-home",
  "buffer-end",
  "select-buffer-home",
  "select-buffer-end",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "backspace",
  "delete",
  "newline",
  "undo",
  "redo",
  "word-forward",
  "word-backward",
  "select-word-forward",
  "select-word-backward",
  "delete-word-forward",
  "delete-word-backward",
  "select-all",
  "submit",
] as const;

export function agentTextareaKeyBindings(): KeyBinding[] {
  return [
    { name: "return", action: "submit" },
    { name: "enter", action: "submit" },
    { name: "kpenter", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "enter", shift: true, action: "newline" },
    { name: "kpenter", shift: true, action: "newline" },
    { name: "return", meta: true, action: "newline" },
    { name: "enter", meta: true, action: "newline" },
    { name: "kpenter", meta: true, action: "newline" },
    { name: "return", ctrl: true, action: "newline" },
    { name: "enter", ctrl: true, action: "newline" },
    { name: "kpenter", ctrl: true, action: "newline" },
    { name: "linefeed", action: "newline" },
    { name: "j", ctrl: true, action: "newline" },
    { name: "a", ctrl: true, action: "line-home" },
    { name: "e", ctrl: true, action: "line-end" },
    { name: "b", ctrl: true, action: "move-left" },
    { name: "f", ctrl: true, action: "move-right" },
    { name: "p", ctrl: true, action: "move-up" },
    { name: "n", ctrl: true, action: "move-down" },
    { name: "k", ctrl: true, action: "delete-to-line-end" },
    { name: "u", ctrl: true, action: "delete-to-line-start" },
    { name: "w", ctrl: true, action: "delete-word-backward" },
    { name: "z", ctrl: true, action: "undo" },
    { name: "y", ctrl: true, action: "redo" },
    ...TEXTAREA_ACTIONS.flatMap((action): KeyBinding[] => {
      if (action === "submit" || action === "newline") return [];
      return [];
    }),
  ];
}

export function isTextareaNewlineKey(key: TextareaKeyLike): boolean {
  if (key.sequence === "\n" || key.raw === "\n") return true;
  const name = key.name?.toLowerCase();
  if (!name) return false;
  if (name === "linefeed") return true;
  if (name === "j" && key.ctrl) return true;
  if (name !== "return" && name !== "enter" && name !== "kpenter") return false;
  return Boolean(key.shift || key.meta || key.option || key.ctrl);
}
