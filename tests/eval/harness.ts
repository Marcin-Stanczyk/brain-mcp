// Loads the judged query set, builds a throwaway base from the fixture corpus,
// and scores the retriever. Shared by tests/eval.test.ts (which asserts
// thresholds) and scripts/eval.mjs (which prints a report while tuning).

import { readFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { initDB } from "../../src/tools.js";
import { searchLessons, severityBoosts } from "../../src/search.js";
import { evaluate, type EvalReport, type Judgement } from "../../src/metrics.js";
import { rebuildAllChunks } from "../../src/chunk.js";
import { createEmbedder, embeddingsConfigFromEnv, type Embedder } from "../../src/embeddings.js";
import { loadVectorIndex, type VectorIndex } from "../../src/vector.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CorpusLesson {
  key: string;
  content: string;
  category: string;
  project?: string;
  severity?: string;
  scope?: string;
}

export interface JudgedQuery {
  query: string;
  relevant: string[];
  project?: string;
  category?: string;
  why?: string;
  /**
   * Lexical retrieval provably cannot answer this one — the question and the
   * lesson share meaning but no words. Scored separately so the cost of running
   * without embeddings is a number rather than an opinion.
   */
  requiresSemantic?: boolean;
}

export function loadCorpus(): CorpusLesson[] {
  return JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf-8")).lessons;
}

export function loadQueries(): JudgedQuery[] {
  return JSON.parse(readFileSync(join(HERE, "queries.json"), "utf-8")).queries;
}

export interface Fixture {
  db: Database.Database;
  dir: string;
  /** corpus key → row id, so judgements can be written against stable names. */
  idByKey: Map<string, number>;
  /** Present only when the fixture was built with embeddings. */
  vector?: VectorIndex | null;
  embedder?: Embedder | null;
}

/** Build a fresh database containing exactly the fixture corpus. */
export function buildFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "brain-mcp-eval-"));
  const db = initDB(join(dir, "knowledge.db"));
  const insert = db.prepare(
    `INSERT INTO lessons (content, category, tags, project, severity, scope)
     VALUES (?, ?, '[]', ?, ?, ?)`
  );
  const idByKey = new Map<string, number>();
  for (const lesson of loadCorpus()) {
    const info = insert.run(
      lesson.content,
      lesson.category,
      lesson.project ?? null,
      lesson.severity ?? "info",
      lesson.scope ?? "project"
    );
    idByKey.set(lesson.key, Number(info.lastInsertRowid));
  }
  // Seeding writes rows directly, which bypasses the passage indexing that
  // brain_learn performs. Without this the eval would silently score a
  // retriever that is not running — the chunk lists would just be empty.
  rebuildAllChunks(db);
  return { db, dir, idByKey };
}

/**
 * The same fixture with every passage embedded, or null when no backend is
 * configured.
 *
 * Deliberately opt-in and separate: `npm test` must not depend on a running
 * embeddings server, and CI thresholds are asserted on what lexical retrieval
 * alone achieves. This exists so the question "did embeddings earn their
 * place?" is answered by the same judged queries as everything else, rather
 * than by the fact that they were installed.
 */
export async function buildEmbeddedFixture(): Promise<Fixture | null> {
  const cfg = embeddingsConfigFromEnv();
  if (!cfg) return null;
  const fixture = buildFixture();
  const vector = await loadVectorIndex(fixture.db);
  if (!vector) return null;
  const embedder = createEmbedder(cfg);
  const chunks = fixture.db
    .prepare("SELECT id, text FROM lesson_chunks ORDER BY id")
    .all() as { id: number; text: string }[];
  for (const chunk of chunks) {
    vector.upsert(chunk.id, await embedder(chunk.text), cfg.model);
  }
  return { ...fixture, vector, embedder };
}

export interface ScoredQuery extends JudgedQuery {
  judgement: Judgement;
  /** Keys actually returned, best first — the readable form of a failure. */
  returnedKeys: string[];
}

/** Run every judged query against the fixture and score the results. */
export interface EvalResult {
  /** Every judged query, semantic ones included. */
  report: EvalReport;
  /** Only the queries lexical retrieval is expected to answer. */
  lexical: EvalReport;
  scored: ScoredQuery[];
}

export async function runEval(fixture: Fixture, limit = 10): Promise<EvalResult> {
  const { db, idByKey } = fixture;
  const keyById = new Map([...idByKey].map(([k, v]) => [v, k]));
  const boosts = severityBoosts(db);
  const scored: ScoredQuery[] = [];

  for (const q of loadQueries()) {
    const out = await searchLessons(
      db,
      { query: q.query, project: q.project, category: q.category, limit },
      { severityBoost: boosts, vector: fixture.vector, embedder: fixture.embedder }
    );
    const { rows } = out;
    // A HIT THE TOOL FLAGGED AS THIN IS THE TOOL SAYING "PROBABLY NOTHING".
    // brain_recall answers and labels weak evidence rather than suppressing it —
    // filtering was measured and cost recall@5 100% → 79.4%. So a negative query
    // whose every hit came back thin has been answered correctly, and counting
    // it as a miss would measure a design decision instead of the retrieval.
    const allThin =
      rows.length > 0 &&
      rows.every((r) => {
        const c = out.coverage.get(Number(r.id));
        return c !== undefined && c < out.coverageFloor;
      });
    const returned = allThin && q.relevant.length === 0 ? [] : rows.map((r) => Number(r.id));
    scored.push({
      ...q,
      judgement: {
        returned,
        relevant: q.relevant.map((k) => {
          const id = idByKey.get(k);
          if (id === undefined) throw new Error(`queries.json references unknown corpus key: ${k}`);
          return id;
        }),
      },
      returnedKeys: returned.map((id) => keyById.get(id) ?? `#${id}`),
    });
  }

  return {
    report: evaluate(scored.map((s) => s.judgement)),
    lexical: evaluate(scored.filter((s) => !s.requiresSemantic).map((s) => s.judgement)),
    scored,
  };
}

/** Per-query lines, worst first — what to read when a threshold fails. */
export function explainFailures(scored: ScoredQuery[]): string {
  const lines: string[] = [];
  for (const s of scored) {
    const rel = new Set(s.judgement.relevant);
    const top5 = s.judgement.returned.slice(0, 5);
    const hit = top5.filter((id) => rel.has(id)).length;
    const expected = s.judgement.relevant.length;
    const ok = expected === 0 ? s.judgement.returned.length === 0 : hit === expected;
    if (ok) continue;
    lines.push(
      `  ✗ "${s.query}"\n` +
        `      want: ${s.relevant.join(", ") || "(nothing)"}\n` +
        `      got : ${s.returnedKeys.slice(0, 5).join(", ") || "(nothing)"}`
    );
  }
  return lines.join("\n");
}
