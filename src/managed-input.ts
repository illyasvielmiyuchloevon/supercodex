export type ManagedPlainTextAction = "initial_goal" | "new_goal" | "steer";

export function managedPlainTextAction(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): ManagedPlainTextAction {
  if (input.supervisorRunning) {
    return "steer";
  }
  if (!input.activeRunStarted && !input.activeRunIsResume) {
    return "initial_goal";
  }
  if (input.activeRunStarted && !input.activeRunIsResume) {
    return "new_goal";
  }
  return "steer";
}

export function shouldCreateFreshRunForManagedMessage(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): boolean {
  return managedPlainTextAction(input) === "new_goal";
}
