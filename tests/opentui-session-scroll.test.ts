import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptScrollAcceleration, transcriptPageRows } from "../src/opentui/session-scroll.js";

test("transcript mouse wheel uses a larger OpenTUI scroll multiplier", () => {
  const acceleration = createTranscriptScrollAcceleration();
  assert.equal(acceleration.tick(), 6);
  acceleration.reset();
  assert.equal(acceleration.tick(), 6);
});

test("transcript page scrolling moves almost a full viewport with a useful minimum", () => {
  assert.equal(transcriptPageRows(4), 6);
  assert.equal(transcriptPageRows(20), 18);
});
