import { randomUUID } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { nowIso, pathExists, readJson, writeJsonAtomic } from "./fs-utils.js";
import { supervisorDataRoot } from "./settings.js";
import type { JsonObject } from "./types.js";

export type InteractionStatus = "handled" | "pending" | "responded";

export interface InteractionChoice extends JsonObject {
  id: string;
  label: string;
  description?: string;
  response: JsonObject;
}

export interface InteractionRecord extends JsonObject {
  id: string;
  requestId: string | number;
  method: string;
  status: InteractionStatus;
  title: string;
  summary: string;
  choices: InteractionChoice[];
  params: JsonObject;
  runId?: string;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  createdAt: string;
  respondedAt: string | null;
  handledAt: string | null;
}

export interface InteractionResponse extends JsonObject {
  id: string;
  requestId: string | number;
  response: JsonObject;
  createdAt: string;
  choiceId?: string | null;
}

const interactionMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);

export function isInteractionRequest(message: JsonObject): boolean {
  return (typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string" && interactionMethods.has(message.method);
}

export function interactionsRoot(project: string, runId?: string | null): string {
  return join(supervisorDataRoot(project, runId), "interactions");
}

export function pendingInteractionsDir(project: string, runId?: string | null): string {
  return join(interactionsRoot(project, runId), "pending");
}

export function respondedInteractionsDir(project: string, runId?: string | null): string {
  return join(interactionsRoot(project, runId), "responded");
}

export function handledInteractionsDir(project: string, runId?: string | null): string {
  return join(interactionsRoot(project, runId), "handled");
}

export async function captureInteractionRequest(project: string, request: JsonObject, runId?: string | null): Promise<InteractionRecord> {
  if (!isInteractionRequest(request)) {
    throw new Error("Unsupported app-server interaction request.");
  }
  const params = isObject(request.params) ? request.params : {};
  const createdAt = nowIso();
  const record = buildInteractionRecord({
    id: randomUUID(),
    requestId: request.id as string | number,
    method: String(request.method),
    params,
    createdAt,
    runId: runId ?? undefined,
  });
  await writeJsonAtomic(interactionPath(project, record, runId), record);
  return record;
}

export async function readPendingInteractions(project: string, runId?: string | null): Promise<Array<InteractionRecord & { path: string }>> {
  const dir = pendingInteractionsDir(project, runId);
  const result: Array<InteractionRecord & { path: string }> = [];
  if (!(await pathExists(dir))) {
    return result;
  }
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  for (const entry of entries) {
    const path = join(dir, entry);
    const data = await readJson<InteractionRecord | null>(path, null);
    if (!data || data.status !== "pending" || !data.id || !data.method) {
      continue;
    }
    result.push({ ...data, path });
  }
  return result;
}

export async function chooseInteraction(
  project: string,
  interactionIdOrChoice: string,
  maybeChoiceId?: string | null,
  runId?: string | null,
): Promise<InteractionResponse> {
  const pending = await readPendingInteractions(project, runId);
  const interaction = pending.find((item) => item.id === interactionIdOrChoice) ?? pending[0];
  if (!interaction) {
    throw new Error("No pending Codex interaction request.");
  }
  const choiceId = interaction.id === interactionIdOrChoice ? maybeChoiceId : interactionIdOrChoice;
  const selected = findChoice(interaction, choiceId ?? "accept") ?? interaction.choices[0];
  if (!selected) {
    throw new Error(`No available choice for interaction ${interaction.id}.`);
  }
  return await writeInteractionResponse(project, interaction, selected.id, selected.response, runId);
}

export async function answerInteraction(project: string, answer: string, interactionId?: string | null, runId?: string | null): Promise<InteractionResponse> {
  const pending = await readPendingInteractions(project, runId);
  const interaction = (interactionId ? pending.find((item) => item.id === interactionId) : pending[0]) ?? null;
  if (!interaction) {
    throw new Error("No pending Codex interaction request.");
  }
  const response = buildFreeformResponse(interaction, answer);
  return await writeInteractionResponse(project, interaction, "answer", response, runId);
}

export async function readInteractionResponses(project: string, runId?: string | null): Promise<Array<InteractionResponse & { path: string }>> {
  const dir = respondedInteractionsDir(project, runId);
  const result: Array<InteractionResponse & { path: string }> = [];
  if (!(await pathExists(dir))) {
    return result;
  }
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  for (const entry of entries) {
    const path = join(dir, entry);
    const data = await readJson<InteractionResponse | null>(path, null);
    if (!data || !data.id || data.requestId === undefined || !isObject(data.response)) {
      continue;
    }
    result.push({ ...data, path });
  }
  return result;
}

export async function markInteractionHandled(project: string, response: InteractionResponse & { path?: string }, runId?: string | null): Promise<void> {
  const responsePath = response.path ?? join(respondedInteractionsDir(project, runId), `${response.id}.json`);
  const pending = await findInteractionRecord(project, response.id, runId);
  if (pending) {
    const handled: InteractionRecord = {
      ...pending,
      status: "handled",
      handledAt: nowIso(),
    };
    delete (handled as InteractionRecord & { path?: string }).path;
    await writeJsonAtomic(join(handledInteractionsDir(project, runId), `${handled.createdAt.replace(/[:.]/g, "-")}-${handled.id}.json`), handled);
    await rename(pending.path, `${pending.path}.handled.tmp`).catch(() => undefined);
    await rm(`${pending.path}.handled.tmp`, { force: true }).catch(() => undefined);
  }
  await rm(responsePath, { force: true }).catch(() => undefined);
}

export function summarizeInteraction(record: InteractionRecord): string {
  return `${record.title}: ${record.summary}`;
}

function buildInteractionRecord(input: {
  id: string;
  requestId: string | number;
  method: string;
  params: JsonObject;
  createdAt: string;
  runId?: string;
}): InteractionRecord {
  const base = {
    id: input.id,
    requestId: input.requestId,
    method: input.method,
    status: "pending" as const,
    params: input.params,
    runId: input.runId,
    threadId: stringOrNull(input.params.threadId),
    turnId: stringOrNull(input.params.turnId),
    itemId: stringOrNull(input.params.itemId),
    createdAt: input.createdAt,
    respondedAt: null,
    handledAt: null,
  };
  switch (input.method) {
    case "item/commandExecution/requestApproval":
      return {
        ...base,
        title: "Command Approval",
        summary: commandSummary(input.params),
        choices: commandApprovalChoices(input.params),
      };
    case "item/fileChange/requestApproval":
      return {
        ...base,
        title: "File Change Approval",
        summary: String(input.params.reason ?? input.params.grantRoot ?? "Codex requests file write approval."),
        choices: ["accept", "acceptForSession", "decline", "cancel"].map((decision) => ({
          id: normalizeChoiceId(decision),
          label: decision,
          response: { decision },
        })),
      };
    case "item/permissions/requestApproval":
      return {
        ...base,
        title: "Permission Request",
        summary: String(input.params.reason ?? `Codex requests additional permissions in ${String(input.params.cwd ?? "current workspace")}.`),
        choices: permissionChoices(input.params),
      };
    case "item/tool/requestUserInput":
      return {
        ...base,
        title: "User Input Request",
        summary: toolInputSummary(input.params),
        choices: toolInputChoices(input.params),
      };
    case "mcpServer/elicitation/request":
      return {
        ...base,
        title: "MCP Elicitation",
        summary: String(input.params.message ?? `${String(input.params.serverName ?? "MCP server")} requests input.`),
        choices: [
          { id: "accept", label: "accept", description: "Accept with empty content or use /answer for form content.", response: { action: "accept", content: null, _meta: null } },
          { id: "decline", label: "decline", response: { action: "decline", content: null, _meta: null } },
          { id: "cancel", label: "cancel", response: { action: "cancel", content: null, _meta: null } },
        ],
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        ...base,
        title: input.method === "applyPatchApproval" ? "Apply Patch Approval" : "Exec Command Approval",
        summary: String(input.params.command ?? input.params.reason ?? "Codex requests legacy approval."),
        choices: [
          { id: "accept", label: "approved", response: { decision: "approved" } },
          { id: "accept-session", label: "approved_for_session", response: { decision: "approved_for_session" } },
          { id: "decline", label: "denied", response: { decision: "denied" } },
          { id: "cancel", label: "abort", response: { decision: "abort" } },
        ],
      };
    default:
      return {
        ...base,
        title: "Codex Interaction",
        summary: input.method,
        choices: [{ id: "cancel", label: "cancel", response: { action: "cancel" } }],
      };
  }
}

function commandApprovalChoices(params: JsonObject): InteractionChoice[] {
  const available = Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0
    ? params.availableDecisions
    : ["accept", "acceptForSession", "decline", "cancel"];
  return available.map((decision) => {
    const id = normalizeChoiceId(typeof decision === "string" ? decision : Object.keys(decision as JsonObject)[0] ?? "decision");
    return {
      id,
      label: typeof decision === "string" ? decision : id,
      response: { decision },
    };
  });
}

function permissionChoices(params: JsonObject): InteractionChoice[] {
  const requested = isObject(params.permissions) ? params.permissions : {};
  const granted = {
    network: requested.network ?? undefined,
    fileSystem: requested.fileSystem ?? undefined,
  };
  return [
    {
      id: "accept",
      label: "accept for this turn",
      response: { permissions: granted, scope: "turn" },
    },
    {
      id: "accept-session",
      label: "accept for session",
      response: { permissions: granted, scope: "session" },
    },
    {
      id: "decline",
      label: "decline",
      response: { permissions: {}, scope: "turn", strictAutoReview: true },
    },
  ];
}

function toolInputChoices(params: JsonObject): InteractionChoice[] {
  const questions = Array.isArray(params.questions) ? params.questions.filter(isObject) : [];
  if (questions.length !== 1) {
    return [{ id: "answer", label: "answer with /answer <text>", response: { answers: {} } }];
  }
  const question = questions[0]!;
  const questionId = typeof question.id === "string" ? question.id : "answer";
  const options = Array.isArray(question.options) ? question.options.filter(isObject) : [];
  if (options.length === 0) {
    return [{ id: "answer", label: "answer with /answer <text>", response: { answers: {} } }];
  }
  return options.map((option, index) => {
    const label = typeof option.label === "string" ? option.label : `option-${index + 1}`;
    return {
      id: slug(label) || `option-${index + 1}`,
      label,
      description: typeof option.description === "string" ? option.description : undefined,
      response: { answers: { [questionId]: { answers: [label] } } },
    };
  });
}

function buildFreeformResponse(interaction: InteractionRecord, answer: string): JsonObject {
  if (interaction.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(interaction.params.questions) ? interaction.params.questions.filter(isObject) : [];
    const question = questions[0];
    const questionId = typeof question?.id === "string" ? question.id : "answer";
    return { answers: { [questionId]: { answers: [answer] } } };
  }
  if (interaction.method === "mcpServer/elicitation/request") {
    const parsed = parseJsonObject(answer);
    return { action: "accept", content: parsed ?? { value: answer }, _meta: null };
  }
  return { value: answer };
}

async function writeInteractionResponse(
  project: string,
  interaction: InteractionRecord & { path?: string },
  choiceId: string,
  response: JsonObject,
  runId?: string | null,
): Promise<InteractionResponse> {
  const payload: InteractionResponse = {
    id: interaction.id,
    requestId: interaction.requestId,
    choiceId,
    response,
    createdAt: nowIso(),
  };
  await writeJsonAtomic(join(respondedInteractionsDir(project, runId), `${interaction.createdAt.replace(/[:.]/g, "-")}-${interaction.id}.json`), payload);
  if (interaction.path) {
    const responded = { ...interaction, status: "responded", respondedAt: payload.createdAt } as InteractionRecord;
    delete (responded as InteractionRecord & { path?: string }).path;
    await writeJsonAtomic(interaction.path, responded);
  }
  return payload;
}

function interactionPath(project: string, interaction: InteractionRecord, runId?: string | null): string {
  return join(pendingInteractionsDir(project, runId), `${interaction.createdAt.replace(/[:.]/g, "-")}-${interaction.id}.json`);
}

function findChoice(interaction: InteractionRecord, choiceId: string): InteractionChoice | null {
  const normalized = normalizeChoiceId(choiceId);
  return interaction.choices.find((choice) => choice.id === normalized || normalizeChoiceId(choice.label) === normalized) ?? null;
}

async function findInteractionRecord(project: string, id: string, runId?: string | null): Promise<(InteractionRecord & { path: string }) | null> {
  const dir = pendingInteractionsDir(project, runId);
  if (!(await pathExists(dir))) {
    return null;
  }
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  for (const entry of entries) {
    const path = join(dir, entry);
    const data = await readJson<InteractionRecord | null>(path, null);
    if (data?.id === id) {
      return { ...data, path };
    }
  }
  return null;
}

function commandSummary(params: JsonObject): string {
  const command = typeof params.command === "string" && params.command.trim() ? params.command.trim() : null;
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null;
  const cwd = typeof params.cwd === "string" ? ` cwd=${params.cwd}` : "";
  return `${command ?? reason ?? "Codex requests command execution approval."}${cwd}`;
}

function toolInputSummary(params: JsonObject): string {
  const questions = Array.isArray(params.questions) ? params.questions.filter(isObject) : [];
  if (questions.length === 0) {
    return "Codex requests user input.";
  }
  return questions.map((question) => String(question.question ?? question.header ?? question.id ?? "question")).join(" | ");
}

function normalizeChoiceId(value: string): string {
  if (value === "acceptForSession" || value === "approved_for_session") {
    return "accept-session";
  }
  return slug(value);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
