import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import { wrapLinesByCellWidth } from "../display-width";
import type { TuiMessage } from "./message-projection";
import { MessageList } from "./message-list";
import { createTranscriptScrollAcceleration, transcriptPageRows } from "./session-scroll";
import type { AgentTuiTheme } from "./theme";

export interface SessionTranscriptHandle {
  scrollPage(delta: number): void;
  scrollToBottom(): void;
}

export function SessionTranscript(props: {
  lines: string[];
  messages?: TuiMessage[];
  theme: AgentTuiTheme;
  contentWidth?: number;
  ref?: (handle: SessionTranscriptHandle | undefined) => void;
}) {
  let scroll: ScrollBoxRenderable | undefined;
  const scrollAcceleration = createTranscriptScrollAcceleration();

  const toBottom = () => {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return;
      scroll.scrollTo(scroll.scrollHeight);
    }, 0);
  };

  const page = (delta: number) => {
    if (!scroll || scroll.isDestroyed) return;
    const amount = transcriptPageRows(scroll.height);
    scroll.scrollBy(delta * amount);
  };

  createEffect(() => {
    props.ref?.({
      scrollPage: page,
      scrollToBottom: toBottom,
    });
  });

  return (
    <scrollbox
      ref={(ref: ScrollBoxRenderable) => {
        scroll = ref;
      }}
      flexGrow={1}
      stickyScroll={true}
      stickyStart="bottom"
      scrollAcceleration={scrollAcceleration}
      viewportOptions={{ paddingRight: 1 }}
      verticalScrollbarOptions={{
        paddingLeft: 1,
        visible: true,
        trackOptions: {
          backgroundColor: props.theme.background,
          foregroundColor: props.theme.border,
        },
      }}
    >
      <box height={1} />
      <ShowStructuredMessages messages={props.messages ?? []} lines={props.lines} theme={props.theme} contentWidth={props.contentWidth ?? 80} />
    </scrollbox>
  );
}

function ShowStructuredMessages(props: { messages: TuiMessage[]; lines: string[]; theme: AgentTuiTheme; contentWidth: number }) {
  return (
    <Show
      when={props.messages.length > 0 && props.lines.length === 0}
      fallback={
        <For each={props.lines.length > 0 ? props.lines : ["Waiting for Codex app-server events..."]}>
          {(line, index) => <TranscriptLine line={line} index={index()} theme={props.theme} contentWidth={props.contentWidth} />}
        </For>
      }
    >
      <MessageList messages={props.messages} theme={props.theme} contentWidth={props.contentWidth} />
    </Show>
  );
}

function TranscriptLine(props: { line: string; index: number; theme: AgentTuiTheme; contentWidth: number }) {
  const role = classify(props.line);
  const fg = role === "error" ? props.theme.error : role === "operator" ? props.theme.primary : role === "system" ? props.theme.muted : props.theme.text;
  const bg = role === "operator" ? props.theme.panelRaised : undefined;
  const lineWidth = Math.max(1, Math.floor(props.contentWidth) - (role === "plain" ? 1 : 2));
  const lines = () => wrapTranscriptLineForDisplay(props.line, lineWidth);
  return (
    <For each={lines()}>
      {(line, lineIndex) => (
        <box
          id={`transcript-line-${props.index}-${lineIndex()}`}
          marginTop={props.index === 0 || lineIndex() > 0 ? 0 : 1}
          paddingLeft={role === "plain" ? 0 : 1}
          paddingRight={1}
          backgroundColor={bg}
          flexShrink={0}
        >
          <text fg={fg} wrapMode="none">
            {line || " "}
          </text>
        </box>
      )}
    </For>
  );
}

export function wrapTranscriptLineForDisplay(line: string, contentWidth: number): string[] {
  return wrapLinesByCellWidth([line], Math.max(1, Math.floor(contentWidth)));
}

function classify(line: string): "error" | "operator" | "system" | "plain" {
  if (line.includes("[error]") || line.includes("[ui error]") || line.includes("failed")) return "error";
  if (line.startsWith("[operator]")) return "operator";
  if (line.startsWith("[supercodex]") || line.startsWith("[codex")) return "system";
  return "plain";
}
