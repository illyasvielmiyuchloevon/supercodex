export type ManagedPlainTextAction = "initial_message" | "new_message" | "steer";

export function managedPlainTextAction(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): ManagedPlainTextAction {
  if (input.supervisorRunning) {
    return "steer";
  }
  if (!input.activeRunStarted && !input.activeRunIsResume) {
    return "initial_message";
  }
  if (input.activeRunStarted && !input.activeRunIsResume) {
    return "new_message";
  }
  return "steer";
}

export function shouldCreateFreshRunForManagedMessage(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): boolean {
  return managedPlainTextAction(input) === "new_message";
}
