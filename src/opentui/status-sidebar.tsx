import { createMemo, For } from "solid-js";
import type { InteractionRecord } from "../interactions.js";
import type { JsonObject } from "../types.js";
import type { AgentTuiConfig } from "./config";
import type { AgentTuiTheme } from "./theme";

export function StatusSidebar(props: {
  status: JsonObject;
  interactions: InteractionRecord[];
  width?: number;
  messageCount?: number;
  lineCount?: number;
  tuiConfig?: AgentTuiConfig;
  theme: AgentTuiTheme;
}) {
  const contentWidth = createMemo(() => Math.max(6, (props.width ?? 40) - 12));
  const statusLines = createMemo(() => {
    const settings = isObject(props.status.settings) ? props.status.settings : {};
    const effectiveConfig = isObject(props.status.effectiveCodexConfig) ? props.status.effectiveCodexConfig : {};
    const valueWidth = contentWidth();
    return [
      ["mode", String(props.status.mode ?? "idle")],
      ["phase", String(props.status.phase ?? "idle")],
      ["stage", String(props.status.stage ?? "none")],
      ["task", String(props.status.task ?? "none")],
      ["runtime", String(props.status.runtimeStatus ?? "idle")],
      ["thread", shorten(String(props.status.threadId ?? "none"), valueWidth)],
      ["model", shorten(String(settings.model ?? effectiveConfig.model ?? "unset"), valueWidth)],
      ["reasoning", String(settings.reasoningEffort ?? effectiveConfig.reasoningEffort ?? "unset")],
      ["auth", String(props.status.activeAuth ?? "none")],
      ["theme", shorten(themeLabel(props.tuiConfig), valueWidth)],
      ["mouse", props.tuiConfig?.mouse === false ? "off" : "on"],
      ["sandbox", shorten(String(settings.sandbox ?? effectiveConfig.sandbox ?? "danger-full-access"), valueWidth)],
      ["approval", shorten(String(settings.approvalPolicy ?? effectiveConfig.approvalPolicy ?? "never"), valueWidth)],
      ["requests", String(props.interactions.length)],
      ["messages", String(props.messageCount ?? 0)],
      ["lines", String(props.lineCount ?? 0)],
      ["next", shorten(String(props.status.nextWork ?? "none"), valueWidth)],
    ];
  });

  return (
    <box width={props.width ?? 40} flexShrink={0} backgroundColor={props.theme.panel} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: props.theme.panel,
            foregroundColor: props.theme.borderActive,
          },
        }}
      >
        <box flexShrink={0} gap={1} paddingRight={1}>
          <text fg={props.theme.primary}>
            <b>SuperCodex</b>
          </text>
          <For each={statusLines()}>
            {(row) => (
              <text fg={props.theme.text} wrapMode="none">
                <span style={{ fg: props.theme.muted }}>{row[0]} </span>
                {row[1]}
              </text>
            )}
          </For>
          <text fg={props.theme.primary}>Commands</text>
          <text fg={props.theme.muted}>/goal /new /start /model</text>
          <text fg={props.theme.muted}>/permissions /sandbox /approval</text>
          <text fg={props.theme.muted}>/auth /interrupt /pause</text>
          <text fg={props.theme.muted}>/resume /status /runs</text>
          <text fg={props.theme.muted}>/interactions /fresh-next</text>
        </box>
      </scrollbox>
      <box flexShrink={0} paddingTop={1}>
        <text fg={props.theme.muted}>
          <span style={{ fg: props.theme.success }}>•</span> OpenTUI frontend
        </text>
      </box>
    </box>
  );
}

function themeLabel(config?: AgentTuiConfig): string {
  const name = config?.theme ?? "opencode";
  const mode = config?.resolvedMode ?? config?.themeMode ?? "auto";
  return `${name}/${mode}`;
}

function shorten(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
