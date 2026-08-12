// Recurrence: noticing that a trap has been recorded before.
//
// The idea arrived as "if a problem repeats, double its severity", and the
// measurement sent it somewhere else twice.
//
// Not severity, because the severity boost is inverse-frequency: `critical` at
// 40% of the base already earns ×1.18 instead of ×1.30, so escalating repeats
// into that field raises the share and LOWERS the boost for everything,
// including the repeat.
//
// Not automatic, because similarity is not transitive. Counting recurrences by
// following nearest neighbours over all 364 lessons produced a 205-lesson
// cluster at the threshold that catches the repeats this base actually
// contains, and at the threshold where clusters mean something the known
// repeats disappear. The chain-following version was not even idempotent: it
// reported most of the base as a fourth occurrence, twice in a row.
//
// So the count is a link somebody stated and a reader can check, and the
// detector only offers the pointer.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import { initDB, createTools, type ToolDef } from "../src/tools.js";
import { searchLessons } from "../src/search.js";
import {
  recurrenceBoost, recurrenceOf, suggestRecurrence,
  MAX_RECURRENCE_BOOST, MIN_PASSAGE_CHARS,
} from "../src/recurrence.js";

let workDir: string;
let db: Database.Database;
let tools: ToolDef[];

const toolByName = (name: string): ToolDef => {
  const t = tools.find((t) => t.name === name)!;
  assert.ok(t, `tool ${name} is registered`);
  return t;
};
const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-recurrence-"));
  db = initDB(join(workDir, "knowledge.db"));
  tools = createTools(db, join(workDir, "code"), { dataDir: workDir });
});
after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── The boost ───────────────────────────────────────────────────────────────

test("a repeat is nudged, never promoted on repetition alone", () => {
  assert.equal(recurrenceBoost(1), 1, "a first recording is not a repeat");
  assert.equal(recurrenceBoost(undefined), 1);
  assert.equal(recurrenceBoost(0), 1);
  assert.ok(recurrenceBoost(2) > 1 && recurrenceBoost(3) > recurrenceBoost(2));
  // Three occurrences is a strong signal; thirty is not thirty times stronger,
  // and an unbounded multiplier would let a much-repeated lesson answer
  // questions it has nothing to do with.
  assert.equal(recurrenceBoost(50), MAX_RECURRENCE_BOOST);
});

// ── The count ───────────────────────────────────────────────────────────────

test("the count follows the links a writer stated", async () => {
  const learn = toolByName("brain_learn");
  const first = Number(textOf(await learn.handler({
    content: "git checkout -- restores from HEAD, so it discards the uncommitted fix too",
    category: "testing",
  })).match(/Lesson #(\d+)/)![1]);

  const second = Number(textOf(await learn.handler({
    content: "the same checkout trap again, this time on a new file",
    category: "testing", repeats: first,
  })).match(/Lesson #(\d+)/)![1]);

  const third = await learn.handler({
    content: "third time: checkout after a mutation test took the fix with it",
    category: "testing", repeats: second,
  });

  assert.equal(recurrenceOf(db, first), 1, "the original repeats nothing");
  assert.equal(recurrenceOf(db, second), 2);
  assert.equal(recurrenceOf(db, Number(textOf(third).match(/Lesson #(\d+)/)![1])), 3);
  assert.match(textOf(third), /recurrence #3 of the trap in #/, "and it says so on the way in");
});

test("a broken or circular link cannot hang the count", () => {
  // The links are user input. A cycle would be a bug in whoever wrote them, and
  // must not become an infinite loop in the ranking.
  const a = Number(db.prepare("INSERT INTO lessons (content, category, tags) VALUES ('a','gotcha','[]')")
    .run().lastInsertRowid);
  const b = Number(db.prepare("INSERT INTO lessons (content, category, tags, repeats) VALUES ('b','gotcha','[]',?)")
    .run(a).lastInsertRowid);
  db.prepare("UPDATE lessons SET repeats = ? WHERE id = ?").run(b, a);
  assert.ok(recurrenceOf(db, b) >= 2, "counts what it can");
  assert.ok(recurrenceOf(db, b) < 10, "and stops");

  // A LINK WHOSE TARGET IS GONE STILL COUNTS. brain_forget archives lessons,
  // and archiving the original does not unmake the fact that the trap came
  // back — resetting the count would erase history as a side effect of tidying
  // up. The claim is what the field records.
  const orphan = Number(db.prepare("INSERT INTO lessons (content, category, tags, repeats) VALUES ('x','gotcha','[]', 999999)")
    .run().lastInsertRowid);
  assert.equal(recurrenceOf(db, orphan), 2, "the claim survives the archiving of what it points at");
});

// ── The suggestion ──────────────────────────────────────────────────────────

test("without a vector index there is no suggestion, and that is not an error", () => {
  assert.equal(suggestRecurrence(db, null, 1), null);
});

test("boilerplate cannot establish a recurrence", () => {
  // THE FIRST RUN PAIRED TWO UNRELATED TRAPS AT 0.999.
  // `set -e` inside `$( )` and a SIGPIPE race, matched on a 148-character
  // source-attribution footer the two lessons happened to share verbatim; their
  // actual content matched at 0.699. Taking the closest passage is right for
  // retrieval, where any paragraph answering the question is a hit, and wrong
  // for identity, where a shared footer says nothing.
  assert.ok(MIN_PASSAGE_CHARS >= 200, "short passages are excluded from the comparison");
});

// ── The effect on ranking ───────────────────────────────────────────────────

test("between two equally relevant lessons, the one recorded twice goes first", async () => {
  const fresh = initDB(join(workDir, "rank.db"));
  const insert = fresh.prepare(
    "INSERT INTO lessons (content, category, tags, severity, repeats) VALUES (?, 'gotcha', '[]', 'info', ?)"
  );
  // Identical text, so nothing but the recurrence separates them.
  const plain = Number(insert.run("the deploy pipeline clears the cache", null).lastInsertRowid);
  const origin = Number(insert.run("an earlier account of the same trap", null).lastInsertRowid);
  const repeat = Number(insert.run("the deploy pipeline clears the cache", origin).lastInsertRowid);

  const { rows } = await searchLessons(fresh, { query: "deploy pipeline cache", limit: 5 });
  const ids = rows.map((r) => Number(r.id));
  assert.ok(ids.indexOf(repeat) < ids.indexOf(plain), "the repeat ranks above its twin");
  fresh.close();
});

test("recurrence is reported in the result, because that is the part a reader acts on", async () => {
  const fresh = initDB(join(workDir, "render.db"));
  const freshTools = createTools(fresh, join(workDir, "code"), { dataDir: workDir });
  const learn = freshTools.find((t) => t.name === "brain_learn")!;
  const recall = freshTools.find((t) => t.name === "brain_recall")!;

  const first = Number(textOf(await learn.handler({
    content: "quokka manifests must be regenerated before the upload step", category: "deployment",
  })).match(/Lesson #(\d+)/)![1]);
  await learn.handler({
    content: "quokka manifests caught us again before the upload step",
    category: "deployment", repeats: first,
  });

  const out = textOf(await recall.handler({ query: "quokka manifests upload", limit: 5 }));
  assert.match(out, /🔁 2× recorded/, "the count is on the page, not only in the prose");
  fresh.close();
});
