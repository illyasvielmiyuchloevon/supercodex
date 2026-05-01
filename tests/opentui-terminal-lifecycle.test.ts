import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTerminalTitle,
  consoleOptionsForSelectionCopy,
  copyRendererSelection,
  handleCtrlCCopyOnly,
  isCtrlCCopyShortcut,
  osc52Sequence,
  restoreTerminalTitle,
  terminalTitleForRun,
  type SelectionRenderer,
} from "../src/opentui/terminal-lifecycle.js";

test("terminalTitleForRun includes mode, project, run, and work identity", () => {
  assert.equal(
    terminalTitleForRun({ project: "C:\\Users\\eirui\\Desktop\\agent", runId: "run-1", mode: "managed", stage: "stage-24", task: "S24-T2" }),
    "SuperCodex - managed - agent - run-1 - S24-T2",
  );
});

test("applyTerminalTitle and restoreTerminalTitle use renderer title API when present", () => {
  const titles: string[] = [];
  const renderer = { setTerminalTitle: (title: string) => titles.push(title) };
  applyTerminalTitle(renderer, "custom title");
  restoreTerminalTitle(renderer);
  assert.deepEqual(titles, ["custom title", "SuperCodex"]);
});

test("copyRendererSelection copies and clears selected text", async () => {
  const copied: string[] = [];
  let cleared = false;
  const renderer: SelectionRenderer = {
    getSelection: () => ({ getSelectedText: () => "selected text" }),
    clearSelection: () => {
      cleared = true;
    },
  };

  assert.equal(await copyRendererSelection(renderer, (text) => {
    copied.push(text);
  }), true);
  assert.deepEqual(copied, ["selected text"]);
  assert.equal(cleared, true);
});

test("copyRendererSelection returns false when nothing is selected", async () => {
  const renderer: SelectionRenderer = {
    getSelection: () => null,
    clearSelection: () => {
      throw new Error("clearSelection should not run");
    },
  };

  assert.equal(await copyRendererSelection(renderer, () => undefined), false);
});

test("handleCtrlCCopyOnly consumes Ctrl+C as copy-only without any exit action", async () => {
  const copiedText: string[] = [];
  const copiedState: boolean[] = [];
  let prevented = false;
  let stopped = false;
  let cleared = false;
  const renderer: SelectionRenderer = {
    getSelection: () => ({ getSelectedText: () => "selected text" }),
    clearSelection: () => {
      cleared = true;
    },
  };

  assert.equal(isCtrlCCopyShortcut({ ctrl: true, name: "c" }), true);
  assert.equal(await handleCtrlCCopyOnly(
    {
      ctrl: true,
      name: "c",
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    },
    renderer,
    (copied) => {
      copiedState.push(copied);
    },
    (text) => {
      copiedText.push(text);
    },
  ), true);

  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(cleared, true);
  assert.deepEqual(copiedText, ["selected text"]);
  assert.deepEqual(copiedState, [true]);
});

test("handleCtrlCCopyOnly still consumes Ctrl+C when no selection exists", async () => {
  const copiedState: boolean[] = [];
  let prevented = false;
  const renderer: SelectionRenderer = {
    getSelection: () => null,
    clearSelection: () => {
      throw new Error("clearSelection should not run");
    },
  };

  assert.equal(await handleCtrlCCopyOnly(
    {
      ctrl: true,
      name: "c",
      preventDefault: () => {
        prevented = true;
      },
    },
    renderer,
    (copied) => {
      copiedState.push(copied);
    },
    () => {
      throw new Error("copy should not run");
    },
  ), true);

  assert.equal(prevented, true);
  assert.deepEqual(copiedState, [false]);
  assert.equal(isCtrlCCopyShortcut({ ctrl: true, name: "x" }), false);
});

test("consoleOptionsForSelectionCopy binds ctrl+y to copy-selection", () => {
  const copied: string[] = [];
  const options = consoleOptionsForSelectionCopy((text) => {
    copied.push(text);
  });
  assert.deepEqual(options.keyBindings, [{ name: "y", ctrl: true, action: "copy-selection" }]);
  options.onCopySelection?.("console selection");
  assert.deepEqual(copied, ["console selection"]);
});

test("osc52Sequence supports tmux passthrough", () => {
  assert.equal(osc52Sequence("abc", {}), "\x1b]52;c;YWJj\x07");
  assert.equal(osc52Sequence("abc", { TMUX: "1" }), "\x1bPtmux;\x1b\x1b]52;c;YWJj\x07\x1b\\");
});
