import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  coercePastedPath,
  createPasteSummary,
  expandPasteSummaries,
  normalizePasteText,
  resolvePastedFile,
  shouldSummarizePaste,
} from "../src/opentui/paste.js";

test("paste utilities normalize line endings and summarize long content", () => {
  const text = normalizePasteText("a\r\nb\rc");
  assert.equal(text, "a\nb\nc");
  assert.equal(shouldSummarizePaste(text), true);

  const summary = createPasteSummary({
    text,
    sequence: 2,
    now: "2026-05-01T00:00:00.000Z",
  });
  assert.equal(summary.marker, "[Pasted ~3 lines #2]");
  assert.equal(expandPasteSummaries(`before ${summary.marker} after`, [summary]), "before a\nb\nc after");
});

test("paste utilities coerce file urls and quoted paths", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-paste-"));
  const nested = join(project, "notes");
  await mkdir(nested, { recursive: true });
  const file = join(nested, "todo.txt");
  await writeFile(file, "line one\nline two\nline three\n", "utf8");

  assert.equal(coercePastedPath(`"${file}"`, "win32"), file);
  assert.equal(coercePastedPath(pathToFileURL(file).toString()).toLowerCase(), file.toLowerCase());

  const resolved = await resolvePastedFile(project, pathToFileURL(file).toString());
  assert.equal(resolved?.displayPath.replaceAll("\\", "/"), "notes/todo.txt");
  assert.equal(resolved?.text, "line one\nline two\nline three\n");
});
