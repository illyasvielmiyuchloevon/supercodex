import type { JsonObject } from "./types.js";
import { fileChangeCount, summarizeFileChanges } from "./file-change-summary.js";

export interface AppServerNotificationSummary {
  text: string;
  stream?: "stderr" | "stdout";
  inline?: boolean;
}

export function summarizeAppServerNotification(message: JsonObject): AppServerNotificationSummary | null {
  const method = typeof message.method === "string" ? message.method : "";
  const params = isPlainObject(message.params) ? message.params : {};
  if (method === "turn/started") {
    return { text: "[codex turn] started\n" };
  }
  if (method === "turn/completed") {
    const turn = isPlainObject(params.turn) ? params.turn : {};
    const status = String(turn.status ?? "unknown");
    return { text: `[codex turn] completed status=${status}\n` };
  }
  if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
    return { text: `[codex ${method}] ${compactJson(params)}\n`, stream: "stderr" };
  }
  if (method === "thread/compacted") {
    return { text: "[codex thread] compacted\n" };
  }
  if (method === "model/rerouted") {
    return { text: `[codex model] rerouted ${compactJson(params)}\n` };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = isPlainObject(params.item) ? params.item : {};
    const phase = method === "item/started" ? "started" : "completed";
    return summarizeThreadItem(item, phase);
  }
  if (method === "item/commandExecution/outputDelta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    return delta ? { text: delta, inline: true } : null;
  }
  if (method === "command/exec/outputDelta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    return delta ? { text: delta, inline: true } : null;
  }
  if (method === "item/fileChange/outputDelta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    return delta ? { text: delta, inline: true } : null;
  }
  if (method === "item/mcpToolCall/progress") {
    return { text: `[codex mcp] ${compactJson(params)}\n` };
  }
  return null;
}

function summarizeThreadItem(item: JsonObject, phase: "completed" | "started"): AppServerNotificationSummary | null {
  const type = typeof item.type === "string" ? item.type : "item";
  if (type === "agentMessage" || type === "reasoning" || type === "plan" || type === "userMessage") {
    return null;
  }
  if (type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "(unknown command)";
    if (phase === "started") {
      return { text: `[codex command] ${command}\n` };
    }
    const exit = item.exitCode === null || item.exitCode === undefined ? "unknown" : String(item.exitCode);
    const duration = item.durationMs === null || item.durationMs === undefined ? "" : ` durationMs=${item.durationMs}`;
    return { text: `[codex command] completed exit=${exit}${duration}\n` };
  }
  if (type === "fileChange") {
    const status = typeof item.status === "string" ? item.status : "unknown";
    const summary = summarizeFileChanges(item.changes);
    const count = fileChangeCount(item.changes);
    return { text: `[codex fileChange] ${phase} status=${status} changes=${count}\n${summary}\n` };
  }
  if (type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "unknown";
    const tool = typeof item.tool === "string" ? item.tool : "unknown";
    const status = typeof item.status === "string" ? item.status : "unknown";
    return { text: `[codex mcp] ${phase} ${server}/${tool} status=${status}\n` };
  }
  if (type === "dynamicToolCall") {
    const namespace = typeof item.namespace === "string" ? `${item.namespace}/` : "";
    const tool = typeof item.tool === "string" ? item.tool : "unknown";
    const status = typeof item.status === "string" ? item.status : "unknown";
    return { text: `[codex tool] ${phase} ${namespace}${tool} status=${status}\n` };
  }
  if (type === "webSearch") {
    const query = typeof item.query === "string" ? item.query : "";
    return { text: `[codex webSearch] ${phase} ${query}\n` };
  }
  return { text: `[codex item] ${phase} type=${type}\n` };
}

function compactJson(value: JsonObject): string {
  const text = JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
