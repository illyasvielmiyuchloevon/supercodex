import { join, resolve } from "node:path";
import { nowIso, pathExists, readJson, writeJsonAtomic } from "./fs-utils.js";
import type { CodexApprovalPolicy, CodexSandboxMode, JsonObject, ReasoningEffort } from "./types.js";

export const defaultRunId = "default";

export interface SupervisorRuntimeSettings extends JsonObject {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  sandbox?: CodexSandboxMode | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  pendingAuthName?: string | null;
  forceFreshNext?: boolean;
  paused?: boolean;
  updatedAt?: string;
}

export interface SupervisorSettingsPatch {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  sandbox?: CodexSandboxMode | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  pendingAuthName?: string | null;
  forceFreshNext?: boolean;
  paused?: boolean;
}

export type CodexPermissionPatch = Pick<SupervisorSettingsPatch, "sandbox" | "approvalPolicy">;

export function sanitizeRunId(value?: string | null): string {
  const cleaned = (value ?? defaultRunId).trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || defaultRunId;
}

export function supercodexDataRoot(projectInput: string, runId?: string | null): string {
  const project = resolve(projectInput);
  const cleanRunId = sanitizeRunId(runId);
  return cleanRunId === defaultRunId ? join(project, ".supercodex", "runtime") : join(project, ".supercodex", "runtime", "runs", cleanRunId);
}

export function legacySupervisorDataRoot(projectInput: string, runId?: string | null): string {
  const project = resolve(projectInput);
  const cleanRunId = sanitizeRunId(runId);
  return cleanRunId === defaultRunId ? join(project, ".supercodex", "supervisor") : join(project, ".supercodex", "supervisor", "runs", cleanRunId);
}

export function supervisorDataRoot(projectInput: string, runId?: string | null): string {
  return supercodexDataRoot(projectInput, runId);
}

export function settingsPath(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "settings.json");
}

function legacySettingsPath(project: string, runId?: string | null): string {
  return join(legacySupervisorDataRoot(project, runId), "settings.json");
}

export async function readSupervisorSettings(project: string, runId?: string | null): Promise<SupervisorRuntimeSettings> {
  const primary = settingsPath(project, runId);
  const data = await readJson<SupervisorRuntimeSettings>(
    (await pathExists(primary)) ? primary : legacySettingsPath(project, runId),
    {},
  );
  return normalizeSettings(data);
}

export async function patchSupervisorSettings(
  project: string,
  patch: SupervisorSettingsPatch,
  runId?: string | null,
): Promise<SupervisorRuntimeSettings> {
  const current = await readSupervisorSettings(project, runId);
  const next = normalizeSettings({ ...current, ...patch, updatedAt: nowIso() });
  await writeJsonAtomic(settingsPath(project, runId), next);
  return next;
}

export async function copySupervisorSessionPreferences(
  project: string,
  fromRunId?: string | null,
  toRunId?: string | null,
): Promise<SupervisorRuntimeSettings> {
  const current = await readSupervisorSettings(project, fromRunId);
  return await patchSupervisorSettings(project, {
    model: current.model ?? null,
    reasoningEffort: current.reasoningEffort ?? null,
    sandbox: current.sandbox ?? null,
    approvalPolicy: current.approvalPolicy ?? null,
  }, toRunId);
}

export async function consumeForceFreshNext(project: string, runId?: string | null): Promise<boolean> {
  const current = await readSupervisorSettings(project, runId);
  if (!current.forceFreshNext) {
    return false;
  }
  await patchSupervisorSettings(project, { forceFreshNext: false }, runId);
  return true;
}

export async function consumePendingAuthName(project: string, runId?: string | null): Promise<string | null> {
  const current = await readSupervisorSettings(project, runId);
  const pending = typeof current.pendingAuthName === "string" && current.pendingAuthName.trim() ? current.pendingAuthName.trim() : null;
  if (pending) {
    await patchSupervisorSettings(project, { pendingAuthName: null }, runId);
  }
  return pending;
}

export function parseReasoningEffort(value: string): ReasoningEffort {
  const normalized = value.trim().toLowerCase();
  if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized;
  }
  throw new Error("reasoning must be one of: minimal, low, medium, high, xhigh");
}

export function parseSandboxMode(value: string): CodexSandboxMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "danger" || normalized === "danger-full" || normalized === "full-access" || normalized === "yolo") {
    return "danger-full-access";
  }
  if (normalized === "danger-full-access" || normalized === "read-only" || normalized === "workspace-write") {
    return normalized;
  }
  throw new Error("sandbox must be one of: read-only, workspace-write, danger-full-access");
}

export function parseApprovalPolicy(value: string): CodexApprovalPolicy {
  const normalized = value.trim().toLowerCase();
  if (normalized === "ask" || normalized === "ask-for-approval") {
    return "on-request";
  }
  if (normalized === "never" || normalized === "on-failure" || normalized === "on-request" || normalized === "untrusted") {
    return normalized;
  }
  throw new Error("approval must be one of: never, on-failure, on-request, untrusted");
}

export function parsePermissionSetting(value: string): CodexPermissionPatch {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("permissions must be one of: Default permissions, Auto-review, Full access, Codex CLI flags, or <sandbox> <approval>");
  }
  const patch: CodexPermissionPatch = {};
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const rawToken = tokens[index]!;
    const token = stripCommandToken(rawToken).toLowerCase();
    const [flag, inlineValue] = splitFlagValue(token);
    if (flag === "--sandbox" || flag === "-s") {
      patch.sandbox = parseSandboxMode(requiredFlagValue(flag, inlineValue ?? tokens[++index]));
      continue;
    }
    if (flag === "--ask-for-approval" || flag === "--approval" || flag === "-a") {
      patch.approvalPolicy = parseApprovalPolicy(requiredFlagValue(flag, inlineValue ?? tokens[++index]));
      continue;
    }
    if (flag === "--full-auto") {
      patch.sandbox = "workspace-write";
      patch.approvalPolicy = "on-request";
      continue;
    }
    if (flag === "--dangerously-bypass-approvals-and-sandbox") {
      patch.sandbox = "danger-full-access";
      patch.approvalPolicy = "never";
      continue;
    }
    if (flag === "--config" || flag === "-c") {
      applyCodexConfigPermission(requiredFlagValue(flag, inlineValue ?? tokens[++index]), patch);
      continue;
    }
    if (token.includes("=")) {
      applyCodexConfigPermission(token, patch);
      continue;
    }
    positional.push(token);
  }
  const positionalPatch = parsePositionalPermissionTokens(positional);
  const next = { ...positionalPatch, ...patch };
  if (!("sandbox" in next) && !("approvalPolicy" in next)) {
    throw new Error("permissions accepts Default permissions, Auto-review, Full access, Codex CLI permission flags, or '<sandbox> <approval>'");
  }
  return next;
}

function parsePositionalPermissionTokens(tokens: string[]): CodexPermissionPatch {
  if (tokens.length === 0) {
    return {};
  }
  const phrase = normalizePermissionPhrase(tokens);
  if (phrase === "default" || phrase === "defaults" || phrase === "default-permissions" || phrase === "normal" || phrase === "normal-permissions") {
    return { sandbox: null, approvalPolicy: null };
  }
  if (phrase === "auto" || phrase === "auto-review" || phrase === "autoreview" || phrase === "full-auto") {
    return { sandbox: "workspace-write", approvalPolicy: "on-request" };
  }
  if (phrase === "full" || phrase === "full-access" || phrase === "full-permissions" || phrase === "complete-access") {
    return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
  if (tokens.length === 1) {
    const token = tokens[0]!;
    if (token === "danger" || token === "danger-full-access" || token === "bypass" || token === "yolo" || token === "dangerously-bypass-approvals-and-sandbox") {
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    }
    if (token === "read-only" || token === "readonly" || token === "safe") {
      return { sandbox: "read-only", approvalPolicy: "on-request" };
    }
    if (token === "workspace-write" || token === "workspace") {
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    }
    if (token === "never" || token === "on-failure" || token === "on-request" || token === "untrusted") {
      return { approvalPolicy: parseApprovalPolicy(token) };
    }
    return { sandbox: parseSandboxMode(token) };
  }
  if (tokens.length === 2) {
    return {
      sandbox: parseSandboxMode(tokens[0]!),
      approvalPolicy: parseApprovalPolicy(tokens[1]!),
    };
  }
  throw new Error("permissions accepts Default permissions, Auto-review, Full access, Codex CLI permission flags, or '<sandbox> <approval>'");
}

function normalizePermissionPhrase(tokens: string[]): string {
  return tokens
    .map((token) => stripCommandToken(token).trim().toLowerCase())
    .filter(Boolean)
    .join("-")
    .replace(/_/g, "-");
}

function splitFlagValue(token: string): [string, string | null] {
  const equals = token.indexOf("=");
  if (equals < 0) {
    return [token, null];
  }
  return [token.slice(0, equals), token.slice(equals + 1)];
}

function requiredFlagValue(flag: string, value?: string): string {
  const cleaned = stripCommandToken(value ?? "");
  if (!cleaned) {
    throw new Error(`${flag} requires a value`);
  }
  return cleaned;
}

function applyCodexConfigPermission(rawToken: string, patch: CodexPermissionPatch): void {
  const token = stripCommandToken(rawToken);
  const equals = token.indexOf("=");
  if (equals < 0) {
    throw new Error("permissions -c only supports sandbox_mode=<mode> and approval_policy=<policy>");
  }
  const key = stripCommandToken(token.slice(0, equals)).toLowerCase();
  const value = stripCommandToken(token.slice(equals + 1));
  if (key === "sandbox" || key === "sandbox_mode") {
    patch.sandbox = parseSandboxMode(value);
    return;
  }
  if (key === "approval" || key === "approval_policy" || key === "ask_for_approval" || key === "ask-for-approval") {
    patch.approvalPolicy = parseApprovalPolicy(value);
    return;
  }
  throw new Error("permissions -c only supports sandbox_mode=<mode> and approval_policy=<policy>");
}

function stripCommandToken(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeSettings(input: SupervisorRuntimeSettings): SupervisorRuntimeSettings {
  const next: SupervisorRuntimeSettings = {};
  if (typeof input.model === "string") {
    next.model = input.model.trim() || null;
  } else if (input.model === null) {
    next.model = null;
  }
  if (typeof input.reasoningEffort === "string") {
    next.reasoningEffort = parseReasoningEffort(input.reasoningEffort);
  } else if (input.reasoningEffort === null) {
    next.reasoningEffort = null;
  }
  if (typeof input.sandbox === "string") {
    next.sandbox = parseSandboxMode(input.sandbox);
  } else if (input.sandbox === null) {
    next.sandbox = null;
  }
  if (typeof input.approvalPolicy === "string") {
    next.approvalPolicy = parseApprovalPolicy(input.approvalPolicy);
  } else if (input.approvalPolicy === null) {
    next.approvalPolicy = null;
  }
  if (typeof input.pendingAuthName === "string") {
    next.pendingAuthName = input.pendingAuthName.trim() || null;
  } else if (input.pendingAuthName === null) {
    next.pendingAuthName = null;
  }
  if (typeof input.forceFreshNext === "boolean") {
    next.forceFreshNext = input.forceFreshNext;
  }
  if (typeof input.paused === "boolean") {
    next.paused = input.paused;
  }
  if (typeof input.updatedAt === "string") {
    next.updatedAt = input.updatedAt;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in next)) {
      next[key] = value;
    }
  }
  return next;
}
