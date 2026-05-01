import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { AgentTuiTheme } from "./theme";

export interface PickerFrame {
  x: number;
  y: number;
  width: number;
}

export interface PickerLayout {
  top: number;
  left: number;
  width: number;
  height: number;
  rowWidth: number;
}

export interface AgentPickerOption {
  id: string;
  label: string;
  description?: string;
  footer?: string;
  marker?: string;
  variant?: "primary" | "danger" | "muted";
}

export interface AgentPickerRecord {
  id: string;
  title: string;
  subtitle?: string;
  options: AgentPickerOption[];
  currentId?: string | null;
  emptyMessage?: string;
  footerText?: string;
  placement?: "anchor" | "bottom";
  maxRows?: number;
  minWidth?: number;
  zIndex?: number;
}

export function PickerOverlay(props: {
  picker: AgentPickerRecord;
  selection: number;
  anchor?: BoxRenderable;
  theme: AgentTuiTheme;
  onSelect?: (index: number) => void;
  onChoose?: (option: AgentPickerOption) => void | Promise<void>;
  onClose?: () => void;
  formatOption?: (option: AgentPickerOption, index: number, width: number, current: boolean) => string;
}) {
  let scroll: ScrollBoxRenderable | undefined;
  const dimensions = useTerminalDimensions();
  const [positionTick, setPositionTick] = createSignal(0);
  const [mouseActive, setMouseActive] = createSignal(false);

  createEffect(() => {
    if (props.picker.placement !== "anchor" || !props.anchor) return;
    let last = pickerAnchorFrame(props.anchor);
    const interval = setInterval(() => {
      if (!props.anchor || props.anchor.isDestroyed) return;
      const next = pickerAnchorFrame(props.anchor);
      if (next.x !== last.x || next.y !== last.y || next.width !== last.width) {
        last = next;
        setPositionTick((tick) => tick + 1);
      }
    }, 50);
    onCleanup(() => clearInterval(interval));
  });

  const layout = createMemo(() => {
    positionTick();
    const placement = props.picker.placement ?? "bottom";
    const parent = props.anchor?.parent;
    return pickerOverlayLayout({
      anchor: placement === "anchor" && props.anchor && !props.anchor.isDestroyed ? pickerAnchorFrame(props.anchor) : undefined,
      parent: parent ? { x: parent.x, y: parent.y, width: parent.width } : undefined,
      terminal: dimensions(),
      itemCount: props.picker.options.length,
      maxRows: props.picker.maxRows,
      minWidth: props.picker.minWidth,
      placement,
    });
  });

  createEffect(() => {
    if (!scroll || scroll.isDestroyed) return;
    const selected = clamp(props.selection, 0, Math.max(0, props.picker.options.length - 1));
    if (selected < scroll.scrollTop) {
      scroll.scrollTo(selected);
      return;
    }
    const viewportHeight = Math.max(1, scroll.height || layout().height);
    if (selected >= scroll.scrollTop + viewportHeight) {
      scroll.scrollTo(selected - viewportHeight + 1);
    }
  });

  const formatter = () => props.formatOption ?? formatPickerOption;
  const optionRows = () => (
    <For each={props.picker.options}>
      {(option, index) => {
        const selected = () => index() === props.selection;
        const current = () => option.id === props.picker.currentId;
        return (
          <box
            height={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={selected() ? optionBackground(option, props.theme) : props.theme.panel}
            onMouseMove={() => setMouseActive(true)}
            onMouseOver={() => {
              if (mouseActive()) props.onSelect?.(index());
            }}
            onMouseDown={() => {
              setMouseActive(true);
              props.onSelect?.(index());
            }}
            onMouseUp={() => void props.onChoose?.(option)}
          >
            <text fg={optionText(option, props.theme, selected(), current())} wrapMode="none">
              {formatter()(option, index(), layout().rowWidth, current())}
            </text>
          </box>
        );
      }}
    </For>
  );

  return (
    <box
      position="absolute"
      zIndex={props.picker.zIndex ?? (props.picker.placement === "anchor" ? 3500 : 2800)}
      top={layout().top}
      left={layout().left}
      width={layout().width}
      border={["top", "right", "bottom", "left"]}
      borderColor={props.theme.borderActive}
      backgroundColor={props.theme.panel}
    >
      <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={props.theme.panelRaised} flexDirection="row" justifyContent="space-between">
        <text fg={props.theme.primary} wrapMode="none">
          {truncateAscii(props.picker.title, Math.max(1, layout().rowWidth - 4))}
        </text>
        <Show when={props.onClose}>
          <text fg={props.theme.muted} wrapMode="none" onMouseUp={() => props.onClose?.()}>
            esc
          </text>
        </Show>
      </box>
      <Show when={props.picker.subtitle}>
        {(subtitle) => (
          <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={props.theme.panelRaised}>
            <text fg={props.theme.muted} wrapMode="none">
              {truncateAscii(subtitle(), layout().rowWidth)}
            </text>
          </box>
        )}
      </Show>
      <Show
        when={props.picker.options.length > 0}
        fallback={
          <box height={1} paddingLeft={1} paddingRight={1}>
            <text fg={props.theme.muted} wrapMode="none">
              {truncateAscii(props.picker.emptyMessage ?? "No options available.", layout().rowWidth)}
            </text>
          </box>
        }
      >
        <Show
          when={props.picker.options.length > layout().height}
          fallback={optionRows()}
        >
          <scrollbox
            ref={(ref: ScrollBoxRenderable) => {
              scroll = ref;
            }}
            height={layout().height}
            backgroundColor={props.theme.panel}
            verticalScrollbarOptions={{
              visible: true,
              trackOptions: {
                backgroundColor: props.theme.panel,
                foregroundColor: props.theme.border,
              },
            }}
          >
            {optionRows()}
          </scrollbox>
        </Show>
      </Show>
      <Show when={props.picker.footerText}>
        {(footer) => (
          <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={props.theme.panelRaised}>
            <text fg={props.theme.muted} wrapMode="none">
              {truncateAscii(footer(), layout().rowWidth)}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}

export function pickerOverlayLayout(input: {
  anchor?: PickerFrame;
  parent?: PickerFrame;
  terminal: { width: number; height: number };
  itemCount: number;
  maxRows?: number;
  minWidth?: number;
  placement?: "anchor" | "bottom";
}): PickerLayout {
  const terminalWidth = finiteFloor(input.terminal.width, 80);
  const terminalHeight = finiteFloor(input.terminal.height, 24);
  const placement = input.placement ?? (input.anchor ? "anchor" : "bottom");
  const maxRows = Math.max(1, Math.min(input.maxRows ?? 10, input.itemCount || 1));
  const height = placement === "anchor" ? maxRows : Math.max(1, Math.min(maxRows, Math.max(1, terminalHeight - 12)));

  if (placement === "anchor") {
    const anchor = input.anchor ?? { x: 0, y: terminalHeight - 3, width: terminalWidth };
    const parent = input.parent ?? { x: 0, y: 0, width: terminalWidth };
    const minWidth = Math.max(1, Math.min(input.minWidth ?? 40, terminalWidth));
    const maxWidth = Math.max(1, terminalWidth - 2);
    const desiredWidth = Math.max(minWidth, finiteFloor(anchor.width, minWidth));
    const width = Math.max(1, Math.min(desiredWidth, maxWidth));
    const maxGlobalLeft = Math.max(0, terminalWidth - width - 1);
    const globalLeft = clamp(finiteFloor(anchor.x, 0), 0, maxGlobalLeft);
    return {
      top: finiteFloor(anchor.y, terminalHeight - 3) - finiteFloor(parent.y, 0) - height - 3,
      left: globalLeft - finiteFloor(parent.x, 0),
      width,
      height,
      rowWidth: Math.max(1, width - 2),
    };
  }

  const maxWidth = Math.max(1, Math.min(112, terminalWidth - 2));
  const minWidth = Math.max(1, Math.min(input.minWidth ?? 56, maxWidth));
  const width = clamp(terminalWidth - 4, minWidth, maxWidth);
  return {
    top: Math.max(2, terminalHeight - height - 9),
    left: Math.max(1, Math.floor((terminalWidth - width) / 2)),
    width,
    height,
    rowWidth: Math.max(1, width - 2),
  };
}

export function formatPickerOption(option: AgentPickerOption, index: number, width: number, current = false): string {
  const ordinal = String(index + 1).padStart(2, " ");
  const marker = current ? "*" : option.marker ?? " ";
  const description = option.description ? `  ${option.description}` : "";
  const footer = option.footer ? `  ${option.footer}` : "";
  return truncateAscii(`${ordinal}. ${marker} ${option.label}${description}${footer}`, Math.max(1, Math.floor(width)));
}

export function pickerAnchorFrame(anchor: BoxRenderable): PickerFrame {
  return {
    x: anchor.x,
    y: anchor.y,
    width: anchor.width,
  };
}

export function truncateAscii(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function optionBackground(option: AgentPickerOption, theme: AgentTuiTheme) {
  if (option.variant === "danger") return theme.error;
  if (option.variant === "muted") return theme.panelSelected;
  return theme.panelSelected;
}

function optionText(option: AgentPickerOption, theme: AgentTuiTheme, selected: boolean, current: boolean) {
  if (selected && option.variant === "danger") return theme.selectedText;
  if (selected) return theme.primary;
  if (current) return theme.primary;
  if (option.variant === "danger") return theme.error;
  if (option.variant === "muted") return theme.muted;
  return theme.text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}
