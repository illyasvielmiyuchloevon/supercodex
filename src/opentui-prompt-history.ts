import { join } from "node:path";
import { appendLog, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic } from "./fs-utils.js";
import { supervisorDataRoot } from "./settings.js";

export interface PromptHistoryEntry {
  input: string;
  createdAt: string;
}

export interface PromptStashEntry extends PromptHistoryEntry {
  id: string;
}

const MAX_PROMPT_HISTORY = 50;
const MAX_PROMPT_STASH = 50;

export function promptHistoryPath(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "prompt-history.jsonl");
}

export function promptStashPath(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "prompt-stash.json");
}

export async function readPromptHistory(project: string, runId?: string | null): Promise<PromptHistoryEntry[]> {
  const path = promptHistoryPath(project, runId);
  const parsed = parsePromptHistory(await readText(path, ""));
  if (parsed.rewrite) {
    await writePromptHistory(project, parsed.entries, runId);
  }
  return parsed.entries;
}

export async function appendPromptHistory(project: string, input: string, runId?: string | null): Promise<PromptHistoryEntry[]> {
  const normalized = normalizePromptInput(input);
  if (!normalized) {
    return await readPromptHistory(project, runId);
  }
  const history = await readPromptHistory(project, runId);
  const entry = { input: normalized, createdAt: nowIso() };
  const next = [...history.filter((item) => item.input !== normalized), entry].slice(-MAX_PROMPT_HISTORY);
  if (next.length === history.length + 1 && next.length <= MAX_PROMPT_HISTORY) {
    await appendLog(promptHistoryPath(project, runId), `${JSON.stringify(entry)}\n`);
  } else {
    await writePromptHistory(project, next, runId);
  }
  return next;
}

export async function writePromptHistory(project: string, entries: PromptHistoryEntry[], runId?: string | null): Promise<void> {
  const clean = entries.map(normalizePromptHistoryEntry).filter((entry): entry is PromptHistoryEntry => entry !== null).slice(-MAX_PROMPT_HISTORY);
  const content = clean.length > 0 ? `${clean.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  await writeTextAtomic(promptHistoryPath(project, runId), content);
}

export function selectPromptHistory(
  entries: PromptHistoryEntry[],
  currentIndex: number,
  direction: 1 | -1,
): { index: number; input: string } {
  if (entries.length === 0) {
    return { index: 0, input: "" };
  }
  const start = Number.isInteger(currentIndex) ? currentIndex : entries.length;
  const next = Math.max(0, Math.min(entries.length, start + direction));
  return {
    index: next,
    input: next === entries.length ? "" : entries[next]?.input ?? "",
  };
}

export async function readPromptStash(project: string, runId?: string | null): Promise<PromptStashEntry[]> {
  const entries = await readJson<PromptStashEntry[]>(promptStashPath(project, runId), []);
  return Array.isArray(entries)
    ? entries.map(normalizePromptStashEntry).filter((entry): entry is PromptStashEntry => entry !== null).slice(-MAX_PROMPT_STASH)
    : [];
}

export async function pushPromptStash(project: string, input: string, runId?: string | null): Promise<PromptStashEntry[]> {
  const normalized = normalizePromptInput(input);
  if (!normalized) {
    return await readPromptStash(project, runId);
  }
  const stash = await readPromptStash(project, runId);
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    input: normalized,
    createdAt: nowIso(),
  };
  const next = [...stash, entry].slice(-MAX_PROMPT_STASH);
  await writeJsonAtomic(promptStashPath(project, runId), next);
  return next;
}

export async function popPromptStash(project: string, runId?: string | null): Promise<PromptStashEntry | null> {
  const stash = await readPromptStash(project, runId);
  const entry = stash.at(-1) ?? null;
  const next = entry ? stash.slice(0, -1) : stash;
  await writeJsonAtomic(promptStashPath(project, runId), next);
  return entry;
}

function parsePromptHistory(text: string): { entries: PromptHistoryEntry[]; rewrite: boolean } {
  const entries: PromptHistoryEntry[] = [];
  let rewrite = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = normalizePromptHistoryEntry(JSON.parse(line) as unknown);
      if (parsed) {
        entries.push(parsed);
      } else {
        rewrite = true;
      }
    } catch {
      rewrite = true;
    }
  }
  const trimmed = entries.slice(-MAX_PROMPT_HISTORY);
  return { entries: trimmed, rewrite: rewrite || trimmed.length !== entries.length };
}

function normalizePromptHistoryEntry(value: unknown): PromptHistoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = normalizePromptInput((value as { input?: unknown }).input);
  if (!input) return null;
  const createdAt = typeof (value as { createdAt?: unknown }).createdAt === "string" ? (value as { createdAt: string }).createdAt : nowIso();
  return { input, createdAt };
}

function normalizePromptStashEntry(value: unknown): PromptStashEntry | null {
  const base = normalizePromptHistoryEntry(value);
  if (!base || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = typeof (value as { id?: unknown }).id === "string" && (value as { id: string }).id.trim() ? (value as { id: string }).id : `${Date.now().toString(36)}`;
  return { ...base, id };
}

function normalizePromptInput(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

