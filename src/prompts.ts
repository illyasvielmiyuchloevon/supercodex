import type { CodexRunResult, ProjectSnapshot, WorkItem } from "./types.js";

export function buildPrompt(input: {
  snapshot: ProjectSnapshot;
  work: WorkItem;
  previousResult?: CodexRunResult | null;
  forceFreshSession?: boolean;
  operatorMessage?: string | null;
}): string {
  const { snapshot, work } = input;
  const directOperatorMessage = input.operatorMessage?.trim() ?? "";
  const state = snapshot.state;
  const previousBlock = input.previousResult
    ? `
## Previous Run Failure
- classification: ${input.previousResult.classification}
- returncode: ${input.previousResult.returnCode}
- event log: ${input.previousResult.eventLogPath}
- stderr log: ${input.previousResult.stderrPath}
Recover by reading the persistent project state first. Do not ask the user.
`
    : "";
  const freshBlock = input.forceFreshSession
    ? `
This is a deliberately fresh Codex thread for a new Stage or repeated failure recovery. Use only repository files, .supercodex state, .supercodex/docs, checkpoints, and git history as truth.
`
    : "";
  const operatorBlock = directOperatorMessage
    ? `
## Runtime Operator Intervention
The user supplied this instruction through the SuperCodex control channel. Treat it as the highest-priority instruction for this turn while still preserving the existing PRD, PLAN, backlog, checkpoints, and git state as source of truth.

${directOperatorMessage}

Apply the intervention directly. Do not update .supercodex/docs/PLAN.md or .supercodex/backlog.json unless this instruction explicitly changes the future task plan or acceptance path.
`
    : "";
  const executionGuidance =
    work.kind === "operator_intervention"
      ? "Handle the runtime operator message as the actual work item. If the project is already marked done and the message is a new change request, reopen durable state only as part of a real PRD/PLAN/backlog update for that change; do not run a synthetic final Stage Gate just because all existing PLAN tasks are checked."
      : "Execute this work item end to end if feasible in this turn. Keep changes scoped to the current task or stage gate. Update PLAN/backlog/state/checkpoints/progress after the task. If the work item is `supplement_docs`, create only missing artifacts and preserve existing PRD/PLAN wording.";

  return `# External Supervisor Prompt

You are being launched by supercodex, an external Codex app-server loop controller.

## Mandatory Bootstrap
1. Read AGENTS.md.
2. Read \`.supercodex/state.json\`, \`.supercodex/backlog.json\` if present, \`.supercodex/checkpoints.md\`, \`.supercodex/last-action.md\`, \`.supercodex/last-error.md\`.
3. Read \`.supercodex/docs/PRD.md\`, \`.supercodex/docs/ARCHITECTURE.md\`, \`.supercodex/docs/PLAN.md\`, and \`.supercodex/docs/ACCEPTANCE_MATRIX.md\`.
4. Check git status before edits.
5. Resume from the next unfinished checkpoint/task. Do not restart from scratch.

## Existing Project Rule
If this project already has \`.supercodex\`, \`.supercodex/docs/PRD.md\`, or \`.supercodex/docs/PLAN.md\` and PLAN is not fully complete, you must only supplement missing documents/state and then continue the existing PLAN. Do not replace PRD, do not rewrite PLAN into a new strategy, and do not replan completed or in-progress work.

## Session Policy
- SuperCodex controls Codex through app-server threads and turns, not through the legacy non-interactive runner.
- Same Stage failures may resume this thread.
- After a Stage gate has committed and pushed, SuperCodex starts the next Stage in a fresh thread to avoid context corrosion.
- Context compaction failure and network interruption are not user blockers. Recover from persistent state and continue.
${freshBlock}
## Current Work Item
- kind: ${work.kind}
- stage: ${work.stageId ?? state.currentStageId ?? "none"}
- task: ${work.taskId ?? state.currentTaskId ?? "none"}
- title: ${work.title}
- reason: ${work.reason}
- source: ${work.source}
${operatorBlock}

## Execution Contract
${executionGuidance}

Do not ask the user during execution. If an external credential, network, or remote Git permission is unavailable, record it in \`.supercodex/docs/BLOCKERS.md\` and continue with local substitutes or PR docs where possible.
${previousBlock}
`;
}
