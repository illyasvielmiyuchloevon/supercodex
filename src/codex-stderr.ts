const suppressedCodexStderrFragments = [
  "codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
] as const;

export function shouldSuppressCodexStderr(line: string): boolean {
  const normalized = line.replace(/\s+/g, " ").trim().toLowerCase();
  return suppressedCodexStderrFragments.some((fragment) => normalized.includes(fragment));
}
