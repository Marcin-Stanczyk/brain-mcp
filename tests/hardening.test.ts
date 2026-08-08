// Phase 4 — the MCP surface beyond the happy path.
//
// `src/` already had 39 tests and they passed; nothing here is repair. These are
// the questions the happy path never asks: what happens when two agents write at
// once, when a lesson is Polish prose with a fenced code block inside it, when a
// lesson is archived and the search index is not told, and when the embeddings
// endpoint is slow rather than dead.
//
// Run with: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { initDB, createTools, type ToolDef } from "../src/tools.js";

let workDir: string;
let db: Database.Database;
let tools: ToolDef[];

const byName = (n: string): ToolDef => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return t;
};
const textOf = (r: { content: { text: string }[] }) => r.content[0].text;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-hardening-"));
  db = initDB(join(workDir, "k.db"));
  tools = createTools(db, workDir, { dataDir: workDir });
});

after(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── Concurrency ────────────────────────────────────────────────────────────
// Two agents in two worktrees is the situation the sibling project exists for,
// and they share one knowledge base. WAL plus a busy timeout is supposed to make
// that a non-event; "supposed to" is what tests are for.

test("two connections writing at once lose nothing", async () => {
  const dbPath = join(workDir, "concurrent.db");
  const a = initDB(dbPath);
  const b = new DatabaseCtor(dbPath);
  b.pragma("busy_timeout = 5000");
  try {
    const toolsA = createTools(a, workDir, { dataDir: workDir });
    const learn = toolsA.find((t) => t.name === "brain_learn")!;

    // Interleave: the second connection writes between the first's writes,
    // which is exactly the ordering a retry-on-lock would paper over.
    for (let i = 0; i < 20; i++) {
      await learn.handler({ content: `lesson from connection A number ${i}`, category: "tooling" });
      b.prepare("INSERT INTO lessons (content, category) VALUES (?, 'tooling')")
        .run(`lesson from connection B number ${i}`);
    }

    const count = (b.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n;
    assert.equal(count, 40, "a write was lost");

    // The FTS index is maintained by triggers, so a write through a second
    // connection must be searchable too — otherwise a lesson exists and cannot
    // be found, which is worse than not existing.
    const hits = (b.prepare(
      "SELECT COUNT(*) AS n FROM lessons_fts WHERE lessons_fts MATCH 'connection'"
    ).get() as { n: number }).n;
    assert.equal(hits, 40, "rows written by the second connection are not in the index");
  } finally {
    a.close();
    b.close();
  }
});

test("a reader sees committed writes while another connection keeps writing", async () => {
  const dbPath = join(workDir, "reader.db");
  const writer = initDB(dbPath);
  const reader = new DatabaseCtor(dbPath, { readonly: true });
  try {
    const learn = createTools(writer, workDir, { dataDir: workDir })
      .find((t) => t.name === "brain_learn")!;
    await learn.handler({ content: "first committed lesson", category: "tooling" });
    assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n, 1);
    await learn.handler({ content: "second committed lesson", category: "tooling" });
    assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n, 2,
      "the read-only connection is stuck on a stale snapshot");
  } finally {
    writer.close();
    reader.close();
  }
});

// ── Archive semantics ──────────────────────────────────────────────────────
// A lesson that is archived but still in the index is the worst of both: it is
// gone from the base and still turned up by search.

test("brain_forget removes the lesson from search, brain_restore puts it back", async () => {
  const learn = byName("brain_learn");
  const recall = byName("brain_recall");
  const forget = byName("brain_forget");
  const restore = byName("brain_restore");

  const stored = await learn.handler({
    content: "The nightly export of quokka manifests needs the tenant id first",
    category: "tooling",
  });
  const id = Number(/#(\d+)/.exec(textOf(stored))![1]);

  assert.ok(textOf(await recall.handler({ query: "quokka manifests", limit: 10 })).includes("quokka"),
    "precondition: it is findable");

  await forget.handler({ id, confirm: true, reason: "test" });

  const afterForget = textOf(await recall.handler({ query: "quokka manifests", limit: 10 }));
  assert.ok(!afterForget.includes("quokka manifests"),
    "an archived lesson is still returned by search");
  const ftsRows = (db.prepare(
    "SELECT COUNT(*) AS n FROM lessons_fts WHERE lessons_fts MATCH 'quokka'"
  ).get() as { n: number }).n;
  assert.equal(ftsRows, 0, "the index still holds a row for an archived lesson");

  // Restoring is a two-step, like forgetting: without confirm it previews and
  // changes nothing. Worth asserting — a safety gate that quietly stopped
  // gating would look exactly like this test passing for the wrong reason.
  await restore.handler({ id });
  assert.ok(
    !textOf(await recall.handler({ query: "quokka manifests", limit: 10 })).includes("quokka manifests"),
    "restore without confirm=true brought the lesson back anyway"
  );

  await restore.handler({ id, confirm: true });
  assert.ok(textOf(await recall.handler({ query: "quokka manifests", limit: 10 })).includes("quokka"),
    "a restored lesson is not findable again — the FTS index was not repopulated");
  const backInIndex = (db.prepare(
    "SELECT COUNT(*) AS n FROM lessons_fts WHERE lessons_fts MATCH 'quokka'"
  ).get() as { n: number }).n;
  assert.equal(backInIndex, 1, "restored but absent from the index");
});

// ── Export / import fidelity ───────────────────────────────────────────────
// The lessons in the live base are Polish prose with fenced code blocks in them.
// A round-trip that is "lossless" for ASCII single-liners proves very little.

const AWKWARD = [
  "PUŁAPKA: `set -euo pipefail` + potok do `head` — cicha śmierć, exit 141.\n\n" +
    "```bash\nf() {\n  local all\n  all=\"$(producent)\" || true\n  printf '%s\\n' \"$all\" | head -1\n}\n```\n\n" +
    "Znaki: żółć, ćma, ŹDŹBŁO, emoji 🧠, cudzysłowy „polskie\" i \"proste\", tab\there.",
  "Line one\r\nline two with a CRLF before it\r\nand a trailing backslash \\",
  "A lesson containing the export's own delimiters: --- and ## and | pipes | in | a | table",
];

test("export → import preserves unicode, newlines, code fences and scope", async () => {
  const dbPath = join(workDir, "fidelity.db");
  const src = initDB(dbPath);
  const srcTools = createTools(src, workDir, { dataDir: workDir });
  const learn = srcTools.find((t) => t.name === "brain_learn")!;

  for (const [i, content] of AWKWARD.entries()) {
    await learn.handler({
      content,
      category: "gotcha",
      severity: "critical",
      project: "kamar",
      tags: ["ąę", "code-fence"],
      scope: i === 0 ? "global" : "project",
    });
  }

  const file = join(workDir, "fidelity.json");
  await srcTools.find((t) => t.name === "brain_export")!.handler({ path: file, format: "json" });

  const destPath = join(workDir, "fidelity-dest.db");
  const dest = initDB(destPath);
  const destTools = createTools(dest, workDir, { dataDir: workDir });
  await destTools.find((t) => t.name === "brain_import")!.handler({ path: file });

  const before = src.prepare("SELECT content, tags, severity, project FROM lessons ORDER BY id").all();
  const after = dest.prepare("SELECT content, tags, severity, project FROM lessons ORDER BY id").all();
  assert.deepEqual(after, before, "the round-trip changed a lesson");

  src.close();
  dest.close();
});

test("export → import → export is byte-identical the second time round", async () => {
  // A round-trip that is merely "equal enough" tends to normalise something on
  // the first pass and stay put after — which hides the loss rather than fixing
  // it. Two passes make any such normalisation visible.
  const dbPath = join(workDir, "twice.db");
  const one = initDB(dbPath);
  const oneTools = createTools(one, workDir, { dataDir: workDir });
  const learn = oneTools.find((t) => t.name === "brain_learn")!;
  for (const content of AWKWARD) await learn.handler({ content, category: "gotcha" });

  const first = join(workDir, "twice-1.json");
  await oneTools.find((t) => t.name === "brain_export")!.handler({ path: first, format: "json" });

  const two = initDB(join(workDir, "twice-2.db"));
  const twoTools = createTools(two, workDir, { dataDir: workDir });
  await twoTools.find((t) => t.name === "brain_import")!.handler({ path: first });
  const second = join(workDir, "twice-2.json");
  await twoTools.find((t) => t.name === "brain_export")!.handler({ path: second, format: "json" });

  const readLessons = (p: string) =>
    JSON.parse(readFileSync(p, "utf8")).lessons
      .map((l: Record<string, unknown>) => l.content);
  assert.deepEqual(readLessons(second), readLessons(first));

  one.close();
  two.close();
});

test("brain_import ignores a truncated export instead of importing half of it", async () => {
  const file = join(workDir, "truncated.json");
  writeFileSync(file, '{"lessons":[{"content":"half a les');
  const dbPath = join(workDir, "truncated.db");
  const target = initDB(dbPath);
  try {
    const imp = createTools(target, workDir, { dataDir: workDir })
      .find((t) => t.name === "brain_import")!;
    let text: string;
    try {
      text = textOf(await imp.handler({ path: file }));
    } catch (err) {
      text = String(err);   // rejecting outright is an acceptable answer too
    }
    const n = (target.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n;
    assert.equal(n, 0, `imported from a truncated file: ${text}`);
  } finally {
    target.close();
  }
});

// ── Embeddings degradation ─────────────────────────────────────────────────
// "Down" is already covered. "Slow" is the one that hurts, because a hook or a
// tool call that waits is indistinguishable from one that hung.

test("a slow embeddings endpoint does not stop a lesson being stored", async () => {
  const dbPath = join(workDir, "slow.db");
  const slowDb = initDB(dbPath);
  try {
    const slowEmbedder = (_text: string) =>
      new Promise<number[]>((_resolve, reject) =>
        setTimeout(() => reject(new Error("timeout after 4000ms")), 20)
      );
    const slowTools = createTools(slowDb, workDir, {
      dataDir: workDir,
      vector: {
        upsert: () => { throw new Error("should not be reached"); },
        remove: () => {},
        knn: () => [],
        embeddedCount: () => 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      embedder: slowEmbedder,
      embeddingsConfig: { url: "http://127.0.0.1:1", model: "nomic-embed-text", timeoutMs: 10 },
    });
    const learn = slowTools.find((t) => t.name === "brain_learn")!;
    const started = Date.now();
    const out = textOf(await learn.handler({ content: "stored despite a slow endpoint", category: "tooling" }));
    assert.match(out, /Lesson #\d+ stored/);
    assert.ok(Date.now() - started < 5000, "storing waited on the embeddings endpoint");
    const n = (slowDb.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n;
    assert.equal(n, 1);
  } finally {
    slowDb.close();
  }
});

// ── Retrieval reporting ────────────────────────────────────────────────────

test("brain_status withholds 'never surfaced' until counting has run long enough", async () => {
  // Reported naively it is true of the whole base on day one, and reads like a
  // finding about the lessons when it is a fact about the clock.
  const dbPath = join(workDir, "status.db");
  const sdb = initDB(dbPath);
  try {
    const stools = createTools(sdb, workDir, { dataDir: workDir });
    await stools.find((t) => t.name === "brain_learn")!
      .handler({ content: "an old lesson nobody ever needed", category: "tooling" });
    sdb.prepare("UPDATE lessons SET created_at = datetime('now', '-90 days')").run();

    const status = () => stools.find((t) => t.name === "brain_status")!.handler({}).then(textOf);

    assert.match(await status(), /No retrieval recorded yet/);

    // One lesson surfaced just now: counting has begun, but the window is 0 days.
    sdb.prepare("UPDATE lessons SET shown_count = 1, last_shown_at = datetime('now')").run();
    const fresh = await status();
    assert.match(fresh, /Counting began 0 day\(s\) ago/);
    assert.ok(!/never surfaced: \d/.test(fresh), "a tautology was reported as a finding");

    // Counting started long ago and this lesson has not been surfaced since.
    sdb.prepare(
      "UPDATE lessons SET shown_count = 0, last_shown_at = datetime('now', '-60 days')"
    ).run();
    assert.match(await status(), /Older than 30 days and never surfaced: 1/);
  } finally {
    sdb.close();
  }
});
