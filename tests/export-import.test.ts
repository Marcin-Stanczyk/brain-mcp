// brain_export / brain_import tests: roundtrip, content-hash dedupe, and
// path confinement to the data directory.
// Run with: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import {
  initDB,
  createTools,
  resolveDataFilePath,
  contentHash,
  type ToolDef,
} from "../src/tools.js";

let workDir: string;
let dataDir: string;
let codeDir: string;
let db: Database.Database;
let tools: ToolDef[];

const toolByName = (tls: ToolDef[], name: string): ToolDef => {
  const t = tls.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t;
};
const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "brain-export-test-"));
  dataDir = join(workDir, "data");
  codeDir = join(workDir, "code");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codeDir, { recursive: true });

  db = initDB(join(dataDir, "knowledge.db"));
  tools = createTools(db, codeDir, { dataDir });

  const learn = toolByName(tools, "brain_learn");
  await learn.handler({
    content: "D1 has no ALTER TABLE IF NOT EXISTS",
    category: "gotcha",
    tags: ["cloudflare", "d1"],
    severity: "important",
  });
  await learn.handler({
    content: "Use WAL mode for concurrent SQLite readers",
    category: "performance",
    project: "brain-mcp",
  });
  await learn.handler({
    content: "Ship a smoke test with every MCP server",
    category: "best-practice",
  });
  await toolByName(tools, "brain_store_pattern").handler({
    name: "Confined file reads",
    pattern_type: "error-handling",
    description: "realpath + prefix check before any fs read",
    projects: ["brain-mcp"],
  });
});

after(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── resolveDataFilePath (path confinement) ──────────────────────────────────

test("resolveDataFilePath confines writes to the data dir", () => {
  // realpath: on macOS the tmpdir lives behind a /var → /private/var symlink
  const realDataDir = realpathSync(dataDir);
  const ok = resolveDataFilePath("export.json", dataDir);
  assert.equal(ok, join(realDataDir, "export.json"), "relative path resolves inside data dir");

  assert.equal(resolveDataFilePath("../evil.json", dataDir), null, "parent escape refused");
  assert.equal(resolveDataFilePath("../../../../etc/passwd", dataDir), null);
  assert.equal(resolveDataFilePath("/etc/evil.json", dataDir), null, "absolute outside refused");
  assert.equal(resolveDataFilePath("sub/dir/file.json", dataDir), null, "nonexistent parent refused");
  assert.equal(resolveDataFilePath(".", dataDir), null);

  const abs = resolveDataFilePath(join(dataDir, "abs.json"), dataDir);
  assert.equal(abs, join(realDataDir, "abs.json"), "absolute path inside data dir allowed");
});

test("contentHash is a stable sha256 of the content", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.match(contentHash("abc"), /^[0-9a-f]{64}$/);
});

// ── Export ──────────────────────────────────────────────────────────────────

test("brain_export markdown groups lessons by category (inline)", async () => {
  const result = await toolByName(tools, "brain_export").handler({ format: "markdown" });
  const text = textOf(result);
  assert.match(text, /# Brain export/);
  assert.match(text, /## best-practice \(1\)/);
  assert.match(text, /## gotcha \(1\)/);
  assert.match(text, /## performance \(1\)/);
  assert.ok(text.includes("D1 has no ALTER TABLE"));
  assert.ok(text.includes("Tags: cloudflare, d1"));
  assert.match(text, /## Patterns \(1\)/);
  assert.ok(text.includes("Confined file reads"));
});

test("brain_export refuses paths outside the data dir and the db file itself", async () => {
  const exportTool = toolByName(tools, "brain_export");
  assert.match(textOf(await exportTool.handler({ format: "json", path: "../evil.json" })), /❌ Refused/);
  assert.match(textOf(await exportTool.handler({ format: "json", path: "/tmp/evil.json" })), /❌ Refused/);
  assert.match(textOf(await exportTool.handler({ format: "json", path: "knowledge.db" })), /collides with the database/);
  assert.ok(!existsSync(join(workDir, "evil.json")));
});

// ── Roundtrip + dedupe ──────────────────────────────────────────────────────

test("export → import roundtrip is lossless and dedupes by content hash", async () => {
  const exported = await toolByName(tools, "brain_export").handler({
    format: "json",
    path: "export.json",
  });
  assert.match(textOf(exported), /✅ Exported 3 lessons and 1 patterns \(json\)/);
  const file = join(dataDir, "export.json");
  assert.ok(existsSync(file));

  const parsed = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(parsed.brain_export_version, 1);
  assert.equal(parsed.lessons.length, 3);
  assert.deepEqual(parsed.lessons[0].tags, ["cloudflare", "d1"], "tags survive as arrays");

  // Fresh DB in the SAME data dir, pre-seeded with one duplicate lesson
  const db2 = initDB(join(dataDir, "knowledge2.db"));
  const tools2 = createTools(db2, codeDir, { dataDir });
  await toolByName(tools2, "brain_learn").handler({
    content: "Use WAL mode for concurrent SQLite readers", // duplicate of an exported lesson
    category: "performance",
  });

  const imported = await toolByName(tools2, "brain_import").handler({ path: "export.json" });
  const text = textOf(imported);
  assert.match(text, /Lessons inserted: 2/, "duplicate skipped by content hash");
  assert.match(text, /Patterns inserted: 1/);
  assert.match(text, /Skipped \(duplicate content hash\): 1/);

  const rows = db2.prepare("SELECT content, category, tags, severity, created_at FROM lessons ORDER BY id").all() as Record<string, unknown>[];
  assert.equal(rows.length, 3);
  const d1 = rows.find((r) => String(r.content).includes("D1 has no ALTER TABLE"))!;
  assert.equal(d1.category, "gotcha");
  assert.equal(d1.severity, "important");
  assert.equal(d1.tags, JSON.stringify(["cloudflare", "d1"]));
  assert.ok(d1.created_at, "created_at preserved on import");

  // Idempotence: importing the same file again inserts nothing
  const again = await toolByName(tools2, "brain_import").handler({ path: "export.json" });
  assert.match(textOf(again), /Lessons inserted: 0/);
  assert.match(textOf(again), /Patterns inserted: 0/);
  assert.match(textOf(again), /Skipped \(duplicate content hash\): 4/);

  // Imported lessons are searchable (FTS triggers fired)
  const found = await toolByName(tools2, "brain_recall").handler({ query: "smoke test MCP", limit: 5 });
  assert.ok(textOf(found).includes("Ship a smoke test"));

  db2.close();
});

test("brain_import rejects paths outside the data dir and non-export files", async () => {
  const importTool = toolByName(tools, "brain_import");
  assert.match(textOf(await importTool.handler({ path: "../evil.json" })), /❌ Refused/);
  assert.match(textOf(await importTool.handler({ path: "missing.json" })), /❌/);

  writeFileSync(join(dataDir, "not-an-export.json"), JSON.stringify({ hello: "world" }));
  assert.match(
    textOf(await importTool.handler({ path: "not-an-export.json" })),
    /Not a brain_export JSON file/
  );
});

test("brain_export inline JSON is size-capped", async () => {
  // 10 lessons × ~9KB comfortably exceeds the 64KB inline cap
  const bigDb = initDB(join(dataDir, "big.db"));
  const bigTools = createTools(bigDb, codeDir, { dataDir });
  const learn = toolByName(bigTools, "brain_learn");
  for (let i = 0; i < 10; i++) {
    await learn.handler({ content: `lesson ${i} ` + "x".repeat(9000), category: "tooling" });
  }
  const inline = await toolByName(bigTools, "brain_export").handler({ format: "json" });
  assert.match(textOf(inline), /larger than \d+ bytes — pass a path/);

  // ...but writing to a file still works
  const toFile = await toolByName(bigTools, "brain_export").handler({ format: "json", path: "big-export.json" });
  assert.match(textOf(toFile), /✅ Exported 10 lessons/);
  bigDb.close();
});
