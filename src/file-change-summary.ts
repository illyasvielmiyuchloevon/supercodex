import type { JsonObject } from "./types.js";

export function summarizeFileChanges(changes: unknown, options: { maxEntries?: number } = {}): string {
  if (!Array.isArray(changes) || changes.length === 0) {
    return "changes=0";
  }
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 20));
  const lines = changes.slice(0, maxEntries).map(formatFileChange).filter(Boolean);
  const remaining = changes.length - maxEntries;
  if (remaining > 0) {
    lines.push(`... ${remaining} more file${remaining === 1 ? "" : "s"}`);
  }
  return lines.length > 0 ? lines.join("\n") : `changes=${changes.length}`;
}

export function fileChangeCount(changes: unknown): number {
  return Array.isArray(changes) ? changes.length : 0;
}

function formatFileChange(change: unknown): string {
  if (typeof change === "string") {
    return `M ${change}`;
  }
  if (!isObject(change)) {
    return "";
  }
  const marker = fileChangeMarker(change);
  const oldPath = firstString(change.oldPath, change.previousPath, change.from, change.sourcePath);
  const newPath = firstString(change.path, change.newPath, change.targetPath, change.filePath, change.relativePath, change.absolutePath, change.to);
  if (marker === "R" && oldPath && newPath && oldPath !== newPath) {
    return `R ${oldPath} -> ${newPath}`;
  }
  const displayPath = newPath ?? oldPath ?? firstString(change.name, change.file);
  return displayPath ? `${marker} ${displayPath}` : `${marker} ${compactJson(change)}`;
}

function fileChangeMarker(change: JsonObject): "A" | "D" | "M" | "R" {
  const raw = firstString(change.type, change.kind, change.action, change.operation, change.changeType, change.status) ?? "";
  const normalized = raw.toLowerCase();
  if (normalized.includes("rename") || normalized.includes("move")) return "R";
  if (normalized.includes("delete") || normalized.includes("remove") || normalized.includes("unlink")) return "D";
  if (normalized.includes("add") || normalized.includes("create") || normalized.includes("new")) return "A";
  if (firstString(change.oldPath, change.previousPath, change.from, change.sourcePath) && firstString(change.newPath, change.targetPath, change.to)) {
    return "R";
  }
  return "M";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function compactJson(value: JsonObject): string {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
