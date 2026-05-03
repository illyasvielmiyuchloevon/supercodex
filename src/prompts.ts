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
  const taskMode = typeof snapshot.autoDevState.run_mode === "string" && snapshot.autoDevState.run_mode.toUpperCase() === "TASK";
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
This is a deliberately fresh Codex thread for plan-completion review, explicit operator request, or repeated failure recovery. Use only repository files, .supercodex/AUTO_DEV_STATE.json, lightweight .supercodex governance artifacts, checkpoints, and git history as truth.
`
    : "";
  const operatorBlock = directOperatorMessage
    ? `
## Runtime Operator Intervention
The user supplied this instruction through the SuperCodex control channel. Treat it as the highest-priority instruction for this turn while preserving existing durable state, checkpoints, and git state.

${directOperatorMessage}

Apply the intervention directly. In ordinary task mode, do not create or rewrite FINAL_GOAL and do not start final-goal acceptance. In explicit goal mode, FINAL_GOAL remains the root source of truth and PRD, architecture, PLAN, and TRACEABILITY_MATRIX must be updated only when they no longer cover FINAL_GOAL.
`
    : "";
  const executionGuidance =
    taskMode
      ? "Execute the ordinary task request end to end. Do lightweight requirement analysis, create or update .supercodex/PLAN.md as needed, implement, test, review, and mark AUTO_DEV_STATE decision TASK_DONE when the task plan is complete. Do not create .supercodex/FINAL_GOAL.md, do not run Phase 6, and do not run Phase 7 unless the user explicitly used /goal."
      : work.kind === "operator_intervention"
        ? "Handle the runtime operator message as the actual work item. If the project is already marked delivered and the message is a new change request, update FINAL_GOAL and reopen AUTO_DEV_STATE / PRD / ARCHITECTURE / PLAN / TRACEABILITY_MATRIX as required by AGENTS.md; do not run a synthetic final gate just because all existing PLAN tasks are checked."
        : "Execute this work item end to end if feasible in this turn. Keep changes scoped to the current phase, task, gate, or required acceptance-driven revision. Update PLAN, TRACEABILITY_MATRIX, AUTO_DEV_STATE, checkpoints, and progress after the task. If the work item is `supplement_docs`, create only missing lightweight AGENTS.md artifacts and preserve existing PRD/PLAN wording unless FINAL_GOAL coverage, traceability, tests, review, or final acceptance proves a gap.";
  const bootstrapBlock = taskMode
    ? `## Mandatory Bootstrap
1. Read AGENTS.md.
2. Read \`.supercodex/AUTO_DEV_STATE.json\`, \`.supercodex/TASK.md\`, \`.supercodex/PLAN.md\`, \`.supercodex/CODE_REVIEW_REPORT.md\`, checkpoints, and git status if present.
3. This is ordinary task mode. \`.supercodex/TASK.md\` is the task request. Do not treat it as FINAL_GOAL.
4. Resume from AUTO_DEV_STATE phase/current task/remaining tasks. If PLAN is exhausted, mark TASK_DONE and stop; do not enter Phase 6 or Phase 7.

## Existing Task Continuity
Preserve the ordinary task state by default. Repair PLAN/AUTO_DEV_STATE only when they no longer match TASK.md, tests, or the actual code state.
`
    : `## Mandatory Bootstrap
1. Read AGENTS.md.
2. Read \`.supercodex/AUTO_DEV_STATE.json\`, \`.supercodex/checkpoints.md\`, \`.supercodex/last-action.md\`, and \`.supercodex/last-error.md\` if present.
3. Read \`.supercodex/FINAL_GOAL.md\`, \`.supercodex/CLARIFICATIONS.md\`, \`.supercodex/ASSUMPTIONS.md\`, \`.supercodex/PRD.md\`, \`.supercodex/ARCHITECTURE.md\`, \`.supercodex/PLAN.md\`, \`.supercodex/TRACEABILITY_MATRIX.md\`, \`.supercodex/CODE_REVIEW_REPORT.md\`, and \`.supercodex/FINAL_ACCEPTANCE_REPORT.md\` if present.
4. Check git status before edits.
5. Resume from AUTO_DEV_STATE phase/current task/remaining tasks. Do not restart from scratch.
6. If PLAN is exhausted, do not deliver from the plan-cycle thread. Run or refresh FINAL_ACCEPTANCE_REPORT against FINAL_GOAL inside the full-project Phase 6 review.

## Existing Project Continuity and State Rule
If this project already has \`.supercodex\`, \`.supercodex/PRD.md\`, \`.supercodex/PLAN.md\`, or \`.supercodex/AUTO_DEV_STATE.json\`, preserve the existing durable state and continue from it by default. Supplement missing lightweight AGENTS.md artifacts first, continue the existing PLAN when it still covers FINAL_GOAL, and do not restart from scratch.

The continuity rule forbids ungrounded replacement, not required correction. Do not silently replace PRD, rewrite PLAN into an unrelated new strategy, or replan completed/in-progress work merely because a fresh session started. However, when AGENTS.md, FINAL_GOAL, TRACEABILITY_MATRIX, tests, review, FINAL_ACCEPTANCE_REPORT, or an explicit operator instruction proves a gap, update PRD / ARCHITECTURE / PLAN / TRACEABILITY_MATRIX / AUTO_DEV_STATE as needed, write a checkpoint, and continue execution.

FINAL_GOAL is more authoritative than PRD and PLAN. If PRD, architecture, PLAN, or TRACEABILITY_MATRIX conflicts with, omits, narrows, or weakens FINAL_GOAL, repair the lightweight governance artifacts instead of treating the old documents as immutable truth.
`;
  const completionContract = taskMode
    ? "When the ordinary task PLAN is checked off, update AUTO_DEV_STATE to decision TASK_DONE / phase TASK_DONE and stop. Do not create FINAL_ACCEPTANCE_REPORT as a completion gate, do not enter Phase 6, and do not enter Phase 7."
    : "After all planned work is checked off, run Final Acceptance before marking delivery done. If acceptance fails, update FINAL_ACCEPTANCE_REPORT, set AUTO_DEV_STATE decision to FAIL_CONTINUE_NEXT_CYCLE, revise PRD / ARCHITECTURE / PLAN / TRACEABILITY_MATRIX, and continue the loop. Passing tests, completed PLAN tasks, committed code, pushed branches, or AUTO_DEV_STATE PASS/FAIL/DELIVERED are not final completion or next-cycle authority by themselves.";

  return `# External Supervisor Prompt

You are being launched by supercodex, an external Codex app-server loop controller.

${bootstrapBlock}

## Sub-Agent Collaboration Policy
When the current Codex runtime provides sub-agent, delegation, worker, explorer, tester, or reviewer capabilities and policy permits using them, use them as needed for complex work. Prefer sub-agents for independent codebase exploration, disjoint implementation ownership, repeated failure root-cause analysis, parallel testing, code review, security review, or final-goal coverage review.

Do not spawn sub-agents for tiny tasks, overlapping write scopes, or the immediate blocking step on the critical path. Give each sub-agent a concrete role, scope, file/module ownership, expected output, and integration boundary. The main agent remains responsible for reviewing results, integrating changes, running verification, and updating AUTO_DEV_STATE, PLAN, TRACEABILITY_MATRIX, and reports.

## Session Policy
- SuperCodex controls Codex through app-server threads and turns, not through the legacy non-interactive runner.
- Keep the whole active PLAN in one Codex thread. Do not start a fresh thread merely because the stage or phase changed.
- Start a fresh normal-work thread only when the PLAN is exhausted and the next work is full-project Final Acceptance / PRD / Architecture / PLAN review for the next cycle.
- Phase 7 or final done requires the current Cycle Phase 6 review to succeed.
- Explicit operator \`/fresh-next\` requests and hard runtime recovery may still start a fresh thread.
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

${completionContract}

Inside PLAN, use Stage as the execution unit and Milestone as the intermediate commit/push boundary. Do not create or request a fresh Codex thread because a Stage changed, a Milestone commit happened, or an intermediate push happened; only explicit goal mode PLAN completion leads to the full-project Final Acceptance review thread.

Do not ask the user after Phase 0. If an external credential, network, or remote Git permission is unavailable, continue with local substitutes where possible.
${previousBlock}
`;
}
