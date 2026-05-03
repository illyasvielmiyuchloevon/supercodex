import assert from "node:assert/strict";
import test from "node:test";
import { openTuiLaunchEnv } from "../src/opentui-launcher.js";

test("OpenTUI launcher defaults to wcwidth rendering for mixed-width terminal text", () => {
  const env = openTuiLaunchEnv({ PATH: "bin" });

  assert.equal(env.OPENTUI_FORCE_WCWIDTH, "true");
  assert.equal(env.PATH, "bin");
});

test("OpenTUI launcher preserves explicit Unicode width overrides", () => {
  assert.equal(openTuiLaunchEnv({ OPENTUI_FORCE_WCWIDTH: "false" }).OPENTUI_FORCE_WCWIDTH, "false");
  assert.equal(openTuiLaunchEnv({ OPENTUI_FORCE_UNICODE: "true" }).OPENTUI_FORCE_WCWIDTH, undefined);
});
