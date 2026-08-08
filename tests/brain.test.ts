// Test suite for the brain-mcp tools layer.
// Runs against a temp SQLite DB and a fixture code directory — never touches
// the real knowledge base or ~/code.
// Run with: npm test  (tsx --test tests/brain.test.ts)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import type Database from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import {
  initDB,
  createTools,
  scanProjects,
  safeReadFile,
  sanitizeFTS5Query,
  MAX_SCAN_FILE_BYTES,
  type ToolDef,
} from "../src/tools.js";

let workDir: string;
let codeDir: string;
let outsideDir: string;
let db: Database.Database;
let tools: ToolDef[];

const toolByName = (name: string): ToolDef => {
  const t = tools.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t;
};

const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-mcp-test-"));
  codeDir = join(workDir, "code");
  outsideDir = join(workDir, "outside");
  mkdirSync(codeDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // Fixture project A: normal React project with a description
  const projA = join(codeDir, "proj-a");
  mkdirSync(projA);
  writeFileSync(
    join(projA, "package.json"),
    JSON.stringify({ name: "proj-a", description: "A fixture react app", dependencies: { react: "18.0.0" } })
  );

  // Fixture project B: package.json is a symlink pointing OUTSIDE the scan root
  writeFileSync(
    join(outsideDir, "secret-package.json"),
    JSON.stringify({ name: "secret", description: "TOP-SECRET-DESCRIPTION", dependencies: { react: "18.0.0" } })
  );
  const projB = join(codeDir, "proj-b");
  mkdirSync(projB);
  symlinkSync(join(outsideDir, "secret-package.json"), join(projB, "package.json"));

  // Fixture project C: README larger than the scanner's read cap
  const projC = join(codeDir, "proj-c");
  mkdirSync(projC);
  mkdirSync(join(projC, ".git"));
  writeFileSync(join(projC, "package.json"), JSON.stringify({ name: "proj-c" }));
  writeFileSync(join(projC, "README.md"), "giant readme line\n".repeat(80000)); // ~1.4 MB > 1 MiB cap

  // A symlinked directory inside the scan root pointing outside — must be skipped entirely
  symlinkSync(outsideDir, join(codeDir, "sneaky-link"));

  db = initDB(join(workDir, "test-knowledge.db"));
  tools = createTools(db, codeDir);
});

after(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── brain_learn → brain_recall roundtrip ────────────────────────────────────

test("brain_learn stores a lesson and brain_recall finds it via FTS", async () => {
  const learn = toolByName("brain_learn");
  const recall = toolByName("brain_recall");

  const learned = await learn.handler({
    content: "Cloudflare D1 does not support ALTER TABLE ADD COLUMN IF NOT EXISTS",
    category: "gotcha",
    tags: ["cloudflare", "d1"],
    severity: "important",
  });
  assert.match(textOf(learned), /Lesson #\d+ stored \[gotcha\]/);

  const found = await recall.handler({ query: "cloudflare alter table", limit: 10 });
  const text = textOf(found);
  assert.match(text, /Found \d+ lessons/);
  assert.ok(text.includes("Cloudflare D1 does not support"), "recall returns the stored lesson");
});

test("brain_learn defaults to project scope and can mark a lesson global", async () => {
  // A lesson about a TOOL rather than a project — a shell trap, a git behaviour —
  // recurs everywhere, and filing it under whichever project happened to be open
  // is what made it invisible where the mistake repeats. The UserPromptSubmit
  // hook boosts `global`, so nothing may quietly write the wrong default.
  const learn = toolByName("brain_learn");

  await learn.handler({
    content: "set -o pipefail plus a pipe into head kills the script with exit 141",
    category: "gotcha",
    severity: "critical",
    scope: "global",
  });
  await learn.handler({
    content: "The staging invoice exporter needs the VAT column ordered last",
    category: "tooling",
  });

  const rows = db
    .prepare("SELECT content, scope FROM lessons WHERE content LIKE ? OR content LIKE ?")
    .all("%pipefail%", "%invoice exporter%") as { content: string; scope: string }[];

  const trap = rows.find((r) => r.content.includes("pipefail"));
  const local = rows.find((r) => r.content.includes("invoice exporter"));
  assert.equal(trap?.scope, "global");
  assert.equal(local?.scope, "project", "the default must stay project-scoped");
});

test("initDB migrates an existing database to the retrieval columns", async () => {
  // The hooks perform the same migration in Python when they run without the
  // server. Two descriptions of one schema is exactly the pair that drifts, so
  // both sides are asserted — here, and in tests/hooks/test_hooks.py.
  const legacy = join(workDir, "legacy.db");
  const raw = new DatabaseCtor(legacy);
  raw.exec(`
    CREATE TABLE lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL, source TEXT, project TEXT,
      severity TEXT DEFAULT 'info',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  raw.prepare("INSERT INTO lessons (category, content) VALUES ('gotcha','older than the columns')").run();
  raw.close();

  const migrated = initDB(legacy);
  const cols = new Set(
    (migrated.prepare("PRAGMA table_info(lessons)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const name of ["shown_count", "last_shown_at", "scope"]) {
    assert.ok(cols.has(name), `${name} was not added to an existing database`);
  }
  const row = migrated.prepare("SELECT shown_count, scope FROM lessons").get() as
    { shown_count: number; scope: string };
  assert.equal(row.shown_count, 0, "existing rows start uncounted");
  assert.equal(row.scope, "project", "existing rows default to project scope");
  migrated.close();
});

test("brain_recall with empty query lists recent lessons, with category filter", async () => {
  const learn = toolByName("brain_learn");
  const recall = toolByName("brain_recall");

  await learn.handler({
    content: "Always run migrations before deploying the worker",
    category: "deployment",
  });

  const all = await recall.handler({ query: "", limit: 10 });
  assert.match(textOf(all), /Found \d+ lessons/);

  const filtered = await recall.handler({ query: "", category: "deployment", limit: 10 });
  const text = textOf(filtered);
  assert.ok(text.includes("Always run migrations"), "category filter returns the deployment lesson");
  assert.ok(!text.includes("[gotcha]"), "category filter excludes other categories");
});

test("FTS search survives hyphens, dots and bare operators (sanitizer)", async () => {
  const learn = toolByName("brain_learn");
  const recall = toolByName("brain_recall");

  await learn.handler({
    content: "wp-config.php must not be committed; keep salts in env",
    category: "security",
    tags: ["wordpress"],
  });

  // Hyphen/dot tokens would be FTS5 syntax errors without sanitizing
  const found = await recall.handler({ query: "wp-config.php", limit: 10 });
  assert.ok(textOf(found).includes("wp-config.php must not be committed"));

  // Bare operators must not throw
  const opQuery = await recall.handler({ query: "AND", limit: 5 });
  assert.ok(typeof textOf(opQuery) === "string");

  assert.equal(sanitizeFTS5Query("wp-config.php AND salts"), '"wp-config.php" "AND" salts');
});

// ── brain_forget confirm guard ──────────────────────────────────────────────

test("brain_forget schema requires confirm and handler refuses without confirm=true", async () => {
  const forget = toolByName("brain_forget");
  const learn = toolByName("brain_learn");

  // Schema-level guard: confirm is required
  const parsed = z.object(forget.schema).safeParse({ id: 1 });
  assert.equal(parsed.success, false, "input without confirm fails Zod validation");

  const learned = await learn.handler({ content: "Lesson to be archived later", category: "tooling" });
  const id = Number(textOf(learned).match(/Lesson #(\d+)/)?.[1]);
  assert.ok(id > 0);

  // confirm=false → preview only, nothing deleted
  const preview = await forget.handler({ id, confirm: false });
  assert.match(textOf(preview), /Preview: 1 lesson\(s\) would be archived/);
  const stillThere = db.prepare("SELECT COUNT(*) as c FROM lessons WHERE id = ?").get(id) as { c: number };
  assert.equal(stillThere.c, 1, "lesson untouched after preview");

  // confirm=true → archived (soft-delete)
  const archived = await forget.handler({ id, confirm: true, reason: "test cleanup" });
  assert.match(textOf(archived), /Archived 1 lesson\(s\)/);
  const gone = db.prepare("SELECT COUNT(*) as c FROM lessons WHERE id = ?").get(id) as { c: number };
  assert.equal(gone.c, 0, "lesson removed from active table");
  const inArchive = db.prepare("SELECT COUNT(*) as c FROM lessons_archive WHERE id = ?").get(id) as { c: number };
  assert.equal(inArchive.c, 1, "lesson present in archive table");

  // brain_restore roundtrip
  const restore = toolByName("brain_restore");
  const restored = await restore.handler({ id, confirm: true });
  assert.match(textOf(restored), /Restored lesson/);
  const back = db.prepare("SELECT COUNT(*) as c FROM lessons WHERE id = ?").get(id) as { c: number };
  assert.equal(back.c, 1, "lesson restored to active table");
});

// ── Scanner ─────────────────────────────────────────────────────────────────

test("scanner indexes fixture projects and detects stack", async () => {
  const scan = toolByName("brain_scan_projects");
  const result = await scan.handler({});
  const text = textOf(result);

  assert.ok(text.includes("proj-a"), "proj-a discovered");
  assert.ok(text.includes("React"), "React detected from package.json");
  assert.ok(text.includes("A fixture react app"), "description read from package.json");

  const rows = scanProjects(db, codeDir);
  const names = rows.map((r) => r.name);
  assert.ok(!names.includes("sneaky-link"), "symlinked directory is not scanned");
});

test("scanner never reads through symlinks that escape the scan root", async () => {
  const rows = scanProjects(db, codeDir);
  const projB = rows.find((r) => r.name === "proj-b");
  assert.ok(projB, "proj-b is still listed as a project");
  assert.equal(projB.description, "", "symlinked package.json outside root is not read");
  assert.deepEqual(projB.stack, [], "no stack leaked from outside file");

  const scanOutput = textOf(await toolByName("brain_scan_projects").handler({}));
  assert.ok(!scanOutput.includes("TOP-SECRET-DESCRIPTION"), "outside file content never surfaces");
});

test("scanner caps file reads — oversized README is skipped, no OOM", async () => {
  const rows = scanProjects(db, codeDir);
  const projC = rows.find((r) => r.name === "proj-c");
  assert.ok(projC, "proj-c discovered");
  assert.equal(projC.description, "", "oversized README not read for description");
});

test("safeReadFile enforces root confinement and size cap", () => {
  assert.ok(MAX_SCAN_FILE_BYTES <= 1024 * 1024, "cap is at most 1 MiB");
  const ok = safeReadFile(join(codeDir, "proj-a", "package.json"), codeDir);
  assert.ok(ok && ok.includes("proj-a"), "reads normal file inside root");

  const escaped = safeReadFile(join(codeDir, "proj-b", "package.json"), codeDir);
  assert.equal(escaped, null, "refuses symlink escaping the root");

  const direct = safeReadFile(join(outsideDir, "secret-package.json"), codeDir);
  assert.equal(direct, null, "refuses path outside the root");

  const big = safeReadFile(join(codeDir, "proj-c", "README.md"), codeDir);
  assert.equal(big, null, "refuses oversized file");
});

// ── Zod validation coverage ─────────────────────────────────────────────────

test("every tool declares a Zod schema and rejects bad input", () => {
  const expected = [
    "brain_learn", "brain_recall", "brain_scan_projects", "brain_project_context",
    "brain_store_pattern", "brain_status", "brain_forget", "brain_restore",
    "brain_reindex", "brain_export", "brain_import",
  ];
  assert.deepEqual(tools.map((t) => t.name).sort(), [...expected].sort(), "all 11 tools present");

  for (const t of tools) {
    assert.ok(t.schema && typeof t.schema === "object", `${t.name} has a schema`);
  }

  // brain_learn: oversized content and unknown category rejected
  const learnSchema = z.object(toolByName("brain_learn").schema);
  assert.equal(learnSchema.safeParse({ content: "x".repeat(10001), category: "gotcha" }).success, false);
  assert.equal(learnSchema.safeParse({ content: "ok", category: "not-a-category" }).success, false);
  assert.equal(learnSchema.safeParse({ content: "ok", category: "gotcha" }).success, true);

  // brain_recall: limit is bounded
  const recallSchema = z.object(toolByName("brain_recall").schema);
  assert.equal(recallSchema.safeParse({ query: "x", limit: 0 }).success, false);
  assert.equal(recallSchema.safeParse({ query: "x", limit: 1000 }).success, false);
  assert.equal(recallSchema.safeParse({ query: "x" }).success, true);

  // brain_project_context: project name required and bounded
  const ctxSchema = z.object(toolByName("brain_project_context").schema);
  assert.equal(ctxSchema.safeParse({}).success, false);
  assert.equal(ctxSchema.safeParse({ project: "x".repeat(201) }).success, false);
});

// ── Misc tools ──────────────────────────────────────────────────────────────

test("brain_store_pattern, brain_project_context and brain_status work end to end", async () => {
  await toolByName("brain_store_pattern").handler({
    name: "Test pattern",
    pattern_type: "api",
    description: "Fixture pattern for tests",
    projects: ["proj-a"],
  });

  await toolByName("brain_learn").handler({
    content: "proj-a uses React 18 with strict mode",
    category: "architecture",
    project: "proj-a",
  });

  const ctx = textOf(await toolByName("brain_project_context").handler({ project: "proj-a" }));
  assert.ok(ctx.includes("Project: proj-a"));
  assert.ok(ctx.includes("proj-a uses React 18"), "lesson listed in project context");
  assert.ok(ctx.includes("Test pattern"), "pattern listed in project context");

  const status = textOf(await toolByName("brain_status").handler({}));
  assert.match(status, /\| Lessons \| \d+ \|/);
  assert.match(status, /\| Patterns \| [1-9]\d* \|/);
});
