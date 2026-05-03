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
  const goalMode = snapshot.autoDevState.goal_mode === true;
  const state = snapshot.state;
  const previousBlock = input.previousResult
    ? `
## Previous Run Failure
- classification: ${input.previousResult.classification}
- returncode: ${input.previousResult.returnCode}
- event log: ${input.previousResult.eventLogPath}
- stderr log: ${input.previousResult.stderrPath}
Recover by reading the persistent project state first, then continue autonomously.
`
    : "";
  const freshBlock = input.forceFreshSession
    ? `
This is a deliberately fresh Codex thread for plan-completion review, explicit operator request, or repeated failure recovery. Use repository files, .supercodex/AUTO_DEV_STATE.json, FINAL_GOAL/PRD/ARCHITECTURE/PLAN, SuperCodex machine state, and git history as truth.
`
    : "";
  const operatorBlock = directOperatorMessage
    ? `
## Runtime Operator Intervention
The user supplied this instruction through the SuperCodex control channel. Treat it as the highest-priority instruction for this turn while preserving existing durable state, runtime state, and git state.

${directOperatorMessage}

Apply the intervention directly. Ordinary operator messages stay inside the active run shape. If FINAL_GOAL already exists and the instruction modifies that ongoing goal, update the required docs and state parameters.
`
    : "";
  const executionGuidance =
    work.kind === "operator_intervention"
      ? goalMode
        ? "Handle the runtime operator message as the actual work item inside the active goal-mode delivery loop. Preserve FINAL_GOAL as the root source of truth, update PRD / ARCHITECTURE / PLAN when the operator instruction changes or repairs that goal loop, and sync AUTO_DEV_STATE when phase or decision changes."
        : "Handle the runtime operator message as the actual work item. Do concise requirement analysis, inspect the repository, implement, test, and report the result. Existing final-goal state keeps its Phase 3 acceptance/delivery loop; ordinary requests remain ordinary work."
      : goalMode
        ? "Execute this work item end to end if feasible in this turn. Keep changes scoped to the current phase, gate, or required acceptance-driven revision. Update FINAL_GOAL, PRD, ARCHITECTURE, and PLAN when the work requires semantic or planning updates. Sync AUTO_DEV_STATE when phase or decision changes. If the work item is `supplement_docs`, create missing required docs and preserve existing PRD/PLAN wording while FINAL_GOAL coverage, tests, review, and final acceptance guide corrections."
        : "Execute this non-goal work item end to end if feasible in this turn. Do concise requirement analysis, inspect the repository, implement, test, and report the result.";
  const bootstrapBlock = `## Mandatory Bootstrap
1. Read AGENTS.md.
2. Read \`.supercodex/AUTO_DEV_STATE.json\` if present.
3. Read \`.supercodex/FINAL_GOAL.md\`, \`.supercodex/PRD.md\`, \`.supercodex/ARCHITECTURE.md\`, and \`.supercodex/PLAN.md\` if present.
4. Check git status before edits.
5. Resume from AUTO_DEV_STATE phase and decision, then read PLAN.md yourself to continue the plan.
6. PLAN exhaustion leads to full-project Phase 3 review against FINAL_GOAL and delivery readiness; record the result in AUTO_DEV_STATE.acceptance.decision.

## Existing Project Continuity and State Rule
If this project already has \`.supercodex\`, \`.supercodex/PRD.md\`, \`.supercodex/PLAN.md\`, or \`.supercodex/AUTO_DEV_STATE.json\`, preserve the existing durable state and continue from it by default. Supplement missing required docs first and continue the existing PLAN when it still covers FINAL_GOAL.

Continuity means grounding changes in repository evidence. When AGENTS.md, FINAL_GOAL, tests, review, AUTO_DEV_STATE.acceptance, or an explicit operator instruction proves a gap, update the required docs and Phase state parameters, then continue execution.

FINAL_GOAL is more authoritative than PRD and PLAN. If PRD, architecture, PLAN, or AUTO_DEV_STATE status parameters conflict with, omit, narrow, or weaken FINAL_GOAL, repair the required docs or state parameters and continue from the corrected durable state.
`;
  const completionContract =
    goalMode
      ? work.kind === "operator_intervention"
        ? "Because this run is in goal mode, keep the final-goal delivery loop intact: after planned goal work is checked off, run Final Acceptance before marking delivery done."
        : "After all planned work is checked off, run Final Acceptance before marking delivery done. If acceptance fails, set AUTO_DEV_STATE decision to FAIL_CONTINUE_NEXT_CYCLE, revise FINAL_GOAL / PRD / ARCHITECTURE / PLAN as needed, and continue the loop. Phase 3 is the authority for final completion, delivery, and next-cycle decisions."
      : "For non-goal work, finish the requested work, test what changed, and stop with a clear result.";

  return `# External Supervisor Prompt

You are being launched by supercodex, an external Codex app-server loop controller.

${bootstrapBlock}

## Sub-Agent Collaboration Policy
When the current Codex runtime provides sub-agent, delegation, worker, explorer, tester, or reviewer capabilities and policy permits using them, use them as needed for complex work. Prefer sub-agents for independent codebase exploration, disjoint implementation ownership, repeated failure root-cause analysis, parallel testing, code review, security review, or final-goal coverage review.

Give each sub-agent a concrete role, scope, file/module ownership, expected output, and integration boundary. The main agent remains responsible for reviewing results, integrating changes, running verification, and updating required docs when needed.

## Session Policy
- SuperCodex controls Codex through app-server threads and turns, not through the legacy non-interactive runner.
- Keep the whole active PLAN in one Codex thread.
- Start a fresh normal-work thread at PLAN exhaustion when the next work is full-project Phase 3 Final Acceptance / PRD / Architecture / PLAN review for the next cycle.
- Final done requires the current Cycle Phase 3 review and delivery closure to succeed.
- Explicit operator \`/fresh-next\` requests and hard runtime recovery may still start a fresh thread.
- Context compaction failure and network interruption are not user blockers. Recover from persistent state and continue.
${freshBlock}
## Current Work Item
- kind: ${work.kind}
- title: ${work.title}
- reason: ${work.reason}
- source: ${work.source}
- goal_mode: ${goalMode ? "active" : "inactive"}
${operatorBlock}

## Execution Contract
${executionGuidance}

${completionContract}

Inside PLAN, Stage, Task, and Milestone are planning structure for Codex to read and follow. PLAN completion in a final-goal run leads to the full-project Final Acceptance review thread.

After the Phase 1 clarification step closes, continue autonomously. If an external credential, network, or remote Git permission is unavailable, continue with local substitutes where possible.
${previousBlock}
`;
}
