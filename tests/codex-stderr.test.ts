import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSuppressCodexStderr } from "../src/codex-stderr.js";

test("shouldSuppressCodexStderr hides Codex model refresh child-process timeout noise", () => {
  assert.equal(
    shouldSuppressCodexStderr(
      "2026-05-01T14:42:24.247447Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
    ),
    true,
  );
});

test("shouldSuppressCodexStderr keeps unrelated stderr visible", () => {
  assert.equal(shouldSuppressCodexStderr("ERROR codex app-server exited before completing request"), false);
  assert.equal(shouldSuppressCodexStderr("failed to refresh available models: authentication failed"), false);
});
