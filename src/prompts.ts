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
  const goalMode =
    snapshot.autoDevState.goal_mode === true ||
    (typeof snapshot.autoDevState.entry_mode === "string" && snapshot.autoDevState.entry_mode.toUpperCase() === "GOAL");
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
This is a deliberately fresh Codex thread for plan-completion review, explicit operator request, or repeated failure recovery. Use only repository files, .supercodex/AUTO_DEV_STATE.json, FINAL_GOAL/PRD/ARCHITECTURE/PLAN, SuperCodex machine state, and git history as truth.
`
    : "";
  const operatorBlock = directOperatorMessage
    ? `
## Runtime Operator Intervention
The user supplied this instruction through the SuperCodex control channel. Treat it as the highest-priority instruction for this turn while preserving existing durable state, runtime state, and git state.

${directOperatorMessage}

Apply the intervention directly. Unless this run was explicitly started as a final-goal reset, do not create or rewrite FINAL_GOAL and do not start the final-goal acceptance loop just because an operator message exists. If FINAL_GOAL already exists and the instruction modifies that ongoing goal, update only the required docs and state parameters.
`
    : "";
  const executionGuidance =
    work.kind === "operator_intervention"
      ? goalMode
        ? "Handle the runtime operator message as the actual work item inside the active goal-mode delivery loop. Preserve FINAL_GOAL as the root source of truth and update PRD / ARCHITECTURE / PLAN / AUTO_DEV_STATE only when the operator instruction changes or repairs that goal loop."
        : "Handle the runtime operator message as the actual work item. Do concise requirement analysis, inspect the repository, implement, test, and report the result. Do not create .supercodex/FINAL_GOAL.md or run Phase 6/Phase 7 unless a final-goal state already exists and the instruction is clearly part of that ongoing delivery loop."
      : goalMode
        ? "Execute this work item end to end if feasible in this turn. Keep changes scoped to the current phase, task, gate, or required acceptance-driven revision. Update only FINAL_GOAL, PRD, ARCHITECTURE, PLAN, and AUTO_DEV_STATE when the work requires state or planning updates. AUTO_DEV_STATE must contain only machine-readable SuperCodex state parameters. If the work item is `supplement_docs`, create only missing required docs and preserve existing PRD/PLAN wording unless FINAL_GOAL coverage, tests, review, or final acceptance proves a gap."
        : "Execute this non-goal work item end to end if feasible in this turn. Do concise requirement analysis, inspect the repository, implement, test, and report the result. Do not create .supercodex/FINAL_GOAL.md and do not run Phase 6/Phase 7 for non-goal work.";
  const bootstrapBlock = `## Mandatory Bootstrap
1. Read AGENTS.md.
2. Read \`.supercodex/AUTO_DEV_STATE.json\` if present.
3. Read \`.supercodex/FINAL_GOAL.md\`, \`.supercodex/PRD.md\`, \`.supercodex/ARCHITECTURE.md\`, and \`.supercodex/PLAN.md\` if present.
4. Check git status before edits.
5. Resume from AUTO_DEV_STATE phase/current task/remaining tasks. Do not restart from scratch.
6. If PLAN is exhausted, do not deliver from the plan-cycle thread. Run the full-project Phase 6 review against FINAL_GOAL and record the result in AUTO_DEV_STATE.acceptance.

## Existing Project Continuity and State Rule
If this project already has \`.supercodex\`, \`.supercodex/PRD.md\`, \`.supercodex/PLAN.md\`, or \`.supercodex/AUTO_DEV_STATE.json\`, preserve the existing durable state and continue from it by default. Supplement only missing required docs first, continue the existing PLAN when it still covers FINAL_GOAL, and do not restart from scratch.

The continuity rule forbids ungrounded replacement, not required correction. Do not silently replace PRD, rewrite PLAN into an unrelated new strategy, or replan completed/in-progress work merely because a fresh session started. However, when AGENTS.md, FINAL_GOAL, tests, review, AUTO_DEV_STATE.acceptance, or an explicit operator instruction proves a gap, update only the required docs and state parameters, then continue execution.

FINAL_GOAL is more authoritative than PRD and PLAN. If PRD, architecture, PLAN, or AUTO_DEV_STATE status parameters conflict with, omit, narrow, or weaken FINAL_GOAL, repair the required docs or state parameters instead of treating the old documents as immutable truth.
`;
  const completionContract =
    goalMode
      ? work.kind === "operator_intervention"
        ? "Because this run is in goal mode, keep the final-goal delivery loop intact: after planned goal work is checked off, run Final Acceptance before marking delivery done."
        : "After all planned work is checked off, run Final Acceptance before marking delivery done. If acceptance fails, set AUTO_DEV_STATE decision to FAIL_CONTINUE_NEXT_CYCLE, revise FINAL_GOAL / PRD / ARCHITECTURE / PLAN as needed, and continue the loop. Passing tests, completed PLAN tasks, committed code, pushed branches, or AUTO_DEV_STATE PASS/FAIL/DELIVERED are not final completion or next-cycle authority by themselves."
      : "For non-goal work, finish the requested work, test what changed, and stop with a clear result. Do not synthesize Phase 6, Phase 7, or FINAL_GOAL for that instruction.";

  return `# External Supervisor Prompt

You are being launched by supercodex, an external Codex app-server loop controller.

${bootstrapBlock}

## Sub-Agent Collaboration Policy
When the current Codex runtime provides sub-agent, delegation, worker, explorer, tester, or reviewer capabilities and policy permits using them, use them as needed for complex work. Prefer sub-agents for independent codebase exploration, disjoint implementation ownership, repeated failure root-cause analysis, parallel testing, code review, security review, or final-goal coverage review.

Do not spawn sub-agents for tiny tasks, overlapping write scopes, or the immediate blocking step on the critical path. Give each sub-agent a concrete role, scope, file/module ownership, expected output, and integration boundary. The main agent remains responsible for reviewing results, integrating changes, running verification, and updating only the required docs when needed.

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
- goal_mode: ${goalMode ? "active" : "inactive"}
${operatorBlock}

## Execution Contract
${executionGuidance}

${completionContract}

Inside PLAN, use Stage as the execution unit and Milestone as the intermediate commit/push boundary. Do not create or request a fresh Codex thread because a Stage changed, a Milestone commit happened, or an intermediate push happened; PLAN completion in a final-goal run leads to the full-project Final Acceptance review thread.

Do not ask the user after Phase 0. If an external credential, network, or remote Git permission is unavailable, continue with local substitutes where possible.
${previousBlock}
`;
}
