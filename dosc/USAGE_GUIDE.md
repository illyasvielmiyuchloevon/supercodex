# SuperCodex User Guide

This guide is for day-to-day use. It is not an internal `.supercodex` delivery log. It describes how the current app-server/OpenTUI version is installed, started, resumed, configured, and verified.

Current version: `0.1.0` (0.1 release). License: MIT.

## 1. Install the Current Version

From the SuperCodex repository:

```powershell
cd C:\supercodex
npm install
npm run build
npm link
```

Verify that the command is available:

```powershell
supercodex doctor --project C:\supercodex
```

Expected healthy signals:

- `runner` is `codex-app-server`.
- `codexAppServerAvailable` is `true`.
- Bun is available.
- OpenTUI packages are available.
- Git is available in the current project.

If `codexAppServerAvailable=false`, first verify that Codex CLI is installed and that this command works:

```powershell
codex app-server --help
```

## 2. Start SuperCodex in a Project

Open the target project:

```powershell
cd C:\path\to\project
supercodex
```

This starts the OpenTUI full-screen interface. For a new project, type the goal directly. For a project that already has `.supercodex` state, use `/status` first, then `/start` to continue saved work.

## 3. Session Rules

### `/start` Continues Saved Work

`/start` starts a saved SuperCodex run. It does not create a new SuperCodex run.

```text
/start
```

starts the `default` run.

```text
/start main
```

starts the saved `main` run.

After an unexpected terminal close, process exit, machine restart, or interrupted SuperCodex session, this version restores in this order:

1. Reads project `.supercodex/state.json`, `backlog.json`, and docs state.
2. Reads the selected run's `session.json`.
3. If Codex was running when the process stopped, reads the active `runtime.json` thread.
4. If a usable thread is found, calls Codex app-server `thread/resume`.
5. If the thread is missing or unsafe, keeps the same SuperCodex run and starts a fresh Codex thread with `thread/start`.

Practical rule:

```text
/start reopens the previous SuperCodex run and continues it.
For accidental stop/close cases, it can recover a saved or active Codex thread.
It does not create a new SuperCodex session/run.
```

### When Can the Same Run Start a Fresh Codex Thread?

These cases can start a fresh Codex thread inside the same SuperCodex run:

- No thread has been saved yet.
- The previous turn was a dry run.
- The previous failure is not recoverable.
- `/fresh-next` was requested.
- The saved thread belongs to a different Stage than the next work item.
- The same thread failed repeatedly.

This protects new stages from stale Codex context. It is not the same as losing the SuperCodex session.

### `/resume` Selects Without Running

`/resume` is passive:

```text
/resume
/resume 2
/resume codex-019de35e...
```

It loads history and switches the active run, but does not automatically execute anything.

After `/resume`:

- Type a normal message to continue manually.
- Type `/start <run-id>` to auto-run saved work.

### `/new` Starts Fresh

```text
/new
/new Re-check the test strategy before implementation.
```

`/new` creates a new SuperCodex run and a new Codex thread. `/clear` is an alias for `/new`.

## 4. Recommended Daily Flow

### New Project

```powershell
cd C:\path\to\project
supercodex
```

Then type a final goal, for example:

```text
Turn this project into a resumable, tested, releasable CLI tool and continue until build and tests pass.
```

SuperCodex creates the required `.supercodex/` runtime state and continues from the project state.

### Continue Previous Work

```powershell
cd C:\path\to\project
supercodex
```

Inside the TUI:

```text
/status
/start
```

For multiple runs:

```text
/runs
/start main
```

### Inspect History Without Running

```text
/resume
```

Use Up/Down to select and Enter to confirm. This only loads history. Run explicitly with:

```text
/start <run-id>
```

### Start a New Session

```text
/new
```

or:

```text
/new Only check whether the README still matches the current implementation.
```

## 5. TUI Controls

Common keys:

- `Enter`: submit.
- `Shift+Enter`, `Alt+Enter`, `Ctrl+Enter`, `Ctrl+J`: insert a newline.
- `Ctrl+C`: copy terminal selection only; it does not exit SuperCodex.
- `Esc`: while Codex is running, opens the stop confirmation picker.
- `/exit`: exit the TUI.
- `/`: open the command palette.

The main screen shows:

- Current run/thread/turn.
- Whether SuperCodex and Codex app-server are running.
- Current model, reasoning effort, permission mode, and auth account.
- Compact transcript.
- Pending Codex interactions.

Command output and file-read output are compact in the UI. Full raw data remains in `.supercodex/logs/supercodex/` and in Codex native session JSONL.

## 6. Permissions

The main permission modes are:

```text
/permissions default
/permissions auto-review
/permissions full-access
```

Meaning:

- `Default permissions`: clears run-level overrides and returns to the normal default, `danger-full-access` plus `approvalPolicy=never`.
- `Auto-review`: a more conservative review-oriented mode.
- `Full access`: explicitly sets `danger-full-access` plus `approvalPolicy=never`.

Advanced native Codex settings remain available:

```text
/sandbox read-only
/sandbox workspace-write
/sandbox danger-full-access
/approval never
/approval on-failure
/approval on-request
/approval untrusted
```

The `/permissions`, `/sandbox`, and `/approval` command pickers support keyboard selection with Up/Down and Enter.

## 7. Model, Reasoning, and Auth

```text
/model gpt-5.5
/reasoning xhigh
/auth account-2
```

Rules:

- `/model` and `/reasoning` affect the next Codex turn.
- `/auth <name>` switches immediately when idle.
- If a Codex turn is running, auth switching is queued for the next turn.

Auth commands:

```powershell
supercodex auth list
supercodex auth add --name account-1 --login
supercodex auth use --name account-1
supercodex auth snapshot-config
supercodex auth reset-limits
```

Global SuperCodex auth data is stored under:

```text
C:\Users\<you>\.supercodex\codex-auth
```

## 8. Codex Approval and Input Requests

When Codex CLI asks for command execution approval, file-change approval, permission escalation, user input, or MCP elicitation, SuperCodex captures the app-server request and displays it in the same `PickerOverlay` design used by the command pickers and the Esc stop confirmation picker.

Keyboard support:

- Up/Left or `Ctrl+P`: previous choice.
- Down/Right or `Ctrl+N`: next choice.
- Home/End: first or last choice.
- Enter: confirm the highlighted choice.
- Number keys `1` to `9`: choose directly.
- Esc: cancel or decline when the request offers a cancel/decline action.

You can also use slash commands:

```text
/interactions
/approve
/approve-session
/deny
/cancel
/answer <text-or-json>
```

Freeform Codex questions and MCP forms can be answered with `/answer <text-or-json>`.

## 9. Non-TUI Commands

Check status:

```powershell
supercodex status --project C:\path\to\project
```

Diagnose the environment:

```powershell
supercodex doctor --project C:\path\to\project
```

Run without the TUI:

```powershell
supercodex run --project C:\path\to\project
```

Limit cycles:

```powershell
supercodex run --project C:\path\to\project --max-cycles 1
```

Attach to an existing run:

```powershell
supercodex attach --project C:\path\to\project
```

Interrupt a running turn:

```powershell
supercodex interrupt --project C:\path\to\project --message "Stop and inspect the failing tests first."
```

## 10. FAQ

### Does `/start` create a new session?

No. `/start` uses the saved `default` run or the run-id you provide. It only starts a fresh Codex thread inside that run when the previous thread is missing or unsafe.

### What should I do after SuperCodex closes unexpectedly?

Reopen the project:

```powershell
cd C:\path\to\project
supercodex
```

Then:

```text
/status
/start
```

SuperCodex will prefer saved `session.json` or active `runtime.json` state.

### Why does `/resume` not auto-run?

By design. `/resume` is for safe browsing and selection. Use `/start <run-id>` when you want execution to begin.

### Why does `Ctrl+C` not exit?

In the SuperCodex TUI, `Ctrl+C` is copy-only to avoid accidentally stopping long-running work. Exit with:

```text
/exit
```

### How can I tell whether the next run will resume or start fresh?

Run:

```powershell
supercodex status --project C:\path\to\project
```

Look for:

```json
"nextDefaultThreadAction": "thread/resume ..."
```

or:

```json
"nextDefaultThreadAction": "thread/start"
```

## 11. Verify This Repository

In `C:\supercodex`:

```powershell
npm run build
node --test dist\tests\supervisor.test.js dist\tests\app-server.test.js
bun test tests\opentui-smoke.test.tsx --test-name-pattern "routes /start|resume session picker"
npm test
git diff --check
```

The focused supervisor/app-server tests verify:

- Saved same-Stage sessions use `resume=true` and the original thread.
- Active runtime threads left by unexpected closes can be recovered.
- App-server resume parameters include `threadId`.
- OpenTUI `/start` uses active saved-run startup, not passive `/resume` or fresh `/new`.
