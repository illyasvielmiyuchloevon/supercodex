import type { InteractionRecord } from "../interactions.js";
import type { JsonObject } from "../types.js";
import type { AgentTuiConfig } from "./config";
import type { TuiMessage } from "./message-projection";
import type { AgentTuiTheme } from "./theme";

export function SessionFooter(props: {
  status: JsonObject;
  interactions: InteractionRecord[];
  messages: TuiMessage[];
  lineCount: number;
  tuiConfig?: AgentTuiConfig;
  theme: AgentTuiTheme;
}) {
  const settings = isObject(props.status.settings) ? props.status.settings : {};
  const effectiveConfig = isObject(props.status.effectiveCodexConfig) ? props.status.effectiveCodexConfig : {};
  const model = String(settings.model ?? effectiveConfig.model ?? "unset");
  const reasoning = String(settings.reasoningEffort ?? effectiveConfig.reasoningEffort ?? "unset");
  const sandbox = String(settings.sandbox ?? effectiveConfig.sandbox ?? "danger-full-access");
  const approval = String(settings.approvalPolicy ?? effectiveConfig.approvalPolicy ?? "never");
  const runtime = String(props.status.runtimeStatus ?? "idle");
  const tuiTheme = `${props.tuiConfig?.theme ?? "opencode"}/${props.tuiConfig?.resolvedMode ?? props.tuiConfig?.themeMode ?? "auto"}`;
  const mouse = props.tuiConfig?.mouse === false ? "off" : "on";
  const thread = shorten(String(props.status.threadId ?? "none"), 18);
  const turn = shorten(String(props.status.turnId ?? "none"), 18);
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={props.theme.panel}>
      <text fg={props.theme.muted} wrapMode="none">
        msgs {props.messages.length} · req {props.interactions.length} · status {runtime} · model {shorten(model, 18)} · theme {shorten(tuiTheme, 18)} · mouse {mouse} · perm {shorten(`${sandbox}/${approval}`, 24)} · reasoning {shorten(reasoning, 8)} · auth {shorten(String(props.status.activeAuth ?? "none"), 14)} · thread {thread} · turn {turn} · lines {props.lineCount}
      </text>
    </box>
  );
}

function shorten(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
