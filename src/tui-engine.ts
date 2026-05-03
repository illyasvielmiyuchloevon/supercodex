import type { InteractionRecord } from "./interactions.js";
import type { SlashCommandSuggestion } from "./tui-commands.js";
import type { JsonObject } from "./types.js";
import {
  displayCellWidth,
  padRightCells,
  shortenByCellWidth,
  sliceTextByCellWidth,
  sliceTextEndByCellWidth,
  wrapLinesByCellWidth,
} from "./display-width.js";

export interface TerminalFrame {
  columns: number;
  rows: number;
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export interface TuiScreenModel {
  columns: number;
  rows: number;
  modeLabel: string;
  runId: string;
  project: string;
  logs: string[];
  logScrollOffset: number;
  status: JsonObject;
  suggestions: SlashCommandSuggestion[];
  commandSelection: number;
  interaction: InteractionRecord | null;
  interactionSelection: number;
  inputPrompt: string;
  inputBuffer: string;
  inputCursor: number;
}

export interface TuiScreenRender {
  frame: TerminalFrame;
  layout: TuiLayout;
  cursorRow: number;
  cursorColumn: number;
}

export interface TuiLayout {
  columns: number;
  rows: number;
  headerHeight: number;
  bodyHeight: number;
  paletteHeight: number;
  interactionHeight: number;
  inputHeight: number;
  sideWidth: number;
  transcriptWidth: number;
  visiblePaletteItems: number;
}

export interface TranscriptWindow {
  lines: string[];
  totalLines: number;
  maxScrollOffset: number;
  effectiveScrollOffset: number;
}

export function buildTuiFrame(model: TuiScreenModel): TuiScreenRender {
  const columns = Math.max(60, Math.floor(model.columns));
  const rows = Math.max(20, Math.floor(model.rows));
  const suggestions = model.suggestions.slice(0, 10);
  const visiblePaletteItems = suggestions.length > 0 ? Math.max(1, Math.min(8, rows - 10)) : 0;
  const paletteHeight = visiblePaletteItems > 0 ? visiblePaletteItems + 2 : 0;
  const interactionLines = suggestions.length === 0 && model.interaction ? interactionPanel(model.interaction, columns, model.interactionSelection) : [];
  const inputHeight = 3;
  const headerHeight = 3;
  const interactionHeight = interactionLines.length;
  const bodyHeight = Math.max(1, rows - headerHeight - inputHeight - paletteHeight - interactionHeight);
  const sideWidth = columns >= 100 ? Math.min(42, Math.floor(columns * 0.36)) : 0;
  const transcriptWidth = sideWidth > 0 ? columns - sideWidth - 3 : columns;
  const layout: TuiLayout = {
    columns,
    rows,
    headerHeight,
    bodyHeight,
    paletteHeight,
    interactionHeight,
    inputHeight,
    sideWidth,
    transcriptWidth,
    visiblePaletteItems,
  };

  const transcript = transcriptWindow(model.logs.length > 0 ? model.logs : ["No app-server events yet."], transcriptWidth, bodyHeight, model.logScrollOffset);
  const lines = [
    color(invert(padRight(" SuperCodex ", columns)), "cyan"),
    padRight(`${model.modeLabel} | run=${model.runId} | view=${transcriptLabel(transcript)} | ${model.project}`, columns),
    horizontal(columns),
  ];
  const side = sideWidth > 0 ? sidePanel(model.status, sideWidth) : [];
  for (let index = 0; index < bodyHeight; index++) {
    const log = transcript.lines[index] ?? "";
    if (sideWidth > 0) {
      lines.push(`${padRight(log, transcriptWidth)} | ${padRight(side[index] ?? "", sideWidth)}`);
    } else {
      lines.push(padRight(log, columns));
    }
  }

  if (visiblePaletteItems > 0) {
    lines.push(horizontal(columns));
    lines.push(padRight(" Commands", columns));
    for (const [index, suggestion] of suggestions.slice(0, visiblePaletteItems).entries()) {
      const marker = index === model.commandSelection ? "> " : "  ";
      const text = `${marker}${suggestion.usage.padEnd(40)} ${suggestion.description}`;
      const clipped = shorten(text, columns);
      lines.push(padRight(index === model.commandSelection ? invert(clipped) : clipped, columns));
    }
  }
  if (interactionLines.length > 0) {
    lines.push(...interactionLines);
  }

  lines.push(horizontal(columns));
  const inputView = inputViewport(model.inputPrompt, model.inputBuffer, model.inputCursor, columns);
  const cursorRow = lines.length + 1;
  lines.push(padRight(inputView.line, columns));
  lines.push(padRight("Type / for commands. PgUp/PgDn scroll logs. Ctrl+V pastes. Ctrl+C exits.", columns));

  const frame = createTerminalFrame({
    lines,
    columns,
    rows,
    cursorRow,
    cursorColumn: inputView.cursorColumn,
  });
  return { frame, layout, cursorRow: frame.cursorRow, cursorColumn: frame.cursorColumn };
}

export function transcriptWindow(lines: string[], width: number, height: number, scrollOffset: number): TranscriptWindow {
  const wrapped = wrapLines(lines, Math.max(20, width));
  const totalLines = wrapped.length;
  const maxScrollOffset = Math.max(0, totalLines - height);
  const effectiveScrollOffset = Math.max(0, Math.min(maxScrollOffset, Math.floor(scrollOffset)));
  const start = Math.max(0, totalLines - height - effectiveScrollOffset);
  return {
    lines: wrapped.slice(start, start + height),
    totalLines,
    maxScrollOffset,
    effectiveScrollOffset,
  };
}

export function inputViewport(prompt: string, inputText: string, cursor: number, columns: number): { line: string; cursorColumn: number } {
  const boundedCursor = Math.max(0, Math.min(cursor, inputText.length));
  const visibleText = inputText.replace(/\n/g, "\\n");
  const beforeCursor = inputText.slice(0, boundedCursor).replace(/\n/g, "\\n");
  const afterCursor = visibleText.slice(beforeCursor.length);
  const promptWidth = displayCellWidth(prompt);
  const available = Math.max(1, Math.floor(columns) - promptWidth - 1);
  const before = sliceTextEndByCellWidth(beforeCursor, available);
  const after = sliceTextByCellWidth(afterCursor, available - displayCellWidth(before));
  const visible = `${before}${after}`;
  const cursorColumn = Math.max(1, Math.min(columns, promptWidth + displayCellWidth(before) + 1));
  return { line: sliceTextByCellWidth(`${prompt}${visible}`, columns), cursorColumn };
}

export function createTerminalFrame(input: {
  lines: string[];
  columns: number;
  rows: number;
  cursorRow: number;
  cursorColumn: number;
}): TerminalFrame {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const lines: string[] = [];
  for (let index = 0; index < rows; index++) {
    lines.push(padRight(input.lines[index] ?? "", columns));
  }
  return {
    columns,
    rows,
    lines,
    cursorRow: Math.max(1, Math.min(rows, Math.floor(input.cursorRow))),
    cursorColumn: Math.max(1, Math.min(columns, Math.floor(input.cursorColumn))),
  };
}

export function renderFrameDiff(previous: TerminalFrame | null, next: TerminalFrame, forceFull = false): string {
  const cursor = `\x1b[${next.cursorRow};${next.cursorColumn}H`;
  const full = forceFull || !previous || previous.columns !== next.columns || previous.rows !== next.rows;
  if (full) {
    return `\x1b[?25l\x1b[2J\x1b[H${next.lines.join("\n")}${cursor}\x1b[?25h`;
  }
  const chunks: string[] = [];
  for (let index = 0; index < next.rows; index++) {
    if (previous.lines[index] !== next.lines[index]) {
      chunks.push(`\x1b[${index + 1};1H${next.lines[index] ?? ""}`);
    }
  }
  const cursorChanged = previous.cursorRow !== next.cursorRow || previous.cursorColumn !== next.cursorColumn;
  if (chunks.length === 0 && !cursorChanged) {
    return "";
  }
  return `\x1b[?25l${chunks.join("")}${cursor}\x1b[?25h`;
}

function sidePanel(status: JsonObject, width: number): string[] {
  const settings = isObject(status.settings) ? status.settings : {};
  const effectiveCodexConfig = isObject(status.effectiveCodexConfig) ? status.effectiveCodexConfig : {};
  const interactions = Array.isArray(status.interactions) ? status.interactions : [];
  const model = String(settings.model ?? effectiveCodexConfig.model ?? "unset");
  const reasoning = String(settings.reasoningEffort ?? effectiveCodexConfig.reasoningEffort ?? "unset");
  return [
    "Status",
    `done: ${String(status.done ?? false)}`,
    `mode: ${String(status.mode ?? "unknown")}`,
    `phase: ${String(status.phase ?? "unknown")}`,
    `stage: ${String(status.stage ?? "none")}`,
    `task: ${String(status.task ?? "none")}`,
    `next: ${String(status.nextWork ?? "none")}`,
    "",
    "Runtime",
    `status: ${String(status.runtimeStatus ?? "idle")}`,
    `thread: ${shorten(String(status.threadId ?? "none"), width - 8)}`,
    `turn: ${shorten(String(status.turnId ?? "none"), width - 6)}`,
    `requests: ${interactions.length}`,
    "",
    "Settings",
    `model: ${shorten(model, width - 7)}`,
    `reasoning: ${shorten(reasoning, width - 11)}`,
    `auth: ${String(status.activeAuth ?? "none")}`,
    "",
    "Commands",
    "/goal <prompt>",
    "/new [prompt]",
    "/start [run-id]",
    "/model <name>",
    "/reasoning xhigh",
    "/auth <name>",
    "/interrupt [prompt]",
    "/approve  /deny",
    "/answer <text>",
    "/pause  /resume",
    "/exit",
  ];
}

function interactionPanel(interaction: InteractionRecord, columns: number, selectedIndex: number): string[] {
  const lines = [
    horizontal(columns),
    padRight(color(" Interaction Required ", "yellow"), columns),
    padRight(shorten(`${interaction.title}: ${interaction.summary}`, columns), columns),
  ];
  const choices = interaction.choices.slice(0, 6);
  const selection = clampSelection(selectedIndex, choices.length);
  for (const [index, choice] of choices.entries()) {
    const hotkey = index + 1;
    const description = choice.description ? ` - ${choice.description}` : "";
    const marker = index === selection ? "> " : "  ";
    const clipped = shorten(`${marker}${hotkey}. ${choice.label}${description}`, columns);
    lines.push(padRight(index === selection ? invert(clipped) : clipped, columns));
  }
  lines.push(padRight(shorten("Up/Down choose, Enter confirms. 1-6, A=approve, S=session, D=deny, C=cancel. Or /answer <text-or-json>.", columns), columns));
  return lines;
}

function transcriptLabel(window: TranscriptWindow): string {
  if (window.maxScrollOffset === 0 || window.effectiveScrollOffset === 0) {
    return "tail";
  }
  return `scroll-${window.effectiveScrollOffset}`;
}

function horizontal(width: number): string {
  return "-".repeat(Math.max(0, width));
}

function padRight(value: string, width: number): string {
  return padRightCells(value, width);
}

function wrapLines(lines: string[], width: number): string[] {
  return wrapLinesByCellWidth(lines, width);
}

function shorten(value: string, width: number): string {
  return shortenByCellWidth(value, width);
}

function invert(value: string): string {
  return `\x1b[7m${value}\x1b[27m`;
}

function color(value: string, name: "cyan" | "yellow"): string {
  const code = name === "cyan" ? 36 : 33;
  return `\x1b[${code}m${value}\x1b[39m`;
}

function clampSelection(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (!Number.isFinite(index) || index < 0) {
    return 0;
  }
  return Math.min(index, length - 1);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
