import { RGBA } from "@opentui/core";
import type { AgentTuiColorName, AgentTuiConfig, AgentTuiResolvedMode } from "./config";
import type { JsonObject } from "../types.js";

export interface AgentTuiTheme {
  background: RGBA;
  panel: RGBA;
  panelRaised: RGBA;
  panelSelected: RGBA;
  border: RGBA;
  borderActive: RGBA;
  primary: RGBA;
  success: RGBA;
  warning: RGBA;
  error: RGBA;
  text: RGBA;
  muted: RGBA;
  selectedText: RGBA;
}

type Palette = Record<AgentTuiColorName, string>;

const opencodeDark: Palette = {
  background: "#0a0a0a",
  panel: "#141414",
  panelRaised: "#1e1e1e",
  panelSelected: "#282828",
  border: "#484848",
  borderActive: "#606060",
  primary: "#fab283",
  success: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
  text: "#eeeeee",
  muted: "#808080",
  selectedText: "#0a0a0a",
};

const opencodeLight: Palette = {
  background: "#ffffff",
  panel: "#fafafa",
  panelRaised: "#f5f5f5",
  panelSelected: "#ebebeb",
  border: "#b8b8b8",
  borderActive: "#a0a0a0",
  primary: "#3b7dd8",
  success: "#3d9a57",
  warning: "#d68c27",
  error: "#d1383d",
  text: "#1a1a1a",
  muted: "#8a8a8a",
  selectedText: "#ffffff",
};

const supercodexDark: Palette = {
  background: "#0a0c10",
  panel: "#14171d",
  panelRaised: "#1a1e26",
  panelSelected: "#252e3a",
  border: "#4c5666",
  borderActive: "#60a5fa",
  primary: "#60a5fa",
  success: "#4ade80",
  warning: "#eab308",
  error: "#f87171",
  text: "#e2e8f0",
  muted: "#94a3b8",
  selectedText: "#111827",
};

const builtinThemes: Record<string, Record<AgentTuiResolvedMode, Palette>> = {
  opencode: {
    dark: opencodeDark,
    light: opencodeLight,
  },
  supercodex: {
    dark: supercodexDark,
    light: opencodeLight,
  },
  supervisor: {
    dark: supercodexDark,
    light: opencodeLight,
  },
  agent: {
    dark: supercodexDark,
    light: opencodeLight,
  },
};

export function themeForStatus(status: JsonObject, config: AgentTuiConfig = {}): AgentTuiTheme {
  const running = status.runtimeStatus === "running";
  const mode = config.resolvedMode ?? (config.themeMode === "light" ? "light" : "dark");
  const selected = builtinThemes[config.theme ?? "opencode"] ?? builtinThemes.opencode!;
  const palette = {
    ...(selected[mode] ?? selected.dark),
    ...(config.colors ?? {}),
  };
  if (!config.colors?.borderActive) {
    palette.borderActive = running ? palette.success : palette.primary;
  }
  return {
    background: rgba(palette.background),
    panel: rgba(palette.panel),
    panelRaised: rgba(palette.panelRaised),
    panelSelected: rgba(palette.panelSelected),
    border: rgba(palette.border),
    borderActive: rgba(palette.borderActive),
    primary: rgba(palette.primary),
    success: rgba(palette.success),
    warning: rgba(palette.warning),
    error: rgba(palette.error),
    text: rgba(palette.text),
    muted: rgba(palette.muted),
    selectedText: rgba(palette.selectedText),
  };
}

function rgba(hex: string): RGBA {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return RGBA.fromInts(r, g, b);
}
