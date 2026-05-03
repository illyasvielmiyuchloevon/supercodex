import { decodePasteBytes, type BoxRenderable, type KeyEvent, type PasteEvent, type TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import type { SlashCommandSuggestion } from "../tui-commands.js";
import { slashCommandSuggestions } from "../tui-commands.js";
import { handleCtrlCCopyOnly } from "./terminal-lifecycle";
import {
  appendPromptHistory,
  popPromptStash,
  pushPromptStash,
  readPromptHistory,
  readPromptStash,
  selectPromptHistory,
  type PromptHistoryEntry,
  type PromptStashEntry,
} from "../opentui-prompt-history.js";
import { AutocompleteOverlay } from "./autocomplete";
import { PickerOverlay, type AgentPickerRecord } from "./picker";
import {
  createPasteSummary,
  expandPasteSummaries,
  normalizePasteText,
  resolvePastedFile,
  shouldSummarizePaste,
  type PasteSummary,
} from "./paste";
import { agentTextareaKeyBindings, isTextareaNewlineKey } from "./textarea-keybindings";
import type { AgentTuiTheme } from "./theme";

export function AgentPrompt(props: {
  mode: "managed" | "attach";
  project: string;
  runId: string;
  theme: AgentTuiTheme;
  initialValue?: string;
  inputId?: string;
  onInputReady?: (textarea: TextareaRenderable) => void;
  supervisorRunning?: boolean;
  onSubmit?: (value: string, textarea: TextareaRenderable) => void | Promise<void>;
  onCommandChoice?: (suggestion: SlashCommandSuggestion, textarea: TextareaRenderable, submit: boolean) => void | Promise<void>;
  picker?: AgentPickerRecord | null;
  pickerSelection?: number;
  onPickerSelection?: (next: number) => void;
  onPickerChoice?: (optionId: string) => void | Promise<void>;
  onPickerClose?: () => void;
  onOverlayKeyDown?: (event: KeyEvent) => void | Promise<void>;
  onSelectionCopied?: (copied: boolean) => void;
  onStopRequest?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
}) {
  let input: TextareaRenderable | undefined;
  const renderer = useRenderer();
  const [value, setValue] = createSignal(props.initialValue ?? "");
  const [selection, setSelection] = createSignal(0);
  const [anchor, setAnchor] = createSignal<BoxRenderable>();
  const [history, setHistory] = createSignal<PromptHistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(0);
  const [stash, setStash] = createSignal<PromptStashEntry[]>([]);
  const [pasteSummaries, setPasteSummaries] = createSignal<PasteSummary[]>([]);
  const suggestions = createMemo(() => slashCommandSuggestions(value(), input?.cursorOffset ?? value().length));

  onMount(() => {
    void refreshPromptState();
  });

  const submit = async () => {
    if (!input) return;
    const palette = suggestions();
    if (palette.length > 0) {
      await chooseCommand(palette[selection()] ?? palette[0]!, true);
      return;
    }
    const raw = expandPrompt(input.plainText);
    input.clear();
    setValue("");
    setSelection(0);
    setPasteSummaries([]);
    const historyUpdate = appendPromptHistory(props.project, raw, props.runId).catch(() => null);
    await props.onSubmit?.(raw, input);
    const nextHistory = await historyUpdate;
    if (nextHistory) {
      setHistory(nextHistory);
      setHistoryIndex(nextHistory.length);
    }
  };

  const chooseCommand = async (suggestion: SlashCommandSuggestion, shouldSubmit: boolean) => {
    if (!input) return;
    await props.onCommandChoice?.(suggestion, input, shouldSubmit);
    syncInputValue();
    setSelection(0);
  };

  const keyDown = async (event: KeyEvent) => {
    if (event.defaultPrevented) return;
    if (event.ctrl && event.name === "c") {
      await handleCtrlCCopyOnly(event, renderer, props.onSelectionCopied);
      return;
    }
    await props.onOverlayKeyDown?.(event);
    if (event.defaultPrevented) return;

    const palette = suggestions();
    if (input && isTextareaNewlineKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      insertPromptNewline();
      return;
    }
    if (palette.length > 0 && (event.name === "up" || (event.ctrl && event.name === "p"))) {
      event.preventDefault();
      setSelection((selection() + palette.length - 1) % palette.length);
      return;
    }
    if (palette.length > 0 && (event.name === "down" || (event.ctrl && event.name === "n"))) {
      event.preventDefault();
      setSelection((selection() + 1) % palette.length);
      return;
    }
    if (palette.length > 0 && event.name === "pageup") {
      event.preventDefault();
      setSelection((selection() + palette.length - Math.min(10, palette.length)) % palette.length);
      return;
    }
    if (palette.length > 0 && event.name === "pagedown") {
      event.preventDefault();
      setSelection((selection() + Math.min(10, palette.length)) % palette.length);
      return;
    }
    if (palette.length > 0 && event.name === "home") {
      event.preventDefault();
      setSelection(0);
      return;
    }
    if (palette.length > 0 && event.name === "end") {
      event.preventDefault();
      setSelection(palette.length - 1);
      return;
    }
    if (palette.length > 0 && /^[1-9]$/.test(event.name)) {
      const suggestion = palette[Number(event.name) - 1];
      if (suggestion) {
        event.preventDefault();
        await chooseCommand(suggestion, true);
      }
      return;
    }
    if (palette.length > 0 && (event.name === "tab" || event.name === "return" || event.name === "enter" || event.name === "kpenter")) {
      event.preventDefault();
      await chooseCommand(palette[selection()] ?? palette[0]!, event.name !== "tab");
      return;
    }
    if (palette.length > 0 && event.name === "escape") {
      event.preventDefault();
      input?.setText("");
      syncInputValue();
      setSelection(0);
      setPasteSummaries([]);
      return;
    }
    if (event.name === "escape" && props.supervisorRunning) {
      event.preventDefault();
      event.stopPropagation();
      await props.onStopRequest?.();
      return;
    }
    if (!input || palette.length > 0) return;
    if ((event.ctrl && event.name === "p") || (event.name === "up" && input.visualCursor.visualRow === 0)) {
      event.preventDefault();
      applyHistorySelection(-1);
      return;
    }
    if ((event.ctrl && event.name === "n") || (event.name === "down" && input.visualCursor.visualRow >= Math.max(0, input.height - 1))) {
      event.preventDefault();
      applyHistorySelection(1);
      return;
    }
    if (event.ctrl && event.name === "s" && value().trim()) {
      event.preventDefault();
      setStash(await pushPromptStash(props.project, expandPrompt(input.plainText), props.runId));
      input.clear();
      syncInputValue();
      setPasteSummaries([]);
      return;
    }
    if (event.ctrl && event.name === "r") {
      event.preventDefault();
      const entry = await popPromptStash(props.project, props.runId);
      setStash(await readPromptStash(props.project, props.runId));
      if (entry) {
        input.setText(entry.input);
        input.gotoBufferEnd();
        syncInputValue();
        setPasteSummaries([]);
      }
    }
  };

  async function refreshPromptState() {
    const [nextHistory, nextStash] = await Promise.all([
      readPromptHistory(props.project, props.runId),
      readPromptStash(props.project, props.runId),
    ]);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length);
    setStash(nextStash);
  }

  function applyHistorySelection(direction: 1 | -1) {
    if (!input) return;
    const selected = selectPromptHistory(history(), historyIndex(), direction);
    setHistoryIndex(selected.index);
    input.setText(selected.input);
    input.gotoBufferEnd();
    syncInputValue();
    setPasteSummaries([]);
  }

  async function handlePaste(event: PasteEvent) {
    if (!input) return;
    event.preventDefault();
    const normalizedText = normalizePasteText(decodePasteBytes(event.bytes));
    const pastedContent = normalizedText.trim();
    if (!pastedContent) return;

    const file = await resolvePastedFile(props.project, pastedContent);
    if (file?.text) {
      insertPasteSummary(file.text, "file", file.displayPath);
      return;
    }
    if (file?.path) {
      insertPromptText(file.displayPath);
      return;
    }
    if (shouldSummarizePaste(normalizedText)) {
      insertPasteSummary(normalizedText, "text");
      return;
    }
    insertPromptText(normalizedText);
  }

  function insertPasteSummary(text: string, kind: "text" | "file", source?: string) {
    if (!input) return;
    const summary = createPasteSummary({
      text,
      kind,
      source,
      sequence: pasteSummaries().length + 1,
    });
    setPasteSummaries((current) => [...current, summary]);
    insertPromptText(`${summary.marker} `);
  }

  function insertPromptText(text: string) {
    if (!input) return;
    const parts = text.split(/\r\n|\r|\n/);
    parts.forEach((part, index) => {
      if (index > 0) {
        input?.newLine();
      }
      if (part) {
        input?.insertText(part);
      }
    });
    input.getLayoutNode().markDirty();
    setValue(input.plainText);
  }

  function insertPromptNewline() {
    if (!input) return;
    input.newLine();
    input.getLayoutNode().markDirty();
    setValue(input.plainText);
  }

  function syncInputValue() {
    if (!input) return;
    input.getLayoutNode().markDirty();
    setValue(input.plainText);
    renderer.requestRender();
  }

  function expandPrompt(text: string): string {
    return expandPasteSummaries(text, pasteSummaries()).trim();
  }

  return (
    <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} backgroundColor={props.theme.panel}>
      <AutocompleteOverlay suggestions={suggestions()} selection={selection()} anchor={anchor()} theme={props.theme} onSelect={setSelection} onChoose={(suggestion) => chooseCommand(suggestion, true)} />
      <Show when={props.picker && anchor()}>
        <PickerOverlay
          picker={props.picker!}
          selection={props.pickerSelection ?? 0}
          anchor={anchor()}
          theme={props.theme}
          onSelect={props.onPickerSelection}
          onChoose={(option) => void props.onPickerChoice?.(option.id)}
          onClose={props.onPickerClose}
        />
      </Show>
      <box
        ref={(ref: BoxRenderable) => {
          setAnchor(ref);
        }}
        border={["left"]}
        borderColor={props.theme.borderActive}
        paddingLeft={2}
        backgroundColor={props.theme.panelRaised}
      >
        <textarea
          id={props.inputId ?? "agent-prompt-input"}
          ref={(ref: TextareaRenderable) => {
            input = ref;
            props.onInputReady?.(ref);
            if (!ref.isDestroyed) {
              ref.focus();
              ref.cursorColor = props.theme.text;
            }
            setTimeout(() => {
              if (!ref.isDestroyed) {
                if (props.initialValue && !ref.plainText) {
                  ref.setText(props.initialValue);
                  ref.gotoBufferEnd();
                }
                ref.focus();
                ref.cursorColor = props.theme.text;
              }
            }, 0);
          }}
          minHeight={1}
          maxHeight={8}
          initialValue={props.initialValue}
          wrapMode="word"
          scrollMargin={2}
          placeholder={props.mode === "managed" ? "Type a task, /goal, or / command" : "Type an intervention or / command"}
          placeholderColor={props.theme.muted}
          textColor={props.theme.text}
          focusedTextColor={props.theme.text}
          focusedBackgroundColor={props.theme.panelRaised}
          backgroundColor={props.theme.panelRaised}
          cursorColor={props.theme.text}
          keyBindings={agentTextareaKeyBindings()}
          onKeyDown={(event: KeyEvent) => void keyDown(event)}
          onContentChange={() => {
            setValue(input?.plainText ?? "");
            setSelection(0);
          }}
          onPaste={(event: PasteEvent) => void handlePaste(event)}
          onSubmit={() => void submit()}
          onMouseDown={(event) => event.target?.focus()}
        />
        <box flexDirection="row" paddingTop={1}>
          <text fg={props.theme.muted} wrapMode="word">
            OpenTUI textarea · Enter submit · Shift/Alt/Ctrl+Enter newline · Ctrl+C copy selection · Ctrl+J newline · Ctrl+P/N history · Ctrl+S/R stash {stash().length ? `(${stash().length})` : ""} · paste summary {pasteSummaries().length ? `(${pasteSummaries().length})` : ""} · / commands
            {props.supervisorRunning ? " · Esc stop" : ""}
          </text>
        </box>
      </box>
    </box>
  );
}
