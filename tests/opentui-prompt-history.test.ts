import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendPromptHistory,
  popPromptStash,
  promptHistoryPath,
  pushPromptStash,
  readPromptHistory,
  readPromptStash,
  selectPromptHistory,
} from "../src/opentui-prompt-history.js";

test("prompt history is run-scoped, capped, and navigable", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-prompt-history-"));
  for (let index = 0; index < 55; index++) {
    await appendPromptHistory(project, `prompt ${index}`, "run-a");
  }
  await appendPromptHistory(project, "other run prompt", "run-b");

  const history = await readPromptHistory(project, "run-a");
  assert.equal(history.length, 50);
  assert.equal(history[0]!.input, "prompt 5");
  assert.equal(history.at(-1)!.input, "prompt 54");
  assert.equal((await readPromptHistory(project, "run-b")).at(-1)!.input, "other run prompt");

  const previous = selectPromptHistory(history, history.length, -1);
  assert.equal(previous.input, "prompt 54");
  const backToDraft = selectPromptHistory(history, previous.index, 1);
  assert.equal(backToDraft.input, "");
});

test("prompt history self-heals invalid jsonl entries", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-prompt-history-corrupt-"));
  const path = promptHistoryPath(project, "default");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `{"input":"valid","createdAt":"2026-05-01T00:00:00.000Z"}\nnot-json\n{"input":""}\n`, "utf8");

  const history = await readPromptHistory(project, "default");
  assert.deepEqual(history.map((entry) => entry.input), ["valid"]);
  const rewritten = await readPromptHistory(project, "default");
  assert.deepEqual(rewritten.map((entry) => entry.input), ["valid"]);
});

test("prompt stash pushes and pops newest run-scoped entry", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-prompt-stash-"));
  await pushPromptStash(project, "first", "run-a");
  await pushPromptStash(project, "second", "run-a");
  await pushPromptStash(project, "other", "run-b");

  assert.deepEqual((await readPromptStash(project, "run-a")).map((entry) => entry.input), ["first", "second"]);
  assert.equal((await popPromptStash(project, "run-a"))?.input, "second");
  assert.deepEqual((await readPromptStash(project, "run-a")).map((entry) => entry.input), ["first"]);
  assert.deepEqual((await readPromptStash(project, "run-b")).map((entry) => entry.input), ["other"]);
});
