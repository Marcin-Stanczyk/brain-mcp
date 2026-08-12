// The passage index: what it is for, and what must not break it.
//
// Two problems with one cause — the good lessons are long. bm25 divides by
// document length, so a 14 000-character lesson whose third paragraph answers
// the question exactly scores as a mostly irrelevant document that contains the
// words. And the prompt hook shows 1 200 characters from the start, which for
// anything written as "PROBLEM — … FIX —" is the setup without the answer.
//
// Measured on the live base on 2026-08-08: 45 of 303 lessons ran past 3 000
// characters, and those are the ones with the evidence in them.
//
// The index is maintained from TypeScript rather than by a SQL trigger, because
// splitting prose is not expressible in SQLite. That makes "every write path
// remembered to reindex" a claim rather than a guarantee, so it is asserted
// here for each of them.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import { initDB, createTools, type ToolDef } from "../src/tools.js";
import { searchLessons } from "../src/search.js";
import { loadVectorIndex } from "../src/vector.js";
import {
  splitIntoChunks, reindexLessonChunks, removeLessonChunks,
  rebuildAllChunks, ensureChunks, CHUNK_MAX, CHUNK_MIN,
} from "../src/chunk.js";

let workDir: string;
let db: Database.Database;
let tools: ToolDef[];

const toolByName = (name: string): ToolDef => {
  const t = tools.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t;
};
const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

const chunkCount = (lessonId: number) =>
  (db.prepare("SELECT COUNT(*) AS c FROM lesson_chunks WHERE lesson_id = ?").get(lessonId) as { c: number }).c;

/** A lesson shaped like the real long ones: setup first, answer late. */
const PROBLEM_THEN_FIX =
  "PROBLEM — " + "the badge showed a positive margin on every order in the finance module. ".repeat(14) +
  "\n\nCAUSE — " + "two files described the same amount with opposite units and neither was checked. ".repeat(14) +
  "\n\nFIX — the supplier cost is netto and the shop price is brutto, so both sides are converted to netto before subtracting, and a regression test recomputes one control order by hand.";

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-mcp-chunk-"));
  db = initDB(join(workDir, "knowledge.db"));
  tools = createTools(db, join(workDir, "code"), { dataDir: workDir });
});
after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── Splitting ───────────────────────────────────────────────────────────────

test("a short lesson is one passage — splitting it would only add noise", () => {
  const short = "wp eval is the only safe way to run a one-off script against production";
  assert.deepEqual(splitIntoChunks(short), [short]);
});

test("a long lesson splits on the boundaries its author already wrote", () => {
  const chunks = splitIntoChunks(PROBLEM_THEN_FIX);
  assert.ok(chunks.length >= 3, "one passage per section");
  assert.ok(chunks.some((c) => c.startsWith("PROBLEM —")));
  assert.ok(chunks.some((c) => c.includes("FIX —")), "the answer is its own passage, not a tail");
  for (const c of chunks) {
    assert.ok(c.length <= CHUNK_MAX, `passage stays under the cap: ${c.length}`);
  }
});

test("a paragraph with no blank lines is still broken up, on sentences", () => {
  const wall = "Sentence number one is here. ".repeat(120);
  const chunks = splitIntoChunks(wall);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX);
  // A passage that begins mid-word is worse to read than one that runs long.
  assert.ok(chunks.slice(1).every((c) => /^[A-Z]/.test(c.trim())), "cuts land on sentence ends");
});

test("tiny neighbours are merged so headings do not become their own passage", () => {
  const doc = `SHORT HEADING\n\n${"body text that follows the heading and explains it. ".repeat(12)}\n\n${"a second section with its own body text here. ".repeat(12)}`;
  const chunks = splitIntoChunks(doc);
  assert.ok(
    chunks[0].startsWith("SHORT HEADING") && chunks[0].length > CHUNK_MIN,
    "the heading travels with the paragraph it introduces"
  );
});

test("splitting is total — no input produces nothing to index", () => {
  assert.deepEqual(splitIntoChunks(""), []);
  assert.deepEqual(splitIntoChunks("   \n  "), []);
  assert.equal(splitIntoChunks("x").length, 1);
  assert.ok(splitIntoChunks("x".repeat(CHUNK_MAX * 4)).length > 1, "a single unbroken word still splits");
});

// ── Index maintenance ───────────────────────────────────────────────────────

test("every write path keeps the passage index in step", async () => {
  const learn = toolByName("brain_learn");
  const forget = toolByName("brain_forget");
  const restore = toolByName("brain_restore");

  const stored = textOf(await learn.handler({ content: PROBLEM_THEN_FIX, category: "financial" }));
  const id = Number(stored.match(/Lesson #(\d+)/)![1]);
  assert.ok(chunkCount(id) >= 3, "brain_learn indexed the passages");

  await forget.handler({ id, confirm: true, reason: "test" });
  assert.equal(chunkCount(id), 0, "archiving drops them — otherwise the lesson keeps answering questions");

  await restore.handler({ id, confirm: true });
  assert.ok(chunkCount(id) >= 3, "restoring puts them back");
});

test("an archived lesson stops being reachable through its passages", async () => {
  const learn = toolByName("brain_learn");
  const stored = textOf(await learn.handler({
    content: "SETUP — " + "context about the quokka manifest pipeline. ".repeat(20) +
      "\n\nANSWER — the quokka manifest must be regenerated before the upload step",
    category: "deployment",
  }));
  const id = Number(stored.match(/Lesson #(\d+)/)![1]);

  const before = await searchLessons(db, { query: "quokka manifest regenerated", limit: 10 });
  assert.ok(before.rows.some((r) => Number(r.id) === id), "findable while active");

  await toolByName("brain_forget").handler({ id, confirm: true, reason: "test" });
  const after = await searchLessons(db, { query: "quokka manifest regenerated", limit: 10 });
  assert.ok(
    !after.rows.some((r) => Number(r.id) === id),
    "soft-deleted from the list and from the passage index together"
  );
});

test("rebuilding is idempotent and repairs a write path that forgot", () => {
  const total = rebuildAllChunks(db).passages;
  assert.equal(rebuildAllChunks(db).passages, total, "twice is the same as once");

  // Simulate the failure mode the rebuild exists for: a row written straight to
  // the table, the way an import or a migration would.
  const id = Number(
    db.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
      .run(PROBLEM_THEN_FIX).lastInsertRowid
  );
  assert.equal(chunkCount(id), 0, "no passages — nothing called reindex");
  rebuildAllChunks(db);
  assert.ok(chunkCount(id) >= 3, "the rebuild repairs it");
});

test("reindexing one lesson replaces its passages rather than adding to them", () => {
  const id = Number(
    db.prepare("INSERT INTO lessons (content, category, tags) VALUES ('first version', 'gotcha', '[]')")
      .run().lastInsertRowid
  );
  reindexLessonChunks(db, id, "first version");
  reindexLessonChunks(db, id, "first version");
  assert.equal(chunkCount(id), 1, "no duplicates");

  reindexLessonChunks(db, id, PROBLEM_THEN_FIX);
  assert.ok(chunkCount(id) >= 3, "and it follows the new content");

  removeLessonChunks(db, [id]);
  assert.equal(chunkCount(id), 0);
  removeLessonChunks(db, []); // must not throw
});

test("ensureChunks repairs partial coverage, not just an empty index", () => {
  // AN EMPTY TABLE IS THE EASY CASE AND NOT THE DANGEROUS ONE.
  // A base missing one lesson out of a thousand looks healthy by volume and
  // never repairs itself, and that lesson quietly stops being findable by the
  // retriever that reads long lessons well. npm run doctor found exactly this
  // on the live base: 1060 passages, 304 lessons, one of them with none.
  const partial = initDB(join(workDir, "partial.db"));
  partial.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
    .run("a lesson that arrived through a path which did not reindex");
  partial.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
    .run(PROBLEM_THEN_FIX);
  rebuildAllChunks(partial);
  const orphan = Number(
    partial.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
      .run("added afterwards, with nothing indexing it").lastInsertRowid
  );
  assert.equal(
    (partial.prepare("SELECT COUNT(*) AS c FROM lesson_chunks WHERE lesson_id = ?").get(orphan) as { c: number }).c,
    0,
    "the gap exists"
  );

  assert.equal(ensureChunks(partial), 1, "exactly the missing lesson is indexed");
  assert.ok(
    (partial.prepare("SELECT COUNT(*) AS c FROM lesson_chunks WHERE lesson_id = ?").get(orphan) as { c: number }).c > 0
  );
  assert.equal(ensureChunks(partial), 0, "and a covered base is left alone");
  partial.close();
});

test("ensureChunks builds a missing index and leaves a present one alone", () => {
  const fresh = initDB(join(workDir, "fresh.db"));
  fresh.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
    .run(PROBLEM_THEN_FIX);
  assert.equal((fresh.prepare("SELECT COUNT(*) AS c FROM lesson_chunks").get() as { c: number }).c, 0);

  ensureChunks(fresh);
  const built = (fresh.prepare("SELECT COUNT(*) AS c FROM lesson_chunks").get() as { c: number }).c;
  assert.ok(built >= 3, "an empty index against a non-empty base gets built");

  ensureChunks(fresh);
  assert.equal(
    (fresh.prepare("SELECT COUNT(*) AS c FROM lesson_chunks").get() as { c: number }).c,
    built,
    "a fully covered base is not rebuilt behind the caller's back"
  );
  fresh.close();
});

test("rewriting a lesson does not strand its vectors", async () => {
  // THE HAZARD WAS DOCUMENTED AT ONE CALL SITE AND ENFORCED AT NONE.
  // brain_forget carried an "ORDER MATTERS" comment explaining that vectors are
  // keyed by passage and can only be found by joining through the rows about to
  // be deleted. A comment at one call site does not travel to the next: measured
  // on the live base on 2026-08-12 there were 4 orphaned vectors, and nothing in
  // the project looked for them. An orphan still answers KNN, for text nobody
  // can read, which the retriever then skips silently as "stale".
  const fresh = initDB(join(workDir, "orphans.db"));
  const vec = await loadVectorIndex(fresh);
  assert.ok(vec, "sqlite-vec loads on this platform");

  const id = Number(
    fresh.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
      .run(PROBLEM_THEN_FIX).lastInsertRowid
  );
  reindexLessonChunks(fresh, id, PROBLEM_THEN_FIX);
  const unit = Float32Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
  for (const c of fresh.prepare("SELECT id FROM lesson_chunks WHERE lesson_id = ?").all(id) as { id: number }[]) {
    vec!.upsert(c.id, unit, "m");
  }
  assert.ok(vec!.embeddedCount() > 0);

  // Rewritten WITHOUT the index: the old vectors have nothing left to hang off.
  reindexLessonChunks(fresh, id, PROBLEM_THEN_FIX + "\n\nEXTRA — a new paragraph.");
  assert.ok(vec!.pruneOrphans() > 0, "this is the failure the ordering exists to prevent");

  // Rewritten WITH it: nothing is stranded, and no prune is needed.
  for (const c of fresh.prepare("SELECT id FROM lesson_chunks WHERE lesson_id = ?").all(id) as { id: number }[]) {
    vec!.upsert(c.id, unit, "m");
  }
  reindexLessonChunks(fresh, id, PROBLEM_THEN_FIX + "\n\nANOTHER — one more.", vec);
  assert.equal(vec!.pruneOrphans(), 0, "the ordering is enforced, not remembered");
  fresh.close();
});

test("a full rebuild never strands vectors, and says so when it cannot help it", async () => {
  // THE THIRD CALL SITE, FOUND BY A RECIPE RATHER THAN BY READING.
  // Take a function with a warning comment, count its call sites, count how
  // many carry the matching guard. rebuildAllChunks gives every passage a new
  // id, so every vector is orphaned — and its one production caller pruned them
  // fourteen lines later, with two `return` statements in between. A server
  // with embeddings switched off returned at the first, having just detached
  // the whole semantic index, and reported "Embeddings are disabled".
  const fresh = initDB(join(workDir, "rebuild.db"));
  const vec = await loadVectorIndex(fresh);
  assert.ok(vec);

  const id = Number(
    fresh.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')")
      .run(PROBLEM_THEN_FIX).lastInsertRowid
  );
  reindexLessonChunks(fresh, id, PROBLEM_THEN_FIX);
  const unit = Float32Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
  for (const c of fresh.prepare("SELECT id FROM lesson_chunks").all() as { id: number }[]) {
    vec!.upsert(c.id, unit, "m");
  }
  assert.ok(vec!.embeddedCount() > 0);

  const withIndex = rebuildAllChunks(fresh, vec);
  assert.equal(withIndex.didClear, true);
  assert.equal(vec!.pruneOrphans(), 0, "nothing was left hanging");

  // Without the index — the shape of a server running with embeddings off. It
  // cannot drop them, and the contract is that it must SAY so rather than
  // return quietly.
  for (const c of fresh.prepare("SELECT id FROM lesson_chunks").all() as { id: number }[]) {
    vec!.upsert(c.id, unit, "m");
  }
  const blind = rebuildAllChunks(fresh, null);
  assert.equal(blind.didClear, false, "it knows it could not clean up");
  assert.ok(blind.strandedVectors > 0, "and how many it left behind");
  fresh.close();
});

// ── What it buys ────────────────────────────────────────────────────────────

test("a match late in a long lesson is found, and the passage is what gets shown", async () => {
  const fresh = initDB(join(workDir, "ranking.db"));
  const freshTools = createTools(fresh, join(workDir, "code"), { dataDir: workDir });
  const learn = freshTools.find((t) => t.name === "brain_learn")!;
  const recall = freshTools.find((t) => t.name === "brain_recall")!;

  const stored = textOf(await learn.handler({ content: PROBLEM_THEN_FIX, category: "financial" }));
  const id = Number(stored.match(/Lesson #(\d+)/)![1]);
  // Competition: short lessons that share a word or two with the question.
  for (let i = 0; i < 20; i++) {
    await learn.handler({ content: `unrelated note ${i} mentioning the supplier once`, category: "client" });
  }

  const out = await searchLessons(fresh, { query: "supplier cost netto brutto subtracting", limit: 5 });
  assert.equal(Number(out.rows[0]?.id), id, "the long lesson wins on the paragraph that matched");
  assert.match(
    out.matchedBy!.get(id)!.join("+"),
    /chunk-/,
    "and a passage retriever is what found it"
  );
  assert.match(out.bestChunk.get(id)!, /FIX —/, "the passage is the answer, not the opening");

  const rendered = textOf(await recall.handler({ query: "supplier cost netto brutto subtracting", limit: 3 }));
  assert.match(rendered, /matching passage of a \d+-character lesson/);
  assert.match(rendered, /brain:\/\/lessons\/\d+/, "with the whole lesson one fetch away");
  fresh.close();
});
