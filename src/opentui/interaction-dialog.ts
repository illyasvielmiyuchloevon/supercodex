import type { InteractionChoice, InteractionRecord } from "../interactions.js";
import type { AgentDialogAction } from "./dialog-stack.js";

export function cancelActionForInteraction(interaction: InteractionRecord): AgentDialogAction | null {
  const choice = interaction.choices.find((item) => item.id === "cancel") ?? interaction.choices.find((item) => item.id === "decline") ?? null;
  return choice ? choiceToAction(choice) : null;
}

export function interactionContextLabel(interaction: InteractionRecord): string {
  const method = interaction.method.replace(/\/request(?:Approval|UserInput)?$/i, "");
  const request = `request ${String(interaction.requestId)}`;
  return [method, request].filter(Boolean).join(" · ");
}

function choiceToAction(choice: InteractionChoice): AgentDialogAction {
  const id = choice.id;
  const variant = id.includes("decline") || id.includes("deny") ? "danger" : id.includes("cancel") ? "muted" : "primary";
  return {
    id,
    label: choice.label,
    variant,
  };
}
