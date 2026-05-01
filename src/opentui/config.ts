import { join, resolve } from "node:path";
import { readText } from "../fs-utils.js";
import { defaultRunId, sanitizeRunId, supervisorDataRoot } from "../settings.js";
import type { JsonObject } from "../types.js";

export const agentTuiColorKeys = [
  "background",
  "panel",
  "panelRaised",
  "panelSelected",
  "border",
  "borderActive",
  "primary",
  "success",
  "warning",
  "error",
  "text",
  "muted",
  "selectedText",
] as const;

export type AgentTuiColorName = (typeof agentTuiColorKeys)[number];
export type AgentTuiThemeMode = "dark" | "light" | "auto";
export type AgentTuiResolvedMode = "dark" | "light";

export interface AgentTuiConfig extends JsonObject {
  theme?: string;
  themeMode?: AgentTuiThemeMode;
  resolvedMode?: AgentTuiResolvedMode;
  mouse?: boolean;
  targetFps?: number;
  colors?: Partial<Record<AgentTuiColorName, string>>;
  sourceFiles?: string[];
}

export interface AgentTuiConfigReadOptions {
  env?: NodeJS.ProcessEnv;
}

const colorAliases: Record<string, AgentTuiColorName> = {
  background: "background",
  backgroundPanel: "panel",
  backgroundElement: "panelRaised",
  backgroundMenu: "panelRaised",
  panel: "panel",
  panelRaised: "panelRaised",
  panelSelected: "panelSelected",
  border: "border",
  borderActive: "borderActive",
  primary: "primary",
  success: "success",
  warning: "warning",
  error: "error",
  text: "text",
  textMuted: "muted",
  muted: "muted",
  selectedText: "selectedText",
  selectedListItemText: "selectedText",
};

export function agentTuiConfigPaths(projectInput: string, runId?: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const project = resolve(projectInput);
  const cleanRunId = sanitizeRunId(runId);
  const paths = [
    join(project, ".supercodex", "tui.json"),
    join(project, ".supercodex", "runtime", "tui.json"),
  ];
  if (cleanRunId !== defaultRunId) {
    paths.push(join(supervisorDataRoot(project, cleanRunId), "tui.json"));
  }
  const custom = typeof env.SUPERCODEX_TUI_CONFIG === "string" && env.SUPERCODEX_TUI_CONFIG.trim()
    ? resolve(project, env.SUPERCODEX_TUI_CONFIG.trim())
    : null;
  if (custom) {
    paths.push(custom);
  }
  return paths;
}

export async function readAgentTuiConfig(
  project: string,
  runId?: string | null,
  options: AgentTuiConfigReadOptions = {},
): Promise<AgentTuiConfig> {
  const env = options.env ?? process.env;
  let merged: AgentTuiConfig = {};
  const sourceFiles: string[] = [];

  for (const path of agentTuiConfigPaths(project, runId, env)) {
    const data = await readAgentTuiConfigFile(path);
    if (!data) continue;
    merged = mergeAgentTuiConfig(merged, data);
    sourceFiles.push(path);
  }

  merged = mergeAgentTuiConfig(merged, configFromEnvironment(env));
  const themeMode = merged.themeMode ?? "auto";
  return {
    ...merged,
    theme: merged.theme ?? "opencode",
    themeMode,
    resolvedMode: resolveAgentTuiThemeMode(themeMode, env),
    sourceFiles,
  };
}

export async function readAgentTuiConfigFile(path: string): Promise<AgentTuiConfig | null> {
  const text = await readText(path, "");
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return normalizeAgentTuiConfig(parsed);
  } catch {
    return null;
  }
}

export function normalizeAgentTuiConfig(value: unknown): AgentTuiConfig {
  if (!isObject(value)) {
    return {};
  }
  const flattened = flattenNestedTui(value);
  const next: AgentTuiConfig = {};

  if (typeof flattened.theme === "string" && flattened.theme.trim()) {
    next.theme = flattened.theme.trim();
  }
  const themeMode = normalizeThemeMode(flattened.themeMode ?? flattened.mode ?? flattened.theme_mode);
  if (themeMode) {
    next.themeMode = themeMode;
  }
  const mouse = normalizeBoolean(flattened.mouse);
  if (mouse !== undefined) {
    next.mouse = mouse;
  }
  const targetFps = normalizeTargetFps(flattened.targetFps ?? flattened.target_fps);
  if (targetFps !== undefined) {
    next.targetFps = targetFps;
  }

  const colors = normalizeColors(firstObject(flattened.colors, flattened.palette, typeof flattened.theme === "object" ? flattened.theme : undefined));
  if (Object.keys(colors).length) {
    next.colors = colors;
  }
  return next;
}

export function mergeAgentTuiConfig(base: AgentTuiConfig, patch: AgentTuiConfig): AgentTuiConfig {
  return {
    ...base,
    ...patch,
    colors: {
      ...(base.colors ?? {}),
      ...(patch.colors ?? {}),
    },
  };
}

export function resolveAgentTuiThemeMode(mode: AgentTuiThemeMode, env: NodeJS.ProcessEnv = process.env): AgentTuiResolvedMode {
  if (mode === "dark" || mode === "light") {
    return mode;
  }
  return inferTerminalThemeMode(env);
}

export function inferTerminalThemeMode(env: NodeJS.ProcessEnv = process.env): AgentTuiResolvedMode {
  const explicit = normalizeThemeMode(env.SUPERCODEX_TUI_THEME_MODE);
  if (explicit === "dark" || explicit === "light") {
    return explicit;
  }
  const colorFgBg = env.COLORFGBG;
  if (typeof colorFgBg === "string") {
    const parts = colorFgBg.split(";").map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
    const background = parts.at(-1);
    if (typeof background === "number") {
      return background >= 7 ? "light" : "dark";
    }
  }
  if (env.WT_SESSION && env.TERM_PROGRAM === "Windows_Terminal") {
    return "dark";
  }
  return "dark";
}

function configFromEnvironment(env: NodeJS.ProcessEnv): AgentTuiConfig {
  return normalizeAgentTuiConfig({
    theme: env.SUPERCODEX_TUI_THEME,
    themeMode: env.SUPERCODEX_TUI_THEME_MODE,
    mouse: env.SUPERCODEX_TUI_MOUSE,
    targetFps: env.SUPERCODEX_TUI_TARGET_FPS,
  });
}

function flattenNestedTui(input: JsonObject): JsonObject {
  if (!isObject(input.tui)) {
    return { ...input };
  }
  const { tui: _tui, ...rest } = input;
  return { ...(input.tui as JsonObject), ...rest };
}

function normalizeColors(value: JsonObject | undefined): Partial<Record<AgentTuiColorName, string>> {
  const colors: Partial<Record<AgentTuiColorName, string>> = {};
  if (!value) {
    return colors;
  }
  for (const [key, raw] of Object.entries(value)) {
    const mapped = colorAliases[key];
    if (!mapped || typeof raw !== "string") continue;
    const color = normalizeHexColor(raw);
    if (color) {
      colors[mapped] = color;
    }
  }
  return colors;
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

function normalizeThemeMode(value: unknown): AgentTuiThemeMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "dark" || normalized === "light" || normalized === "auto") {
    return normalized;
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function normalizeTargetFps(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.min(120, Math.max(10, Math.round(numeric)));
}

function firstObject(...values: unknown[]): JsonObject | undefined {
  return values.find(isObject);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
