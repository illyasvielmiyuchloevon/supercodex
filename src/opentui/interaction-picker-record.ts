import type { InteractionChoice, InteractionRecord } from "../interactions.js";
import { interactionContextLabel } from "./interaction-dialog.js";
import type { AgentPickerOption, AgentPickerRecord } from "./picker";

export function interactionPickerRecord(interaction: InteractionRecord): AgentPickerRecord {
  return {
    id: `interaction:${interaction.id}`,
    title: interaction.title,
    subtitle: interaction.summary || interactionContextLabel(interaction),
    options: interaction.choices.slice(0, 9).map(choiceToOption),
    emptyMessage: "No choices are available for this Codex interaction.",
    footerText: `${interactionContextLabel(interaction)} | Up/Down select | Enter choose | Esc cancel`,
    placement: "bottom",
    minWidth: 56,
    zIndex: 2850,
  };
}

function choiceToOption(choice: InteractionChoice): AgentPickerOption {
  const id = choice.id;
  return {
    id,
    label: choice.label,
    description: choice.description,
    variant: id.includes("decline") || id.includes("deny") ? "danger" : id.includes("cancel") ? "muted" : "primary",
  };
}
