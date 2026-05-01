import { RGBA } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import { dialogActions, type AgentDialogAction, type AgentDialogKind, type AgentDialogRecord } from "./dialog-stack";
import type { AgentTuiTheme } from "./theme";

export type { AgentDialogAction, AgentDialogKind, AgentDialogRecord } from "./dialog-stack";

export function DialogHost(props: {
  dialogs: AgentDialogRecord[];
  theme: AgentTuiTheme;
  selection?: number;
  onSelect?: (index: number) => void;
  onClose?: (dialog: AgentDialogRecord) => void;
  onAction?: (dialog: AgentDialogRecord, action: AgentDialogAction) => void | Promise<void>;
}) {
  const dimensions = useTerminalDimensions();
  const current = () => props.dialogs.at(-1) ?? null;
  const dialogWidth = () => {
    const dialog = current();
    const requested = dialog?.size === "xlarge" ? 116 : dialog?.size === "large" ? 88 : 60;
    return Math.max(32, Math.min(requested, dimensions().width - 4));
  };

  return (
    <Show when={current()}>
      {(dialog) => (
        <box
          position="absolute"
          zIndex={3000}
          top={0}
          left={0}
          width={dimensions().width}
          height={dimensions().height}
          paddingTop={Math.max(1, Math.floor(dimensions().height / 4))}
          alignItems="center"
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          onMouseUp={() => props.onClose?.(dialog())}
        >
          <box
            width={dialogWidth()}
            maxWidth={dimensions().width - 2}
            border={["top", "right", "bottom", "left"]}
            borderColor={dialogBorder(dialog().kind, props.theme)}
            backgroundColor={props.theme.panelRaised}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            onMouseUp={(event) => event.stopPropagation()}
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text fg={dialogBorder(dialog().kind, props.theme)} wrapMode="none">
                {dialog().title}
              </text>
              <text fg={props.theme.muted} wrapMode="none" onMouseUp={() => props.onClose?.(dialog())}>
                esc
              </text>
            </box>
            <box paddingTop={1} paddingBottom={1}>
              <text fg={props.theme.text} wrapMode="word">
                {dialog().body}
              </text>
            </box>
            <box flexDirection="row" justifyContent="flex-end" gap={1}>
              <For each={dialogActions(dialog())}>
                {(action, index) => {
                  const selected = () => index() === (props.selection ?? 0);
                  return (
                  <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={actionBackground(action, props.theme, selected())}
                    onMouseOver={() => props.onSelect?.(index())}
                    onMouseDown={() => props.onSelect?.(index())}
                    onMouseUp={() => void props.onAction?.(dialog(), action)}
                  >
                    <text fg={actionText(action, props.theme, selected())} wrapMode="none">
                      {index() + 1}. {action.label}
                    </text>
                  </box>
                  );
                }}
              </For>
            </box>
          </box>
        </box>
      )}
    </Show>
  );
}

function dialogBorder(kind: AgentDialogKind | undefined, theme: AgentTuiTheme) {
  if (kind === "error") return theme.error;
  if (kind === "warning" || kind === "permission") return theme.warning;
  return theme.primary;
}

function actionBackground(action: AgentDialogAction, theme: AgentTuiTheme, selected: boolean) {
  if (selected) {
    if (action.variant === "danger") return theme.error;
    if (action.variant === "muted") return theme.panelSelected;
    return theme.primary;
  }
  if (action.variant === "danger") return theme.error;
  if (action.variant === "muted") return theme.panel;
  return theme.primary;
}

function actionText(action: AgentDialogAction, theme: AgentTuiTheme, selected: boolean) {
  if (selected && action.variant !== "muted") return theme.selectedText;
  return action.variant === "muted" ? theme.text : theme.selectedText;
}
