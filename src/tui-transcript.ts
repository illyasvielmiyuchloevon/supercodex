import { open, stat } from "node:fs/promises";
import { summarizeAppServerNotification } from "./app-server-events.js";
import { shouldSuppressCodexStderr } from "./codex-stderr.js";
import { TuiMessageProjection, type TuiMessage, type TuiMessagePartType, type TuiMessageRole } from "./opentui/message-projection.js";
import type { JsonObject } from "./types.js";

export interface TuiTranscriptPaths {
  nativeSessionPath?: string | null;
  eventLogPath?: string | null;
  stderrPath?: string | null;
}

export interface TuiTranscriptOptions {
  maxLines?: number;
}

export interface TuiTranscriptSnapshot {
  lines: string[];
  messages: TuiMessage[];
  totalLines: number;
  truncatedLines: number;
  sources: string[];
}

export class TuiTranscriptSource {
  private readonly maxLines: number;
  private readonly offsets = new Map<string, number>();
  private readonly sources: string[] = [];
  private readonly entries: string[] = [];
  private readonly projection: TuiMessageProjection;
  private readonly nativeCallRoles = new Map<string, TuiMessageRole>();
  private readonly pendingLineFragments = new Map<string, string>();
  private currentLineOpen = false;
  private truncatedLines = 0;

  constructor(options: TuiTranscriptOptions = {}) {
    this.maxLines = Math.max(100, Math.floor(options.maxLines ?? defaultMaxTranscriptLines()));
    this.projection = new TuiMessageProjection({ maxMessages: this.maxLines });
  }

  snapshot(): TuiTranscriptSnapshot {
    const projection = this.projection.snapshot();
    const prefix = this.truncatedLines > 0 ? [`[supercodex] transcript truncated ${this.truncatedLines} earlier lines`] : [];
    return {
      lines: [...prefix, ...this.entries],
      messages: projection.messages,
      totalLines: this.entries.length + this.truncatedLines,
      truncatedLines: this.truncatedLines,
      sources: [...this.sources],
    };
  }

  reset(): void {
    this.offsets.clear();
    this.sources.splice(0, this.sources.length);
    this.entries.splice(0, this.entries.length);
    this.projection.reset();
    this.nativeCallRoles.clear();
    this.pendingLineFragments.clear();
    this.currentLineOpen = false;
    this.truncatedLines = 0;
  }

  appendLocal(message: string): void {
    this.projection.appendLocal(message);
    this.closeOpenLine();
    this.appendText(`${message}\n`, { inline: false });
  }

  appendUser(message: string): void {
    this.projection.appendUser(message);
    this.closeOpenLine();
    this.appendText(`[operator] ${message}\n`, { inline: false });
  }

  async sync(paths: TuiTranscriptPaths): Promise<boolean> {
    let changed = false;
    if (paths.nativeSessionPath) {
      changed = (await this.pollPath(paths.nativeSessionPath, "native")) || changed;
    }
    if (paths.eventLogPath) {
      changed = (await this.pollPath(paths.eventLogPath, "event")) || changed;
    }
    if (paths.stderrPath) {
      changed = (await this.pollPath(paths.stderrPath, "stderr")) || changed;
    }
    return changed;
  }

  private async pollPath(path: string, kind: "event" | "native" | "stderr"): Promise<boolean> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return false;
    }
    const previousOffset = this.offsets.get(path) ?? 0;
    const start = size < previousOffset ? 0 : previousOffset;
    if (size < previousOffset) {
      this.pendingLineFragments.delete(path);
    }
    if (size <= start) {
      this.offsets.set(path, size);
      this.addSource(path);
      return false;
    }

    const text = await readFileRange(path, start, size - start);
    this.offsets.set(path, size);
    this.addSource(path);
    if (!text) {
      return false;
    }
    this.consumeLogText(path, text, kind);
    return true;
  }

  private consumeLogText(path: string, text: string, kind: "event" | "native" | "stderr"): void {
    for (const line of this.completeLogLines(path, text)) {
      if (!line && kind === "stderr") {
        continue;
      }
      if (kind === "event") {
        this.appendEventLine(line);
      } else if (kind === "native") {
        this.appendNativeSessionLine(line);
      } else {
        if (shouldSuppressCodexStderr(line)) {
          continue;
        }
        this.projection.appendStderr(line);
        this.appendText(`[codex app-server] ${line}\n`, { inline: false });
      }
    }
  }

  private completeLogLines(path: string, text: string): string[] {
    const combined = `${this.pendingLineFragments.get(path) ?? ""}${text}`;
    if (!combined) {
      return [];
    }
    const lines = combined.split(/\r?\n/);
    if (combined.endsWith("\n")) {
      this.pendingLineFragments.delete(path);
      if (lines.at(-1) === "") lines.pop();
      return lines;
    }
    this.pendingLineFragments.set(path, lines.pop() ?? "");
    return lines;
  }

  private appendNativeSessionLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let event: JsonObject;
    try {
      event = JSON.parse(line) as JsonObject;
    } catch {
      this.projection.appendStderr(line);
      this.appendText(`[codex session] ${line}\n`, { inline: false });
      return;
    }

    if (event.type !== "response_item" || !isPlainObject(event.payload)) {
      return;
    }

    const item = event.payload;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "message") {
      this.appendNativeMessageItem(item);
      return;
    }
    if (itemType === "function_call") {
      this.appendNativeFunctionCall(item);
      return;
    }
    if (itemType === "function_call_output") {
      this.appendNativeFunctionOutput(item);
      return;
    }
    if (itemType === "reasoning") {
      const text = nativeContentText(item.summary) || nativeContentText(item.content);
      if (text) {
        this.appendNativeProjection({
          id: firstString(item.id),
          role: "reasoning",
          title: "reasoning",
          partType: "reasoning",
          text,
          metadata: item,
        });
      }
    }
  }

  private appendNativeMessageItem(item: JsonObject): void {
    const role = nativeMessageRole(item.role);
    if (!role) {
      return;
    }
    const text = nativeContentText(item.content);
    if (!text) {
      return;
    }
    const phase = typeof item.phase === "string" ? item.phase : "";
    this.appendNativeProjection({
      id: firstString(item.id),
      role,
      title: nativeMessageTitle(role, phase),
      partType: "text",
      text,
      metadata: item,
    });
  }

  private appendNativeFunctionCall(item: JsonObject): void {
    const name = firstString(item.name) ?? "tool";
    const callId = firstString(item.call_id, item.id);
    const args = parseNativeArguments(item.arguments);
    const isShell = /(^|[._-])shell_command$/.test(name) || name === "functions.shell_command";
    const command = isPlainObject(args) ? firstString(args.command) : null;
    const text = command ?? `${name} ${nativeContentText(args) || compactNativeValue(item.arguments)}`.trim();
    const role = isShell ? "command" : "tool";
    if (callId) {
      this.nativeCallRoles.set(callId, role);
    }
    this.appendNativeProjection({
      id: callId,
      role,
      title: isShell ? "command" : name,
      partType: isShell ? "command" : "tool",
      text,
      metadata: item,
    });
  }

  private appendNativeFunctionOutput(item: JsonObject): void {
    const callId = firstString(item.call_id, item.id);
    const text = nativeContentText(item.output) || nativeContentText(item.content);
    if (!text) {
      return;
    }
    const role = callId ? this.nativeCallRoles.get(callId) ?? "tool" : "tool";
    const visibleText = role === "command" || role === "tool" ? compactNativeToolOutput(text) : text;
    this.appendNativeProjection({
      id: callId,
      role,
      title: "tool output",
      partType: role === "command" ? "command-output" : "tool",
      text: visibleText,
      metadata: item,
    });
  }

  private appendNativeProjection(input: {
    id?: string | null;
    role: TuiMessageRole;
    title: string;
    partType: TuiMessagePartType;
    text: string;
    status?: string;
    metadata?: JsonObject;
  }): void {
    this.projection.appendExternalPart(input);
    this.closeOpenLine();
    for (const line of splitTextLines(input.text)) {
      this.appendText(`${nativeTranscriptPrefix(input.role)}${line ? ` ${line}` : ""}\n`, { inline: false });
    }
  }

  private appendEventLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.projection.appendStderr(line);
      this.appendText(`[codex app-server] ${line}\n`, { inline: false });
      return;
    }

    this.projection.consumeEvent(message);
    const method = typeof message.method === "string" ? message.method : "";
    const params = isPlainObject(message.params) ? message.params : {};
    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta) {
        this.appendText(delta, { inline: true });
      }
      return;
    }
    if (isBulkOutputMethod(method)) {
      return;
    }

    const summary = summarizeAppServerNotification(message);
    if (summary) {
      this.appendText(summary.text, { inline: Boolean(summary.inline) });
    }
  }

  private appendText(text: string, options: { inline: boolean }): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!options.inline) {
      this.closeOpenLine();
    }
    const parts = normalized.split("\n");
    for (const [index, part] of parts.entries()) {
      if (part) {
        this.appendFragment(part);
      }
      if (index < parts.length - 1) {
        if (!part && !this.currentLineOpen) {
          this.pushLine("");
        }
        this.currentLineOpen = false;
      }
    }
    if (!options.inline || normalized.endsWith("\n")) {
      this.currentLineOpen = false;
    }
  }

  private appendFragment(fragment: string): void {
    if (this.currentLineOpen && this.entries.length > 0) {
      this.entries[this.entries.length - 1] = `${this.entries[this.entries.length - 1] ?? ""}${fragment}`;
      return;
    }
    this.pushLine(fragment);
    this.currentLineOpen = true;
  }

  private closeOpenLine(): void {
    this.currentLineOpen = false;
  }

  private pushLine(line: string): void {
    this.entries.push(line);
    if (this.entries.length > this.maxLines) {
      const overflow = this.entries.length - this.maxLines;
      this.entries.splice(0, overflow);
      this.truncatedLines += overflow;
    }
  }

  private addSource(path: string): void {
    if (!this.sources.includes(path)) {
      this.sources.push(path);
    }
  }
}

function nativeMessageRole(value: unknown): TuiMessageRole | null {
  if (value === "user" || value === "assistant") {
    return value;
  }
  return null;
}

function nativeMessageTitle(role: TuiMessageRole, phase: string): string {
  if (role === "assistant" && phase) {
    return phase === "final" ? "assistant final" : `assistant ${phase}`;
  }
  return role;
}

function nativeTranscriptPrefix(role: TuiMessageRole): string {
  switch (role) {
    case "user":
      return "[user]";
    case "assistant":
      return "[assistant]";
    case "reasoning":
      return "[reasoning]";
    case "command":
      return "[codex command]";
    case "error":
      return "[codex error]";
    case "tool":
      return "[codex tool]";
    default:
      return "[codex]";
  }
}

function nativeContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(nativeContentText).filter(Boolean).join("\n");
  }
  if (!isPlainObject(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.output === "string") {
    return value.output;
  }
  if (typeof value.summary === "string") {
    return value.summary;
  }
  if (Array.isArray(value.text_elements)) {
    return value.text_elements.filter((entry): entry is string => typeof entry === "string").join("");
  }
  if (value.content !== undefined) {
    return nativeContentText(value.content);
  }
  if (value.summary !== undefined) {
    return nativeContentText(value.summary);
  }
  return "";
}

function parseNativeArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function compactNativeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") {
      return String(value);
    }
    return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function splitTextLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}

function isBulkOutputMethod(method: string): boolean {
  return method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta" || method === "item/fileChange/outputDelta";
}

function compactNativeToolOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = splitTextLines(normalized);
  if (normalized.length <= 800 && lines.length <= 8) {
    return text;
  }
  return `[output hidden: ${lines.length} line${lines.length === 1 ? "" : "s"}, ${normalized.length} chars; see Codex session log for full text]`;
}

function defaultMaxTranscriptLines(): number {
  const raw = process.env.SUPERCODEX_TUI_TRANSCRIPT_MAX_LINES;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
}

async function readFileRange(path: string, start: number, length: number): Promise<string> {
  if (length <= 0) {
    return "";
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const result = await handle.read(buffer, total, length - total, start + total);
      if (result.bytesRead === 0) {
        break;
      }
      total += result.bytesRead;
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
