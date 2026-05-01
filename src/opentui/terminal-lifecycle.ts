import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import type { CliRendererConfig } from "@opentui/core";

export interface TerminalTitleInput {
  project: string;
  runId: string;
  mode: "managed" | "attach";
  stage?: string | null;
  task?: string | null;
}

export interface TerminalTitleRenderer {
  setTerminalTitle?: (title: string) => void;
}

export interface SelectionRenderer {
  getSelection: () => { getSelectedText: () => string } | null;
  clearSelection: () => void;
}

export interface CopyOnlyKeyEvent {
  ctrl?: boolean;
  name?: string | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export type CopyText = (text: string) => Promise<void> | void;

export function terminalTitleForRun(input: TerminalTitleInput): string {
  const project = basename(resolve(input.project)) || "project";
  const work = input.task || input.stage || "idle";
  return `SuperCodex - ${input.mode} - ${project} - ${input.runId} - ${work}`;
}

export function applyTerminalTitle(renderer: TerminalTitleRenderer, title: string): void {
  renderer.setTerminalTitle?.(title);
}

export function restoreTerminalTitle(renderer: TerminalTitleRenderer): void {
  renderer.setTerminalTitle?.("SuperCodex");
}

export async function copyRendererSelection(renderer: SelectionRenderer, copy: CopyText = copyTextToClipboard): Promise<boolean> {
  const text = renderer.getSelection()?.getSelectedText();
  if (!text) {
    return false;
  }
  await copy(text);
  renderer.clearSelection();
  return true;
}

export async function handleCtrlCCopyOnly(
  event: CopyOnlyKeyEvent,
  renderer: SelectionRenderer,
  onSelectionCopied?: (copied: boolean) => void,
  copy?: CopyText,
): Promise<boolean> {
  if (!isCtrlCCopyShortcut(event)) {
    return false;
  }
  event.preventDefault?.();
  event.stopPropagation?.();
  const copied = await copyRendererSelection(renderer, copy);
  onSelectionCopied?.(copied);
  return true;
}

export function isCtrlCCopyShortcut(event: CopyOnlyKeyEvent): boolean {
  return Boolean(event.ctrl && event.name?.toLowerCase() === "c");
}

export function consoleOptionsForSelectionCopy(copy: CopyText = copyTextToClipboard): NonNullable<CliRendererConfig["consoleOptions"]> {
  return {
    keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
    onCopySelection: (text) => {
      void copy(text);
    },
  };
}

export async function copyTextToClipboard(text: string): Promise<void> {
  writeOsc52(text);
  const command = clipboardCommand();
  if (!command) {
    return;
  }
  await writeToCommand(command.command, command.args, text);
}

export function osc52Sequence(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const base64 = Buffer.from(text).toString("base64");
  const sequence = `\x1b]52;c;${base64}\x07`;
  return env.TMUX || env.STY ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence;
}

function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write(osc52Sequence(text));
}

function clipboardCommand(): { command: string; args: string[] } | null {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
    };
  }
  if (process.platform === "darwin") {
    return { command: "pbcopy", args: [] };
  }
  if (process.env.WAYLAND_DISPLAY) {
    return { command: "wl-copy", args: [] };
  }
  if (process.env.DISPLAY) {
    return { command: "xclip", args: ["-selection", "clipboard"] };
  }
  return null;
}

function writeToCommand(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => resolvePromise());
    child.on("close", () => resolvePromise());
    child.stdin?.end(text);
  });
}
