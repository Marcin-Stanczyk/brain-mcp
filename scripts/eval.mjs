#!/usr/bin/env node
// Print the retrieval eval report. Run while tuning ranking:
//   npm run eval
// The same numbers are asserted as thresholds by tests/eval.test.ts.
import { buildFixture, runEval, explainFailures } from "../tests/eval/harness.ts";
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
