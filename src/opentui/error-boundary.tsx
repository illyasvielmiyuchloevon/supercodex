import { ErrorBoundary, type JSX } from "solid-js";
import { DialogHost } from "./dialog-host";
import type { AgentTuiTheme } from "./theme";

export function OpenTuiErrorBoundary(props: {
  theme: AgentTuiTheme;
  children: JSX.Element;
}) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <DialogHost
          theme={props.theme}
          dialogs={[
            {
              id: "ui-error",
              title: "UI Error",
              body: error instanceof Error ? error.message : String(error),
              kind: "error",
              actions: [{ id: "reset", label: "Reset", variant: "primary" }],
            },
          ]}
          onAction={() => reset()}
          onClose={() => reset()}
        />
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
}
