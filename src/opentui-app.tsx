import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliRenderer, type CliRendererConfig, type KeyEvent, type TextareaRenderable } from "@opentui/core";
import { render, testRender, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { CodexAuthManager, readEffectiveCodexConfig } from "./auth.js";
import { defaultAppServerOptions, type AppServerOptions } from "./app-server.js";
import { requestSteer, requestTurnInterrupt } from "./control.js";
import {
  answerInteraction,
  chooseInteraction,
  readPendingInteractions,
  type InteractionRecord,
} from "./interactions.js";
import {
  copySupervisorSessionPreferences,
  parseApprovalPolicy,
  parsePermissionSetting,
  parseReasoningEffort,
  parseSandboxMode,
  patchSupervisorSettings,
  readSupervisorSettings,
  sanitizeRunId,
} from "./settings.js";
import { defaultSupervisorConfig, Supervisor } from "./supervisor.js";
import { formatRunSessions, listRunSessions, prepareRunSessionForResume, resolveRunSessionSelector, runSessionsPayload, type RunSessionSummary } from "./run-sessions.js";
import { canonicalSlashCommandName, type SlashCommandSuggestion } from "./tui-commands.js";
import { TuiTranscriptSource } from "./tui-transcript.js";
import { chooseNextWork, loadSnapshotForRun, loadSupervisorRuntime } from "./workspace.js";
import { SUPERCODEX_VERSION } from "./version.js";
import type { JsonObject } from "./types.js";
import { managedPlainTextAction } from "./managed-input.js";
import { readAgentTuiConfig, type AgentTuiConfig } from "./opentui/config";
import { handleDialogKey as handleSharedDialogKey } from "./opentui/dialog-stack";
import type { TuiMessage } from "./opentui/message-projection";
import { DialogHost, type AgentDialogAction, type AgentDialogRecord } from "./opentui/dialog-host";
import { OpenTuiErrorBoundary } from "./opentui/error-boundary";
import { SessionFooter } from "./opentui/footer";
import { cancelActionForInteraction } from "./opentui/interaction-dialog";
import { interactionPickerRecord } from "./opentui/interaction-picker-record";
import { PickerOverlay, type AgentPickerRecord } from "./opentui/picker";
import { AgentPrompt } from "./opentui/prompt";
import { SessionTranscript, type SessionTranscriptHandle } from "./opentui/session-view";
import { StatusSidebar } from "./opentui/status-sidebar";
import { applyTerminalTitle, consoleOptionsForSelectionCopy, copyRendererSelection, handleCtrlCCopyOnly, restoreTerminalTitle, terminalTitleForRun } from "./opentui/terminal-lifecycle";
import { themeForStatus } from "./opentui/theme";
import { ToastStack, type AgentToastRecord } from "./opentui/toast";
import { win32DisableProcessedInput, win32FlushInputBuffer, win32InstallCtrlCGuard } from "./opentui/win32";

type Mode = "managed" | "attach";

export interface OpenTuiViewProps {
  project: string;
  runId: string;
  mode: Mode;
  transcript: string[];
  messages?: TuiMessage[];
  tuiConfig?: AgentTuiConfig;
  status: JsonObject;
  interactions: InteractionRecord[];
  dialogs?: AgentDialogRecord[];
  picker?: AgentPickerRecord | null;
  pickerSelection?: number;
  toasts?: AgentToastRecord[];
  forceError?: string;
  inputValue?: string;
  promptInputId?: string;
  promptInputReady?: (textarea: TextareaRenderable) => void;
  supervisorActive?: boolean;
  commandSelection?: number;
  interactionSelection?: number;
  onSubmit?: (value: string, textarea: TextareaRenderable) => void | Promise<void>;
  onCommandSelection?: (next: number) => void;
  onCommandChoice?: (suggestion: SlashCommandSuggestion, textarea: TextareaRenderable, submit: boolean) => void | Promise<void>;
  onInteractionSelection?: (next: number) => void;
  onInteractionChoice?: (choiceId: string) => void | Promise<void>;
  onDialogClose?: (dialog: AgentDialogRecord) => void;
  onDialogAction?: (dialog: AgentDialogRecord, action: AgentDialogAction) => void | Promise<void>;
  onPickerSelection?: (next: number) => void;
  onPickerChoice?: (optionId: string) => void | Promise<void>;
  onPickerClose?: () => void;
  onSelectionCopied?: (copied: boolean) => void;
  onStopRequest?: () => void | Promise<void>;
  onScroll?: (delta: number) => void;
  onExit?: () => void | Promise<void>;
}

export function AgentSupervisorOpenTuiView(props: OpenTuiViewProps) {
  let transcriptView: SessionTranscriptHandle | undefined;
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [interactionSelection, setInteractionSelection] = createSignal(props.interactionSelection ?? 0);
  const [dialogSelection, setDialogSelection] = createSignal(0);
  const [pickerSelection, setPickerSelection] = createSignal(props.pickerSelection ?? 0);

  const theme = createMemo(() => themeForStatus(props.status, props.tuiConfig));
  const activity = createMemo(() => activityStatus(props.status, Boolean(props.supervisorActive)));
  const currentInteraction = createMemo(() => props.interactions[0] ?? null);
  const dialogs = createMemo(() => props.dialogs ?? []);
  const interactionPicker = createMemo(() => {
    const interaction = currentInteraction();
    return interaction ? interactionPickerRecord(interaction) : null;
  });
  const activePicker = createMemo(() => props.picker ?? null);
  const promptPicker = createMemo(() => activePicker()?.placement === "anchor" ? activePicker() : null);
  const globalPicker = createMemo(() => activePicker()?.placement === "anchor" ? null : activePicker());
  const floatingPicker = createMemo(() => globalPicker() ?? (!activePicker() ? interactionPicker() : null));
  const keyboardPicker = createMemo(() => activePicker() ?? interactionPicker());
  const sidebarWidth = createMemo(() => stableSidebarWidth(dimensions().width));
  const transcriptWidth = createMemo(() => Math.max(12, dimensions().width - sidebarWidth() - 7));

  createEffect(() => {
    const picker = activePicker();
    picker?.id;
    const count = picker?.options.length ?? 0;
    const next = clampSelection(props.pickerSelection ?? pickerSelection(), count);
    if (next !== pickerSelection()) {
      setPickerSelection(next);
    }
  });

  useKeyboard((event) => {
    if (event.ctrl && event.name === "c") {
      void handleCtrlCCopyOnly(event, renderer, props.onSelectionCopied);
      return;
    }
    if (handleOverlayKey(event)) return;
    if (event.defaultPrevented) return;
    if (event.ctrl && event.name === "y") {
      event.preventDefault();
      void copyRendererSelection(renderer).then((copied) => props.onSelectionCopied?.(copied));
      return;
    }
    if (event.name === "pageup") {
      event.preventDefault();
      transcriptView?.scrollPage(-1);
      props.onScroll?.(-1);
      return;
    }
    if (event.name === "pagedown") {
      event.preventDefault();
      transcriptView?.scrollPage(1);
      props.onScroll?.(1);
      return;
    }
  });

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme().background} flexDirection="column">
      <OpenTuiErrorBoundary theme={theme()}>
        <MaybeThrow message={props.forceError} />
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
          <text fg={theme().primary}>SuperCodex v{SUPERCODEX_VERSION}</text>
          <text fg={activityFg(activity().kind, theme())}>{activity().label}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
          <text fg={theme().muted}>run {props.runId} · {props.mode === "managed" ? "OpenTUI managed" : "OpenTUI attach"}</text>
          <text fg={theme().muted}>{props.project}</text>
        </box>
        <box flexDirection="row" flexGrow={1} minHeight={3} border={["top"]} borderColor={theme().border}>
          <box flexGrow={1} paddingLeft={2} paddingRight={1} paddingBottom={1}>
            <SessionTranscript
              lines={props.transcript}
              messages={props.messages}
              theme={theme()}
              contentWidth={transcriptWidth()}
              ref={(handle) => {
                transcriptView = handle;
              }}
            />
          </box>
          <StatusSidebar
            status={props.status}
            interactions={props.interactions}
            width={sidebarWidth()}
            messageCount={props.messages?.length ?? 0}
            lineCount={props.transcript.length}
            tuiConfig={props.tuiConfig}
            theme={theme()}
          />
        </box>
        <SessionFooter status={props.status} interactions={props.interactions} messages={props.messages ?? []} lineCount={props.transcript.length} tuiConfig={props.tuiConfig} theme={theme()} />
        <AgentPrompt
          mode={props.mode}
          project={props.project}
          runId={props.runId}
          theme={theme()}
          initialValue={props.inputValue}
          inputId={props.promptInputId}
          onInputReady={props.promptInputReady}
          supervisorRunning={activity().running}
          onSubmit={props.onSubmit}
          onCommandChoice={props.onCommandChoice}
          picker={promptPicker()}
          pickerSelection={pickerSelection()}
          onPickerSelection={selectPickerOption}
          onPickerChoice={props.onPickerChoice}
          onPickerClose={props.onPickerClose}
          onOverlayKeyDown={(event) => {
            handleOverlayKey(event);
          }}
          onSelectionCopied={props.onSelectionCopied}
          onStopRequest={props.onStopRequest}
          onExit={props.onExit}
        />
        {floatingPicker() && (
          <PickerOverlay
            picker={floatingPicker()!}
            selection={floatingPickerSelection()}
            theme={theme()}
            onSelect={selectFloatingPickerOption}
            onChoose={(option) => void chooseFloatingPickerOption(option.id)}
            onClose={closeFloatingPicker}
          />
        )}
      </OpenTuiErrorBoundary>
      <ToastStack toasts={props.toasts ?? []} theme={theme()} />
      <DialogHost
        dialogs={dialogs()}
        theme={theme()}
        selection={dialogSelection()}
        onSelect={selectDialogAction}
        onClose={closeDialog}
        onAction={chooseDialogAction}
      />
    </box>
  );

  function handleOverlayKey(event: KeyEvent): boolean {
    const dialog = dialogs().at(-1);
    if (dialog && handleDialogKey(event, dialog)) return true;
    return handlePickerKey(event);
  }

  function handleDialogKey(event: KeyEvent, dialog: AgentDialogRecord): boolean {
    return handleSharedDialogKey({
      event,
      dialog,
      selection: dialogSelection(),
      onSelect: selectDialogAction,
      onClose: closeDialog,
      onAction: chooseDialogAction,
    });
  }

  function handlePickerKey(event: KeyEvent): boolean {
    const picker = keyboardPicker();
    if (!picker) return false;
    if (event.name === "escape") {
      consumeKey(event);
      closeKeyboardPicker();
      return true;
    }
    if (event.name === "up" || event.name === "left" || (event.ctrl && event.name === "p")) {
      consumeKey(event);
      moveKeyboardPickerSelection(-1);
      return true;
    }
    if (event.name === "down" || event.name === "right" || (event.ctrl && event.name === "n")) {
      consumeKey(event);
      moveKeyboardPickerSelection(1);
      return true;
    }
    if (event.name === "pageup") {
      consumeKey(event);
      moveKeyboardPickerSelection(-10);
      return true;
    }
    if (event.name === "pagedown") {
      consumeKey(event);
      moveKeyboardPickerSelection(10);
      return true;
    }
    if (event.name === "home") {
      consumeKey(event);
      selectKeyboardPickerOption(0);
      return true;
    }
    if (event.name === "end") {
      consumeKey(event);
      selectKeyboardPickerOption(Math.max(0, picker.options.length - 1));
      return true;
    }
    if (isEnterKey(event)) {
      consumeKey(event);
      const selected = picker.options[clampSelection(keyboardPickerSelection(), picker.options.length)];
      if (selected) {
        void chooseKeyboardPickerOption(selected.id);
      } else {
        closeKeyboardPicker();
      }
      return true;
    }
    if (/^[1-9]$/.test(event.name)) {
      const selected = picker.options[Number(event.name) - 1];
      if (selected) {
        consumeKey(event);
        void chooseKeyboardPickerOption(selected.id);
        return true;
      }
    }
    return false;
  }

  function selectInteractionChoice(next: number) {
    const count = currentInteraction()?.choices.slice(0, 9).length ?? 0;
    const bounded = clampSelection(next, count);
    setInteractionSelection(bounded);
    props.onInteractionSelection?.(bounded);
  }

  function movePickerSelection(delta: number) {
    const picker = activePicker();
    const count = picker?.options.length ?? 0;
    if (count === 0) {
      selectPickerOption(0);
      return;
    }
    const next = (pickerSelection() + delta + count) % count;
    selectPickerOption(next);
  }

  function selectPickerOption(next: number) {
    const count = activePicker()?.options.length ?? 0;
    const bounded = clampSelection(next, count);
    setPickerSelection(bounded);
    props.onPickerSelection?.(bounded);
  }

  function keyboardPickerSelection(): number {
    return isKeyboardInteractionPicker() ? interactionSelection() : pickerSelection();
  }

  function floatingPickerSelection(): number {
    return isFloatingInteractionPicker() ? interactionSelection() : pickerSelection();
  }

  function moveKeyboardPickerSelection(delta: number) {
    const picker = keyboardPicker();
    const count = picker?.options.length ?? 0;
    if (count === 0) {
      selectKeyboardPickerOption(0);
      return;
    }
    const next = (keyboardPickerSelection() + delta + count) % count;
    selectKeyboardPickerOption(next);
  }

  function selectKeyboardPickerOption(next: number) {
    if (isKeyboardInteractionPicker()) {
      selectInteractionChoice(next);
      return;
    }
    selectPickerOption(next);
  }

  function selectFloatingPickerOption(next: number) {
    if (isFloatingInteractionPicker()) {
      selectInteractionChoice(next);
      return;
    }
    selectPickerOption(next);
  }

  function chooseKeyboardPickerOption(optionId: string) {
    if (isKeyboardInteractionPicker()) {
      void props.onInteractionChoice?.(optionId);
      return;
    }
    void props.onPickerChoice?.(optionId);
  }

  function chooseFloatingPickerOption(optionId: string) {
    if (isFloatingInteractionPicker()) {
      void props.onInteractionChoice?.(optionId);
      return;
    }
    void props.onPickerChoice?.(optionId);
  }

  function closeKeyboardPicker() {
    if (isKeyboardInteractionPicker()) {
      cancelCurrentInteraction();
      return;
    }
    props.onPickerClose?.();
  }

  function closeFloatingPicker() {
    if (isFloatingInteractionPicker()) {
      cancelCurrentInteraction();
      return;
    }
    props.onPickerClose?.();
  }

  function cancelCurrentInteraction() {
    const interaction = currentInteraction();
    const cancel = interaction ? cancelActionForInteraction(interaction) : null;
    if (cancel) {
      void props.onInteractionChoice?.(cancel.id);
    }
  }

  function isKeyboardInteractionPicker(): boolean {
    return !activePicker() && Boolean(interactionPicker());
  }

  function isFloatingInteractionPicker(): boolean {
    return !globalPicker() && !activePicker() && Boolean(interactionPicker());
  }

  function selectDialogAction(next: number) {
    setDialogSelection(next);
  }

  function closeDialog(dialog: AgentDialogRecord) {
    props.onDialogClose?.(dialog);
  }

  function chooseDialogAction(dialog: AgentDialogRecord, action: AgentDialogAction) {
    void props.onDialogAction?.(dialog, action);
  }
}

function isEnterKey(event: KeyEvent): boolean {
  return event.name === "return" || event.name === "enter" || event.name === "kpenter";
}

function consumeKey(event: KeyEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function clampSelection(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

export function stableSidebarWidth(terminalWidth: number): number {
  const width = Number.isFinite(terminalWidth) ? Math.floor(terminalWidth) : 100;
  return Math.min(36, Math.max(24, Math.floor(width * 0.26)));
}

function MaybeThrow(props: { message?: string }) {
  if (props.message) {
    throw new Error(props.message);
  }
  return null;
}

export async function runOpenTuiFromEnvironment(): Promise<void> {
  const project = resolve(process.env.SUPERCODEX_PROJECT ?? ".");
  const mode = process.env.SUPERCODEX_TUI_MODE === "attach" ? "attach" : "managed";
  const initialRunId = sanitizeRunId(process.env.SUPERCODEX_RUN_ID ?? "default");
  const appServerOptions = {
    ...defaultAppServerOptions,
    ...parseJsonObject(process.env.SUPERCODEX_APP_SERVER_OPTIONS),
    streamConsole: false,
  } as AppServerOptions;
  const authManager = new CodexAuthManager({
    root: process.env.SUPERCODEX_AUTH_ROOT,
    codexHome: process.env.SUPERCODEX_CODEX_HOME,
  });
  const tuiConfig = await readAgentTuiConfig(project, initialRunId);
  const config: CliRendererConfig = {
    externalOutputMode: "passthrough",
    targetFps: tuiConfig.targetFps ?? 60,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: true,
    useMouse: tuiConfig.mouse ?? true,
    openConsoleOnError: false,
    consoleOptions: consoleOptionsForSelectionCopy(),
  };
  const unguard = await win32InstallCtrlCGuard();
  await win32DisableProcessedInput();
  const renderer = await createCliRenderer(config);
  applyTerminalTitle(renderer, terminalTitleForRun({ project, runId: initialRunId, mode }));
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    restoreTerminalTitle(renderer);
    renderer.destroy();
    unguard?.();
    await win32FlushInputBuffer();
  };
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onExit = async () => {
        await cleanup();
        resolvePromise();
      };
      void render(
        () => (
          <OpenTuiRuntime
            project={project}
            initialRunId={initialRunId}
            mode={mode}
            authManager={authManager}
            appServerOptions={appServerOptions}
            onExit={onExit}
          />
        ),
        renderer,
      ).catch(rejectPromise);
    });
  } finally {
    await cleanup();
  }
}

export async function smokeRenderOpenTui(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["user: hello", "assistant: working"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
      supervisorActive={true}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiPanels(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      inputValue="/"
      transcript={["system: choose a command or answer the request"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[
        {
          id: "interaction-1",
          requestId: 1,
          method: "item/commandExecution/requestApproval",
          status: "pending",
          title: "Command Approval",
          summary: "npm test",
          choices: [
            { id: "accept", label: "accept", response: { decision: "accept" } },
            { id: "decline", label: "decline", response: { decision: "decline" } },
          ],
          params: {},
          createdAt: "2026-05-01T00:00:00.000Z",
          respondedAt: null,
          handledAt: null,
        },
      ]}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiResumePicker(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="default"
      mode="managed"
      transcript={["system: resume picker smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "idle" }}
      interactions={[]}
      picker={resumeSessionsPicker([
        fakeRunSession("session-2026-05-01T09-02-50-057Z-edb26450", "019de2c7-3899-7943-b31e-151cb1462631", "success", "2026-05-01T09:16:24.871Z"),
        fakeRunSession("default", "019de246-1d38-70d0-918c-4318bcf9e64a", "failed", "2026-05-01T06:59:38.707Z"),
      ], "default")}
      pickerSelection={0}
    />
  ), { width: 96, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiSecondaryCommandPicker(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="default"
      mode="managed"
      transcript={["system: secondary command picker smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5", reasoningEffort: "medium" }, runtimeStatus: "idle" }}
      interactions={[]}
      picker={reasoningEffortPicker("medium")}
      pickerSelection={2}
    />
  ), { width: 96, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiModelPicker(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="default"
      mode="managed"
      transcript={["system: model picker smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "idle" }}
      interactions={[]}
      picker={modelPicker("gpt-5.5")}
      pickerSelection={0}
    />
  ), { width: 96, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiPermissionsPicker(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="default"
      mode="managed"
      transcript={["system: permissions picker smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{
        mode: "execution",
        phase: "execution",
        settings: { sandbox: "danger-full-access", approvalPolicy: "never" },
        effectiveCodexConfig: { sandbox: "danger-full-access", approvalPolicy: "never" },
        runtimeStatus: "idle",
      }}
      interactions={[]}
      picker={permissionsPresetPicker({
        settings: { sandbox: "danger-full-access", approvalPolicy: "never" },
        effectiveCodexConfig: { sandbox: "danger-full-access", approvalPolicy: "never" },
      })}
      pickerSelection={0}
    />
  ), { width: 96, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeChooseSlashCommandWithEnter(): Promise<{ command: string; submit: boolean; input: string }> {
  return smokeChooseSlashCommandInputWithEnter("/");
}

export async function smokeChooseSlashPrefixCommandWithEnter(): Promise<{ command: string; submit: boolean; input: string }> {
  return smokeChooseSlashCommandInputWithEnter("/mo");
}

export async function smokeRouteOpenTuiStartCommand(): Promise<{ started: string[]; resumed: string[]; fresh: string[] }> {
  const transcript = new TuiTranscriptSource();
  const calls: { started: string[]; resumed: string[]; fresh: string[] } = { started: [], resumed: [], fresh: [] };
  const authManager = {
    async listAccounts() {
      return [];
    },
    async activeAccount() {
      return null;
    },
  } as unknown as CodexAuthManager;

  await handleOpenTuiCommand({
    commandLine: "/start saved-run",
    project: "C:\\repo",
    runId: "default",
    mode: "managed",
    authManager,
    transcript,
    publishTranscript: () => {},
    supervisorTask: null,
    status: {},
    interactions: [],
    startSavedRun: async (runId) => {
      calls.started.push(runId);
    },
    resumeSavedRun: async (runId) => {
      calls.resumed.push(runId);
    },
    startFreshSession: async (prompt) => {
      calls.fresh.push(prompt ?? "");
    },
  });

  return calls;
}

async function smokeChooseSlashCommandInputWithEnter(inputValue: string): Promise<{ command: string; submit: boolean; input: string }> {
  let prompt: TextareaRenderable | undefined;
  let command = "";
  let submit = false;
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="default"
      mode="managed"
      transcript={["system: slash enter smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "idle" }}
      interactions={[]}
      inputValue={inputValue}
      promptInputReady={(textarea) => {
        prompt = textarea;
      }}
      onCommandChoice={(suggestion, textarea, shouldSubmit) => {
        command = `/${suggestion.name}`;
        submit = shouldSubmit;
        if (shouldSubmit) {
          textarea.setText("");
        }
      }}
    />
  ), { width: 96, height: 30 });
  await setup.renderOnce();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  if (!prompt) {
    throw new Error("OpenTUI prompt textarea was not mounted.");
  }
  setup.mockInput.pressEnter();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  const result = { command, submit, input: prompt.plainText };
  setup.renderer.destroy();
  return result;
}

function fakeRunSession(runId: string, threadId: string, classification: string, updatedAt: string): RunSessionSummary {
  return {
    runId,
    root: `C:\\repo\\.supercodex\\runtime\\runs\\${runId}`,
    hasSession: true,
    hasRuntime: true,
    threadId,
    sessionId: threadId,
    turnId: null,
    status: "finished",
    classification,
    updatedAt,
    mtimeMs: Date.parse(updatedAt),
  };
}

export async function smokeSubmitOpenTuiPromptMultiline(): Promise<string> {
  let submitted = "";
  let prompt: TextareaRenderable | undefined;
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["system: compose a multiline prompt"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "idle" }}
      interactions={[]}
      promptInputReady={(textarea) => {
        prompt = textarea;
      }}
      onSubmit={(value) => {
        submitted = value;
      }}
    />
  ), { width: 100, height: 30, otherModifiersMode: true });
  await setup.renderOnce();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  if (!prompt) {
    throw new Error("OpenTUI prompt textarea was not mounted.");
  }
  prompt.insertText("first line");
  prompt.newLine();
  prompt.insertText("second line");
  prompt.submit();
  await setup.renderOnce();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  setup.renderer.destroy();
  return submitted;
}

export async function smokeRenderOpenTuiLongTranscript(): Promise<string> {
  const transcript = Array.from({ length: 80 }, (_, index) =>
    index === 79
      ? "[operator] final visible message with enough words to exercise OpenTUI word wrapping inside the session scrollbox"
      : `[codex item] transcript line ${index.toString().padStart(2, "0")}`,
  );
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={transcript}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiStructuredMessages(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={[]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      messages={[
        {
          id: "user-1",
          role: "user",
          title: "user",
          status: "completed",
          parts: [{ id: "user-1-part-1", type: "text", text: "please run the checks" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          title: "assistant",
          status: "completed",
          parts: [{ id: "assistant-1-part-1", type: "text", text: "running verification\n\nfirst paragraph stays first\nsecond paragraph stays second" }],
        },
        {
          id: "cmd-1",
          role: "command",
          title: "command",
          status: "completed",
          parts: [
            { id: "cmd-1-part-1", type: "command", text: "npm test" },
            { id: "cmd-1-part-2", type: "command-output", text: "48 passed" },
          ],
        },
        {
          id: "file-1",
          role: "file",
          title: "file change",
          status: "completed",
          parts: [{ id: "file-1-part-1", type: "file-change", text: "updated src/opentui/message-list.tsx" }],
        },
      ]}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
    />
  ), { width: 110, height: 34 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiMixedWidthAssistantText(): Promise<string> {
  const text = "对齐结果里有一个实际不一致：`.supercodex` 已标记交付并记录 commit/push，但三份要求严格遵守的架构/迁移文档仍写着 S18-T4 “open/pending”。这不是重新规划问题，是交付证据回写漏项；我会把这些文档和轻量假设同步到当前已交付状态，然后跑边界/文档卫生验证。";
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="mixed-width"
      mode="managed"
      transcript={[]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      messages={[
        {
          id: "assistant-mixed-width",
          role: "assistant",
          title: "assistant",
          status: "completed",
          parts: [{ id: "assistant-mixed-width-part-1", type: "text", text }],
        },
      ]}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiResponsiveMetadata(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["metadata stays visible"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      messages={[
        {
          id: "assistant-1",
          role: "assistant",
          title: "assistant",
          status: "completed",
          parts: [{ id: "assistant-1-part-1", type: "text", text: "metadata stays visible" }],
        },
      ]}
      status={{
        mode: "execution",
        phase: "execution",
        stage: "stage-22",
        task: "S22-T3",
        settings: { model: "gpt-5.5", reasoningEffort: "xhigh" },
        runtimeStatus: "running",
        activeAuth: "account-2",
        threadId: "019dded9-4175-7eb0-8037-28b6fcf8fede",
        turnId: "019dded9-4196-7042-aa41-dab9021cc7c4",
      }}
      interactions={[]}
    />
  ), { width: 72, height: 28 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiPrefersCanonicalTranscriptLines(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["canonical line from transcript"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      messages={[
        {
          id: "stale-message",
          role: "assistant",
          title: "assistant",
          status: "completed",
          parts: [{ id: "stale-message-part", type: "text", text: "stale structured message" }],
        },
      ]}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiDialogHost(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["dialog host smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
      dialogs={[
        {
          id: "dialog-1",
          title: "Dialog Host",
          body: "Reusable overlay stack is active.",
          kind: "permission",
          actions: [
            { id: "cancel", label: "Cancel", variant: "muted" },
            { id: "continue", label: "Continue", variant: "primary" },
          ],
        },
      ]}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiToastsAndErrorBoundary(): Promise<string> {
  const toastSetup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["toast smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
      toasts={[{ id: "toast-1", message: "Saved settings", variant: "success" }]}
    />
  ), { width: 100, height: 30 });
  await toastSetup.renderOnce();
  const toastFrame = toastSetup.captureCharFrame();
  toastSetup.renderer.destroy();

  const errorSetup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["error smoke"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "running" }}
      interactions={[]}
      forceError="render failure"
    />
  ), { width: 100, height: 30 });
  await errorSetup.renderOnce();
  const errorFrame = errorSetup.captureCharFrame();
  errorSetup.renderer.destroy();
  return `${toastFrame}\n---error---\n${errorFrame}`;
}

export async function smokeRenderOpenTuiCustomTheme(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="smoke"
      mode="managed"
      transcript={["theme config smoke"]}
      tuiConfig={{
        theme: "opencode",
        themeMode: "light",
        resolvedMode: "light",
        mouse: false,
        targetFps: 30,
        colors: { primary: "#3b7dd8", panel: "#f5f5f5" },
        sourceFiles: ["C:\\repo\\.supercodex\\tui.json"],
      }}
      status={{ mode: "execution", phase: "execution", settings: { model: "gpt-5.5" }, runtimeStatus: "idle" }}
      interactions={[]}
    />
  ), { width: 100, height: 30 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeRenderOpenTuiViewportMatrix(): Promise<string> {
  const frames: string[] = [];
  const sizes = [
    { width: 60, height: 22 },
    { width: 96, height: 30 },
    { width: 140, height: 42 },
  ];
  for (const size of sizes) {
    const setup = await testRender(() => (
      <AgentSupervisorOpenTuiView
        project="C:\\repo"
        runId={`matrix-${size.width}x${size.height}`}
        mode="managed"
        inputValue="matrix input"
        transcript={Array.from({ length: 64 }, (_, index) => `matrix ${size.width}x${size.height} transcript ${index}`)}
        messages={[
          {
            id: `matrix-message-${size.width}`,
            role: "assistant",
            title: "assistant",
            status: "completed",
            parts: [{ id: "part-1", type: "text", text: `matrix ${size.width}x${size.height} message block stays framed` }],
          },
        ]}
        tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
        status={{
          mode: "execution",
          phase: "execution",
          stage: "stage-24",
          task: "S24-T3",
          settings: { model: "gpt-5.5", reasoningEffort: "xhigh" },
          runtimeStatus: "running",
        }}
        interactions={[]}
        dialogs={[
          {
            id: `matrix-dialog-${size.width}`,
            title: "Viewport Matrix",
            body: `Dialog remains inside ${size.width}x${size.height}.`,
            kind: "info",
            actions: [{ id: "close", label: "Close", variant: "primary" }],
          },
        ]}
        toasts={[{ id: `matrix-toast-${size.width}`, message: "Matrix toast", variant: "info" }]}
      />
    ), size);
    await setup.renderOnce();
    frames.push(setup.captureCharFrame());
    setup.renderer.destroy();
  }
  return frames.join("\n---viewport---\n");
}

export async function smokeRenderOpenTuiRunningControls(): Promise<string> {
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="running-controls"
      mode="managed"
      transcript={["[operator] inspect runtime state", "[codex turn] running"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{
        mode: "execution",
        phase: "execution",
        settings: { model: "gpt-5.5", reasoningEffort: "xhigh" },
        runtimeStatus: "running",
        supervisorActive: true,
      }}
      interactions={[]}
      supervisorActive={true}
      picker={stopConfirmationPicker()}
    />
  ), { width: 110, height: 32 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

export async function smokeOperateStopPickerWithKeyboard(): Promise<{ action: string; frame: string }> {
  let action = "";
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="running-controls"
      mode="managed"
      transcript={["[codex turn] running"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{
        mode: "execution",
        phase: "execution",
        settings: { model: "gpt-5.5", reasoningEffort: "xhigh" },
        runtimeStatus: "running",
        supervisorActive: true,
      }}
      interactions={[]}
      supervisorActive={true}
      picker={stopConfirmationPicker()}
      onPickerChoice={(optionId) => {
        action = optionId;
      }}
    />
  ), { width: 110, height: 32 });
  await setup.renderOnce();
  setup.mockInput.pressArrow("down");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.mockInput.pressEnter();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  setup.renderer.destroy();
  return { action, frame };
}

export async function smokeOperateCodexInteractionPickerWithKeyboard(): Promise<{ choice: string; frame: string }> {
  let choice = "";
  const setup = await testRender(() => (
    <AgentSupervisorOpenTuiView
      project="C:\\repo"
      runId="interaction-controls"
      mode="managed"
      transcript={["[codex turn] awaiting approval"]}
      tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
      status={{
        mode: "execution",
        phase: "execution",
        settings: { model: "gpt-5.5", reasoningEffort: "xhigh" },
        runtimeStatus: "running",
        supervisorActive: true,
      }}
      interactions={[
        {
          id: "interaction-approval",
          requestId: 8,
          method: "item/commandExecution/requestApproval",
          status: "pending",
          title: "Command Approval",
          summary: "npm test",
          choices: [
            { id: "accept", label: "accept", response: { decision: "accept" } },
            { id: "accept-session", label: "accept for session", response: { decision: "acceptForSession" } },
            { id: "decline", label: "decline", response: { decision: "decline" } },
          ],
          params: {},
          createdAt: "2026-05-01T00:00:00.000Z",
          respondedAt: null,
          handledAt: null,
        },
      ]}
      supervisorActive={true}
      onInteractionChoice={(choiceId) => {
        choice = choiceId;
      }}
    />
  ), { width: 110, height: 32 });
  await setup.renderOnce();
  setup.mockInput.pressArrow("down");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.mockInput.pressEnter();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  await setup.renderOnce();
  setup.renderer.destroy();
  return { choice, frame };
}

export async function smokeRenderOpenTuiTranscriptUpdateBurst(): Promise<{ frame: string; durationMs: number }> {
  let setLines!: (lines: string[]) => void;
  let setMessages!: (messages: TuiMessage[]) => void;
  const BurstView = () => {
    const [lines, updateLines] = createSignal(["burst update 0"]);
    const [messages, updateMessages] = createSignal<TuiMessage[]>([]);
    setLines = updateLines;
    setMessages = updateMessages;
    return (
      <AgentSupervisorOpenTuiView
        project="C:\\repo"
        runId="burst"
        mode="managed"
        transcript={lines()}
        messages={messages()}
        tuiConfig={{ theme: "opencode", themeMode: "dark", resolvedMode: "dark" }}
        status={{
          mode: "execution",
          phase: "execution",
          stage: "stage-24",
          task: "S24-T3",
          settings: { model: "gpt-5.5" },
          runtimeStatus: "running",
        }}
        interactions={[]}
      />
    );
  };
  const setup = await testRender(() => <BurstView />, { width: 110, height: 32 });
  await setup.renderOnce();
  const start = performance.now();
  for (let index = 1; index <= 24; index++) {
    setLines(Array.from({ length: 40 }, (_, line) => `burst update ${index} line ${line}`));
    setMessages([
      {
        id: `burst-${index}`,
        role: "assistant",
        title: "assistant",
        status: "running",
        parts: [{ id: `burst-${index}-part`, type: "text", text: `burst update ${index} message remains stable` }],
      },
    ]);
    await setup.renderOnce();
  }
  const durationMs = performance.now() - start;
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return { frame, durationMs };
}

function OpenTuiRuntime(props: {
  project: string;
  initialRunId: string;
  mode: Mode;
  authManager: CodexAuthManager;
  appServerOptions: AppServerOptions;
  onExit: () => void | Promise<void>;
}) {
  const renderer = useRenderer();
  const transcript = new TuiTranscriptSource();
  const [runId, setRunId] = createSignal(props.mode === "managed" ? createFreshRunId() : props.initialRunId);
  const [activeRunStarted, setActiveRunStarted] = createSignal(props.mode !== "managed");
  const [activeRunIsResume, setActiveRunIsResume] = createSignal(false);
  const [transcriptLines, setTranscriptLines] = createSignal<string[]>([]);
  const [transcriptMessages, setTranscriptMessages] = createSignal<TuiMessage[]>([]);
  const [status, setStatus] = createSignal<JsonObject>({});
  const [tuiConfig, setTuiConfig] = createSignal<AgentTuiConfig>();
  const [interactions, setInteractions] = createSignal<InteractionRecord[]>([]);
  const [supervisorTask, setSupervisorTask] = createSignal<Promise<number> | null>(null);
  const [dialogs, setDialogs] = createSignal<AgentDialogRecord[]>([]);
  const [picker, setPicker] = createSignal<AgentPickerRecord | null>(null);
  const [pickerSelection, setPickerSelection] = createSignal(0);
  const [toasts, setToasts] = createSignal<AgentToastRecord[]>([]);
  const [pollTimer, setPollTimer] = createSignal<ReturnType<typeof setInterval> | null>(null);
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pollMs = Number(process.env.SUPERCODEX_POLL_MS ?? "500");
  const publishTranscript = () => {
    const transcriptSnapshot = transcript.snapshot();
    setTranscriptLines(transcriptSnapshot.lines);
    setTranscriptMessages(transcriptSnapshot.messages);
  };
  const dismissToast = (toastId: string) => {
    const timer = toastTimers.get(toastId);
    if (timer) clearTimeout(timer);
    toastTimers.delete(toastId);
    setToasts((current) => removeToastById(current, toastId));
    renderer.requestRender();
  };
  const showToast = (message: string, variant: AgentToastRecord["variant"] = "info", ttlMs = DEFAULT_TOAST_TTL_MS) => {
    const toastId = pushToast(setToasts, message, variant);
    if (ttlMs > 0) {
      const timer = setTimeout(() => dismissToast(toastId), ttlMs);
      toastTimers.set(toastId, timer);
    }
    renderer.requestRender();
  };

  const refresh = async () => {
    const snapshot = await loadSnapshotForRun(props.project, runId());
    const runtime = await loadSupervisorRuntime(props.project, runId());
    const session = snapshot.supervisorSession;
    const nativeSessionPath = firstString(session.nativeSessionPath, runtime.nativeSessionPath);
    const eventLogPath = firstString(runtime.eventLogPath, session.lastEventLog);
    const stderrPath = firstString(runtime.stderrPath, session.lastStderrLog);
    await transcript.sync({ nativeSessionPath, eventLogPath, stderrPath });
    const work = chooseNextWork(snapshot);
    const pending = await readPendingInteractions(props.project, runId());
    const currentTuiConfig = await readAgentTuiConfig(props.project, runId());
    setInteractions(pending);
    setTuiConfig(currentTuiConfig);
    publishTranscript();
    setStatus({
      done: snapshot.done,
      mode: snapshot.state.mode ?? (props.mode === "managed" && !activeRunStarted() ? "fresh" : null),
      phase: snapshot.state.phase ?? (props.mode === "managed" && !activeRunStarted() ? "idle" : null),
      runId: runId(),
      stage: snapshot.supervisorSession.stage_id ?? snapshot.state.currentStageId ?? work.stageId ?? null,
      task: snapshot.supervisorSession.task_id ?? snapshot.state.currentTaskId ?? work.taskId ?? null,
      nextWork: work.title,
      runtimeStatus: runtime.status ?? (activeRunStarted() ? "unknown" : "idle"),
      supervisorActive: Boolean(supervisorTask()),
      threadId: runtime.thread_id ?? null,
      turnId: runtime.turn_id ?? null,
      settings: await readSupervisorSettings(props.project, runId()),
      tuiConfig: currentTuiConfig,
      effectiveCodexConfig: await readEffectiveCodexConfig(props.authManager),
      activeAuth: await props.authManager.activeAccount(),
    });
    renderer.requestRender();
  };

  createEffect(() => {
    applyTerminalTitle(renderer, terminalTitleForRun({
      project: props.project,
      runId: runId(),
      mode: props.mode,
      stage: String(status().stage ?? ""),
      task: String(status().task ?? ""),
    }));
  });

  onMount(() => {
    transcript.appendLocal(
      props.mode === "managed"
        ? "OpenTUI managed frontend ready. Type a goal to start a fresh run, or /start [run-id] to resume."
        : "OpenTUI attach frontend ready. Type an intervention or / command.",
    );
    publishTranscript();
    void refresh();
    const timer = setInterval(() => void refresh().catch((error) => appendLocal(transcript, publishTranscript, `[ui error] ${formatError(error)}`)), Math.max(200, pollMs));
    setPollTimer(timer);
  });

  onCleanup(() => {
    const timer = pollTimer();
    if (timer) clearInterval(timer);
    for (const toastTimer of toastTimers.values()) {
      clearTimeout(toastTimer);
    }
    toastTimers.clear();
    restoreTerminalTitle(renderer);
    void win32FlushInputBuffer();
  });

  const submit = async (rawValue: string) => {
    const value = rawValue.trim();
    if (!value) return;
    if (value.startsWith("/")) {
      await submitCommand(value);
      return;
    }
    appendUser(transcript, publishTranscript, value);
    if (props.mode === "managed") {
      let action = managedPlainTextAction({
        supervisorRunning: Boolean(supervisorTask()),
        activeRunStarted: activeRunStarted(),
        activeRunIsResume: activeRunIsResume(),
      });
      if (action === "new_goal") {
        const previousRunId = runId();
        const nextRunId = createFreshRunId();
        setRunId(nextRunId);
        await copySupervisorSessionPreferences(props.project, previousRunId, nextRunId);
        transcript.reset();
        appendUser(transcript, publishTranscript, value);
        action = "initial_goal";
      }
      if (action === "initial_goal") {
        setActiveRunStarted(true);
        setSupervisorTask(startSupervisor({
          project: props.project,
          runId: runId(),
          goalOrInstruction: value,
          operatorIntervention: false,
          authManager: props.authManager,
          appServerOptions: props.appServerOptions,
          transcript,
          publishTranscript,
          clearTask: () => setSupervisorTask(null),
        }));
        return;
      }
      await requestSteer(props.project, value, runId());
      setActiveRunStarted(true);
      if (!supervisorTask()) {
        setSupervisorTask(startSupervisor({
          project: props.project,
          runId: runId(),
          goalOrInstruction: "",
          operatorIntervention: true,
          authManager: props.authManager,
          appServerOptions: props.appServerOptions,
          transcript,
          publishTranscript,
          clearTask: () => setSupervisorTask(null),
        }));
      }
      return;
    }
    const request = await requestSteer(props.project, value, runId());
    appendLocal(transcript, publishTranscript, `[supercodex] queued steering message ${request.id}`);
  };

  const choose = async (choiceId: string) => {
    const interaction = interactions()[0];
    if (!interaction) return;
    const response = await chooseInteraction(props.project, interaction.id, choiceId, runId());
    appendLocal(transcript, publishTranscript, `[supercodex] answered interaction ${response.id} with ${response.choiceId ?? choiceId}`);
    await refresh();
  };

  const chooseCommand = async (suggestion: SlashCommandSuggestion, textarea: TextareaRenderable, submit: boolean) => {
    const text = suggestion.insertText ?? `/${suggestion.name}`;
    if (!submit || suggestion.requiresArgument) {
      textarea.setText(text);
      textarea.gotoBufferEnd();
      textarea.getLayoutNode().markDirty();
      setTimeout(() => {
        if (!textarea.isDestroyed) {
          textarea.focus();
          textarea.gotoBufferEnd();
        }
      }, 0);
      return;
    }
    textarea.setText("");
    textarea.getLayoutNode().markDirty();
    await submitCommand(`/${suggestion.name}`);
  };

  const resumeSavedRun = async (selectedRunId: string) => {
    closePicker();
    if (props.mode !== "managed") {
      appendLocal(transcript, publishTranscript, "Attach mode can inspect sessions, but only managed TUI can resume one.");
      return;
    }
    if (supervisorTask()) {
      appendLocal(transcript, publishTranscript, "Supervisor is already running; wait for it to stop or interrupt it before switching sessions.");
      return;
    }
    const selected = resolveRunSessionSelector(await listRunSessions(props.project), selectedRunId);
    const prepared = selected ? await prepareRunSessionForResume(props.project, selected) : null;
    const nextRunId = sanitizeRunId(prepared?.runId ?? selectedRunId);
    setRunId(nextRunId);
    setActiveRunStarted(true);
    setActiveRunIsResume(true);
    transcript.reset();
    appendLocal(transcript, publishTranscript, resumeSelectionMessage(nextRunId));
    await transcript.sync({ nativeSessionPath: prepared?.nativePath });
    publishTranscript();
    await refresh();
  };

  const startSavedRun = async (selectedRunId: string) => {
    closePicker();
    if (props.mode !== "managed") {
      appendLocal(transcript, publishTranscript, "Attach mode cannot start a SuperCodex run. Use managed TUI for /start.");
      return;
    }
    if (supervisorTask()) {
      appendLocal(transcript, publishTranscript, "Supervisor is already running; wait for it to stop or interrupt it before switching sessions.");
      return;
    }
    const selected = resolveRunSessionSelector(await listRunSessions(props.project), selectedRunId);
    const prepared = selected ? await prepareRunSessionForResume(props.project, selected) : null;
    const nextRunId = sanitizeRunId(prepared?.runId ?? selectedRunId);
    setRunId(nextRunId);
    setActiveRunStarted(true);
    setActiveRunIsResume(true);
    transcript.reset();
    appendLocal(transcript, publishTranscript, `[supercodex] starting saved session ${nextRunId}.`);
    await transcript.sync({ nativeSessionPath: prepared?.nativePath });
    publishTranscript();
    setSupervisorTask(startSupervisor({
      project: props.project,
      runId: nextRunId,
      goalOrInstruction: "",
      operatorIntervention: false,
      authManager: props.authManager,
      appServerOptions: props.appServerOptions,
      transcript,
      publishTranscript,
      clearTask: () => setSupervisorTask(null),
    }));
  };

  const startFreshSession = async (prompt = "") => {
    closePicker();
    if (props.mode !== "managed") {
      appendLocal(transcript, publishTranscript, "Attach mode cannot create a new session. Use managed TUI for /new.");
      return;
    }
    if (supervisorTask()) {
      appendLocal(transcript, publishTranscript, "Supervisor is already running; interrupt or wait before starting a new session.");
      return;
    }
    const previousRunId = runId();
    const nextRunId = createFreshRunId();
    setRunId(nextRunId);
    setActiveRunStarted(false);
    setActiveRunIsResume(false);
    await copySupervisorSessionPreferences(props.project, previousRunId, nextRunId);
    transcript.reset();
    appendLocal(transcript, publishTranscript, `[supercodex] new session ${nextRunId}.`);
    const value = prompt.trim();
    if (!value) {
      await refresh();
      return;
    }
    appendUser(transcript, publishTranscript, value);
    setActiveRunStarted(true);
    setSupervisorTask(startSupervisor({
      project: props.project,
      runId: nextRunId,
      goalOrInstruction: value,
      operatorIntervention: false,
      authManager: props.authManager,
      appServerOptions: props.appServerOptions,
      transcript,
      publishTranscript,
      clearTask: () => setSupervisorTask(null),
    }));
  };

  const showResumePicker = (sessions: RunSessionSummary[]) => {
    openPicker(resumeSessionsPicker(sessions, runId()));
  };

  const showModelPicker = () => {
    openPicker(modelPicker(readModelFromStatus(status())));
  };

  const showReasoningPicker = () => {
    openPicker(reasoningEffortPicker(readReasoningFromStatus(status())));
  };

  const showAuthPicker = (accounts: string[], active: string | null) => {
    openPicker(authAccountPicker(accounts, active));
  };

  const showPermissionsPicker = () => {
    openPicker(permissionsPresetPicker(status()));
  };

  const showSandboxPicker = () => {
    openPicker(sandboxModePicker(readSandboxFromStatus(status())));
  };

  const showApprovalPicker = () => {
    openPicker(approvalPolicyPicker(readApprovalFromStatus(status())));
  };

  const openPicker = (record: AgentPickerRecord) => {
    setPickerSelection(0);
    setPicker(record);
    renderer.requestRender();
  };

  const closePicker = () => {
    setPicker(null);
    renderer.requestRender();
  };

  const choosePickerOption = async (optionId: string) => {
    const current = picker();
    closePicker();
    if (!current) return;
    if (current.id === "stop-supervisor") {
      if (optionId !== "stop") {
        return;
      }
      const request = await requestTurnInterrupt(props.project, "", runId());
      appendLocal(transcript, publishTranscript, `[supercodex] stop requested ${request.id}`);
      showToast("Stop requested for the active Codex turn.", "warning");
      await refresh();
      return;
    }
    if (current.id === "resume-sessions") {
      await resumeSavedRun(optionId);
      return;
    }
    if (current.id === "codex-model") {
      await submitCommand(`/model ${optionId}`);
      return;
    }
    if (current.id === "reasoning-effort") {
      await submitCommand(`/reasoning ${optionId}`);
      return;
    }
    if (current.id === "auth-account") {
      await submitCommand(`/auth ${optionId}`);
      return;
    }
    if (current.id === "permissions-preset") {
      await submitCommand(`/permissions ${optionId}`);
      return;
    }
    if (current.id === "sandbox-mode") {
      await submitCommand(`/sandbox ${optionId}`);
      return;
    }
    if (current.id === "approval-policy") {
      await submitCommand(`/approval ${optionId}`);
    }
  };

  const submitCommand = async (commandLine: string) => {
    await handleOpenTuiCommand({
      commandLine,
      project: props.project,
      runId: runId(),
      mode: props.mode,
      authManager: props.authManager,
      transcript,
      publishTranscript,
      supervisorTask: supervisorTask(),
      status: status(),
      interactions: interactions(),
      startSavedRun,
      resumeSavedRun,
      startFreshSession,
      showResumePicker,
      showModelPicker,
      showReasoningPicker,
      showAuthPicker,
      showPermissionsPicker,
      showSandboxPicker,
      showApprovalPicker,
    });
    await refresh();
  };

  const requestStop = () => {
    if (!isRuntimeActive(status()) && !supervisorTask()) {
      showToast("No active Codex turn is running.", "info");
      return;
    }
    openPicker(stopConfirmationPicker());
  };

  const closeDialog = (dialog: AgentDialogRecord) => {
    setDialogs((current) => current.filter((item) => item.id !== dialog.id));
  };

  const chooseDialogAction = async (dialog: AgentDialogRecord, action: AgentDialogAction) => {
    closeDialog(dialog);
    void action;
  };

  return (
    <AgentSupervisorOpenTuiView
      project={props.project}
      runId={runId()}
      mode={props.mode}
      transcript={transcriptLines()}
      messages={transcriptMessages()}
      tuiConfig={tuiConfig()}
      status={status()}
      interactions={interactions()}
      dialogs={dialogs()}
      picker={picker()}
      pickerSelection={pickerSelection()}
      toasts={toasts()}
      supervisorActive={Boolean(supervisorTask())}
      onSubmit={submit}
      onCommandChoice={chooseCommand}
      onInteractionChoice={choose}
      onDialogClose={closeDialog}
      onDialogAction={chooseDialogAction}
      onPickerSelection={setPickerSelection}
      onPickerChoice={choosePickerOption}
      onPickerClose={closePicker}
      onSelectionCopied={(copied) =>
        appendLocal(transcript, publishTranscript, copied ? "[supercodex] copied selection to clipboard" : "[supercodex] no selection to copy")
      }
      onStopRequest={requestStop}
      onExit={props.onExit}
    />
  );
}

async function handleOpenTuiCommand(input: {
  commandLine: string;
  project: string;
  runId: string;
  mode: Mode;
  authManager: CodexAuthManager;
  transcript: TuiTranscriptSource;
  publishTranscript: () => void;
  supervisorTask: Promise<number> | null;
  status: JsonObject;
  interactions: InteractionRecord[];
  resumeSavedRun: (runId: string) => void | Promise<void>;
  startSavedRun: (runId: string) => void | Promise<void>;
  startFreshSession: (prompt?: string) => void | Promise<void>;
  showResumePicker?: (sessions: RunSessionSummary[]) => void;
  showModelPicker?: () => void;
  showReasoningPicker?: () => void;
  showAuthPicker?: (accounts: string[], active: string | null) => void;
  showPermissionsPicker?: () => void;
  showSandboxPicker?: () => void;
  showApprovalPicker?: () => void;
}): Promise<void> {
  const parsed = parseSlashCommand(input.commandLine);
  switch (parsed.command) {
    case "":
    case "help":
      appendLocal(input.transcript, input.publishTranscript, "Commands: /new [prompt], /start [run-id], /model <name>, /reasoning <effort>, /auth <name>, /permissions, /sandbox, /approval, /interrupt [prompt], /pause, /resume, /approve, /deny, /answer <text>, /exit");
      return;
    case "status":
      appendLocal(input.transcript, input.publishTranscript, JSON.stringify(input.status, null, 2));
      return;
    case "runs":
      appendLocal(input.transcript, input.publishTranscript, JSON.stringify(await runSessionsPayload(input.project), null, 2));
      return;
    case "interactions":
      appendLocal(input.transcript, input.publishTranscript, JSON.stringify(input.interactions.map(summarizeOpenTuiInteraction), null, 2));
      return;
    case "exit":
    case "quit":
      process.exitCode = 0;
      process.kill(process.pid, "SIGINT");
      return;
    case "start": {
      if (input.mode !== "managed") {
        appendLocal(input.transcript, input.publishTranscript, "Attach mode cannot start a SuperCodex run. Use supercodex tui for managed mode.");
        return;
      }
      await input.startSavedRun(parsed.arg ? sanitizeRunId(parsed.arg) : "default");
      return;
    }
    case "new":
      await input.startFreshSession(parsed.arg);
      return;
    case "model":
      if (!parsed.arg && input.showModelPicker) {
        input.showModelPicker();
        return;
      }
      if (!parsed.arg) {
        appendLocal(input.transcript, input.publishTranscript, "Use /model <name> or select a model from the OpenTUI picker.");
        return;
      }
      await patchSupervisorSettings(input.project, { model: parsed.arg }, input.runId);
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] model set for next turn: ${parsed.arg}`);
      return;
    case "reasoning":
      if (!parsed.arg && input.showReasoningPicker) {
        input.showReasoningPicker();
        return;
      }
      await patchSupervisorSettings(input.project, { reasoningEffort: parseReasoningEffort(parsed.arg) }, input.runId);
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] reasoning set for next turn: ${parsed.arg}`);
      return;
    case "auth": {
      if (!parsed.arg) {
        const [accounts, active] = await Promise.all([input.authManager.listAccounts(), input.authManager.activeAccount()]);
        if (input.showAuthPicker) {
          input.showAuthPicker(accounts, active);
          return;
        }
        appendLocal(input.transcript, input.publishTranscript, JSON.stringify({ accounts, active }, null, 2));
        return;
      }
      if (shouldApplyAuthImmediately(input.supervisorTask, input.status)) {
        await input.authManager.useAccount(parsed.arg);
        await patchSupervisorSettings(input.project, { pendingAuthName: null }, input.runId);
        appendLocal(input.transcript, input.publishTranscript, `[supercodex] auth switched immediately: ${await input.authManager.activeAccount()}`);
        return;
      }
      await patchSupervisorSettings(input.project, { pendingAuthName: parsed.arg }, input.runId);
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] auth set for next turn: ${parsed.arg}`);
      return;
    }
    case "permissions":
    case "permission":
    case "perms":
      if (!parsed.arg && input.showPermissionsPicker) {
        input.showPermissionsPicker();
        return;
      }
      if (!parsed.arg) {
        appendLocal(input.transcript, input.publishTranscript, formatPermissionsHelp(input.status));
        return;
      }
      {
        const next = await patchSupervisorSettings(input.project, parsePermissionSetting(parsed.arg), input.runId);
        await persistCodexRuntimePreferences(input.project, input.authManager, next);
        appendLocal(input.transcript, input.publishTranscript, `[supercodex] permissions set for next turn: sandbox=${next.sandbox ?? defaultAppServerOptions.sandbox} approval=${next.approvalPolicy ?? defaultAppServerOptions.approvalPolicy}`);
      }
      return;
    case "sandbox":
      if (!parsed.arg && input.showSandboxPicker) {
        input.showSandboxPicker();
        return;
      }
      if (!parsed.arg) {
        appendLocal(input.transcript, input.publishTranscript, formatPermissionsHelp(input.status));
        return;
      }
      {
        const next = await patchSupervisorSettings(input.project, { sandbox: parseSandboxMode(parsed.arg) }, input.runId);
        await persistCodexRuntimePreferences(input.project, input.authManager, next);
        appendLocal(input.transcript, input.publishTranscript, `[supercodex] sandbox set for next turn: ${next.sandbox}`);
      }
      return;
    case "approval":
    case "ask-for-approval":
      if (!parsed.arg && input.showApprovalPicker) {
        input.showApprovalPicker();
        return;
      }
      if (!parsed.arg) {
        appendLocal(input.transcript, input.publishTranscript, formatPermissionsHelp(input.status));
        return;
      }
      {
        const next = await patchSupervisorSettings(input.project, { approvalPolicy: parseApprovalPolicy(parsed.arg) }, input.runId);
        await persistCodexRuntimePreferences(input.project, input.authManager, next);
        appendLocal(input.transcript, input.publishTranscript, `[supercodex] approval set for next turn: ${next.approvalPolicy}`);
      }
      return;
    case "interrupt": {
      const request = await requestTurnInterrupt(input.project, parsed.arg, input.runId);
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] interrupt queued ${request.id}`);
      return;
    }
    case "pause":
      await patchSupervisorSettings(input.project, { paused: true }, input.runId);
      appendLocal(input.transcript, input.publishTranscript, "[supercodex] run will pause before the next turn.");
      return;
    case "resume": {
      if (parsed.arg === "current" || parsed.arg === "--current") {
        await patchSupervisorSettings(input.project, { paused: false }, input.runId);
        appendLocal(input.transcript, input.publishTranscript, "[supercodex] current run resumed from pause.");
        return;
      }
      const sessions = await listRunSessions(input.project);
      if (!parsed.arg) {
        if (input.showResumePicker) {
          input.showResumePicker(sessions);
          return;
        }
        appendLocal(input.transcript, input.publishTranscript, formatRunSessions(sessions));
        return;
      }
      const selected = resolveRunSessionSelector(sessions, parsed.arg);
      if (!selected) {
        appendLocal(input.transcript, input.publishTranscript, `No saved session matched "${parsed.arg}".\n${formatRunSessions(sessions)}`);
        return;
      }
      await input.resumeSavedRun(selected.runId);
      return;
    }
    case "fresh-next":
    case "fresh":
      await patchSupervisorSettings(input.project, { forceFreshNext: true }, input.runId);
      appendLocal(input.transcript, input.publishTranscript, "[supercodex] next cycle will start a fresh Codex thread.");
      return;
    case "approve":
    case "approve-session":
    case "deny":
    case "cancel": {
      const choice = parsed.command === "approve" ? "accept" : parsed.command === "approve-session" ? "accept-session" : parsed.command === "deny" ? "decline" : "cancel";
      const response = await chooseInteraction(input.project, parsed.arg || choice, parsed.arg ? choice : null, input.runId);
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] answered interaction ${response.id} with ${response.choiceId ?? choice}`);
      return;
    }
    case "answer": {
      const response = await answerInteraction(input.project, parsed.arg, null, input.runId);
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] answered interaction ${response.id} with freeform input`);
      return;
    }
    default:
      appendLocal(input.transcript, input.publishTranscript, `Unknown command: /${parsed.command}`);
  }
}

function summarizeOpenTuiInteraction(interaction: InteractionRecord): JsonObject {
  return {
    id: interaction.id,
    method: interaction.method,
    title: interaction.title,
    summary: interaction.summary,
    choices: interaction.choices.map((choice) => choice.id),
  };
}

function resumeSessionsPicker(sessions: RunSessionSummary[], currentRunId: string): AgentPickerRecord {
  return {
    id: "resume-sessions",
    title: "Slash commands > /resume",
    subtitle: "Resume Sessions - No.  Run ID  Thread  Status  Updated",
    currentId: currentRunId,
    options: sessions.map((session) => ({
      id: session.runId,
      label: session.runId,
      description: session.threadId ? `${session.source ?? "supercodex"} thread ${shortId(session.threadId)}` : `${session.source ?? "supercodex"} no saved thread`,
      footer: `${session.classification ?? session.status ?? "unknown"}  ${formatSessionUpdated(session.updatedAt, session.mtimeMs)}`,
    })),
    emptyMessage: "No saved Codex/SuperCodex sessions were found for this project.",
    footerText: "Up/Down select | Enter select | 1-9 quick select",
    placement: "anchor",
    minWidth: 56,
  };
}

function modelPicker(current: string | null): AgentPickerRecord {
  const models = withCurrentOption([
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2",
  ], current);
  return {
    id: "codex-model",
    title: "Slash commands > /model",
    subtitle: "Codex Model - select the model for the next Codex turn.",
    currentId: current,
    options: models.map((model) => ({
      id: model,
      label: model,
      description: model === current ? "current" : model.includes("mini") || model.includes("spark") ? "fast option" : "available option",
    })),
    footerText: "Up/Down select | Enter apply | Esc close",
    placement: "anchor",
    minWidth: 56,
  };
}

function reasoningEffortPicker(current: string | null): AgentPickerRecord {
  const efforts = ["minimal", "low", "medium", "high", "xhigh"];
  return {
    id: "reasoning-effort",
    title: "Slash commands > /reasoning",
    subtitle: "Reasoning Effort - select the next Codex turn effort.",
    currentId: current,
    options: efforts.map((effort) => ({
      id: effort,
      label: effort,
      description: effort === "xhigh" ? "extra high reasoning" : effort === "high" ? "deeper reasoning" : effort === "medium" ? "balanced default" : "faster response",
    })),
    footerText: "Up/Down select | Enter apply | Esc close",
    placement: "anchor",
    minWidth: 56,
  };
}

function authAccountPicker(accounts: string[], active: string | null): AgentPickerRecord {
  return {
    id: "auth-account",
    title: "Slash commands > /auth",
    subtitle: "Codex Auth Account - select the active or next-turn account.",
    currentId: active,
    options: accounts.map((account) => ({
      id: account,
      label: account,
      description: account === active ? "active" : "saved account",
    })),
    emptyMessage: "No saved Codex auth accounts were found.",
    footerText: "Up/Down select | Enter apply | Esc close",
    placement: "anchor",
    minWidth: 56,
  };
}

function permissionsPresetPicker(status: JsonObject): AgentPickerRecord {
  const current = `${readSandboxFromStatus(status)} ${readApprovalFromStatus(status)}`;
  const options = [
    { id: "default", label: "Default permissions", description: "normal default: danger-full-access, approval never" },
    { id: "auto-review", label: "Auto-review", description: "workspace-write, approval on-request" },
    { id: "full-access", label: "Full access", description: "danger-full-access, approval never" },
  ];
  return {
    id: "permissions-preset",
    title: "Slash commands > /permissions",
    subtitle: `Codex Permissions - ${permissionModeLabelFromStatus(status)} (${current})`,
    currentId: permissionModeIdFromStatus(status),
    options,
    footerText: "Up/Down select | Enter apply | Esc close",
    placement: "anchor",
    minWidth: 64,
  };
}

function sandboxModePicker(current: string): AgentPickerRecord {
  const modes = ["danger-full-access", "workspace-write", "read-only"];
  return {
    id: "sandbox-mode",
    title: "Slash commands > /sandbox",
    subtitle: "Codex Sandbox - select the next turn sandbox mode.",
    currentId: current,
    options: modes.map((mode) => ({
      id: mode,
      label: mode,
      description: mode === "danger-full-access" ? "no sandbox" : mode === "workspace-write" ? "workspace writes allowed" : "read-only filesystem",
    })),
    footerText: "Up/Down select | Enter apply | Esc close",
    placement: "anchor",
    minWidth: 64,
  };
}

function approvalPolicyPicker(current: string): AgentPickerRecord {
  const policies = ["never", "on-request", "on-failure", "untrusted"];
  return {
    id: "approval-policy",
    title: "Slash commands > /approval",
    subtitle: "Codex Approval - select when Codex asks before commands.",
    currentId: current,
    options: policies.map((policy) => ({
      id: policy,
      label: policy,
      description: policy === "never" ? "never ask" : policy === "on-request" ? "model may ask" : policy === "on-failure" ? "ask after failure" : "ask for untrusted commands",
    })),
    footerText: "Up/Down select | Enter apply | Esc close",
    placement: "anchor",
    minWidth: 64,
  };
}

function stopConfirmationPicker(): AgentPickerRecord {
  return {
    id: "stop-supervisor",
    title: "Stop Current Task?",
    subtitle: "Stop interrupts the active Codex turn through the SuperCodex control channel.",
    options: [
      { id: "stop", label: "Stop", description: "interrupt the active Codex turn", variant: "danger" },
      { id: "cancel", label: "Keep Running", description: "dismiss this prompt", variant: "muted" },
    ],
    footerText: "Up/Down select | Enter choose | Esc keep running",
    placement: "bottom",
    minWidth: 64,
    zIndex: 2850,
  };
}

function withCurrentOption(options: string[], current: string | null): string[] {
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

function readModelFromStatus(status: JsonObject): string | null {
  const settings = isObject(status.settings) ? status.settings : {};
  const effective = isObject(status.effectiveCodexConfig) ? status.effectiveCodexConfig : {};
  return firstString(settings.model, effective.model);
}

function readReasoningFromStatus(status: JsonObject): string | null {
  const settings = isObject(status.settings) ? status.settings : {};
  const effective = isObject(status.effectiveCodexConfig) ? status.effectiveCodexConfig : {};
  return firstString(settings.reasoningEffort, effective.reasoningEffort);
}

function readSandboxFromStatus(status: JsonObject): string {
  const settings = isObject(status.settings) ? status.settings : {};
  const effective = isObject(status.effectiveCodexConfig) ? status.effectiveCodexConfig : {};
  return firstString(settings.sandbox, effective.sandbox) ?? defaultAppServerOptions.sandbox;
}

function readApprovalFromStatus(status: JsonObject): string {
  const settings = isObject(status.settings) ? status.settings : {};
  const effective = isObject(status.effectiveCodexConfig) ? status.effectiveCodexConfig : {};
  return firstString(settings.approvalPolicy, effective.approvalPolicy) ?? defaultAppServerOptions.approvalPolicy;
}

function permissionModeIdFromStatus(status: JsonObject): string | undefined {
  const settings = isObject(status.settings) ? status.settings : {};
  const sandbox = readSandboxFromStatus(status);
  const approval = readApprovalFromStatus(status);
  if (!firstString(settings.sandbox, settings.approvalPolicy)) {
    return "default";
  }
  if (sandbox === "workspace-write" && approval === "on-request") {
    return "auto-review";
  }
  if (sandbox === "danger-full-access" && approval === "never") {
    return "full-access";
  }
  return undefined;
}

function permissionModeLabelFromStatus(status: JsonObject): string {
  const mode = permissionModeIdFromStatus(status);
  if (mode === "default") return "Default permissions";
  if (mode === "auto-review") return "Auto-review";
  if (mode === "full-access") return "Full access";
  return "Custom";
}

async function persistCodexRuntimePreferences(project: string, authManager: CodexAuthManager, settings: { model?: string | null; reasoningEffort?: AppServerOptions["reasoningEffort"] | null; sandbox?: AppServerOptions["sandbox"] | null; approvalPolicy?: AppServerOptions["approvalPolicy"] | null }): Promise<void> {
  await authManager.ensureHighAccessConfig(project, {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    sandbox: settings.sandbox,
    approvalPolicy: settings.approvalPolicy,
  });
}

function formatPermissionsHelp(status: JsonObject): string {
  return [
    `current permissions: ${permissionModeLabelFromStatus(status)}; sandbox=${readSandboxFromStatus(status)} approval=${readApprovalFromStatus(status)}`,
    "modes: /permissions default | auto-review | full-access",
    "labels: Default permissions | Auto-review | Full access",
    "advanced: /sandbox <mode> | /approval <policy>",
    "sandbox values: read-only, workspace-write, danger-full-access",
    "approval values: never, on-failure, on-request, untrusted",
  ].join("\n");
}

function formatSessionUpdated(updatedAt: string | null, mtimeMs: number): string {
  const raw = updatedAt ?? (mtimeMs > 0 ? new Date(mtimeMs).toISOString() : "unknown");
  if (raw === "unknown") return raw;
  return raw.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function resumeSelectionMessage(runId: string): string {
  const sanitized = sanitizeRunId(runId);
  return `[supercodex] selected saved session ${sanitized}. Type a message to continue it, or use /start ${sanitized} to auto-run saved work.`;
}

function startSupervisor(input: {
  project: string;
  runId: string;
  goalOrInstruction: string;
  operatorIntervention: boolean;
  authManager: CodexAuthManager;
  appServerOptions: AppServerOptions;
  transcript: TuiTranscriptSource;
  publishTranscript: () => void;
  clearTask: () => void;
}): Promise<number> {
  appendLocal(input.transcript, input.publishTranscript, `[supercodex] starting run ${input.runId}.`);
  const config = {
    ...defaultSupervisorConfig(input.project),
    goal: input.goalOrInstruction,
    runId: input.runId,
    authManager: input.authManager,
    operatorIntervention: input.operatorIntervention,
    appServerOptions: { ...input.appServerOptions, streamConsole: false },
    supervisorConsole: false,
  };
  const task = new Supervisor(config)
    .run()
    .then((code) => {
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] run stopped with code=${code}`);
      return code;
    })
    .catch((error) => {
      appendLocal(input.transcript, input.publishTranscript, `[supercodex] run failed: ${formatError(error)}`);
      return 1;
    })
    .finally(input.clearTask);
  return task;
}

function createFreshRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return sanitizeRunId(`session-${stamp}-${randomUUID().slice(0, 8)}`);
}

function appendLocal(transcript: TuiTranscriptSource, publishTranscript: () => void, message: string): void {
  transcript.appendLocal(message);
  publishTranscript();
}

function appendUser(transcript: TuiTranscriptSource, publishTranscript: () => void, message: string): void {
  transcript.appendUser(message);
  publishTranscript();
}

function parseSlashCommand(line: string): { command: string; arg: string } {
  const trimmed = line.slice(1).trim();
  const space = trimmed.search(/\s/);
  if (space < 0) {
    return { command: canonicalSlashCommandName(trimmed), arg: "" };
  }
  return { command: canonicalSlashCommandName(trimmed.slice(0, space)), arg: trimmed.slice(space).trim() };
}

function shouldApplyAuthImmediately(supervisorTask: Promise<number> | null, status: JsonObject): boolean {
  if (supervisorTask) {
    return false;
  }
  return !isActiveRuntimeStatus(status.runtimeStatus);
}

function isActiveRuntimeStatus(value: unknown): boolean {
  return value === "starting" || value === "thread-started" || value === "running";
}

function isRuntimeActive(status: JsonObject): boolean {
  return Boolean(status.supervisorActive) || isActiveRuntimeStatus(status.runtimeStatus);
}

function activityStatus(status: JsonObject, supervisorActive: boolean): { label: string; kind: "running" | "starting" | "idle" | "error"; running: boolean } {
  const runtime = String(status.runtimeStatus ?? "idle");
  const running = supervisorActive || isActiveRuntimeStatus(runtime);
  if (running) {
    const codex = isActiveRuntimeStatus(runtime) ? `CODEX ${runtime.toUpperCase()}` : "CODEX WAITING";
    return { label: `SUPERCODEX RUNNING | ${codex} | Esc stop`, kind: runtime === "starting" ? "starting" : "running", running: true };
  }
  if (runtime === "failed" || runtime === "error") {
    return { label: `SUPERCODEX STOPPED | CODEX ${runtime.toUpperCase()}`, kind: "error", running: false };
  }
  return { label: "SUPERCODEX IDLE | CODEX IDLE", kind: "idle", running: false };
}

function activityFg(kind: "running" | "starting" | "idle" | "error", theme: ReturnType<typeof themeForStatus>) {
  if (kind === "running") return theme.success;
  if (kind === "starting") return theme.warning;
  if (kind === "error") return theme.error;
  return theme.muted;
}

export const DEFAULT_TOAST_TTL_MS = 4500;

export function pushToast(setToasts: (fn: (current: AgentToastRecord[]) => AgentToastRecord[]) => void, message: string, variant: AgentToastRecord["variant"] = "info"): string {
  const id = randomUUID();
  setToasts((current) => [...current.slice(-3), { id, message, variant }]);
  return id;
}

export function removeToastById(current: AgentToastRecord[], toastId: string): AgentToastRecord[] {
  return current.filter((toast) => toast.id !== toastId);
}

function parseJsonObject(raw: string | undefined): JsonObject {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectEntry(): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (process.argv.includes("--smoke")) {
  const frame = await smokeRenderOpenTui();
  if (!frame.includes("SuperCodex") || !frame.includes("OpenTUI managed") || !frame.includes("OpenTUI textarea")) {
    throw new Error("OpenTUI smoke render did not include expected frame content");
  }
} else if (isDirectEntry()) {
  await runOpenTuiFromEnvironment();
}
