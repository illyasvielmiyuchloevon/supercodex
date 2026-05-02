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
The user supplied this instruction through the SuperCodex control channel. Treat it as the highest-priority instruction for this turn while preserving the Final Goal Ledger, active PRD/PLAN, backlog, checkpoints, and git state as durable context. The Final Goal Ledger is the root source of truth; PRD and PLAN are active interpretations that must be revised only through the versioned history rules when they no longer cover that ledger.

${directOperatorMessage}

Apply the intervention directly. Do not update .supercodex/docs/PLAN.md or .supercodex/backlog.json unless this instruction explicitly changes the future task plan or acceptance path, or unless a required coverage gate / Final Objective Audit proves that the current PRD, Acceptance Matrix, PLAN, or backlog is incomplete.
`
    : "";
  const executionGuidance =
    work.kind === "operator_intervention"
      ? "Handle the runtime operator message as the actual work item. If the project is already marked done and the message is a new change request, append the change to the Final Goal Ledger and reopen durable PRD/Acceptance Matrix/PLAN/backlog state through versioned revisions; do not run a synthetic final Stage Gate just because all existing PLAN tasks are checked."
      : "Execute this work item end to end if feasible in this turn. Keep changes scoped to the current task, stage gate, or required audit-driven revision. Update PLAN/backlog/state/checkpoints/progress after the task. If the work item is `supplement_docs`, create only missing artifacts and preserve existing PRD/PLAN wording unless AGENTS.md requires a versioned revision because the Final Goal Ledger, PRD coverage gate, Acceptance Matrix, Gap Review, or Final Objective Audit proves a gap.";

  return `# External Supervisor Prompt

You are being launched by supercodex, an external Codex app-server loop controller.

## Mandatory Bootstrap
1. Read AGENTS.md.
2. Read \`.supercodex/state.json\`, \`.supercodex/backlog.json\` if present, \`.supercodex/checkpoints.md\`, \`.supercodex/last-action.md\`, \`.supercodex/last-error.md\`.
3. Read \`.supercodex/docs/FINAL_GOAL_LEDGER.md\`, \`.supercodex/docs/REQUIREMENTS.md\`, \`.supercodex/docs/PRD.md\`, \`.supercodex/docs/ARCHITECTURE.md\`, \`.supercodex/docs/PLAN.md\`, \`.supercodex/docs/ACCEPTANCE_MATRIX.md\`, \`.supercodex/docs/GAP_REPORT.md\`, \`.supercodex/docs/FINAL_OBJECTIVE_AUDIT.md\`, \`.supercodex/docs/QA_REPORT.md\`, \`.supercodex/docs/REVIEW_REPORT.md\`, and \`.supercodex/docs/DELIVERY_REPORT.md\` if present.
4. Check git status before edits.
5. Resume from the next unfinished checkpoint/task. Do not restart from scratch.
6. If PLAN is exhausted, do not deliver. Run or refresh Final Objective Audit against the Final Goal Ledger first.

## Existing Project Continuity and Revision Rule
If this project already has \`.supercodex\`, \`.supercodex/docs/PRD.md\`, or \`.supercodex/docs/PLAN.md\`, preserve the existing durable state and continue from it by default. Supplement missing documents/state first, continue the existing PLAN when it still covers the Final Goal Ledger, and do not restart from scratch.

The continuity rule forbids ungrounded replacement, not required correction. Do not silently replace PRD, rewrite PLAN into an unrelated new strategy, or replan completed/in-progress work merely because a fresh session started. However, when AGENTS.md, the Final Goal Ledger, PRD Adversarial Coverage Gate, Acceptance Matrix, Gap Review, Final Objective Audit, or an explicit operator instruction proves a gap, you must follow the versioned revision loop: archive the old active artifact under \`.supercodex/docs/history/\`, increment the relevant iteration fields, revise PRD / rebuild Acceptance Matrix / update Architecture / rewrite or extend PLAN and backlog as needed, write a checkpoint, and continue execution.

The Final Goal Ledger is more authoritative than PRD and PLAN. If PRD or PLAN conflicts with, omits, narrows, or weakens the ledger, repair PRD/PLAN through the versioned process instead of treating the old documents as immutable truth.

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

After all planned work is checked off, run Final Objective Audit before marking delivery done. If the audit fails, classify the gap (PRD_GAP, ACCEPTANCE_GAP, ARCHITECTURE_GAP, PLAN_GAP, IMPLEMENTATION_GAP, TEST_GAP, DELIVERY_GAP, or BLOCKER), update the durable documents/backlog/state according to AGENTS.md, and continue the loop. Passing tests, completed PLAN tasks, committed code, pushed branches, or PR docs are not final completion by themselves.

Do not ask the user during execution. If an external credential, network, or remote Git permission is unavailable, record it in \`.supercodex/docs/BLOCKERS.md\` and continue with local substitutes or PR docs where possible.
${previousBlock}
`;
}
