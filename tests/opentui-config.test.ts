import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTuiConfigPaths,
  inferTerminalThemeMode,
  normalizeAgentTuiConfig,
  readAgentTuiConfig,
  resolveAgentTuiThemeMode,
} from "../src/opentui/config.js";

test("readAgentTuiConfig merges project, runtime, run, and explicit custom config", async () => {
  const project = await mkdtemp(join(tmpdir(), "agent-tui-config-"));
  await mkdir(join(project, ".supercodex", "runtime", "runs", "custom"), { recursive: true });
  await writeFile(join(project, ".supercodex", "tui.json"), JSON.stringify({ tui: { theme: "supercodex", themeMode: "dark", colors: { primary: "#123456" } } }));
  await writeFile(join(project, ".supercodex", "runtime", "tui.json"), JSON.stringify({ mouse: false, targetFps: 144, colors: { textMuted: "#abcdef" } }));
  await writeFile(join(project, ".supercodex", "runtime", "runs", "custom", "tui.json"), JSON.stringify({ themeMode: "light", targetFps: 30 }));
  await writeFile(join(project, "custom-tui.json"), JSON.stringify({ colors: { borderActive: "#fedcba" } }));

  const config = await readAgentTuiConfig(project, "custom", {
    env: {
      SUPERCODEX_TUI_CONFIG: "custom-tui.json",
      SUPERCODEX_TUI_THEME: "opencode",
      COLORFGBG: "15;0",
    },
  });

  assert.equal(config.theme, "opencode");
  assert.equal(config.themeMode, "light");
  assert.equal(config.resolvedMode, "light");
  assert.equal(config.mouse, false);
  assert.equal(config.targetFps, 30);
  assert.equal(config.colors?.primary, "#123456");
  assert.equal(config.colors?.muted, "#abcdef");
  assert.equal(config.colors?.borderActive, "#fedcba");
  assert.equal(config.sourceFiles?.length, 4);
});

test("normalizeAgentTuiConfig accepts nested tui values and ignores invalid fields", () => {
  const config = normalizeAgentTuiConfig({
    tui: {
      theme: "agent",
      theme_mode: "auto",
      mouse: "off",
      target_fps: 4,
      themeObjectShouldNotWin: true,
      colors: {
        backgroundPanel: "#fff",
        primary: "blue",
        selectedListItemText: "#010203",
      },
    },
  });

  assert.equal(config.theme, "agent");
  assert.equal(config.themeMode, "auto");
  assert.equal(config.mouse, false);
  assert.equal(config.targetFps, 10);
  assert.equal(config.colors?.panel, "#ffffff");
  assert.equal(config.colors?.primary, undefined);
  assert.equal(config.colors?.selectedText, "#010203");
});

test("agentTuiConfigPaths includes run-scoped config only for named runs", () => {
  const project = "C:\\repo";
  assert.equal(agentTuiConfigPaths(project, "default", {}).some((path) => path.includes("runs")), false);
  assert.equal(agentTuiConfigPaths(project, "nightly", {}).some((path) => path.includes("runs")), true);
});

test("inferTerminalThemeMode uses COLORFGBG background when available", () => {
  assert.equal(inferTerminalThemeMode({ COLORFGBG: "15;0" }), "dark");
  assert.equal(inferTerminalThemeMode({ COLORFGBG: "0;15" }), "light");
  assert.equal(resolveAgentTuiThemeMode("auto", { COLORFGBG: "0;7" }), "light");
});
