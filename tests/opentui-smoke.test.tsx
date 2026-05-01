import { describe, expect, test } from "bun:test";
import { autocompleteOverlayLayout, formatSuggestionRow } from "../src/opentui/autocomplete";
import { smokeChooseSlashCommandWithEnter, smokeChooseSlashPrefixCommandWithEnter, smokeOperateCodexInteractionPickerWithKeyboard, smokeOperateStopPickerWithKeyboard, smokeRenderOpenTui, smokeRenderOpenTuiCustomTheme, smokeRenderOpenTuiDialogHost, smokeRenderOpenTuiLongTranscript, smokeRenderOpenTuiModelPicker, smokeRenderOpenTuiPanels, smokeRenderOpenTuiPermissionsPicker, smokeRenderOpenTuiPrefersCanonicalTranscriptLines, smokeRenderOpenTuiResponsiveMetadata, smokeRenderOpenTuiResumePicker, smokeRenderOpenTuiRunningControls, smokeRenderOpenTuiSecondaryCommandPicker, smokeRenderOpenTuiStructuredMessages, smokeRenderOpenTuiToastsAndErrorBoundary, smokeRenderOpenTuiTranscriptUpdateBurst, smokeRenderOpenTuiViewportMatrix, smokeRouteOpenTuiStartCommand, smokeSubmitOpenTuiPromptMultiline, stableSidebarWidth } from "../src/opentui-app";

describe("OpenTUI frontend", () => {
  test("renders with the real OpenTUI Solid renderer", async () => {
    const frame = await smokeRenderOpenTui();
    expect(frame).toContain("SuperCodex");
    expect(frame).toContain("OpenTUI managed");
    expect(frame).toContain("OpenTUI textarea");
    expect(frame).toContain("assistant: working");
    expect(frame).not.toContain("exiOpenTUI");
  });

  test("renders command palette and Codex interaction picker as OpenTUI components", async () => {
    const frame = await smokeRenderOpenTuiPanels();
    expect(frame).toContain("Slash commands");
    expect(frame).toContain("/start");
    expect(frame).toContain("/model");
    expect(frame).toContain("Command Approval");
    expect(frame).toContain("npm test");
    expect(frame).toContain("accept");
  });

  test("keeps slash command palette inside the viewport and above the prompt", () => {
    const layout = autocompleteOverlayLayout({
      anchor: { x: 52, y: 22, width: 50 },
      parent: { x: 0, y: 21, width: 60 },
      terminal: { width: 60, height: 24 },
      suggestionCount: 16,
    });
    expect(layout.left).toBeLessThanOrEqual(60 - layout.width - 1);
    expect(layout.top).toBeLessThan(0);
    expect(layout.height).toBeLessThanOrEqual(10);

    const row = formatSuggestionRow({
      usage: "/reasoning <minimal|low|medium|high|xhigh>",
      description: "Queue reasoning effort for the next turn.",
    }, 24);
    expect(row.length).toBeLessThanOrEqual(24);
    expect(row.endsWith("...")).toBe(true);
  });

  test("renders a keyboard-selectable resume session picker", async () => {
    const frame = await smokeRenderOpenTuiResumePicker();
    expect(frame).toContain("Slash commands > /resume");
    expect(frame).toContain("Resume Sessions");
    expect(frame).toContain("No.  Run ID");
    expect(frame).toContain("session-2026");
    expect(frame).toContain("default");
    expect(frame).toContain("Enter select");
  });

  test("renders secondary command choices with the shared picker", async () => {
    const frame = await smokeRenderOpenTuiSecondaryCommandPicker();
    expect(frame).toContain("Slash commands > /reasoning");
    expect(frame).toContain("Reasoning Effort");
    expect(frame).toContain("medium");
    expect(frame).toContain("xhigh");
    expect(frame).toContain("Enter apply");
  });

  test("renders model choices with the shared picker", async () => {
    const frame = await smokeRenderOpenTuiModelPicker();
    expect(frame).toContain("Slash commands > /model");
    expect(frame).toContain("Codex Model");
    expect(frame).toContain("gpt-5.5");
    expect(frame).toContain("gpt-5.4-mini");
    expect(frame).toContain("Enter apply");
  });

  test("renders Codex permission choices with the shared picker", async () => {
    const frame = await smokeRenderOpenTuiPermissionsPicker();
    expect(frame).toContain("Slash commands > /permissions");
    expect(frame).toContain("Codex Permissions");
    expect(frame).toContain("Default permissions");
    expect(frame).toContain("Auto-review");
    expect(frame).toContain("Full access");
    expect(frame).toContain("danger-full-access");
    expect(frame).toContain("Enter apply");
  });

  test("submits a slash command selection on enter instead of requiring manual completion", async () => {
    const result = await smokeChooseSlashCommandWithEnter();
    expect(result.command).toBe("/start");
    expect(result.submit).toBe(true);
    expect(result.input).toBe("");
  });

  test("routes /start to active saved-run startup, not passive resume selection", async () => {
    const result = await smokeRouteOpenTuiStartCommand();
    expect(result.started).toEqual(["saved-run"]);
    expect(result.resumed).toEqual([]);
    expect(result.fresh).toEqual([]);
  });

  test("submits a filtered slash command selection instead of the partial query", async () => {
    const result = await smokeChooseSlashPrefixCommandWithEnter();
    expect(result.command).toBe("/model");
    expect(result.submit).toBe(true);
    expect(result.input).toBe("");
  });

  test("submits multiline prompt text from the OpenTUI textarea", async () => {
    const submitted = await smokeSubmitOpenTuiPromptMultiline();
    expect(submitted).toBe("first line\nsecond line");
  });

  test("keeps long transcript inside the OpenTUI scrollbox", async () => {
    const frame = await smokeRenderOpenTuiLongTranscript();
    expect(frame).toContain("final visible message");
    expect(frame).toContain("OpenTUI textarea");
    expect(frame).not.toContain("transcript line 00");
  });

  test("renders structured message parts instead of flat transcript rows", async () => {
    const frame = await smokeRenderOpenTuiStructuredMessages();
    expect(frame).toContain("USER");
    expect(frame).toContain("ASSISTANT");
    expect(frame).toContain("first paragraph stays first");
    expect(frame).toContain("second paragraph stays second");
    expect(frame.indexOf("first paragraph stays first")).toBeLessThan(frame.indexOf("second paragraph stays second"));
    expect(frame).toContain("COMMAND");
    expect(frame).toContain("$ npm test");
    expect(frame).toContain("FILE CHANGE");
  });

  test("keeps session metadata visible in a narrow viewport with the same sidebar structure", async () => {
    const frame = await smokeRenderOpenTuiResponsiveMetadata();
    expect(frame).toContain("metadata stays visible");
    expect(frame).toContain("model gpt-5.5");
    expect(frame).toContain("msgs 1");
    expect(frame).toContain("stage stage-22");
  });

  test("prefers canonical transcript lines over stale structured messages", async () => {
    const frame = await smokeRenderOpenTuiPrefersCanonicalTranscriptLines();
    expect(frame).toContain("canonical line from transcript");
    expect(frame).not.toContain("stale structured message");
  });

  test("uses a continuous sidebar width without the old 96-column breakpoint", () => {
    expect(stableSidebarWidth(95)).toBe(stableSidebarWidth(96));
    expect(stableSidebarWidth(60)).toBeGreaterThan(0);
    expect(stableSidebarWidth(140)).toBeGreaterThan(stableSidebarWidth(96));
  });

  test("renders an absolute dialog host overlay", async () => {
    const frame = await smokeRenderOpenTuiDialogHost();
    expect(frame).toContain("Dialog Host");
    expect(frame).toContain("Reusable overlay stack is active.");
    expect(frame).toContain("Continue");
    expect(frame).toContain("esc");
  });

  test("renders toast feedback and recoverable UI errors", async () => {
    const frame = await smokeRenderOpenTuiToastsAndErrorBoundary();
    expect(frame).toContain("Saved settings");
    expect(frame).toContain("UI Error");
    expect(frame).toContain("render failure");
    expect(frame).toContain("Reset");
  });

  test("renders local TUI theme/config metadata", async () => {
    const frame = await smokeRenderOpenTuiCustomTheme();
    expect(frame).toContain("theme opencode/light");
    expect(frame).toContain("mouse off");
    expect(frame).toContain("theme config smoke");
  });

  test("renders active SuperCodex/codex state and stop confirmation affordance", async () => {
    const frame = await smokeRenderOpenTuiRunningControls();
    expect(frame).toContain("SUPERCODEX RUNNING");
    expect(frame).toContain("CODEX RUNNING");
    expect(frame).toContain("Esc stop");
    expect(frame).toContain("Stop Current Task?");
    expect(frame).toContain("Keep Running");
  });

  test("uses the shared picker keyboard controls for the Esc stop confirmation", async () => {
    const result = await smokeOperateStopPickerWithKeyboard();
    expect(result.frame).toContain("Stop Current Task?");
    expect(result.frame).toContain("Keep Running");
    expect(result.action).toBe("cancel");
  });

  test("uses the shared picker keyboard controls for Codex interaction requests", async () => {
    const result = await smokeOperateCodexInteractionPickerWithKeyboard();
    expect(result.frame).toContain("Command Approval");
    expect(result.frame).toContain("accept for session");
    expect(result.choice).toBe("accept-session");
  });

  test("renders a viewport matrix with dialog, toast, long transcript, and prompt", async () => {
    const frame = await smokeRenderOpenTuiViewportMatrix();
    expect(frame).toContain("matrix 60x22");
    expect(frame).toContain("matrix 140x42");
    expect(frame).toContain("Viewport Matrix");
    expect(frame).toContain("Matrix toast");
    expect(frame).toContain("OpenTUI textarea");
    expect(frame).not.toContain("undefined");
    expect(frame).not.toContain("exiOpenTUI");
  });

  test("renders repeated transcript updates within a stable budget", async () => {
    const result = await smokeRenderOpenTuiTranscriptUpdateBurst();
    expect(result.frame).toContain("burst update 24");
    expect(result.frame).toContain("OpenTUI textarea");
    expect(result.durationMs).toBeLessThan(1500);
  });
});
