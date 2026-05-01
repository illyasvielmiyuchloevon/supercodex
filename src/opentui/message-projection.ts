import type { JsonObject } from "../types.js";
import { fileChangeCount, summarizeFileChanges } from "../file-change-summary.js";

export type TuiMessageRole = "system" | "user" | "assistant" | "reasoning" | "tool" | "command" | "file" | "error";

export type TuiMessagePartType =
  | "text"
  | "reasoning"
  | "command"
  | "command-output"
  | "file-change"
  | "tool"
  | "status"
  | "stderr"
  | "error";

export interface TuiMessagePart {
  id: string;
  type: TuiMessagePartType;
  text: string;
  title?: string;
  status?: string;
  metadata?: JsonObject;
}

export interface TuiMessage {
  id: string;
  role: TuiMessageRole;
  title: string;
  status?: string;
  parts: TuiMessagePart[];
  metadata?: JsonObject;
}

export interface TuiMessageProjectionSnapshot {
  messages: TuiMessage[];
  totalMessages: number;
  truncatedMessages: number;
}

export class TuiMessageProjection {
  private readonly maxMessages: number;
  private readonly messages: TuiMessage[] = [];
  private readonly byId = new Map<string, TuiMessage>();
  private sequence = 0;
  private truncatedMessages = 0;
  private lastAssistantId: string | null = null;
  private lastCommandId: string | null = null;
  private lastFileChangeId: string | null = null;
  private readonly outputCounters = new Map<string, { chars: number; lines: number; kind: "command" | "file" }>();

  constructor(options: { maxMessages?: number } = {}) {
    this.maxMessages = Math.max(100, Math.floor(options.maxMessages ?? 20_000));
  }

  reset(): void {
    this.messages.splice(0, this.messages.length);
    this.byId.clear();
    this.sequence = 0;
    this.truncatedMessages = 0;
    this.lastAssistantId = null;
    this.lastCommandId = null;
    this.lastFileChangeId = null;
    this.outputCounters.clear();
  }

  snapshot(): TuiMessageProjectionSnapshot {
    return {
      messages: this.messages.map(cloneMessage),
      totalMessages: this.messages.length + this.truncatedMessages,
      truncatedMessages: this.truncatedMessages,
    };
  }

  appendLocal(message: string): void {
    const item = this.createMessage("local", "system", "supercodex");
    this.appendPart(item, "text", message);
  }

  appendUser(message: string): void {
    const item = this.createMessage(`operator-${this.sequence + 1}`, "user", "operator");
    this.appendPart(item, "text", message);
  }

  appendStderr(line: string): void {
    if (!line.trim()) return;
    const item = this.createMessage("stderr", "error", "codex app-server");
    this.appendPart(item, "stderr", line, { status: "stderr" });
  }

  appendExternalPart(input: {
    id?: string | null;
    role: TuiMessageRole;
    title: string;
    partType?: TuiMessagePartType;
    text: string;
    status?: string;
    metadata?: JsonObject;
  }): void {
    if (!input.text) return;
    const seed = input.id ?? `${input.role}-${this.sequence + 1}`;
    const existing = this.byId.get(this.normalizeId(seed));
    const message = existing ?? this.createMessage(seed, input.role, input.title);
    if (input.status) message.status = input.status;
    if (input.metadata && !message.metadata) message.metadata = input.metadata;
    const partType = input.partType ?? "text";
    if (partType === "text") {
      this.appendOrMergeText(message, input.text, {
        status: input.status,
        metadata: input.metadata,
      });
      return;
    }
    this.appendPart(message, partType, input.text, {
      status: input.status,
      metadata: input.metadata,
    });
  }

  consumeEvent(message: JsonObject): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params = asObject(message.params);
    if (method === "turn/started") {
      this.appendSystem("codex turn", "started", params);
      return;
    }
    if (method === "turn/completed") {
      const turn = asObject(params.turn);
      this.appendSystem("codex turn", `completed status=${String(turn.status ?? "unknown")}`, params);
      return;
    }
    if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
      const item = this.createMessage(`${method}-${this.sequence + 1}`, "error", `codex ${method}`);
      this.appendPart(item, "error", compactJson(params), { status: method, metadata: params });
      return;
    }
    if (method === "thread/compacted") {
      this.appendSystem("codex thread", "compacted", params);
      return;
    }
    if (method === "model/rerouted") {
      this.appendSystem("codex model", `rerouted ${compactJson(params)}`, params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.appendAssistantDelta(params);
      return;
    }
    if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta") {
      this.appendToolDelta(params, "command");
      return;
    }
    if (method === "item/fileChange/outputDelta") {
      this.appendToolDelta(params, "file");
      return;
    }
    if (method === "item/mcpToolCall/progress") {
      const item = this.createMessage(`mcp-progress-${this.sequence + 1}`, "tool", "codex mcp progress");
      this.appendPart(item, "tool", compactJson(params), { metadata: params });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = asObject(params.item);
      this.consumeItem(item, method === "item/started" ? "started" : "completed");
    }
  }

  private consumeItem(item: JsonObject, phase: "started" | "completed"): void {
    const type = typeof item.type === "string" ? item.type : "item";
    if (type === "userMessage") {
      const message = this.ensureItemMessage(item, "user", "user");
      message.status = phase;
      const text = userMessageText(item);
      if (text && !message.parts.some((part) => part.type === "text" && part.text === text)) {
        this.appendPart(message, "text", text);
      }
      return;
    }
    if (type === "agentMessage") {
      const message = this.ensureItemMessage(item, "assistant", agentTitle(item));
      message.status = phase;
      this.lastAssistantId = message.id;
      const text = typeof item.text === "string" ? item.text : "";
      if (text) {
        this.appendOrMergeText(message, text);
      }
      return;
    }
    if (type === "reasoning" || type === "plan") {
      const message = this.ensureItemMessage(item, "reasoning", type);
      message.status = phase;
      const text = reasoningText(item);
      if (text && !message.parts.some((part) => part.text === text)) {
        this.appendPart(message, "reasoning", text);
      }
      return;
    }
    if (type === "commandExecution") {
      const message = this.ensureItemMessage(item, "command", "command");
      message.status = phase;
      this.lastCommandId = message.id;
      const command = typeof item.command === "string" ? item.command : "(unknown command)";
      if (!message.parts.some((part) => part.type === "command")) {
        this.appendPart(message, "command", command, { title: "command" });
      }
      if (phase === "completed") {
        const exit = item.exitCode === null || item.exitCode === undefined ? "unknown" : String(item.exitCode);
        this.appendStatus(message, `completed exit=${exit}`);
      }
      return;
    }
    if (type === "fileChange") {
      const message = this.ensureItemMessage(item, "file", "file change");
      message.status = phase;
      this.lastFileChangeId = message.id;
      const count = fileChangeCount(item.changes);
      this.upsertStatus(message, `${phase} changes=${count}`, "file-change-summary");
      const summary = summarizeFileChanges(item.changes);
      if (!message.parts.some((part) => part.type === "file-change" && part.text === summary)) {
        this.appendPart(message, "file-change", summary);
      }
      return;
    }
    if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
      const message = this.ensureItemMessage(item, "tool", type);
      message.status = phase;
      this.appendStatus(message, toolStatusText(item, phase));
      return;
    }
    const message = this.ensureItemMessage(item, "tool", type);
    message.status = phase;
    this.appendStatus(message, `${phase} type=${type}`);
  }

  private appendAssistantDelta(params: JsonObject): void {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!delta) return;
    const id = typeof params.itemId === "string" ? params.itemId : this.lastAssistantId;
    const message = id ? this.byId.get(id) ?? this.createMessage(id, "assistant", "assistant") : this.createMessage("assistant", "assistant", "assistant");
    this.lastAssistantId = message.id;
    this.appendPart(message, "text", delta, { inline: true });
  }

  private appendToolDelta(params: JsonObject, kind: "command" | "file"): void {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!delta) return;
    const idFromParams = typeof params.itemId === "string" ? params.itemId : null;
    const fallbackId = kind === "command" ? this.lastCommandId : this.lastFileChangeId;
    const message =
      (idFromParams ? this.byId.get(idFromParams) : null) ??
      (fallbackId ? this.byId.get(fallbackId) : null) ??
      this.createMessage(kind, kind === "command" ? "command" : "file", kind === "command" ? "command output" : "file change");
    if (kind === "command") this.lastCommandId = message.id;
    if (kind === "file") this.lastFileChangeId = message.id;
    const counter = this.outputCounters.get(message.id) ?? { chars: 0, lines: 0, kind };
    counter.chars += delta.length;
    counter.lines += countVisibleLines(delta);
    counter.kind = kind;
    this.outputCounters.set(message.id, counter);
    this.upsertStatus(message, compactOutputStatus(counter), "output-summary");
  }

  private appendSystem(title: string, text: string, metadata?: JsonObject): void {
    const message = this.createMessage(title, "system", title);
    this.appendPart(message, "status", text, { metadata });
  }

  private appendStatus(message: TuiMessage, text: string): void {
    if (message.parts.at(-1)?.type === "status" && message.parts.at(-1)?.text === text) return;
    this.appendPart(message, "status", text);
  }

  private upsertStatus(message: TuiMessage, text: string, status: string): void {
    const last = message.parts.at(-1);
    if (last?.type === "status" && last.status === status) {
      last.text = text;
      return;
    }
    this.appendPart(message, "status", text, { status });
  }

  private ensureItemMessage(item: JsonObject, role: TuiMessageRole, title: string): TuiMessage {
    const id = typeof item.id === "string" ? item.id : `${role}-${this.sequence + 1}`;
    const existing = this.byId.get(id);
    if (existing) return existing;
    const message = this.createMessage(id, role, title);
    message.metadata = item;
    return message;
  }

  private createMessage(seed: string, role: TuiMessageRole, title: string): TuiMessage {
    const id = this.uniqueId(seed);
    const message: TuiMessage = { id, role, title, parts: [] };
    this.messages.push(message);
    this.byId.set(id, message);
    this.trim();
    return message;
  }

  private appendPart(
    message: TuiMessage,
    type: TuiMessagePartType,
    text: string,
    options: { inline?: boolean; title?: string; status?: string; metadata?: JsonObject } = {},
  ): void {
    if (!text) return;
    const last = message.parts.at(-1);
    if (options.inline && last?.type === type && !last.metadata) {
      last.text += text;
      return;
    }
    message.parts.push({
      id: `${message.id}-part-${message.parts.length + 1}`,
      type,
      text,
      title: options.title,
      status: options.status,
      metadata: options.metadata,
    });
  }

  private appendOrMergeText(
    message: TuiMessage,
    text: string,
    options: { status?: string; metadata?: JsonObject } = {},
  ): void {
    const current = messageText(message);
    if (!current) {
      this.appendPart(message, "text", text, options);
      return;
    }
    if (current === text || current.includes(text)) {
      return;
    }
    if (text.includes(current) || text.length > current.length) {
      this.replaceTextParts(message, text, options);
      return;
    }
    this.appendPart(message, "text", text, options);
  }

  private replaceTextParts(
    message: TuiMessage,
    text: string,
    options: { status?: string; metadata?: JsonObject } = {},
  ): void {
    const firstTextIndex = message.parts.findIndex((part) => part.type === "text");
    if (firstTextIndex < 0) {
      this.appendPart(message, "text", text, options);
      return;
    }
    const firstTextPart = message.parts[firstTextIndex]!;
    firstTextPart.text = text;
    firstTextPart.status = options.status ?? firstTextPart.status;
    firstTextPart.metadata = options.metadata ?? firstTextPart.metadata;
    for (let index = message.parts.length - 1; index > firstTextIndex; index--) {
      if (message.parts[index]?.type === "text") {
        message.parts.splice(index, 1);
      }
    }
  }

  private uniqueId(seed: string): string {
    this.sequence += 1;
    const normalized = this.normalizeId(seed);
    if (!this.byId.has(normalized)) return normalized;
    return `${normalized}-${this.sequence}`;
  }

  private normalizeId(seed: string): string {
    return seed.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "message";
  }

  private trim(): void {
    if (this.messages.length <= this.maxMessages) return;
    const overflow = this.messages.length - this.maxMessages;
    const removed = this.messages.splice(0, overflow);
    for (const message of removed) {
      this.byId.delete(message.id);
    }
    this.truncatedMessages += overflow;
  }
}

export function messagesToTranscriptLines(messages: TuiMessage[]): string[] {
  return messages.flatMap((message) => {
    const prefix = messagePrefix(message);
    return message.parts.flatMap((part) => splitLines(part.text).map((line) => `${prefix} ${line}`.trimEnd()));
  });
}

function messagePrefix(message: TuiMessage): string {
  switch (message.role) {
    case "user":
      return "[user]";
    case "assistant":
      return "[assistant]";
    case "reasoning":
      return "[reasoning]";
    case "command":
      return "[codex command]";
    case "file":
      return "[codex fileChange]";
    case "error":
      return "[codex error]";
    case "tool":
      return "[codex tool]";
    default:
      return "[codex]";
  }
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function userMessageText(item: JsonObject): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!asObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (Array.isArray(part.text_elements)) {
        return (part.text_elements as unknown[]).filter((entry): entry is string => typeof entry === "string").join("");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function reasoningText(item: JsonObject): string {
  const blocks = [item.summary, item.content].flatMap((value) => (Array.isArray(value) ? value : []));
  return blocks
    .map((part) => {
      if (typeof part === "string") return part;
      if (asObject(part) && typeof part.text === "string") return part.text;
      if (asObject(part) && typeof part.summary === "string") return part.summary;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function agentTitle(item: JsonObject): string {
  const phase = typeof item.phase === "string" ? item.phase : "assistant";
  return phase === "final" ? "assistant final" : phase === "commentary" ? "assistant commentary" : "assistant";
}

function toolStatusText(item: JsonObject, phase: "started" | "completed"): string {
  const type = typeof item.type === "string" ? item.type : "tool";
  const name =
    typeof item.tool === "string"
      ? item.tool
      : typeof item.query === "string"
        ? item.query
        : typeof item.server === "string"
          ? item.server
          : type;
  const status = typeof item.status === "string" ? ` status=${item.status}` : "";
  return `${phase} ${name}${status}`;
}

function messageText(message: TuiMessage): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function countVisibleLines(text: string): number {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return 0;
  const split = normalized.split("\n");
  if (split.at(-1) === "") split.pop();
  return Math.max(1, split.length);
}

function compactOutputStatus(counter: { chars: number; lines: number; kind: "command" | "file" }): string {
  const label = counter.kind === "command" ? "output" : "file output";
  return `${label} hidden (${counter.lines} line${counter.lines === 1 ? "" : "s"}, ${counter.chars} chars; see Codex logs for full text)`;
}

function cloneMessage(message: TuiMessage): TuiMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
    parts: message.parts.map((part) => ({
      ...part,
      metadata: part.metadata ? { ...part.metadata } : undefined,
    })),
  };
}

function compactJson(value: JsonObject): string {
  const text = JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}
