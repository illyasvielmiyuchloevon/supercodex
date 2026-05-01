import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLog, writeJsonAtomic, writeTextAtomic } from "../src/fs-utils.js";

test("appendLog supports concurrent stderr line appends without temp rename races", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supercodex-log-"));
  const logPath = join(dir, "stderr.log");
  const entries = Array.from({ length: 50 }, (_, index) => `line-${index}`);

  await Promise.all(entries.map((entry) => appendLog(logPath, `${entry}\n`)));

  const actual = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).sort();
  assert.deepEqual(actual, [...entries].sort());
});

test("writeJsonAtomic supports concurrent same-target writes without temp rename races", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supercodex-json-"));
  const target = join(dir, "state.json");
  const entries = Array.from({ length: 50 }, (_, index) => ({ index }));

  await Promise.all(entries.map((entry) => writeJsonAtomic(target, entry)));

  const final = JSON.parse(await readFile(target, "utf8")) as { index?: number };
  assert.equal(typeof final.index, "number");
});

test("writeTextAtomic supports concurrent config writes and unchanged rewrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supercodex-text-"));
  const target = join(dir, "config.toml");
  const entries = Array.from({ length: 50 }, (_, index) => `model = "gpt-${index}"\n`);

  await writeTextAtomic(target, entries[0]!);
  await Promise.all(entries.map((entry) => writeTextAtomic(target, entry)));
  const firstFinal = await readFile(target, "utf8");
  assert.ok(firstFinal.startsWith('model = "gpt-'));

  await Promise.all(Array.from({ length: 20 }, () => writeTextAtomic(target, firstFinal)));
  assert.equal(await readFile(target, "utf8"), firstFinal);
});
