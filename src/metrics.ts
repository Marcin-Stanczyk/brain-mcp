// Retrieval metrics.
//
// Pure functions over ranked id lists. They exist so that a change to the
// ranking policy — a retriever weight, a severity boost, a new retriever —
// produces a number instead of an impression. Every constant in src/search.ts
// was chosen by judgement; these are what keep that judgement honest.

export interface Judgement {
  /** Ranked ids the retriever returned, best first. */
  returned: readonly number[];
  /** Ids a human considers relevant. Order does not matter. */
  relevant: readonly number[];
}

/**
 * Fraction of the relevant set that appears in the top k.
 *
 * The headline number for this system: a lesson that exists and does not
 * surface is indistinguishable, to the reader, from a lesson that was never
 * written. Queries with no relevant ids are excluded by the caller, not scored
 * as 1 — see meanRecallAt.
 */
export function recallAt(k: number, { returned, relevant }: Judgement): number {
  if (!relevant.length) return 1;
  const top = new Set(returned.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** Fraction of the top k that is relevant — the cost of recall, measured. */
export function precisionAt(k: number, { returned, relevant }: Judgement): number {
  const top = returned.slice(0, k);
  if (!top.length) return 0;
  const rel = new Set(relevant);
  return top.filter((id) => rel.has(id)).length / top.length;
}

/**
 * Reciprocal rank of the first relevant hit, 0 if none.
 *
 * Recall says the lesson was returned; this says whether anyone will read it.
 * A hit at rank 8 of 10 is technically recalled and practically invisible.
 */
export function reciprocalRank({ returned, relevant }: Judgement): number {
  const rel = new Set(relevant);
  for (let i = 0; i < returned.length; i++) {
    if (rel.has(returned[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface EvalReport {
  queries: number;
  recallAt5: number;
  recallAt10: number;
  precisionAt1: number;
  mrr: number;
  /** Share of queries that returned nothing at all. */
  zeroResultRate: number;
  /** Share of queries expected to return nothing that correctly did. */
  trueNegativeRate: number;
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/**
 * Score a whole judged query set.
 *
 * Queries whose relevant set is empty are scored separately as true negatives:
 * averaging them into recall would let a retriever that returns nothing for
 * everything score well on the half of the set that expects nothing.
 */
export function evaluate(judgements: readonly Judgement[]): EvalReport {
  const positives = judgements.filter((j) => j.relevant.length > 0);
  const negatives = judgements.filter((j) => j.relevant.length === 0);

  return {
    queries: judgements.length,
    recallAt5: mean(positives.map((j) => recallAt(5, j))),
    recallAt10: mean(positives.map((j) => recallAt(10, j))),
    precisionAt1: mean(positives.map((j) => precisionAt(1, j))),
    mrr: mean(positives.map(reciprocalRank)),
    zeroResultRate: positives.length
      ? positives.filter((j) => j.returned.length === 0).length / positives.length
      : 0,
    trueNegativeRate: negatives.length
      ? negatives.filter((j) => j.returned.length === 0).length / negatives.length
      : 1,
  };
}

/** Render a report as an aligned block for a terminal or a test failure. */
export function formatReport(report: EvalReport, label = "eval"): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `${label} — ${report.queries} queries`,
    `  recall@5        ${pct(report.recallAt5)}`,
    `  recall@10       ${pct(report.recallAt10)}`,
    `  precision@1     ${pct(report.precisionAt1)}`,
    `  MRR             ${report.mrr.toFixed(3)}`,
    `  zero-result     ${pct(report.zeroResultRate)}`,
    `  true negatives  ${pct(report.trueNegativeRate)}`,
  ].join("\n");
}
