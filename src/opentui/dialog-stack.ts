import type { KeyEvent } from "@opentui/core";

export type AgentDialogKind = "info" | "warning" | "error" | "permission" | "input";
export type AgentDialogSize = "medium" | "large" | "xlarge";

export interface AgentDialogAction {
  id: string;
  label: string;
  variant?: "primary" | "danger" | "muted";
}

export interface AgentDialogRecord {
  id: string;
  title: string;
  body: string;
  kind?: AgentDialogKind;
  size?: AgentDialogSize;
  actions?: AgentDialogAction[];
}

export function pushDialog(stack: AgentDialogRecord[], dialog: AgentDialogRecord): AgentDialogRecord[] {
  return [...stack.filter((item) => item.id !== dialog.id), dialog];
}

export function replaceDialog(stack: AgentDialogRecord[], dialog: AgentDialogRecord): AgentDialogRecord[] {
  return stack.length === 0 ? [dialog] : [...stack.slice(0, -1), dialog];
}

export function closeDialog(stack: AgentDialogRecord[], id?: string): AgentDialogRecord[] {
  if (stack.length === 0) return [];
  if (!id) return stack.slice(0, -1);
  return stack.filter((item) => item.id !== id);
}

export function dialogActions(dialog: AgentDialogRecord): AgentDialogAction[] {
  return dialog.actions ?? [{ id: "close", label: "Close", variant: "primary" }];
}

export function clampDialogSelection(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

export function handleDialogKey(input: {
  event: KeyEvent;
  dialog: AgentDialogRecord;
  selection: number;
  onSelect: (index: number) => void;
  onClose: (dialog: AgentDialogRecord) => void;
  onAction: (dialog: AgentDialogRecord, action: AgentDialogAction) => void | Promise<void>;
}): boolean {
  const { event, dialog } = input;
  if (event.name === "escape") {
    consumeDialogKey(event);
    input.onClose(dialog);
    return true;
  }

  const actions = dialogActions(dialog);
  if (actions.length === 0) return false;

  if (event.name === "up" || event.name === "left" || (event.ctrl && event.name === "p")) {
    consumeDialogKey(event);
    input.onSelect((input.selection + actions.length - 1) % actions.length);
    return true;
  }
  if (event.name === "down" || event.name === "right" || (event.ctrl && event.name === "n")) {
    consumeDialogKey(event);
    input.onSelect((input.selection + 1) % actions.length);
    return true;
  }
  if (event.name === "home") {
    consumeDialogKey(event);
    input.onSelect(0);
    return true;
  }
  if (event.name === "end") {
    consumeDialogKey(event);
    input.onSelect(Math.max(0, actions.length - 1));
    return true;
  }
  if (isDialogEnterKey(event)) {
    consumeDialogKey(event);
    void input.onAction(dialog, actions[clampDialogSelection(input.selection, actions.length)] ?? actions[0]!);
    return true;
  }
  if (/^[1-9]$/.test(event.name)) {
    const action = actions[Number(event.name) - 1];
    if (action) {
      consumeDialogKey(event);
      void input.onAction(dialog, action);
      return true;
    }
  }
  return false;
}

function isDialogEnterKey(event: KeyEvent): boolean {
  return event.name === "return" || event.name === "enter" || event.name === "kpenter";
}

function consumeDialogKey(event: KeyEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
