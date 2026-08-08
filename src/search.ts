// Retrieval: from a question to a ranked list of lessons.
//
// Deliberately separate from the tool that presents them. `brain_recall` used to
// be one function that searched, ranked and rendered, and the consequence was
// that nothing could measure the ranking without parsing "#123" out of a
// formatted string. Retrieval you cannot measure is retrieval you tune by
// anecdote — which is how a query language bug survived here for months.
//
// Everything below returns rows. tests/eval scores them; src/tools.ts renders
// them; neither knows about the other.

import type Database from "better-sqlite3";
import { rrfFuse, type Embedder, type RankedList } from "./embeddings.js";
import { planFtsQuery } from "./query.js";
import type { VectorIndex } from "./vector.js";

// ── Ranking policy ──────────────────────────────────────────────────────────

/**
 * How much each retriever's ranking counts in the fusion.
 *
 * Ordered by precision, and the gaps matter more than the absolute numbers.
 * `all` outweighs the rest combined at equal rank, so a lesson containing every
 * word of the question stays on top; `prefix` is deliberately weak because it is
 * there to rescue an inflected word, not to have opinions about relevance.
 */
export const RETRIEVER_WEIGHTS = {
  all: 3,
  any: 1.5,
  vector: 1.5,
  prefix: 0.6,
} as const;

/** Lessons filed as being about a tool rather than a project travel further. */
export const SCOPE_GLOBAL_BOOST = 1.05;

export interface LessonRow {
  id: number;
  content: string;
  category: string;
  tags: string | null;
  project: string | null;
  source: string | null;
  severity: string | null;
  scope: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface SearchDeps {
  /** Vector index, or null for lexical-only. */
  vector?: VectorIndex | null;
  /** Embedder, or null for lexical-only. */
  embedder?: Embedder | null;
  /**
   * Multiplier per severity, applied to the fused score. Injected rather than
   * hard-coded because the right value depends on how the severities are
   * actually distributed in a given base — see severityBoosts().
   */
  severityBoost?: Record<string, number>;
}

export interface SearchQuery {
  query: string;
  category?: string;
  project?: string;
  limit?: number;
}

export interface SearchOutcome {
  rows: LessonRow[];
  /** id → which retrievers found it. null when no query was given. */
  matchedBy: Map<number, string[]> | null;
  /** The terms actually searched for — surfaced to the caller on a miss. */
  terms: string[];
  /** Human-readable note about which retrievers ran. */
  modeNote: string;
}

const ROW_COLUMNS =
  "l.id, l.content, l.category, l.tags, l.project, l.source, l.severity, l.scope, l.created_at";

/**
 * SEVERITY BOOSTS DERIVED FROM THE BASE, NOT FROM A CONSTANT.
 *
 * A fixed `critical → ×1.25` assumes `critical` is rare. Measured on the live
 * base on 2026-08-08 it was 118 of 303 lessons, with `important` another 155:
 * 90% of everything carried a raised severity, so the boost was rewarding
 * almost the whole base and separating nothing. Severity that means "urgent"
 * when nine lessons in ten are urgent is not a signal, it is a habit.
 *
 * Inverse frequency fixes it without re-judging 303 rows: a severity gets
 * weight in proportion to how much it narrows the field. If a tenth of the base
 * is critical, saying so is informative and is rewarded; if half of it is, the
 * boost fades to nothing on its own. Bounded so the ranking can never be
 * decided by severity alone — it is a tie-breaker between lessons the
 * retrievers already agreed were relevant.
 */
export const MAX_SEVERITY_BOOST = 1.3;

export function severityBoosts(db: Database.Database): Record<string, number> {
  let rows: { severity: string | null; c: number }[];
  try {
    rows = db
      .prepare("SELECT severity, COUNT(*) AS c FROM lessons GROUP BY severity")
      .all() as { severity: string | null; c: number }[];
  } catch {
    return {};
  }
  const total = rows.reduce((n, r) => n + r.c, 0);
  if (!total) return {};

  const boosts: Record<string, number> = {};
  for (const { severity, c } of rows) {
    // Only severities that claim urgency can earn a boost; `info` and `tip`
    // are the baseline and being rare does not make them important.
    if (severity !== "critical" && severity !== "important") continue;
    const share = c / total;
    // share → boost: 0 ⇒ MAX, 1 ⇒ none. Linear is enough for a tie-breaker.
    boosts[severity] = 1 + (MAX_SEVERITY_BOOST - 1) * (1 - share);
  }
  return boosts;
}

/**
 * Search the knowledge base and return ranked rows.
 *
 * An empty query is a browse: filters apply, ordering is by recency, and no
 * retriever runs. A non-empty query runs the plan from src/query.ts — every
 * term, any term, any stem — plus the vector index when one is configured, and
 * merges them by weighted reciprocal rank fusion.
 */
export async function searchLessons(
  db: Database.Database,
  { query, category, project, limit }: SearchQuery,
  deps: SearchDeps = {}
): Promise<SearchOutcome> {
  const max = limit || 10;
  const vector = deps.vector ?? null;
  const embedder = deps.embedder ?? null;
  const hybridEnabled = Boolean(vector && embedder);
  const severityBoost = deps.severityBoost ?? {};

  if (!query.trim()) {
    let sql = `SELECT ${ROW_COLUMNS} FROM lessons l WHERE 1=1`;
    const params: (string | number)[] = [];
    if (category) {
      sql += ` AND l.category = ?`;
      params.push(category);
    }
    if (project) {
      sql += ` AND (${projectPredicate()})`;
      params.push(project, `%"${project}"%`);
    }
    sql += ` ORDER BY l.created_at DESC LIMIT ?`;
    params.push(max);
    return {
      rows: db.prepare(sql).all(...params) as LessonRow[],
      matchedBy: null,
      terms: [],
      modeNote: "",
    };
  }

  // Over-fetch every retriever so reciprocal rank fusion has depth to work with.
  const fetchN = Math.min(100, max * 5);
  const plan = planFtsQuery(query);
  const rowById = new Map<number, LessonRow>();
  const lists: RankedList[] = [];
  let modeNote = "";

  /**
   * Run one MATCH and remember the rows it found, best-first.
   *
   * A malformed query must not surface as a SQLite error message: the caller
   * asked a question, not for a parser diagnostic, and the other retrievers may
   * still answer it. Every term is quoted upstream, so this should be
   * unreachable — it is here because "should be" is how the old code came to
   * throw `fts5: syntax error near "fix"` at anyone who typed a question mark.
   */
  const addRetriever = (retriever: string, weight: number, match: string | null): void => {
    if (!match) return;
    let sql = `
      SELECT ${ROW_COLUMNS}
      FROM lessons_fts fts
      JOIN lessons l ON l.id = fts.rowid
      WHERE lessons_fts MATCH ?
    `;
    const params: (string | number)[] = [match];
    if (category) {
      sql += ` AND l.category = ?`;
      params.push(category);
    }
    if (project) {
      sql += ` AND (${projectPredicate()})`;
      params.push(project, `%"${project}"%`);
    }
    sql += ` ORDER BY bm25(lessons_fts) LIMIT ?`;
    params.push(fetchN);

    let rows: LessonRow[];
    try {
      rows = db.prepare(sql).all(...params) as LessonRow[];
    } catch (err) {
      console.error(
        `⚠️ brain-mcp: retriever '${retriever}' failed (${err instanceof Error ? err.message : String(err)}) — skipped.`
      );
      return;
    }
    for (const row of rows) {
      if (!rowById.has(Number(row.id))) rowById.set(Number(row.id), row);
    }
    lists.push({ retriever, weight, ids: rows.map((r) => Number(r.id)) });
  };

  addRetriever("all", RETRIEVER_WEIGHTS.all, plan.all);
  addRetriever("any", RETRIEVER_WEIGHTS.any, plan.any);
  addRetriever("prefix", RETRIEVER_WEIGHTS.prefix, plan.prefix);

  if (hybridEnabled) {
    // Vector search joins as one more opinion. Any embedding failure (backend
    // down, model missing, dimension mismatch) simply leaves the lexical
    // retrievers to answer alone.
    try {
      const queryVec = await embedder!(query);
      const knnHits = vector!.knn(queryVec, fetchN * 2);
      const getRow = db.prepare(`SELECT ${ROW_COLUMNS} FROM lessons l WHERE l.id = ?`);
      const vecIds: number[] = [];
      for (const hit of knnHits) {
        let row = rowById.get(hit.id);
        if (!row) {
          row = getRow.get(hit.id) as LessonRow | undefined;
          if (!row) continue; // stale vector for a deleted lesson
          rowById.set(hit.id, row);
        }
        if (!passesFilters(row, category, project)) continue;
        vecIds.push(hit.id);
        if (vecIds.length >= fetchN) break;
      }
      lists.push({ retriever: "vector", weight: RETRIEVER_WEIGHTS.vector, ids: vecIds });
      modeNote = " (hybrid: lexical + vector, RRF-fused)";
    } catch (err) {
      console.error(
        `⚠️ brain-mcp: hybrid recall degraded to lexical-only (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  // SEVERITY AND SCOPE ARE TIE-BREAKERS, NOT RANKINGS.
  // They nudge a fused score by a few percent, which decides between two
  // lessons the retrievers found equally relevant and can never promote an
  // unrelated one.
  const boosted = rrfFuse(lists).map((hit) => {
    const row = rowById.get(hit.id);
    let score = hit.score;
    score *= severityBoost[String(row?.severity ?? "")] ?? 1;
    if (String(row?.scope ?? "project") === "global") score *= SCOPE_GLOBAL_BOOST;
    return { ...hit, score };
  });
  boosted.sort(
    (a, b) => b.score - a.score || b.retrievers.length - a.retrievers.length || a.id - b.id
  );

  const top = boosted.slice(0, max);
  return {
    rows: top.map((h) => rowById.get(h.id)).filter(Boolean) as LessonRow[],
    matchedBy: new Map(top.map((h) => [h.id, h.retrievers])),
    terms: plan.terms,
    modeNote,
  };
}

/**
 * SQL for "belongs to this project" — and `global` lessons belong to all of them.
 *
 * Without that last clause the `scope` column was decorative: a lesson marked
 * global was still filed under whichever project was open when it was learned,
 * so filtering by any *other* project hid it — precisely the invisibility the
 * column exists to end. Expects two bound params: the project name and the
 * `%"name"%` tag pattern.
 */
function projectPredicate(): string {
  return `l.project = ? OR l.tags LIKE ? OR COALESCE(l.scope, 'project') = 'global'`;
}

/** The row-level equivalent of projectPredicate(), for vector hits. */
function passesFilters(row: LessonRow, category?: string, project?: string): boolean {
  if (category && row.category !== category) return false;
  if (!project) return true;
  return (
    row.project === project ||
    String(row.tags ?? "").includes(`"${project}"`) ||
    String(row.scope ?? "project") === "global"
  );
}
