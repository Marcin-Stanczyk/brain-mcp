#!/usr/bin/env node
// Print the retrieval eval report. Run while tuning ranking:
//   npm run eval
// The same numbers are asserted as thresholds by tests/eval.test.ts.
import { buildFixture, buildEmbeddedFixture, runEval, explainFailures } from "../tests/eval/harness.ts";
import { formatReport } from "../src/metrics.ts";
import { rmSync } from "fs";

const fixture = buildFixture();
try {
  const { report, lexical, scored } = await runEval(fixture);
  console.log(formatReport(lexical, "lexical-answerable"));
  console.log();
  console.log(formatReport(report, "all queries (incl. semantic-only)"));
  const failures = explainFailures(scored);
  if (failures) console.log(`\nqueries not fully satisfied in top 5:\n${failures}`);
} finally {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

// With a backend configured, run the same judged queries again with vectors in
// the fusion. Two numbers side by side are the only honest way to say whether
// semantic search earned the daemon it needs.
const hybrid = await buildEmbeddedFixture();
if (hybrid) {
  try {
    const { report, lexical, scored } = await runEval(hybrid);
    console.log("\n" + "=".repeat(52));
    console.log(formatReport(lexical, "lexical-answerable + vectors"));
    console.log();
    console.log(formatReport(report, "all queries + vectors"));
    const failures = explainFailures(scored);
    console.log(failures ? `\nstill not satisfied in top 5:\n${failures}` : "\nevery judged query satisfied in the top 5.");
  } finally {
    hybrid.db.close();
    rmSync(hybrid.dir, { recursive: true, force: true });
  }
} else {
  console.log("\n(set BRAIN_EMBEDDINGS_URL to also score the hybrid retriever)");
}
