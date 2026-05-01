#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join, resolve } from "node:path";
import { CodexAuthManager, defaultCodexHome, defaultSupervisorHome, readEffectiveCodexConfig, runCodexLogin } from "./auth.js";
import { defaultAppServerOptions, resolveCodexInvocation, type AppServerOptions } from "./app-server.js";
import { clearControl, readControl, requestInterrupt } from "./control.js";
import { readPendingInteractions } from "./interactions.js";
import { Supervisor, type SupervisorConfig, shouldResumeStoredThread, resumableThreadId } from "./supervisor.js";
import { chooseNextWork, ensureProjectAgentsMd, ensureScaffold, ensureSupercodexGitignore, loadSnapshotForRun, loadSupervisorRuntime } from "./workspace.js";
import { parseReasoningEffort, readSupervisorSettings, sanitizeRunId } from "./settings.js";
import { runAttach } from "./tui.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean | string[]>;
  rest: string[];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  try {
    switch (parsed.command) {
      case "tui":
        return await cmdTui(parsed);
      case "init":
        return await cmdInit(parsed);
      case "status":
        return await cmdStatus(parsed);
      case "doctor":
        return await cmdDoctor(parsed);
      case "run":
        return await cmdRun(parsed);
      case "once":
        return await cmdRun({ ...parsed, flags: { ...parsed.flags, "max-cycles": "1" } });
      case "attach":
        return await cmdAttach(parsed);
      case "interrupt":
        return await cmdInterrupt(parsed);
      case "auth":
        return await cmdAuth(parsed);
      case "help":
      case "":
        printHelp();
        return 0;
      default:
        console.error(`Unknown command: ${parsed.command}`);
        printHelp();
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  const created = await ensureScaffold(project, stringFlag(args, "goal", ""));
  console.log(JSON.stringify({ project, created }, null, 2));
  return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  const runId = sanitizeRunId(stringFlag(args, "run-id", "default"));
  const snapshot = await loadSnapshotForRun(project, runId);
  const work = chooseNextWork(snapshot);
  const authManager = authManagerFromArgs(args);
  const appServerOptions = applySettingsToAppServerOptions(appServerOptionsFromArgs(args), await readSupervisorSettings(project, runId));
  const nextThread = resumableThreadId(snapshot.supervisorSession);
  const nextResume = shouldResumeStoredThread(snapshot.supervisorSession, work.stageId);
  console.log(
    JSON.stringify(
      {
        project,
        done: snapshot.done,
        executionLock: snapshot.executionLocked,
        missingDocs: snapshot.missingDocs,
        state: {
          mode: snapshot.state.mode,
          phase: snapshot.state.phase,
          currentStageId: snapshot.state.currentStageId,
          currentTaskId: snapshot.state.currentTaskId,
        },
        nextWork: {
          kind: work.kind,
          stageId: work.stageId,
          taskId: work.taskId,
          title: work.title,
          reason: work.reason,
          source: work.source,
        },
        supercodexSession: snapshot.supervisorSession,
        supercodexSessionResumable: Boolean(nextThread),
        authRotation: {
          root: authManager.root,
          codexHome: authManager.codexHome,
          accounts: await authManager.listAccounts(),
          active: await authManager.activeAccount(),
          canonicalConfig: authManager.configPath,
        },
        control: await readControl(project, runId),
        interactions: (await readPendingInteractions(project, runId)).map(({ path: _path, ...interaction }) => interaction),
        runId,
        runtime: await loadSupervisorRuntime(project, runId),
        settings: await readSupervisorSettings(project, runId),
        codexPermissions: await codexPermissionsSummary(appServerOptions, authManager, project),
        nextDefaultCommand: `${appServerOptions.codexBin} app-server --listen stdio://`,
        nextDefaultThreadAction: nextResume ? `thread/resume ${nextThread}` : "thread/start",
      },
      null,
      2,
    ),
  );
  return 0;
}

async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  const runId = sanitizeRunId(stringFlag(args, "run-id", "default"));
  const codexBin = stringFlag(args, "codex-bin", "codex");
  const snapshot = await loadSnapshotForRun(project, runId);
  const authManager = authManagerFromArgs(args);
  const appServerOptions = applySettingsToAppServerOptions(appServerOptionsFromArgs(args), await readSupervisorSettings(project, runId));
  const codexInvocation = resolveCodexInvocation(codexBin);
  const bunBin = process.env.SUPERCODEX_BUN_BIN || "bun";
  const codexHelp = spawnSync(codexInvocation.command, [...codexInvocation.argsPrefix, "app-server", "--help"], {
    encoding: "utf8",
    shell: false,
  });
  const bunVersion = spawnSync(bunBin, ["--version"], { encoding: "utf8", shell: false });
  const gitStatus = spawnSync("git", ["status", "--short"], { cwd: project, encoding: "utf8", shell: false });
  console.log(
    JSON.stringify(
      {
        project,
        runner: "codex-app-server",
        codexCommand: `${codexBin} app-server --listen stdio://`,
        codexAppServerAvailable: codexHelp.status === 0,
        openTuiFrontend: {
          bunCommand: bunBin,
          bunAvailable: bunVersion.status === 0,
          bunVersion: bunVersion.status === 0 ? bunVersion.stdout.trim() : null,
          packages: ["@opentui/core", "@opentui/solid", "solid-js"],
          launch: `${bunBin} --preload @opentui/solid/preload src/opentui-app.tsx`,
        },
        gitAvailable: gitStatus.status === 0,
        missingDocs: snapshot.missingDocs,
        hasSupercodexState: Object.keys(snapshot.state).length > 0,
        hasBacklog: Object.keys(snapshot.backlog).length > 0,
        authManagerRoot: authManager.root,
        codexHome: authManager.codexHome,
        authAccounts: await authManager.listAccounts(),
        activeAuthAccount: await authManager.activeAccount(),
        runId,
        interactions: (await readPendingInteractions(project, runId)).map(({ path: _path, ...interaction }) => interaction),
        runtime: await loadSupervisorRuntime(project, runId),
        settings: await readSupervisorSettings(project, runId),
        codexPermissions: await codexPermissionsSummary(appServerOptions, authManager, project),
      },
      null,
      2,
    ),
  );
  return codexHelp.status === 0 && bunVersion.status === 0 && gitStatus.status === 0 ? 0 : 1;
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  const dryRun = booleanFlag(args, "dry-run");
  const explicitMaxCycles = optionalNumberFlag(args, "max-cycles");
  const config: SupervisorConfig = {
    project,
    goal: stringFlag(args, "goal", ""),
    maxCycles: explicitMaxCycles ?? (dryRun ? 1 : Number.POSITIVE_INFINITY),
    maxRetries: numberFlag(args, "max-retries", 3),
    sameSessionRetryLimit: numberFlag(args, "same-session-retry-limit", 2),
    retryBaseSeconds: numberFlag(args, "retry-base-seconds", 5),
    retryMaxSeconds: numberFlag(args, "retry-max-seconds", 60),
    dryRun,
    appServerOptions: appServerOptionsFromArgs(args),
    authManager: authManagerFromArgs(args),
    runId: sanitizeRunId(stringFlag(args, "run-id", "default")),
    supervisorConsole: !booleanFlag(args, "quiet-supercodex"),
  };
  return await new Supervisor(config).run();
}

async function cmdTui(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  return await runAttach({
    project,
    runId: sanitizeRunId(stringFlag(args, "run-id", "default")),
    authManager: authManagerFromArgs(args),
    appServerOptions: appServerOptionsFromArgs({ ...args, flags: { ...args.flags, "no-stream": true } }),
    managed: true,
  });
}

async function cmdAttach(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  return await runAttach({
    project,
    runId: sanitizeRunId(stringFlag(args, "run-id", "default")),
    authManager: authManagerFromArgs(args),
    appServerOptions: appServerOptionsFromArgs({ ...args, flags: { ...args.flags, "no-stream": true } }),
    managed: false,
  });
}

async function cmdInterrupt(args: ParsedArgs): Promise<number> {
  const project = await projectFromArgs(args);
  if (booleanFlag(args, "clear")) {
    console.log(JSON.stringify({ project, cleared: await clearControl(project, stringFlag(args, "run-id", "default")) }, null, 2));
    return 0;
  }
  const message = stringFlag(args, "message", "") || (await readInterruptPrompt(project));
  const payload = await requestInterrupt(project, message, stringFlag(args, "run-id", "default"));
  console.log(JSON.stringify({ project, interrupt: payload }, null, 2));
  return 0;
}

async function cmdAuth(args: ParsedArgs): Promise<number> {
  const sub = args.rest[0] ?? "";
  const manager = authManagerFromArgs(args);
  if (sub === "list") {
    console.log(
      JSON.stringify(
        {
          root: manager.root,
          codexHome: manager.codexHome,
          accounts: await manager.listAccounts(),
          active: await manager.activeAccount(),
          canonicalConfig: manager.configPath,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (sub === "add") {
    const name = stringFlag(args, "name", "");
    if (!name) {
      throw new Error("auth add requires --name");
    }
    if (booleanFlag(args, "login")) {
      const loginCode = runCodexLogin(stringFlag(args, "codex-bin", "codex"), manager.codexHome);
      if (loginCode !== 0) {
        return loginCode;
      }
    }
    const accountDir = await manager.captureCurrent(name, booleanFlag(args, "snapshot-config"));
    console.log(JSON.stringify({ saved: name, accountDir, root: manager.root, codexHome: manager.codexHome }, null, 2));
    return 0;
  }
  if (sub === "use") {
    const name = stringFlag(args, "name", "");
    if (!name) {
      throw new Error("auth use requires --name");
    }
    console.log(JSON.stringify({ active: name, accountDir: await manager.useAccount(name), codexHome: manager.codexHome }, null, 2));
    return 0;
  }
  if (sub === "snapshot-config") {
    const path = await manager.snapshotConfig();
    console.log(JSON.stringify({ root: manager.root, codexHome: manager.codexHome, canonicalConfig: path }, null, 2));
    return path ? 0 : 1;
  }
  if (sub === "reset-limits") {
    await manager.resetUsageLimits();
    console.log(JSON.stringify({ root: manager.root, usageLimitsReset: true }, null, 2));
    return 0;
  }
  console.error("Unknown auth command. Use: auth list|add|use|snapshot-config|reset-limits");
  return 2;
}

function appServerOptionsFromArgs(args: ParsedArgs): AppServerOptions {
  const reasoning = stringFlag(args, "reasoning", "");
  return {
    ...defaultAppServerOptions,
    codexBin: stringFlag(args, "codex-bin", "codex"),
    model: booleanFlag(args, "use-codex-config-model") ? null : stringFlag(args, "model", "") || null,
    reasoningEffort: reasoning ? parseReasoningEffort(reasoning) : null,
    sandbox: stringFlag(args, "sandbox", defaultAppServerOptions.sandbox) as AppServerOptions["sandbox"],
    approvalPolicy: stringFlag(args, "approval", "never") as AppServerOptions["approvalPolicy"],
    timeoutSeconds: optionalNumberFlag(args, "timeout-seconds"),
    idleTimeoutSeconds: optionalNumberFlag(args, "idle-timeout-seconds"),
    startupTimeoutSeconds: optionalNumberFlag(args, "startup-timeout-seconds") ?? 180,
    streamConsole: !booleanFlag(args, "no-stream"),
  };
}

async function projectFromArgs(args: ParsedArgs): Promise<string> {
  const project = resolve(stringFlag(args, "project", "."));
  await ensureProjectAgentsMd(project);
  await ensureSupercodexGitignore(project);
  return project;
}

function authManagerFromArgs(args: ParsedArgs): CodexAuthManager {
  return new CodexAuthManager({
    root: join(resolve(stringFlag(args, "supercodex-home", defaultSupervisorHome())), "codex-auth"),
    codexHome: stringFlag(args, "codex-home", defaultCodexHome()),
  });
}

async function codexPermissionsSummary(options: AppServerOptions, authManager: CodexAuthManager, project: string): Promise<Record<string, unknown>> {
  const effectiveConfig = await readEffectiveCodexConfig(authManager);
  return {
    appServerThreadSandbox: options.sandbox,
    appServerThreadApprovalPolicy: options.approvalPolicy,
    appServerThreadModel: options.model ?? effectiveConfig.model ?? "unset",
    appServerThreadModelSource: options.model ? "cli" : effectiveConfig.source,
    appServerThreadReasoning: options.reasoningEffort ?? effectiveConfig.reasoningEffort ?? "unset",
    appServerThreadReasoningSource: options.reasoningEffort ? "cli" : effectiveConfig.source,
    codexConfigSandbox: effectiveConfig.sandbox ?? "unset",
    codexConfigApprovalPolicy: effectiveConfig.approvalPolicy ?? "unset",
    codexHome: authManager.codexHome,
    codexConfigPath: authManager.codexConfigPath(),
    supercodexCanonicalConfig: authManager.configPath,
    enforcedConfig: {
      approval_policy: options.approvalPolicy,
      sandbox_mode: options.sandbox,
      windowsSandbox: "elevated",
      projectTrust: { [project]: "trusted" },
    },
  };
}

function applySettingsToAppServerOptions(options: AppServerOptions, settings: Awaited<ReturnType<typeof readSupervisorSettings>>): AppServerOptions {
  return {
    ...options,
    model: typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : options.model,
    reasoningEffort: settings.reasoningEffort ?? options.reasoningEffort ?? null,
    sandbox: settings.sandbox ?? options.sandbox,
    approvalPolicy: settings.approvalPolicy ?? options.approvalPolicy,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0]?.startsWith("--")) {
    return parseCommandArgs("tui", argv);
  }
  const [command = "help", ...tail] = argv;
  return parseCommandArgs(command, tail);
}

function parseCommandArgs(command: string, tail: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  for (let index = 0; index < tail.length; index++) {
    const token = tail[index]!;
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const keyValue = token.slice(2);
    const equalsIndex = keyValue.indexOf("=");
    const key = equalsIndex >= 0 ? keyValue.slice(0, equalsIndex) : keyValue;
    const inlineValue = equalsIndex >= 0 ? keyValue.slice(equalsIndex + 1) : null;
    const next = tail[index + 1];
    const value: string | boolean = inlineValue ?? (next && !next.startsWith("--") ? tail[++index]! : true);
    if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      (flags[key] as string[]).push(String(value));
    } else {
      flags[key] = [String(flags[key]), String(value)];
    }
  }
  return { command, flags, rest };
}

function stringFlag(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags[name];
  if (Array.isArray(value)) {
    return value.at(-1) ?? fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = Number(stringFlag(args, name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumberFlag(args: ParsedArgs, name: string): number | null {
  const raw = stringFlag(args, name, "");
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

async function readInterruptPrompt(project: string): Promise<string> {
  const rl = createInterface({ input, output });
  console.log("+----------------------------------------------------------------------+");
  console.log("|                     supercodex interrupt                       |");
  console.log("+----------------------------------------------------------------------+");
  console.log(`Project: ${project}`);
  console.log("Type the intervention prompt. Submit an empty line to finish.");
  const lines: string[] = [];
  while (true) {
    const line = await rl.question("> ");
    if (!line) {
      if (lines.length > 0) {
        break;
      }
      console.log("Prompt cannot be empty.");
      continue;
    }
    lines.push(line);
  }
  rl.close();
  return lines.join("\n").trim();
}

function printHelp(): void {
  console.log(`supercodex <command> [options]

Commands:
  supercodex  Start the interactive TUI in the current directory
  tui         Start the interactive TUI explicitly
  init        Supplement required .supercodex and .supercodex/docs files without overwriting PRD/PLAN
  status      Show recovered state and next work
  doctor      Check Codex app-server, git, scaffold, and auth availability
  run         Run until done by default; use --max-cycles to cap cycles
  once        Alias for run --max-cycles 1
  attach      Attach-only TUI for an already running SuperCodex run
  interrupt   Steer the active app-server turn, or inject the message into the next turn
  auth        Manage saved Codex auth.json accounts

Common:
  --project <path>
  --goal <text>
  --max-cycles <n>            Optional cap; omitted real runs continue until done
  --timeout-seconds <n>
  --idle-timeout-seconds <n>  Optional no-event timeout; disabled by default
  --codex-bin <path-or-name>
  --supercodex-home <path>     Saved auth/config root; defaults to ~/.supercodex
  --run-id <id>               Isolate SuperCodex controls/session for parallel worktrees
  --model <name>
  --reasoning <minimal|low|medium|high|xhigh>
  --quiet-supercodex          Hide SuperCodex lifecycle lines; used by TUI
`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("cli.js")) {
  const code = await main();
  process.exitCode = code;
}
