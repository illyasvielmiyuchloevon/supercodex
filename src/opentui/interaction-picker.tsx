import type { InteractionRecord } from "../interactions.js";
import { interactionPickerRecord } from "./interaction-picker-record.js";
import type { AgentTuiTheme } from "./theme";
import { PickerOverlay } from "./picker";

export { interactionPickerRecord } from "./interaction-picker-record.js";

export function InteractionChoicePicker(props: {
  interaction: InteractionRecord;
  selection: number;
  theme: AgentTuiTheme;
  onSelect?: (index: number) => void;
  onChoose?: (choiceId: string) => void | Promise<void>;
}) {
  const record = () => interactionPickerRecord(props.interaction);
  return (
    <PickerOverlay
      picker={record()}
      selection={props.selection}
      theme={props.theme}
      onSelect={props.onSelect}
      onChoose={(option) => void props.onChoose?.(option.id)}
    />
  );
}
