import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexConfigText, patchCodexConfigForSupervisor } from "../src/auth.js";
import { parsePermissionSetting } from "../src/settings.js";

test("patchCodexConfigForSupervisor enforces high access supervisor defaults", () => {
  const config = patchCodexConfigForSupervisor(
    [
      'model = "gpt-5.5"',
      'sandbox_mode = "workspace-write"',
      "",
      "[windows]",
      'sandbox = "read-only"',
      "",
      "[projects.'F:\\Walnut']",
      'trust_level = "untrusted"',
    ].join("\n"),
    "F:\\Walnut",
  );

  assert.match(config, /^approval_policy = "never"$/m);
  assert.match(config, /^sandbox_mode = "danger-full-access"$/m);
  assert.match(config, /\[windows\]\nsandbox = "elevated"/);
  assert.match(config, /\[projects\.'F:\\Walnut'\]\ntrust_level = "trusted"/);
  assert.doesNotMatch(config, /workspace-write/);
  assert.doesNotMatch(config, /untrusted/);
});

test("patchCodexConfigForSupervisor can persist model and reasoning settings", () => {
  const config = patchCodexConfigForSupervisor("", "F:\\Walnut", {
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  });

  assert.match(config, /^model = "gpt-5.5"$/m);
  assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(config, /^approval_policy = "never"$/m);
  assert.match(config, /^sandbox_mode = "danger-full-access"$/m);
});

test("parseCodexConfigText reads effective top-level model and reasoning", () => {
  const parsed = parseCodexConfigText(
    [
      '# comment',
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[profiles.default]",
      'model = "ignored"',
    ].join("\n"),
  );

  assert.equal(parsed.model, "gpt-5.5");
  assert.equal(parsed.reasoningEffort, "xhigh");
  assert.equal(parsed.approvalPolicy, "on-request");
  assert.equal(parsed.sandbox, "workspace-write");
});

test("parsePermissionSetting accepts native Codex CLI permission flags", () => {
  assert.deepEqual(parsePermissionSetting("--sandbox danger-full-access --ask-for-approval never"), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  assert.deepEqual(parsePermissionSetting("-s workspace-write -a on-request"), {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(parsePermissionSetting("--full-auto"), {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(parsePermissionSetting("--dangerously-bypass-approvals-and-sandbox"), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  assert.deepEqual(parsePermissionSetting("-c sandbox_mode=\"read-only\" -c approval_policy=untrusted"), {
    sandbox: "read-only",
    approvalPolicy: "untrusted",
  });
});

test("parsePermissionSetting accepts the three user-facing permission modes", () => {
  assert.deepEqual(parsePermissionSetting("default"), {
    sandbox: null,
    approvalPolicy: null,
  });
  assert.deepEqual(parsePermissionSetting("Default permissions"), {
    sandbox: null,
    approvalPolicy: null,
  });
  assert.deepEqual(parsePermissionSetting("auto-review"), {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(parsePermissionSetting("Auto review"), {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(parsePermissionSetting("full-access"), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  assert.deepEqual(parsePermissionSetting("Full access"), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
});
