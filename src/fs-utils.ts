import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const atomicWriteLocks = new Map<string, Promise<void>>();

export function nowIso(): string {
  return new Date().toISOString();
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readText(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeTextAtomic(path, content);
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await withAtomicWriteLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    if ((await readText(path, "")) === content) {
      return;
    }
    const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, "utf8");
      await renameWithRetry(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function withAtomicWriteLock(path: string, operation: () => Promise<void>): Promise<void> {
  const lockKey = normalizeLockPath(path);
  const previous = atomicWriteLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  atomicWriteLocks.set(lockKey, chained);
  await previous.catch(() => undefined);
  try {
    await operation();
  } finally {
    release();
    if (atomicWriteLocks.get(lockKey) === chained) {
      atomicWriteLocks.delete(lockKey);
    }
  }
}

async function renameWithRetry(temp: string, path: string): Promise<void> {
  const attempts = process.platform === "win32" ? 12 : 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!isTransientRenameError(code)) {
        throw error;
      }
      await delay(Math.min(1000, 25 * 2 ** attempt));
    }
  }
  throw lastError;
}

function isTransientRenameError(code: string | undefined): boolean {
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function normalizeLockPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function writeTextIfMissing(path: string, content: string): Promise<boolean> {
  if (await pathExists(path)) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return true;
}

export async function appendLog(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, content, "utf8");
}

export async function appendLogBestEffort(path: string, content: string, fallbackRoot: string): Promise<void> {
  try {
    await appendLog(path, content);
  } catch (error) {
    const fallback = `${fallbackRoot}/.supercodex/logs/supercodex/supercodex-warnings.md`;
    try {
      await appendLog(
        fallback,
        `## ${nowIso()} - log-write-failed\n\n- target: ${path}\n- error: ${
          (error as Error).message
        }\n\nOriginal content:\n\n${content}\n`,
      );
    } catch {
      // Logging must never block recovery.
    }
  }
}

export async function ensureDir(path: string): Promise<boolean> {
  if (await pathExists(path)) {
    return false;
  }
  await mkdir(path, { recursive: true });
  return true;
}

export async function removeIfExists(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
