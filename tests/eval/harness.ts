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
  return { db, dir, idByKey };
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
    const { rows } = await searchLessons(
      db,
      { query: q.query, project: q.project, category: q.category, limit },
      { severityBoost: boosts }
    );
    const returned = rows.map((r) => Number(r.id));
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
