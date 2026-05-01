import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathExists, readJson, readText, writeJsonAtomic, writeTextAtomic } from "./fs-utils.js";
import type { JsonObject } from "./types.js";
import type { CodexApprovalPolicy, CodexSandboxMode, ReasoningEffort } from "./types.js";

const stateFile = "state.json";
const canonicalConfig = "config.toml";
const authFile = "auth.json";

export interface CodexRuntimeConfig {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  sandbox?: CodexSandboxMode | null;
  approvalPolicy?: CodexApprovalPolicy | null;
}

export interface EffectiveCodexConfig {
  model: string | null;
  reasoningEffort: string | null;
  sandbox: CodexSandboxMode | null;
  approvalPolicy: CodexApprovalPolicy | null;
  source: "codex-home" | "supercodex-canonical" | "none";
  path: string | null;
}

export class CodexAuthManager {
  readonly root: string;
  readonly codexHome: string;

  constructor(input: { root?: string; codexHome?: string } = {}) {
    this.root = resolve(input.root ?? join(defaultSupervisorHome(), "codex-auth"));
    this.codexHome = resolve(input.codexHome ?? defaultCodexHome());
  }

  get accountsDir(): string {
    return join(this.root, "accounts");
  }

  get configPath(): string {
    return join(this.root, canonicalConfig);
  }

  get statePath(): string {
    return join(this.root, stateFile);
  }

  accountDir(name: string): string {
    return join(this.accountsDir, sanitizeAccountName(name));
  }

  accountAuthPath(name: string): string {
    return join(this.accountDir(name), authFile);
  }

  codexAuthPath(): string {
    return join(this.codexHome, authFile);
  }

  codexConfigPath(): string {
    return join(this.codexHome, canonicalConfig);
  }

  async loadState(): Promise<JsonObject> {
    const state = await readJson<JsonObject>(this.statePath, { accounts: [], active: null, usageLimited: {} });
    if (!Array.isArray(state.accounts)) {
      state.accounts = [];
    }
    if (typeof state.usageLimited !== "object" || state.usageLimited === null || Array.isArray(state.usageLimited)) {
      state.usageLimited = {};
    }
    return state;
  }

  async saveState(state: JsonObject): Promise<void> {
    await writeJsonAtomic(this.statePath, state);
  }

  async listAccounts(): Promise<string[]> {
    const state = await this.loadState();
    const result: string[] = [];
    for (const item of state.accounts as unknown[]) {
      if (typeof item === "string" && (await pathExists(this.accountAuthPath(item)))) {
        result.push(item);
      }
    }
    return result;
  }

  async activeAccount(): Promise<string | null> {
    const state = await this.loadState();
    const accounts = await this.listAccounts();
    return typeof state.active === "string" && accounts.includes(state.active) ? state.active : accounts[0] ?? null;
  }

  async captureCurrent(name: string, snapshotConfig = false): Promise<string> {
    const account = sanitizeAccountName(name);
    if (!(await pathExists(this.codexAuthPath()))) {
      throw new Error(`Codex auth file not found: ${this.codexAuthPath()}`);
    }
    const target = this.accountDir(account);
    await mkdir(target, { recursive: true });
    await copyFile(this.codexAuthPath(), join(target, authFile));
    if (snapshotConfig || !(await pathExists(this.configPath))) {
      await this.snapshotConfig();
    } else if (await pathExists(this.configPath)) {
      await copyFile(this.configPath, join(target, canonicalConfig));
    }
    const state = await this.loadState();
    const accounts = (state.accounts as unknown[]).filter((item): item is string => typeof item === "string");
    if (!accounts.includes(account)) {
      accounts.push(account);
    }
    state.accounts = accounts;
    if (!state.active) {
      state.active = account;
    }
    await this.saveState(state);
    await this.applyAccountConfig(account);
    if (state.active === account) {
      await this.applyAccountToCodexHome(account);
    }
    return target;
  }

  async snapshotConfig(): Promise<string | null> {
    await mkdir(this.root, { recursive: true });
    if (await pathExists(this.codexConfigPath())) {
      await copyFile(this.codexConfigPath(), this.configPath);
    }
    await this.ensureHighAccessConfig();
    for (const account of await this.listAccounts()) {
      await this.applyAccountConfig(account);
    }
    return this.configPath;
  }

  async applyAccountConfig(account: string): Promise<void> {
    if (!(await pathExists(this.configPath)) || !(await pathExists(this.accountDir(account)))) {
      return;
    }
    await copyFile(this.configPath, join(this.accountDir(account), canonicalConfig));
  }

  async applyAccountToCodexHome(account: string): Promise<void> {
    const cleaned = sanitizeAccountName(account);
    if (!(await pathExists(this.accountAuthPath(cleaned)))) {
      throw new Error(`Unknown Codex auth account: ${cleaned}`);
    }
    await mkdir(this.codexHome, { recursive: true });
    await copyFile(this.accountAuthPath(cleaned), this.codexAuthPath());
    if (await pathExists(this.configPath)) {
      await copyFile(this.configPath, this.codexConfigPath());
      await this.applyAccountConfig(cleaned);
    }
  }

  async prepareEnvironment(baseEnv: NodeJS.ProcessEnv = process.env, project?: string | null, runtime?: CodexRuntimeConfig): Promise<NodeJS.ProcessEnv> {
    await this.ensureHighAccessConfig(project, runtime);
    const active = await this.activeAccount();
    if (active) {
      await this.applyAccountToCodexHome(active);
    }
    return { ...baseEnv, CODEX_HOME: this.codexHome };
  }

  async rotateAfterUsageLimit(): Promise<string | null> {
    return this.rotateAfterAuthFailure("usage_limit");
  }

  async rotateAfterAuthFailure(reason: "usage_limit" | "unauthorized" = "usage_limit"): Promise<string | null> {
    const accounts = await this.listAccounts();
    if (accounts.length < 2) {
      return null;
    }
    const state = await this.loadState();
    const active = (await this.activeAccount()) ?? accounts[0]!;
    const next = accounts[(accounts.indexOf(active) + 1) % accounts.length]!;
    const authFailures = isPlainObject(state.authFailures) ? state.authFailures : {};
    authFailures[active] = reason;
    state.authFailures = authFailures;
    if (reason === "usage_limit") {
      const usageLimited = isPlainObject(state.usageLimited) ? state.usageLimited : {};
      usageLimited[active] = true;
      state.usageLimited = usageLimited;
    }
    state.active = next;
    await this.saveState(state);
    await this.ensureHighAccessConfig();
    await this.applyAccountToCodexHome(next);
    return next;
  }

  async useAccount(name: string): Promise<string> {
    const account = sanitizeAccountName(name);
    if (!(await pathExists(this.accountAuthPath(account)))) {
      throw new Error(`Unknown Codex auth account: ${account}`);
    }
    const state = await this.loadState();
    const accounts = (state.accounts as unknown[]).filter((item): item is string => typeof item === "string");
    if (!accounts.includes(account)) {
      accounts.push(account);
    }
    state.accounts = accounts;
    state.active = account;
    await this.saveState(state);
    await this.ensureHighAccessConfig();
    await this.applyAccountToCodexHome(account);
    return this.accountDir(account);
  }

  async resetUsageLimits(): Promise<void> {
    const state = await this.loadState();
    state.usageLimited = {};
    await this.saveState(state);
  }

  async ensureHighAccessConfig(project?: string | null, runtime?: CodexRuntimeConfig): Promise<string> {
    const source = (await readText(this.configPath, "")) || (await readText(this.codexConfigPath(), ""));
    const config = patchCodexConfigForSupervisor(source, project ?? undefined, runtime);
    await mkdir(this.root, { recursive: true });
    await mkdir(this.codexHome, { recursive: true });
    await writeTextAtomic(this.configPath, config);
    await writeTextAtomic(this.codexConfigPath(), config);
    for (const account of await this.listAccounts()) {
      if (await pathExists(this.accountDir(account))) {
        await copyFile(this.configPath, join(this.accountDir(account), canonicalConfig));
      }
    }
    return this.configPath;
  }
}

export async function readEffectiveCodexConfig(manager: CodexAuthManager): Promise<EffectiveCodexConfig> {
  const codexHomeConfig = await readText(manager.codexConfigPath(), "");
  if (codexHomeConfig.trim()) {
    return {
      ...parseCodexConfigText(codexHomeConfig),
      source: "codex-home",
      path: manager.codexConfigPath(),
    };
  }
  const canonicalConfigText = await readText(manager.configPath, "");
  if (canonicalConfigText.trim()) {
    return {
      ...parseCodexConfigText(canonicalConfigText),
      source: "supercodex-canonical",
      path: manager.configPath,
    };
  }
  return { model: null, reasoningEffort: null, sandbox: null, approvalPolicy: null, source: "none", path: null };
}

export function defaultSupervisorHome(): string {
  return process.env.SUPERCODEX_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || ".", ".supercodex");
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
}

export function sanitizeAccountName(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  if (!cleaned) {
    throw new Error("Auth account name must not be empty.");
  }
  return cleaned;
}

export function runCodexLogin(codexBin = "codex", codexHome?: string): number {
  const env = codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env;
  const result = spawnSync(codexBin, ["login"], { stdio: "inherit", shell: process.platform === "win32", env });
  return result.status ?? 1;
}

export function patchCodexConfigForSupervisor(input: string, project?: string, runtime?: CodexRuntimeConfig): string {
  let lines = input.trimEnd() ? input.trimEnd().split(/\r?\n/) : [];
  if (typeof runtime?.model === "string" && runtime.model.trim()) {
    lines = setTopLevelTomlKey(lines, "model", JSON.stringify(runtime.model.trim()));
  }
  if (typeof runtime?.reasoningEffort === "string" && runtime.reasoningEffort.trim()) {
    lines = setTopLevelTomlKey(lines, "model_reasoning_effort", JSON.stringify(runtime.reasoningEffort.trim()));
  }
  lines = setTopLevelTomlKey(lines, "approval_policy", JSON.stringify(runtime?.approvalPolicy ?? "never"));
  lines = setTopLevelTomlKey(lines, "sandbox_mode", JSON.stringify(runtime?.sandbox ?? "danger-full-access"));
  lines = setTomlSectionKey(lines, "windows", "sandbox", "\"elevated\"");
  if (project?.trim()) {
    lines = setTomlSectionKey(lines, `projects.'${project.trim().replaceAll("'", "\\'")}'`, "trust_level", "\"trusted\"");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseCodexConfigText(input: string): Pick<EffectiveCodexConfig, "model" | "reasoningEffort" | "sandbox" | "approvalPolicy"> {
  return {
    model: parseTopLevelTomlString(input, "model"),
    reasoningEffort: parseTopLevelTomlString(input, "model_reasoning_effort") ?? parseTopLevelTomlString(input, "reasoning_effort"),
    sandbox: parseSandboxModeFromConfig(parseTopLevelTomlString(input, "sandbox_mode")),
    approvalPolicy: parseApprovalPolicyFromConfig(parseTopLevelTomlString(input, "approval_policy")),
  };
}

function parseTopLevelTomlString(input: string, key: string): string | null {
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`);
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (isTomlSectionHeader(line)) {
      break;
    }
    const match = line.match(keyRe);
    if (!match) {
      continue;
    }
    return parseTomlScalarString(match[1] ?? "");
  }
  return null;
}

function parseSandboxModeFromConfig(value: string | null): CodexSandboxMode | null {
  return value === "danger-full-access" || value === "read-only" || value === "workspace-write" ? value : null;
}

function parseApprovalPolicyFromConfig(value: string | null): CodexApprovalPolicy | null {
  return value === "never" || value === "on-failure" || value === "on-request" || value === "untrusted" ? value : null;
}

function parseTomlScalarString(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1] ?? null;
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/);
    return match?.[1] ?? null;
  }
  return value.split("#", 1)[0]?.trim() || null;
}

function setTopLevelTomlKey(lines: string[], key: string, value: string): string[] {
  const next = [...lines];
  const sectionIndex = next.findIndex((line) => isTomlSectionHeader(line));
  const end = sectionIndex >= 0 ? sectionIndex : next.length;
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = 0; index < end; index++) {
    if (keyRe.test(next[index] ?? "")) {
      next[index] = `${key} = ${value}`;
      return next;
    }
  }
  next.splice(end, 0, `${key} = ${value}`);
  return next;
}

function setTomlSectionKey(lines: string[], section: string, key: string, value: string): string[] {
  const next = [...lines];
  const sectionHeader = `[${section}]`;
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let sectionIndex = next.findIndex((line) => line.trim().toLowerCase() === sectionHeader.toLowerCase());
  if (sectionIndex < 0) {
    if (next.length > 0 && next[next.length - 1]?.trim()) {
      next.push("");
    }
    next.push(sectionHeader, `${key} = ${value}`);
    return next;
  }
  let insertAt = sectionIndex + 1;
  for (let index = sectionIndex + 1; index < next.length; index++) {
    if (isTomlSectionHeader(next[index] ?? "")) {
      break;
    }
    insertAt = index + 1;
    if (keyRe.test(next[index] ?? "")) {
      next[index] = `${key} = ${value}`;
      return next;
    }
  }
  next.splice(insertAt, 0, `${key} = ${value}`);
  return next;
}

function isTomlSectionHeader(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*$/.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
