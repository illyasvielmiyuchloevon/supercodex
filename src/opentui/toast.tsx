import { For, Show } from "solid-js";
import type { AgentTuiTheme } from "./theme";

export type AgentToastVariant = "info" | "success" | "warning" | "error";

export interface AgentToastRecord {
  id: string;
  message: string;
  variant?: AgentToastVariant;
}

export function ToastStack(props: { toasts: AgentToastRecord[]; theme: AgentTuiTheme }) {
  return (
    <Show when={props.toasts.length > 0}>
      <box position="absolute" zIndex={2500} top={2} right={2} width={42} gap={1}>
        <For each={props.toasts.slice(-4)}>
          {(toast) => (
            <box
              border={["left"]}
              borderColor={toastColor(toast.variant, props.theme)}
              backgroundColor={props.theme.panelRaised}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={toastColor(toast.variant, props.theme)} wrapMode="word">
                {toast.message}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}

function toastColor(variant: AgentToastVariant | undefined, theme: AgentTuiTheme) {
  if (variant === "success") return theme.success;
  if (variant === "warning") return theme.warning;
  if (variant === "error") return theme.error;
  return theme.primary;
}
