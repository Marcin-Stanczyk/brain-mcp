// Retrieval quality, as a number that CI can fail on.
//
// Every constant in src/search.ts — three retriever weights, a severity curve, a
// stemming cap — was chosen by judgement. Judgement is fine; unmeasured
// judgement is how this project shipped a `brain_recall` that returned nothing
// for ordinary questions and nobody noticed for months. The old suite could not
// have caught it: every query in it hit a single lesson containing all its
// words, which is the one case implicit AND gets right.
//
// So: a committed corpus, judged queries, thresholds. Tuning a weight now
// produces a diff in these numbers instead of an impression. Run `npm run eval`
// while tuning to see the report and the per-query failures.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "fs";
import { formatReport } from "../src/metrics.js";
import { buildFixture, runEval, explainFailures, loadQueries, loadCorpus, type Fixture, type EvalResult } from "./eval/harness.js";

let fixture: Fixture;
let result: EvalResult;

before(async () => {
  fixture = buildFixture();
  result = await runEval(fixture);
});

after(() => {
  fixture?.db.close();
  if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
});

/** Attach the full report to any failure — a bare number tells you nothing. */
const context = (label: string) =>
  `${label}\n\n${formatReport(result.lexical, "lexical-answerable")}\n\n${explainFailures(result.scored)}`;

// ── Thresholds ──────────────────────────────────────────────────────────────
// Set just below the measured lexical-only baseline. Re-derived on 2026-08-11
// after the judged set grew from 21 to 31 queries: recall@5 100% on the
// lexically-answerable slice, precision@1 62.5%, MRR 0.770 — precision fell
// because the queries added are harder, not because ranking regressed (with
// vectors the same set scores precision@1 96.3%, MRR 0.975).
//
// CI runs without an embeddings backend, so these describe what the lexical
// retrievers manage alone. tests/eval/hook_eval.py holds the same line for the
// prompt hook, which has its own ranking and went far longer without one.

test("every question lexical search can answer is answered in the top 5", () => {
  assert.ok(
    result.lexical.recallAt5 >= 0.95,
    context(`recall@5 fell to ${(result.lexical.recallAt5 * 100).toFixed(1)}% (floor 95%)`)
  );
});

test("no lexically-answerable question comes back empty", () => {
  // The reported bug, as a threshold. A zero-result rate above zero on this set
  // means some question has silently become unanswerable again.
  assert.equal(result.lexical.zeroResultRate, 0, context("a question returned nothing at all"));
});

test("the top hit is usually the right one", () => {
  assert.ok(
    result.lexical.precisionAt1 >= 0.55,
    context(`precision@1 fell to ${(result.lexical.precisionAt1 * 100).toFixed(1)}% (floor 55%)`)
  );
  assert.ok(
    result.lexical.mrr >= 0.72,
    context(`MRR fell to ${result.lexical.mrr.toFixed(3)} (floor 0.72)`)
  );
});

test("questions the base has no answer to return nothing", () => {
  // The stemmer is aggressive by design (see stemForPrefix). This is the check
  // that keeps it from manufacturing a plausible-looking answer to anything —
  // an irrelevant hit is what teaches a reader to stop reading.
  assert.equal(
    result.report.trueNegativeRate,
    1,
    context("a query with no relevant lesson returned something anyway")
  );
});

test("overall quality, including the queries only embeddings can answer", () => {
  assert.ok(
    result.report.recallAt5 >= 0.9,
    context(`overall recall@5 fell to ${(result.report.recallAt5 * 100).toFixed(1)}% (floor 90%)`)
  );
});

// ── The eval set itself ─────────────────────────────────────────────────────

test("the judged set stays honest", () => {
  const queries = loadQueries();
  const keys = new Set(loadCorpus().map((l) => l.key));

  for (const q of queries) {
    for (const key of q.relevant) {
      assert.ok(keys.has(key), `queries.json references a corpus key that does not exist: ${key}`);
    }
  }

  // A set with no negatives measures only eagerness. A set with no positives
  // measures only silence. Both are easy to score well on and neither means
  // anything, so the shape of the set is asserted, not just its contents.
  assert.ok(queries.filter((q) => q.relevant.length === 0).length >= 4, "negatives present");
  assert.ok(queries.filter((q) => q.relevant.length > 0).length >= 25, "enough positives to average");
  // At least one negative built from words that are common ACROSS the corpus.
  // Without those the set cannot see the junk shape measured on the live base —
  // a question about Kubernetes answered with a booking widget because
  // "service" is ordinary. Two were added and both were initially WRONG: their
  // topics had semantic neighbours, so the vector arm answered them correctly
  // and the set called it a failure. A negative has to be unrelated in meaning
  // as well as unanswered.
  assert.ok(
    queries.some((q) => q.relevant.length === 0 && /update|client|team/.test(q.query)),
    "a negative built from ordinary vocabulary"
  );
  assert.ok(
    queries.some((q) => q.project),
    "at least one query exercises a filter"
  );
});

test("corpus keys are unique — judgements are written against them", () => {
  const keys = loadCorpus().map((l) => l.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate key in corpus.json");
});
