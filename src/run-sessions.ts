import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultCodexHome } from "./auth.js";
import { nowIso, pathExists, readJson, writeJsonAtomic } from "./fs-utils.js";
import { defaultRunId, sanitizeRunId, supervisorDataRoot } from "./settings.js";
import type { JsonObject } from "./types.js";

export type RunSessionSource = "supercodex" | "codex";

export interface RunSessionSummary {
  runId: string;
  root: string;
  hasSession: boolean;
  hasRuntime: boolean;
  threadId: string | null;
  sessionId: string | null;
  turnId: string | null;
  status: string | null;
  classification: string | null;
  updatedAt: string | null;
  mtimeMs: number;
  source?: RunSessionSource;
  cwd?: string | null;
  nativePath?: string | null;
  originator?: string | null;
}

export interface RunSessionsPayload {
  count: number;
  resumableCount: number;
  sessions: RunSessionSummary[];
}

export async function listRunSessions(projectInput: string): Promise<RunSessionSummary[]> {
  const project = resolve(projectInput);
  const runIds = new Set<string>([defaultRunId]);
  const runsDir = join(project, ".supercodex", "runtime", "runs");
  try {
    for (const entry of await readdir(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        runIds.add(sanitizeRunId(entry.name));
      }
    }
  } catch {
    // Missing runs directory is normal for a default-only project.
  }

  const supercodexSessions = (await Promise.all([...runIds].map((runId) => readRunSession(project, runId))))
    .filter((session) => session.hasSession || session.hasRuntime || Boolean(session.threadId))
    .sort(compareRunSessions);
  const codexSessions = await listCodexSessionsForProject(project);
  return mergeRunSessions(supercodexSessions, codexSessions)
    .sort(compareRunSessions);
}

export async function prepareRunSessionForResume(projectInput: string, session: RunSessionSummary): Promise<RunSessionSummary> {
  const project = resolve(projectInput);
  if (session.source !== "codex" || session.hasSession || !session.threadId) {
    return session;
  }

  const runId = sanitizeRunId(session.runId);
  const root = supervisorDataRoot(project, runId);
  await writeJsonAtomic(join(root, "session.json"), {
    thread_id: session.threadId,
    session_id: session.sessionId ?? session.threadId,
    turn_id: session.turnId,
    stage_id: null,
    task_id: null,
    work_kind: "operator_intervention",
    importedFrom: "codex-session",
    nativeSessionPath: session.nativePath ?? null,
    updatedAt: nowIso(),
  });

  return {
    ...session,
    runId,
    root,
    hasSession: true,
  };
}

export async function runSessionsPayload(project: string): Promise<RunSessionsPayload> {
  const sessions = await listRunSessions(project);
  return {
    count: sessions.length,
    resumableCount: sessions.filter((session) => session.hasSession || session.threadId).length,
    sessions,
  };
}

export function resolveRunSessionSelector(sessions: RunSessionSummary[], selector: string): RunSessionSummary | null {
  const trimmed = selector.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    return sessions[index] ?? null;
  }
  const sanitized = sanitizeRunId(trimmed);
  return sessions.find((session) =>
    session.runId === trimmed ||
    session.runId === sanitized ||
    Boolean(session.threadId && session.threadId.startsWith(trimmed)) ||
    Boolean(session.sessionId && session.sessionId.startsWith(trimmed))
  ) ?? null;
}

export function formatRunSessions(sessions: RunSessionSummary[], maxRows = 12): string {
  if (sessions.length === 0) {
    return "No saved Codex/SuperCodex sessions were found for this project.";
  }
  const resumable = sessions.filter((session) => session.hasSession || session.threadId).length;
  const lines = [
    `Found ${sessions.length} saved Codex/SuperCodex session(s) for this project; ${resumable} can be selected.`,
    "Use /resume <number> or /resume <run-id> to select one without auto-running; type a message to continue, or use /start <run-id> to auto-run.",
    "",
  ];
  sessions.slice(0, Math.max(1, maxRows)).forEach((session, index) => {
    lines.push(`${index + 1}. ${formatRunSession(session)}`);
  });
  if (sessions.length > maxRows) {
    lines.push(`... ${sessions.length - maxRows} more session(s). Use /runs for the full JSON list.`);
  }
  return lines.join("\n");
}

export function formatRunSession(session: RunSessionSummary): string {
  const thread = session.threadId ? `thread ${shortId(session.threadId)}` : "no saved thread";
  const status = session.classification ?? session.status ?? "unknown";
  const updated = session.updatedAt ?? (session.mtimeMs > 0 ? new Date(session.mtimeMs).toISOString() : "unknown time");
  const source = session.source ?? "supercodex";
  return `${session.runId} | ${thread} | ${status} | ${updated} | ${source}`;
}

async function readRunSession(project: string, runId: string): Promise<RunSessionSummary> {
  const root = supervisorDataRoot(project, runId);
  const sessionPath = join(root, "session.json");
  const runtimePath = join(root, "runtime.json");
  const [session, runtime, hasSession, hasRuntime, mtimeMs] = await Promise.all([
    readJson<JsonObject>(sessionPath, {}),
    readJson<JsonObject>(runtimePath, {}),
    pathExists(sessionPath),
    pathExists(runtimePath),
    newestMtimeMs([root, sessionPath, runtimePath]),
  ]);
  const updatedAt = firstString(session.updatedAt, runtime.updatedAt);
  return {
    runId,
    root,
    hasSession,
    hasRuntime,
    threadId: firstString(session.thread_id, runtime.thread_id, session.session_id),
    sessionId: firstString(session.session_id, session.thread_id, runtime.thread_id),
    turnId: firstString(session.turn_id, runtime.turn_id),
    status: firstString(runtime.status),
    classification: firstString(session.lastClassification, runtime.classification),
    updatedAt,
    mtimeMs: updatedAt ? Date.parse(updatedAt) || mtimeMs : mtimeMs,
    source: "supercodex",
    cwd: project,
    nativePath: firstString(session.nativeSessionPath, runtime.nativeSessionPath),
    originator: firstString(session.originator),
  };
}

async function listCodexSessionsForProject(project: string): Promise<RunSessionSummary[]> {
  const sessionsRoot = join(defaultCodexHome(), "sessions");
  let files: string[];
  try {
    files = await collectJsonlFiles(sessionsRoot);
  } catch {
    return [];
  }

  const sessions = await Promise.all(files.map((file) => readCodexSessionForProject(project, file)));
  return sessions.filter((session): session is RunSessionSummary => Boolean(session));
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(path));
      return;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }));
  return files;
}

async function readCodexSessionForProject(project: string, filePath: string): Promise<RunSessionSummary | null> {
  const metadata = await readCodexSessionMetadata(filePath);
  if (!metadata?.id || !metadata.cwd || !sameProjectPath(metadata.cwd, project)) {
    return null;
  }

  const runId = sanitizeRunId(`codex-${metadata.id}`);
  const root = supervisorDataRoot(project, runId);
  const sessionPath = join(root, "session.json");
  const runtimePath = join(root, "runtime.json");
  const [hasSession, hasRuntime, fileMtimeMs, localMtimeMs] = await Promise.all([
    pathExists(sessionPath),
    pathExists(runtimePath),
    newestMtimeMs([filePath]),
    newestMtimeMs([root, sessionPath, runtimePath]),
  ]);
  const mtimeMs = Math.max(fileMtimeMs, localMtimeMs, metadata.timestamp ? Date.parse(metadata.timestamp) || 0 : 0);

  return {
    runId,
    root,
    hasSession,
    hasRuntime,
    threadId: metadata.id,
    sessionId: metadata.id,
    turnId: null,
    status: metadata.source ?? "codex",
    classification: null,
    updatedAt: metadata.timestamp,
    mtimeMs,
    source: "codex",
    cwd: metadata.cwd,
    nativePath: filePath,
    originator: metadata.originator,
  };
}

async function readCodexSessionMetadata(filePath: string): Promise<{ id: string | null; cwd: string | null; timestamp: string | null; originator: string | null; source: string | null } | null> {
  let firstLine: string;
  try {
    firstLine = (await readFirstLine(filePath)).trim();
  } catch {
    return null;
  }
  if (!firstLine) {
    return null;
  }

  let parsed: JsonObject;
  try {
    parsed = JSON.parse(firstLine) as JsonObject;
  } catch {
    return null;
  }
  if (parsed.type !== "session_meta" || !isObject(parsed.payload)) {
    return null;
  }
  const payload = parsed.payload;
  return {
    id: firstString(payload.id),
    cwd: firstString(payload.cwd),
    timestamp: firstString(payload.timestamp, parsed.timestamp),
    originator: firstString(payload.originator),
    source: firstString(payload.source),
  };
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let total = 0;
    const maxBytes = 1024 * 1024;
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - total), position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(Buffer.from(chunk));
      position += bytesRead;
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
  } finally {
    await handle.close();
  }
}

function mergeRunSessions(supercodexSessions: RunSessionSummary[], codexSessions: RunSessionSummary[]): RunSessionSummary[] {
  const result: RunSessionSummary[] = [];
  const seenRunIds = new Set<string>();
  const seenThreadIds = new Set<string>();
  const add = (session: RunSessionSummary) => {
    const runId = sanitizeRunId(session.runId);
    const threadId = session.threadId ?? session.sessionId;
    if (seenRunIds.has(runId)) {
      return;
    }
    if (threadId && seenThreadIds.has(threadId)) {
      return;
    }
    seenRunIds.add(runId);
    if (threadId) {
      seenThreadIds.add(threadId);
    }
    result.push(session);
  };
  supercodexSessions.forEach(add);
  codexSessions.forEach(add);
  return result;
}

function compareRunSessions(a: RunSessionSummary, b: RunSessionSummary): number {
  const byTime = b.mtimeMs - a.mtimeMs;
  if (byTime !== 0) return byTime;
  if (a.runId === defaultRunId) return -1;
  if (b.runId === defaultRunId) return 1;
  return a.runId.localeCompare(b.runId);
}

async function newestMtimeMs(paths: string[]): Promise<number> {
  const mtimes = await Promise.all(paths.map(async (path) => {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  }));
  return Math.max(0, ...mtimes);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function sameProjectPath(left: string, right: string): boolean {
  return normalizeComparePath(left) === normalizeComparePath(right);
}

function normalizeComparePath(value: string): string {
  const resolved = resolve(value).replace(/[\\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
