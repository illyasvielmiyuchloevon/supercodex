import { stat, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PasteSummary {
  id: string;
  marker: string;
  text: string;
  kind: "text" | "file";
  source?: string;
  createdAt: string;
}

export interface ResolvedPasteFile {
  path: string;
  displayPath: string;
  text?: string;
  skippedReason?: "directory" | "too_large" | "binary" | "missing";
}

const LONG_PASTE_MIN_LINES = 3;
const LONG_PASTE_MIN_CHARS = 150;
const MAX_TEXT_FILE_BYTES = 128 * 1024;

export function normalizePasteText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function pasteLineCount(text: string): number {
  if (!text) return 0;
  return (text.match(/\n/g)?.length ?? 0) + 1;
}

export function shouldSummarizePaste(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return pasteLineCount(trimmed) >= LONG_PASTE_MIN_LINES || trimmed.length > LONG_PASTE_MIN_CHARS;
}

export function createPasteSummary(input: {
  text: string;
  kind?: "text" | "file";
  source?: string;
  sequence?: number;
  now?: string;
}): PasteSummary {
  const text = normalizePasteText(input.text);
  const kind = input.kind ?? "text";
  const createdAt = input.now ?? new Date().toISOString();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const sequence = input.sequence ?? 1;
  const marker =
    kind === "file"
      ? `[File: ${input.source ? basename(input.source) : "pasted"} ~${pasteLineCount(text)} lines #${sequence}]`
      : `[Pasted ~${pasteLineCount(text)} lines #${sequence}]`;
  return { id, marker, text, kind, source: input.source, createdAt };
}

export function expandPasteSummaries(input: string, summaries: PasteSummary[]): string {
  let expanded = input;
  for (const summary of summaries) {
    expanded = expanded.split(summary.marker).join(summary.text);
  }
  return expanded;
}

export function coercePastedPath(text: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = normalizePasteText(text).trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return "";
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return "";
    }
  }
  return platform === "win32" ? trimmed : trimmed.replace(/\\(.)/g, "$1");
}

export async function resolvePastedFile(project: string, text: string): Promise<ResolvedPasteFile | null> {
  const pastedPath = coercePastedPath(text);
  if (!pastedPath) return null;
  const candidate = isAbsolute(pastedPath) ? pastedPath : resolve(project, pastedPath);
  try {
    const info = await stat(candidate);
    const displayPath = relative(project, candidate) || candidate;
    if (info.isDirectory()) {
      return { path: candidate, displayPath, skippedReason: "directory" };
    }
    if (!info.isFile()) {
      return null;
    }
    if (info.size > MAX_TEXT_FILE_BYTES) {
      return { path: candidate, displayPath, skippedReason: "too_large" };
    }
    const textContent = normalizePasteText(await readFile(candidate, "utf8"));
    if (textContent.includes("\u0000")) {
      return { path: candidate, displayPath, skippedReason: "binary" };
    }
    return { path: candidate, displayPath, text: textContent };
  } catch {
    return null;
  }
}
