import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachOptions } from "./tui.js";

export async function runOpenTuiFrontend(options: AttachOptions): Promise<number> {
  const entry = resolveOpenTuiEntry();
  const preload = resolveOpenTuiPreload();
  const packageRoot = resolvePackageRoot();
  const bun = process.env.SUPERCODEX_BUN_BIN || "bun";
  const child = spawn(bun, ["--preload", preload, entry], {
    stdio: "inherit",
    shell: false,
    cwd: packageRoot,
    env: openTuiLaunchEnv({
      ...process.env,
      SUPERCODEX_PROJECT: resolve(options.project),
      SUPERCODEX_RUN_ID: options.runId ?? "default",
      SUPERCODEX_TUI_MODE: options.managed ? "managed" : "attach",
      SUPERCODEX_AUTH_ROOT: options.authManager.root,
      SUPERCODEX_CODEX_HOME: options.authManager.codexHome,
      SUPERCODEX_APP_SERVER_OPTIONS: JSON.stringify({
        ...options.appServerOptions,
        streamConsole: false,
      }),
      SUPERCODEX_POLL_MS: String(options.pollMs ?? 500),
    }),
  });

  return await new Promise((resolvePromise) => {
    child.on("error", (error) => {
      console.error(`[supercodex] failed to start Bun/OpenTUI frontend: ${error.message}`);
      resolvePromise(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`[supercodex] Bun/OpenTUI frontend exited by signal ${signal}`);
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

export function openTuiLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (isTruthy(env.OPENTUI_FORCE_UNICODE) || env.OPENTUI_FORCE_WCWIDTH !== undefined) {
    return env;
  }
  return {
    ...env,
    OPENTUI_FORCE_WCWIDTH: "true",
  };
}

function resolveOpenTuiEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolvePackageRoot();
  const candidates = [
    join(here, "opentui-app.jsx"),
    join(packageRoot, "src", "opentui-app.tsx"),
    join(process.cwd(), "src", "opentui-app.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("OpenTUI frontend entry not found. Expected dist/src/opentui-app.jsx or src/opentui-app.tsx to exist.");
}

function resolveOpenTuiPreload(): string {
  try {
    return fileURLToPath(import.meta.resolve("@opentui/solid/preload"));
  } catch {
    return "@opentui/solid/preload";
  }
}

function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}
