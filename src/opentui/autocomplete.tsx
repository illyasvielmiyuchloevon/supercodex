import type { BoxRenderable } from "@opentui/core";
import { Show } from "solid-js";
import type { SlashCommandSuggestion } from "../tui-commands.js";
import type { AgentTuiTheme } from "./theme";
import { PickerOverlay, pickerOverlayLayout, truncateAscii, type PickerFrame, type PickerLayout } from "./picker";

export type AutocompleteFrame = PickerFrame;
export type AutocompleteLayout = PickerLayout;

export function AutocompleteOverlay(props: {
  suggestions: SlashCommandSuggestion[];
  selection: number;
  anchor?: BoxRenderable;
  theme: AgentTuiTheme;
  onSelect?: (index: number) => void;
  onChoose?: (suggestion: SlashCommandSuggestion) => void | Promise<void>;
}) {
  return (
    <Show when={props.suggestions.length > 0 && props.anchor}>
      <PickerOverlay
        picker={{
          id: "slash-commands",
          title: "Slash commands",
          options: props.suggestions.slice(0, 30).map((suggestion, index) => ({
            id: String(index),
            label: suggestion.usage,
            description: suggestion.description,
          })),
          emptyMessage: "",
          placement: "anchor",
          maxRows: 10,
          minWidth: 40,
          zIndex: 3500,
        }}
        selection={props.selection}
        anchor={props.anchor}
        theme={props.theme}
        onSelect={props.onSelect}
        onChoose={(option) => {
          const suggestion = props.suggestions[Number(option.id)];
          if (suggestion) void props.onChoose?.(suggestion);
        }}
        formatOption={(option, _index, width) => formatSuggestionRow({ usage: option.label, description: option.description ?? "" }, width)}
      />
    </Show>
  );
}

export function autocompleteOverlayLayout(input: {
  anchor?: AutocompleteFrame;
  parent?: AutocompleteFrame;
  terminal: { width: number; height: number };
  suggestionCount: number;
  maxRows?: number;
  minWidth?: number;
}): AutocompleteLayout {
  return pickerOverlayLayout({
    anchor: input.anchor,
    parent: input.parent,
    terminal: input.terminal,
    itemCount: input.suggestionCount,
    maxRows: input.maxRows,
    minWidth: input.minWidth,
    placement: "anchor",
  });
}

export function formatSuggestionRow(input: Pick<SlashCommandSuggestion, "usage" | "description">, width: number): string {
  const text = input.description ? `${input.usage}  ${input.description}` : input.usage;
  return truncateAscii(text, Math.max(1, Math.floor(width)));
}
