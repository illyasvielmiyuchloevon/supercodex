import type { ScrollAcceleration } from "@opentui/core";

const TRANSCRIPT_WHEEL_MULTIPLIER = 6;

export function createTranscriptScrollAcceleration(multiplier = TRANSCRIPT_WHEEL_MULTIPLIER): ScrollAcceleration {
  return {
    tick: () => multiplier,
    reset: () => undefined,
  };
}

export function transcriptPageRows(height: number): number {
  return Math.max(6, Math.floor(height * 0.9));
}
