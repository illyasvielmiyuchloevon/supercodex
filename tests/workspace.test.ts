import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseNextWork, ensureScaffold, parsePlanTasks } from "../src/workspace.js";

test("ensureScaffold preserves existing PRD and PLAN while adding gitignore rules", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-"));
  await writeFile(join(project, "docs-plan-placeholder"), "");
  await ensureScaffold(project, "goal");
  await writeFile(join(project, ".supercodex", "docs", "PRD.md"), "# Existing PRD\n", "utf8");
  await writeFile(join(project, ".supercodex", "docs", "PLAN.md"), "# Existing PLAN\n\n- [ ] Task S1-T1: First task\n", "utf8");

  await ensureScaffold(project, "new goal");

  assert.equal(await readFile(join(project, ".supercodex", "docs", "PRD.md"), "utf8"), "# Existing PRD\n");
  assert.match(await readFile(join(project, ".gitignore"), "utf8"), /^\.supercodex\/$/m);
});

test("ensureScaffold creates project AGENTS.md once and preserves existing project guidance", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-agents-"));

  const created = await ensureScaffold(project, "goal");
  const agentsPath = join(project, "AGENTS.md");
  const generatedAgents = await readFile(agentsPath, "utf8");

  assert.ok(created.includes(agentsPath));
  assert.match(generatedAgents, /AGENTS\.md/);
  assert.match(generatedAgents, /SuperCodex|supercodex|Codex/);

  await writeFile(agentsPath, "# Custom Project Rules\n", "utf8");
  const secondCreated = await ensureScaffold(project, "new goal");

  assert.equal(await readFile(agentsPath, "utf8"), "# Custom Project Rules\n");
  assert.ok(!secondCreated.includes(agentsPath));
});

test("ensureScaffold migrates legacy .agent and docs into .supercodex", async () => {
  const project = await mkdtemp(join(tmpdir(), "supercodex-legacy-"));
  await mkdir(join(project, ".agent", "supervisor"), { recursive: true });
  await mkdir(join(project, ".agent", "logs", "supervisor"), { recursive: true });
  await mkdir(join(project, "docs"), { recursive: true });
  await writeFile(join(project, ".agent", "state.json"), "{\"done\":true}\n", "utf8");
  await writeFile(join(project, ".agent", "supervisor", "session.json"), "{\"thread_id\":\"legacy\"}\n", "utf8");
  await writeFile(join(project, ".agent", "logs", "supervisor", "legacy.log"), "legacy\n", "utf8");
  await writeFile(join(project, "docs", "PRD.md"), "# Legacy PRD\n", "utf8");

  await ensureScaffold(project, "goal");

  assert.equal(await readFile(join(project, ".supercodex", "state.json"), "utf8"), "{\"done\":true}\n");
  assert.equal(await readFile(join(project, ".supercodex", "docs", "PRD.md"), "utf8"), "# Legacy PRD\n");
  assert.equal(await readFile(join(project, ".supercodex", "runtime", "session.json"), "utf8"), "{\"thread_id\":\"legacy\"}\n");
  assert.equal(await readFile(join(project, ".supercodex", "logs", "supercodex", "legacy.log"), "utf8"), "legacy\n");
  assert.match(await readFile(join(project, ".gitignore"), "utf8"), /^\.supercodex\/$/m);
});

test("parsePlanTasks and chooseNextWork recover unchecked PLAN tasks", async () => {
  const tasks = parsePlanTasks("## Stage 7: Example\n\n- [x] Task S7-T1: Done\n- [ ] Task S7-T2: Next\n");
  assert.equal(tasks.length, 2);
  const work = chooseNextWork({
    project: ".",
    state: {},
    backlog: {},
    docsPresent: {},
    missingDocs: [],
    planTasks: tasks,
    supervisorSession: {},
    done: false,
    executionLocked: true,
  });
  assert.equal(work.kind, "task");
  assert.equal(work.taskId, "S7-T2");
  assert.equal(work.stageId, "stage-7");
});
