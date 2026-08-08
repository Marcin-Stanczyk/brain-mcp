// Regression suite for the failure that made the knowledge base look empty.
//
// On 2026-08-08 an agent asked the live base — 301 lessons, 125 of them about
// the project in question — for "wp eval / koszty zamówień / backfill / lipiec"
// and got nothing, twice. It concluded brain-mcp was a library you had to guess
// the right question for, and went back to reading handoff files out of the git
// repo. Both conclusions were reasonable and neither was about the lessons.
//
// FTS5 joins bare terms with an implicit AND, so `brain_recall` had been asking
// for one lesson containing every word of the question. The knowledge was there.
// The query language ate it and returned "No matching lessons found."
//
// These tests pin the behaviour that fixes it: a question is a bag of terms, not
// a conjunction; punctuation is text, not syntax; and an inflected Polish noun is
// the same word as its stem. Run with: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { initDB, createTools, type ToolDef } from "../src/tools.js";
import { planFtsQuery, tokenizeQuery, stemForPrefix, STOPWORDS, FTS_MIN_TERM_LEN } from "../src/query.js";
import { rrfFuse } from "../src/embeddings.js";

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

const recall = (args: Record<string, unknown>) => toolByName("brain_recall").handler(args);

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "brain-mcp-recall-"));
  db = initDB(join(workDir, "knowledge.db"));
  tools = createTools(db, join(workDir, "code"), { dataDir: workDir });

  const learn = toolByName("brain_learn");
  // Deliberately spread across lessons: NO single row contains every term of
  // the question below. That is the whole shape of the reported bug.
  await learn.handler({
    content: "wp eval is the only safe way to run a one-off script against production",
    category: "tooling",
    project: "kamar",
    severity: "critical",
  });
  await learn.handler({
    content: "Koszty zamówień liczone są po stronie WooCommerce, nie w bazie",
    category: "architecture",
    project: "kamar",
  });
  await learn.handler({
    content: "Backfill historycznych danych puszczaj partiami po 500 rekordów",
    category: "gotcha",
    project: "kamar",
  });
  await learn.handler({
    content: "Zupełnie niezwiązana lekcja o kolorach w Figmie",
    category: "design",
    project: "kanarix",
  });
});

after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── The reported failure ────────────────────────────────────────────────────

test("a sentence finds lessons even though no single lesson holds every term", async () => {
  const text = textOf(await recall({ query: "wp eval koszty zamówień backfill lipiec", limit: 10 }));

  assert.match(text, /Found \d+ lessons/, "the query that used to return nothing returns results");
  assert.ok(text.includes("wp eval is the only safe way"), "the wp eval lesson is recalled");
  assert.ok(text.includes("Koszty zamówień liczone"), "the costs lesson is recalled");
  assert.ok(text.includes("Backfill historycznych"), "the backfill lesson is recalled");
});

test("an all-terms match outranks lessons that share only one term", async () => {
  const text = textOf(await recall({ query: "koszty zamówień backfill", limit: 10 }));

  const bothTerms = text.indexOf("Koszty zamówień liczone");
  const oneTerm = text.indexOf("Backfill historycznych");
  assert.ok(bothTerms >= 0 && oneTerm >= 0, "both lessons are recalled");
  assert.ok(
    bothTerms < oneTerm,
    "the lesson matching two of three terms ranks above the one matching one"
  );
  assert.match(
    text,
    /Koszty zamówień liczone[\s\S]*?matched: [^\n]*any/,
    "and it got there through the lexical retrievers, not by accident"
  );
});

test("recall reports which terms it actually searched for", async () => {
  const hit = textOf(await recall({ query: "backfill partiami", limit: 5 }));
  assert.match(hit, /for: backfill, partiami/, "successful search names its terms");

  const miss = textOf(await recall({ query: "kubernetes istio sidecar", limit: 5 }));
  assert.match(miss, /No matching lessons found/);
  assert.match(miss, /Searched \d+ lessons for: kubernetes, istio, sidecar/,
    "a miss says what was searched, so the next attempt can be aimed");
});

// ── Punctuation is text, not syntax ─────────────────────────────────────────

test("ordinary punctuation never raises a SQLite parser error into the caller", async () => {
  // Each of these used to throw: `fts5: syntax error near "fix"`,
  // `no such column: kosztami`, and so on, straight out of the tool.
  const hostile = [
    "how do I fix (kamar) orders?",
    "co z kosztami: zamówienia?",
    "wp eval * backfill",
    'search "quoted" thing',
    "a^b OR NOT NEAR",
    "-- drop table",
    "{}[]()!@#$%",
    "",
  ];
  for (const query of hostile) {
    const text = textOf(await recall({ query, limit: 5 }));
    assert.equal(typeof text, "string", `query did not throw: ${query}`);
    assert.ok(
      !/syntax error|no such column/i.test(text),
      `no parser diagnostic leaked to the caller for: ${query}`
    );
  }
});

// ── Morphology ──────────────────────────────────────────────────────────────

test("an inflected Polish noun still finds the lesson written in another case", async () => {
  // "zamówienia" (written) vs "zamówieniach" (asked) — one concept, two tokens.
  // Exact and any-term matching both miss; the prefix retriever is what catches it.
  const text = textOf(await recall({ query: "zamówieniach koszty", limit: 5 }));
  assert.ok(text.includes("Koszty zamówień liczone"), "inflected form still recalls the lesson");
});

test("stemming leaves short terms alone", () => {
  assert.equal(stemForPrefix("eval"), "eval", "trimming 'eval' would match half the base");
  assert.equal(stemForPrefix("wp"), "wp");
  assert.equal(stemForPrefix("zamówień"), "zamówi");
  assert.equal(stemForPrefix("backfill"), "backfi");
});

// ── The query planner ───────────────────────────────────────────────────────

test("planFtsQuery builds precise, forgiving and morphological variants", () => {
  const plan = planFtsQuery("Koszty zamówień backfill");
  assert.deepEqual(plan.terms, ["koszty", "zamówień", "backfill"]);
  assert.equal(plan.all, '"koszty" AND "zamówień" AND "backfill"');
  assert.equal(plan.any, '"koszty" OR "zamówień" OR "backfill"');
  assert.equal(plan.prefix, '"koszty"* OR "zamówi"* OR "backfi"*',
    "six-letter 'koszty' is left whole; only terms long enough to survive it are trimmed");
});

test("a single-term query has no all-terms variant, and an unstemmable one no prefix variant", () => {
  const one = planFtsQuery("backfill");
  assert.equal(one.all, null, "a conjunction of one term is just the term");

  const short = planFtsQuery("wp eval");
  assert.equal(short.prefix, null, "nothing was long enough to stem — do not repeat `any` as noise");
});

test("tokenizing is Unicode-aware, so Polish words survive intact", () => {
  // JavaScript's \w is ASCII-only. Splitting on it would cut "zamówień" into
  // "zam" and "wie" and search the base for words nobody wrote.
  assert.deepEqual(tokenizeQuery("zamówień łódź ćwiczenia"), ["zamówień", "łódź", "ćwiczenia"]);
});

test("a query of nothing but stopwords still searches rather than giving up", () => {
  // "how can I" is all stopwords; returning [] here would surface as
  // "no matching lessons" and read as an empty knowledge base.
  assert.ok(tokenizeQuery("how can I").length > 0, "filters relax instead of yielding nothing");
  assert.deepEqual(tokenizeQuery(""), []);
  assert.deepEqual(tokenizeQuery("wp"), ["wp"], "a two-letter query is still a query");
});

test("terms are de-duplicated and capped", () => {
  assert.deepEqual(tokenizeQuery("backfill backfill BACKFILL"), ["backfill"]);
  assert.ok(planFtsQuery("word ".repeat(200)).terms.length <= 24, "a pasted stack trace is not a search");
});

// ── Fusion weights ──────────────────────────────────────────────────────────

test("rrfFuse weights a retriever's opinion, and defaults to 1", () => {
  const fused = rrfFuse([
    { retriever: "all", ids: [10], weight: 3 },
    { retriever: "prefix", ids: [20], weight: 0.6 },
  ]);
  assert.equal(fused[0].id, 10, "the precise retriever's top hit wins");

  // Without weights the two would tie exactly — which is how a lesson sharing
  // only a word stem could outrank one containing the whole question.
  const unweighted = rrfFuse([
    { retriever: "all", ids: [10] },
    { retriever: "prefix", ids: [20] },
  ]);
  assert.equal(unweighted[0].score, unweighted[1].score, "unweighted lists tie");
});

// ── Instrumentation ─────────────────────────────────────────────────────────

test("brain_recall counts the lessons it returns as shown", async () => {
  const before = db.prepare("SELECT shown_count FROM lessons WHERE content LIKE 'Backfill%'").get() as
    { shown_count: number };
  await recall({ query: "backfill partiami", limit: 5 });
  const after = db.prepare("SELECT shown_count, last_shown_at, updated_at, created_at FROM lessons WHERE content LIKE 'Backfill%'").get() as
    { shown_count: number; last_shown_at: string; updated_at: string; created_at: string };

  assert.equal(after.shown_count, before.shown_count + 1, "retrieval through the tool is counted");
  assert.ok(after.last_shown_at, "and stamped");
  // Recording a read must not look like a write, or the recency-ordered session
  // digest would promote whatever was last recalled, forever.
  assert.equal(after.updated_at, after.created_at, "showing a lesson does not touch updated_at");
});

// ── Parity with the hooks ───────────────────────────────────────────────────

test("the TypeScript and Python tokenizers agree on what counts as a search term", () => {
  // Two definitions of "search term" would drift, and drift here means the
  // prompt hook and brain_recall disagree about what the base contains.
  const py = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "_brain_db.py"),
    "utf-8"
  );

  const block = py.match(/STOPWORDS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, "hooks/_brain_db.py still defines STOPWORDS");
  const pyStopwords = new Set([...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  assert.deepEqual(
    [...pyStopwords].sort(),
    [...STOPWORDS].sort(),
    "STOPWORDS in src/query.ts and hooks/_brain_db.py must stay in step"
  );

  // Anchored on the split, so the stemmer's own threshold below cannot be
  // mistaken for the minimum term length.
  const pyMinLen = py.match(/_WORD\.split\(str\(text\)\)\s*if\s*len\(w\)\s*>=\s*(\d+)/);
  assert.ok(pyMinLen, "hooks/_brain_db.py still filters by term length");
  assert.equal(Number(pyMinLen![1]), FTS_MIN_TERM_LEN, "minimum term length agrees");

  const pyStemLen = py.match(/w\[:-2\]\s*if\s*len\(w\)\s*>=\s*(\d+)/);
  assert.ok(pyStemLen, "hooks/_brain_db.py still stems long terms");
  const tsStemThreshold = Number(pyStemLen![1]);
  assert.equal(
    stemForPrefix("x".repeat(tsStemThreshold)).length,
    tsStemThreshold - 2,
    "the stemming threshold agrees with hooks/_brain_db.py"
  );
  assert.equal(
    stemForPrefix("x".repeat(tsStemThreshold - 1)).length,
    tsStemThreshold - 1,
    "and so does the point below which nothing is trimmed"
  );
});
