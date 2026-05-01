import { randomUUID } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { nowIso, pathExists, readJson, removeIfExists, writeJsonAtomic } from "./fs-utils.js";
import {
  defaultRunId,
  legacySupervisorDataRoot,
  parseReasoningEffort,
  sanitizeRunId,
  supervisorDataRoot,
  type SupervisorSettingsPatch,
} from "./settings.js";
import type { JsonObject, ReasoningEffort } from "./types.js";

const legacyControlFile = "control.json";

export type ControlAction = "auth_use" | "fresh_next" | "interrupt" | "pause" | "resume" | "set_settings" | "steer";
export type ControlStatus = "handled" | "observed" | "pending";

export interface ControlRequest extends JsonObject {
  id: string;
  action: ControlAction;
  status: ControlStatus;
  message?: string;
  settings?: SupervisorSettingsPatch;
  authName?: string;
  runId?: string;
  createdAt: string;
  observedAt: string | null;
  handledAt: string | null;
}

export function controlPath(project: string): string {
  return join(supervisorDataRoot(project), legacyControlFile);
}

function legacyControlPath(project: string): string {
  return join(legacySupervisorDataRoot(project), legacyControlFile);
}

export function controlQueueRoot(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "control");
}

export function controlPendingDir(project: string, runId?: string | null): string {
  return join(controlQueueRoot(project, runId), "pending");
}

export function controlHandledDir(project: string, runId?: string | null): string {
  return join(controlQueueRoot(project, runId), "handled");
}

export async function requestSteer(project: string, message: string, runId?: string | null): Promise<ControlRequest> {
  const cleaned = message.trim();
  if (!cleaned) {
    throw new Error("Intervention message must not be empty.");
  }
  return await enqueueControl(project, { action: "steer", message: cleaned }, runId);
}

export async function requestInterrupt(project: string, message: string, runId?: string | null): Promise<ControlRequest> {
  return await requestSteer(project, message, runId);
}

export async function requestTurnInterrupt(project: string, message = "", runId?: string | null): Promise<ControlRequest> {
  return await enqueueControl(project, { action: "interrupt", message: message.trim() || undefined }, runId);
}

export async function requestSettings(
  project: string,
  settings: { model?: string | null; reasoningEffort?: string | ReasoningEffort | null },
  runId?: string | null,
): Promise<ControlRequest> {
  const patch: SupervisorSettingsPatch = {};
  if ("model" in settings) {
    patch.model = typeof settings.model === "string" ? settings.model.trim() || null : null;
  }
  if ("reasoningEffort" in settings) {
    patch.reasoningEffort = typeof settings.reasoningEffort === "string" ? parseReasoningEffort(settings.reasoningEffort) : null;
  }
  return await enqueueControl(project, { action: "set_settings", settings: patch }, runId);
}

export async function requestAuthUse(project: string, authName: string, runId?: string | null): Promise<ControlRequest> {
  const cleaned = authName.trim();
  if (!cleaned) {
    throw new Error("Auth account name must not be empty.");
  }
  return await enqueueControl(project, { action: "auth_use", authName: cleaned }, runId);
}

export async function requestFreshNext(project: string, runId?: string | null): Promise<ControlRequest> {
  return await enqueueControl(project, { action: "fresh_next" }, runId);
}

export async function requestPause(project: string, runId?: string | null): Promise<ControlRequest> {
  return await enqueueControl(project, { action: "pause" }, runId);
}

export async function requestResume(project: string, runId?: string | null): Promise<ControlRequest> {
  return await enqueueControl(project, { action: "resume" }, runId);
}

export async function enqueueControl(
  project: string,
  input: Pick<ControlRequest, "action"> & Partial<ControlRequest>,
  runId?: string | null,
): Promise<ControlRequest> {
  const id = randomUUID();
  const createdAt = nowIso();
  const payload: ControlRequest = {
    id,
    status: "pending",
    createdAt,
    observedAt: null,
    handledAt: null,
    ...input,
  };
  const path = join(controlPendingDir(project, runId), `${createdAt.replace(/[:.]/g, "-")}-${id}.json`);
  await writeJsonAtomic(path, payload);
  return payload;
}

export async function readControl(project: string, runId?: string | null): Promise<JsonObject> {
  const primaryLegacy = await readJson<JsonObject>(controlPath(project), {});
  const legacy = Object.keys(primaryLegacy).length > 0 ? primaryLegacy : await readJson<JsonObject>(legacyControlPath(project), {});
  const pending = await readPendingControls(project, runId);
  return {
    legacy,
    queueRoot: controlQueueRoot(project, runId),
    pendingCount: pending.length,
    pending: pending.slice(0, 10).map(({ path: _path, ...item }) => item),
  };
}

export async function readPendingControls(project: string, runId?: string | null): Promise<Array<ControlRequest & { path: string }>> {
  const pendingDir = controlPendingDir(project, runId);
  const result: Array<ControlRequest & { path: string }> = [];
  if (await pathExists(pendingDir)) {
    const entries = (await readdir(pendingDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    for (const entry of entries) {
      const path = join(pendingDir, entry);
      const data = await readJson<ControlRequest | null>(path, null);
      if (!data || data.status !== "pending" || typeof data.action !== "string" || typeof data.id !== "string") {
        continue;
      }
      result.push({ ...data, path });
    }
  }
  if (sanitizeRunId(runId) === defaultRunId) {
    const primaryLegacy = await readJson<ControlRequest | null>(controlPath(project), null);
    const legacy = primaryLegacy ?? (await readJson<ControlRequest | null>(legacyControlPath(project), null));
    if (legacy?.status === "pending" && typeof legacy.action === "string" && typeof legacy.id === "string") {
      result.push({ ...legacy, action: legacy.action === "interrupt" ? "steer" : legacy.action, path: controlPath(project) });
    }
  }
  return result;
}

export async function markControlObserved(project: string, request: ControlRequest & { path?: string }, runId?: string | null): Promise<ControlRequest> {
  const path = request.path ?? findPendingPath(project, request, runId);
  const data = { ...request, status: "observed", observedAt: nowIso() } as ControlRequest;
  delete (data as ControlRequest & { path?: string }).path;
  await writeJsonAtomic(await path, data);
  return data;
}

export async function markControlHandled(project: string, request: ControlRequest & { path?: string }, runId?: string | null): Promise<void> {
  const pendingPath = request.path ?? (await findPendingPath(project, request, runId));
  if (!(await pathExists(pendingPath))) {
    return;
  }
  const handled = { ...request, status: "handled", handledAt: nowIso() } as ControlRequest;
  delete (handled as ControlRequest & { path?: string }).path;
  const handledPath = join(controlHandledDir(project, runId), `${handled.createdAt.replace(/[:.]/g, "-")}-${handled.id}.json`);
  await writeJsonAtomic(handledPath, handled);
  await rename(pendingPath, `${pendingPath}.handled.tmp`).catch(() => undefined);
  await rm(`${pendingPath}.handled.tmp`, { force: true }).catch(() => undefined);
}

export async function markInterruptHandled(project: string, requestId?: string | null, runId?: string | null): Promise<void> {
  if (!requestId) {
    return;
  }
  for (const request of await readPendingControls(project, runId)) {
    if (request.id === requestId && (request.action === "steer" || request.action === "interrupt")) {
      await markControlHandled(project, request, runId);
      return;
    }
  }
  const legacy = await readJson<JsonObject>(controlPath(project), {});
  if (legacy.id === requestId && (legacy.action === "interrupt" || legacy.action === "steer")) {
    await writeJsonAtomic(controlPath(project), { ...legacy, status: "handled", handledAt: nowIso() });
  }
}

export async function pendingInterrupt(project: string, runId?: string | null): Promise<ControlRequest | null> {
  const queued = (await readPendingControls(project, runId)).find((request) => request.action === "steer" || request.action === "interrupt");
  if (queued && typeof queued.message === "string" && queued.message.trim()) {
    return queued;
  }
  const data = await readJson<JsonObject>(controlPath(project), {});
  const legacyData = Object.keys(data).length > 0 ? data : await readJson<JsonObject>(legacyControlPath(project), {});
  if (
    (legacyData.action === "interrupt" || legacyData.action === "steer") &&
    legacyData.status === "pending" &&
    typeof legacyData.message === "string" &&
    legacyData.message.trim()
  ) {
    return legacyData as ControlRequest;
  }
  return null;
}

export async function clearControl(project: string, runId?: string | null): Promise<boolean> {
  const removedLegacy = await removeIfExists(controlPath(project));
  const removedOldLegacy = await removeIfExists(legacyControlPath(project));
  const root = controlQueueRoot(project, runId);
  const existed = await pathExists(root);
  await rm(root, { recursive: true, force: true });
  return removedLegacy || removedOldLegacy || existed;
}

async function findPendingPath(project: string, request: ControlRequest, runId?: string | null): Promise<string> {
  for (const pending of await readPendingControls(project, runId)) {
    if (pending.id === request.id) {
      return pending.path;
    }
  }
  return join(controlPendingDir(project, runId), `${request.createdAt.replace(/[:.]/g, "-")}-${request.id}.json`);
}
