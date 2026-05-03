# SuperCodex

SuperCodex is a TypeScript/Node.js supervisor for Codex CLI. It runs Codex through the official `codex app-server --listen stdio://` JSON-RPC interface, keeps project state under `.supercodex/`, and provides an OpenTUI/Solid terminal UI for long-running, resumable software delivery work.

Current version: `0.13.2` (0.13 patch release).

The current 0.13 version is app-server only. The old one-shot runner and hand-drawn raw TUI are no longer the formal path.

## What It Does

- Starts and controls `codex app-server` with `initialize`, `thread/start` or `thread/resume`, then `turn/start`.
- Persists project state, run state, session data, runtime data, logs, interactions, and checkpoints under `.supercodex/`.
- Uses an OpenTUI/Solid full-screen TUI with a transcript, status/sidebar metadata, slash commands, picker overlays, toasts, and a textarea composer.
- Reconstructs the visible transcript from SuperCodex app-server logs and matching native Codex session JSONL files.
- Keeps the main transcript compact: command output, file reads, and large tool output are summarized in the UI while raw logs stay on disk.
- Handles Codex app-server approval, permission, user-input, and MCP elicitation requests inside the TUI.
- Supports run-scoped settings for model, reasoning effort, permissions, auth, pause/resume, and fresh-thread requests.
- Defaults Codex permissions to `danger-full-access` with `approvalPolicy=never`.

## Requirements

- Node.js 20 or newer.
- Bun, used to launch the OpenTUI/Solid frontend.
- Codex CLI with `app-server` support installed and available as `codex`.
- Git in the target project.

Check the environment:

```powershell
node --version
bun --version
codex app-server --help
git --version
```

## Install

From npm:

```powershell
npm install -g @eirui/supercodex
```

For local development from this repository:

```powershell
cd C:\supercodex
npm install
npm run build
npm link
```

Verify the installed command:

```powershell
supercodex doctor --project C:\supercodex
supercodex status --project C:\supercodex
```

## Uninstall

If you installed this repository with `npm link`, remove the global command:

```powershell
npm unlink -g @eirui/supercodex
```

If you installed the public npm package, remove it with:

```powershell
npm uninstall -g @eirui/supercodex
```

Optional local cleanup inside the SuperCodex repository:

```powershell
cd C:\supercodex
Remove-Item -Recurse -Force .\dist, .\node_modules
```

To remove SuperCodex state from a target project, delete that project's `.supercodex/` directory only after you no longer need its resume state, logs, reports, or checkpoints:

```powershell
Remove-Item -Recurse -Force .\.supercodex
```

## Start the TUI

In the project you want SuperCodex to work on:

```powershell
cd C:\path\to\project
supercodex
```

`supercodex` without a subcommand starts managed TUI mode. Managed TUI mode is the normal interactive mode: type a request, use slash commands, inspect transcript/history, respond to Codex interactions, and resume saved work.

Plain text is an ordinary task. It can use SuperCodex analysis, planning, execution, testing, and review, but it is not saved as the project final goal and it does not run the final-goal Phase 6/Phase 7 loop. Use `/goal <prompt>` when you explicitly want to reset `.supercodex` state and start a final-goal delivery loop.

## The Real `/start` Behavior

`/start` is the command for continuing saved work. It does not create a new SuperCodex run.

- `/start` starts the `default` run.
- `/start <run-id>` starts the named saved run.
- It immediately launches the supervisor for that run.
- It reads `.supercodex` state, `session.json`, and, after this version, an active `runtime.json` left behind by an unexpected close.
- If a usable Codex thread exists, SuperCodex calls `thread/resume`.
- If the saved thread is unsafe or unavailable, SuperCodex keeps the same run but starts a fresh Codex thread with `thread/start`.

So the practical answer is:

```text
/start will reopen the previous SuperCodex run and continue it.
For accidental stop/close cases, it can recover the saved or active runtime thread and resume it.
It will not create a new SuperCodex session/run.
```

There are intentional exceptions at the Codex thread level:

- If there is no saved thread, Codex must start a new thread.
- If `/fresh-next` was requested, the next cycle starts a fresh thread.
- When the active PLAN is exhausted, SuperCodex starts a fresh thread for full-project Final Acceptance / PRD / Architecture / PLAN review and next-cycle planning if needed.
- If repeated same-session failures cross the configured limit, SuperCodex starts fresh.
- If the previous session was a dry run or a non-recoverable failure, it is not reused.

Stage or phase changes inside the active PLAN do not start a fresh Codex thread. Milestone completion may create an intermediate commit/push, but it still stays in the same plan-cycle thread and does not replace the Phase 7 final PR closure. This distinction matters: `/start` does not create a new SuperCodex run, but it may intentionally start a new Codex thread inside that run when recovery would be unsafe or when the PLAN-completion review boundary is reached.

## `/resume` and `/new`

`/resume` is passive:

- `/resume` opens the saved-session picker.
- `/resume <number|run-id>` selects a saved run or matching native Codex session.
- It loads history and switches the active run.
- It does not start the supervisor.

After `/resume`, type a normal message to continue that selected run, or use `/start <run-id>` to immediately auto-run saved work.

`/new` is fresh:

- `/new` creates a new run and fresh Codex thread.
- `/new <prompt>` creates a new ordinary task run and immediately sends the prompt.
- `/clear` is an alias for `/new`.

`/goal <prompt>` is the final-goal entry:

- It resets stale `.supercodex` state for the project.
- It writes the prompt to `.supercodex/FINAL_GOAL.md`.
- It enables the full PRD / architecture / PLAN / Phase 6 / Phase 7 delivery loop.

## Common TUI Commands

```text
/start [run-id]       Start/resume the default or selected saved run
/resume [id|current]  Select a saved session without auto-running, or unpause current
/new [prompt]         Create a fresh ordinary task session
/goal <prompt>        Reset state and start a final-goal delivery loop
/model <name>         Set model for the next turn
/reasoning <effort>   Set reasoning effort for the next turn
/permissions          Pick Default permissions, Auto-review, or Full access
/sandbox <mode>       Advanced sandbox override
/approval <policy>    Advanced approval-policy override
/auth <name>          Switch auth now if idle, or queue for the next turn
/fresh-next           Force the next cycle to use a fresh Codex thread
/interrupt [prompt]   Stop/steer the current turn
/interactions         Show pending Codex requests
/approve              Approve the first pending request
/approve-session      Approve for the session when supported
/deny                 Deny the first pending request
/cancel               Cancel the first pending request
/answer <text|json>   Answer a Codex input or MCP elicitation request
/pause                Pause before the next turn
/status               Show runtime status
/runs                 List saved SuperCodex/Codex sessions
/help                 Show command help
/exit                 Leave the TUI
```

Keyboard notes:

- `Enter` submits.
- `Shift+Enter`, `Alt+Enter`, `Ctrl+Enter`, or `Ctrl+J` inserts a newline.
- `Ctrl+C` is copy-only. It does not exit SuperCodex.
- Use `/exit` to leave the TUI.
- Use `Esc` while a turn is running to open the stop confirmation picker.

## Permissions

The main TUI permission modes are:

- `Default permissions`: clears per-run overrides and uses the normal default, `danger-full-access` with `approvalPolicy=never`.
- `Auto-review`: a safer review-oriented mode.
- `Full access`: explicitly sets `danger-full-access` with `approvalPolicy=never`.

Advanced users can still set native-style values:

```text
/sandbox read-only
/sandbox workspace-write
/sandbox danger-full-access
/approval never
/approval on-failure
/approval on-request
/approval untrusted
```

## Auth

SuperCodex stores its global auth/config data under:

```text
C:\Users\<you>\.supercodex\codex-auth
```

Useful commands:

```powershell
supercodex auth list
supercodex auth add --name account-1 --login
supercodex auth use --name account-1
supercodex auth snapshot-config
supercodex auth reset-limits
```

When a turn is idle, `/auth <name>` switches immediately. When a Codex turn is running, the switch is queued for the next turn so the active app-server process is not corrupted.

## Non-TUI Commands

```powershell
supercodex init --project C:\path\to\project
supercodex status --project C:\path\to\project
supercodex doctor --project C:\path\to\project
supercodex run --project C:\path\to\project
supercodex once --project C:\path\to\project
supercodex attach --project C:\path\to\project
supercodex interrupt --project C:\path\to\project --message "Stop and inspect the current direction."
```

`run` continues until the project is done unless you pass `--max-cycles`. Recoverable Codex app-server failures such as context-window errors, timeouts, and missing sessions are retried with backoff. `--max-retries` is the escalation threshold for ordinary recoverable failures, default 10: after the threshold, SuperCodex forces a fresh Codex thread and keeps running. It is a stop threshold only for non-recoverable failures.

Network transient failures and remote pre-sampling compaction failures have stricter same-thread budgets. Network transient failures retry the same Codex thread up to 10 times by default. Remote pre-sampling compaction failures retry the same Codex thread up to 20 times by default. After either threshold, SuperCodex keeps the same run and continues with a fresh Codex thread.

```powershell
supercodex run --project C:\path\to\project --max-cycles 1
supercodex run --project C:\path\to\project --max-retries 10
supercodex run --project C:\path\to\project --network-transient-max-retries 10
supercodex run --project C:\path\to\project --remote-compaction-max-retries 20
supercodex run --project C:\path\to\project --idle-timeout-seconds 1200
supercodex run --project C:\path\to\project --run-id main
```

## Files Written by SuperCodex

Project-local runtime and recovery files:

```text
.supercodex/
  AUTO_DEV_STATE.json
  TASK.md                  # ordinary task mode
  FINAL_GOAL.md            # explicit /goal mode
  CLARIFICATIONS.md        # explicit /goal mode
  ASSUMPTIONS.md           # explicit /goal mode
  PRD.md                   # explicit /goal mode
  ARCHITECTURE.md          # explicit /goal mode
  PLAN.md
  TRACEABILITY_MATRIX.md   # explicit /goal mode
  CODE_REVIEW_REPORT.md
  FINAL_ACCEPTANCE_REPORT.md # explicit /goal mode
  progress.md
  checkpoints.md
  last-action.md
  runtime/
    session.json
    runtime.json
    runs/<run-id>/
  logs/
```

`.supercodex/` is runtime state and is ignored by git by default.

## Development

```powershell
cd C:\supercodex
npm run build
npm test
npm run test:node
npm run test:opentui
git diff --check
```

Focused resume checks:

```powershell
node --test dist\tests\supervisor.test.js dist\tests\app-server.test.js
bun test tests\opentui-smoke.test.tsx --test-name-pattern "routes /start|resume session picker"
```

## More Documentation

- English user guide: `dosc/USAGE_GUIDE.md`
- Chinese README: `README.zh-CN.md`
- Chinese user guide: `dosc/USAGE_GUIDE.zh-CN.md`

## License

MIT. See `LICENSE`.
