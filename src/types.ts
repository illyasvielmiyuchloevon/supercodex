import type { PathLike } from "node:fs";

export type JsonObject = Record<string, unknown>;

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexSandboxMode = "danger-full-access" | "read-only" | "workspace-write";

export type CodexApprovalPolicy = "never" | "on-failure" | "on-request" | "untrusted";

export type SupercodexRunMode = "auto" | "goal" | "task";

export interface PlanTask {
  id: string;
  title: string;
  status: string;
  stageId?: string | null;
  source: "plan";
}

export interface WorkItem {
  kind: "bootstrap" | "done" | "operator_intervention" | "stage_gate" | "supplement_docs" | "task";
  title: string;
  stageId?: string | null;
  taskId?: string | null;
  reason: string;
  source: string;
}

export interface ProjectSnapshot {
  project: string;
  state: JsonObject;
  autoDevState: JsonObject;
  docsPresent: Record<string, boolean>;
  missingDocs: string[];
  planTasks: PlanTask[];
  supervisorSession: JsonObject;
  done: boolean;
  phaseLocked: boolean;
}

export interface CodexRunResult {
  returnCode: number;
  classification: string;
  promptPath: string;
  eventLogPath: string;
  stderrPath: string;
  threadId?: string | null;
  turnId?: string | null;
  stdout?: string;
  stderr?: string;
  durationSeconds: number;
  command: string[];
  operatorMessage?: string | null;
  controlId?: string | null;
}

export function isRunOk(result: CodexRunResult): boolean {
  return result.returnCode === 0 && result.classification === "success";
}

export function isRecoverableClassification(classification: string): boolean {
  return new Set([
    "context_compaction_failed",
    "context_window_exceeded",
    "network_transient",
    "remote_compaction_failed",
    "session_not_found",
    "startup_no_output_timeout",
    "timeout",
    "idle_timeout",
  ]).has(classification);
}

export type FilePath = string | PathLike;
