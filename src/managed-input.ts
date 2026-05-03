export type ManagedPlainTextAction = "initial_task" | "new_task" | "steer";

export function managedPlainTextAction(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): ManagedPlainTextAction {
  if (input.supervisorRunning) {
    return "steer";
  }
  if (!input.activeRunStarted && !input.activeRunIsResume) {
    return "initial_task";
  }
  if (input.activeRunStarted && !input.activeRunIsResume) {
    return "new_task";
  }
  return "steer";
}

export function shouldCreateFreshRunForManagedMessage(input: {
  supervisorRunning: boolean;
  activeRunStarted: boolean;
  activeRunIsResume: boolean;
}): boolean {
  return managedPlainTextAction(input) === "new_task";
}
