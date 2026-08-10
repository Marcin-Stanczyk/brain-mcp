#!/usr/bin/env node
// npm run eval:sweep — pick MIN_VECTOR_SIMILARITY by measuring it.
//
// The floor under the vector retriever belongs to the PAIR of (model, corpus),
// not to either one, so it has to be re-derived whenever the model changes.
// Run with a backend configured:
//
//   BRAIN_EMBEDDINGS_URL=http://localhost:11434 \
//   BRAIN_EMBEDDINGS_MODEL=bge-m3 npm run eval:sweep
//
// Read the table for a plateau, not a peak: a threshold sitting on the edge of
// a cliff is overfitted to 21 queries. Measured on 2026-08-10 the plateau ran
// 0.45–0.52, which is why the default is 0.5.
import { rmSync } from "fs";
const f = await buildEmbeddedFixture();
if (!f) { console.log("brak backendu"); process.exit(1); }
console.log("próg   recall@5  prec@1   MRR    true-neg   (lexical-answerable / all)");
for (const t of [0.35, 0.40, 0.45, 0.48, 0.50, 0.52, 0.55, 0.58]) {
  process.env.BRAIN_MIN_SIMILARITY = String(t);
  // re-import search with the new threshold
  const { searchLessons, severityBoosts } = await import(`../src/search.ts?t=${t}`);
  const { evaluate } = await import("../src/metrics.ts");
  const { loadQueries } = await import("../tests/eval/harness.ts");
  const boosts = severityBoosts(f.db);
  const scored = [];
  for (const q of loadQueries()) {
    const { rows } = await searchLessons(f.db,
      { query: q.query, project: q.project, category: q.category, limit: 10 },
      { severityBoost: boosts, vector: f.vector, embedder: f.embedder });
    scored.push({ q, judgement: { returned: rows.map(r => Number(r.id)),
      relevant: q.relevant.map(k => f.idByKey.get(k)) } });
  }
  const all = evaluate(scored.map(s => s.judgement));
  const lex = evaluate(scored.filter(s => !s.q.requiresSemantic).map(s => s.judgement));
  const p = n => (n*100).toFixed(1).padStart(5);
  console.log(`${t.toFixed(2)}   ${p(lex.recallAt5)}/${p(all.recallAt5)}  ${p(lex.precisionAt1)}  ${lex.mrr.toFixed(3)}  ${p(all.trueNegativeRate)}`);
}
f.db.close(); rmSync(f.dir, { recursive: true, force: true });
