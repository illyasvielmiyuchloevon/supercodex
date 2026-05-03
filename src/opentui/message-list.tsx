import { For, Show } from "solid-js";
import { displayCellWidth, wrapLinesByCellWidth } from "../display-width";
import type { TuiMessage, TuiMessagePart } from "./message-projection";
import type { AgentTuiTheme } from "./theme";

export function MessageList(props: { messages: TuiMessage[]; theme: AgentTuiTheme; contentWidth?: number }) {
  return (
    <For each={props.messages}>
      {(message, index) => (
        <box marginTop={index() === 0 ? 0 : 1} flexShrink={0}>
          <MessageBlock message={message} theme={props.theme} contentWidth={props.contentWidth ?? 80} />
        </box>
      )}
    </For>
  );
}

function MessageBlock(props: { message: TuiMessage; theme: AgentTuiTheme; contentWidth: number }) {
  const colors = () => roleColors(props.message.role, props.theme);
  const partWidth = () => Math.max(1, Math.floor(props.contentWidth) - 2);
  return (
    <box border={["left"]} borderColor={colors().border} paddingLeft={1} paddingRight={1} backgroundColor={colors().background}>
      <box flexDirection="row" height={1}>
        <text fg={colors().label} wrapMode="none" flexShrink={0}>
          {roleLabel(props.message)}
        </text>
        <Show when={props.message.status}>
          <text fg={props.theme.muted} wrapMode="none">
            {" "}
            {props.message.status}
          </text>
        </Show>
      </box>
      <For each={props.message.parts}>{(part) => <MessagePart part={part} role={props.message.role} theme={props.theme} contentWidth={partWidth()} />}</For>
    </box>
  );
}

function MessagePart(props: { part: TuiMessagePart; role: TuiMessage["role"]; theme: AgentTuiTheme; contentWidth: number }) {
  const fg = () => partColor(props.part, props.role, props.theme);
  const prefix = () => partPrefix(props.part);
  const lines = () => messagePartDisplayLines(props.part, props.contentWidth);
  return (
    <For each={lines()}>
      {(line) => (
        <box flexDirection="row" paddingLeft={prefix() ? 1 : 0}>
          <Show when={prefix()}>
            <text fg={props.theme.muted} wrapMode="none" flexShrink={0}>
              {prefix()}
            </text>
          </Show>
          <text fg={fg()} wrapMode="none">
            {line || " "}
          </text>
        </box>
      )}
    </For>
  );
}

export function messagePartDisplayLines(part: Pick<TuiMessagePart, "text" | "type">, contentWidth: number): string[] {
  const lines = messagePartLines(part.text);
  if (part.type === "command-output" || part.type === "file-change") {
    return lines;
  }

  const prefix = partPrefix(part);
  const prefixCells = prefix ? displayCellWidth(prefix) + 1 : 0;
  return wrapLinesByCellWidth(lines, Math.max(1, Math.floor(contentWidth) - prefixCells));
}

function roleLabel(message: TuiMessage): string {
  switch (message.role) {
    case "user":
      return "USER";
    case "assistant":
      return "ASSISTANT";
    case "reasoning":
      return "REASONING";
    case "command":
      return "COMMAND";
    case "file":
      return "FILE CHANGE";
    case "error":
      return "ERROR";
    case "tool":
      return "TOOL";
    default:
      return "SYSTEM";
  }
}

function partPrefix(part: Pick<TuiMessagePart, "type">): string {
  switch (part.type) {
    case "command":
      return "$ ";
    case "command-output":
      return "> ";
    case "file-change":
      return "~ ";
    case "stderr":
    case "error":
      return "! ";
    case "reasoning":
      return "? ";
    default:
      return "";
  }
}

function roleColors(role: TuiMessage["role"], theme: AgentTuiTheme) {
  switch (role) {
    case "user":
      return { label: theme.primary, border: theme.primary, background: theme.panelRaised };
    case "assistant":
      return { label: theme.success, border: theme.borderActive, background: undefined };
    case "reasoning":
      return { label: theme.muted, border: theme.border, background: undefined };
    case "command":
    case "tool":
      return { label: theme.warning, border: theme.warning, background: undefined };
    case "file":
      return { label: theme.primary, border: theme.borderActive, background: undefined };
    case "error":
      return { label: theme.error, border: theme.error, background: undefined };
    default:
      return { label: theme.muted, border: theme.border, background: undefined };
  }
}

function partColor(part: TuiMessagePart, role: TuiMessage["role"], theme: AgentTuiTheme) {
  if (part.type === "stderr" || part.type === "error" || role === "error") return theme.error;
  if (part.type === "status" || part.type === "reasoning") return theme.muted;
  if (part.type === "command" || part.type === "file-change") return theme.warning;
  if (role === "user") return theme.text;
  return theme.text;
}

function messagePartLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}
