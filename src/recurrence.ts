// Noticing that a lesson has been learned before.
//
// WHY THIS IS NOT `severity`
// ==========================
// The obvious move is to escalate a repeated trap to `critical`, and it is
// self-defeating here. The severity boost is derived from inverse frequency
// (see severityBoosts): `critical` at 40% of the base already earns ×1.18
// instead of ×1.30. Pushing repeats into that field raises the share, which
// LOWERS the boost for everything including the repeat. And it would be piling
// evidence into a field that is 90% saturated and whose two attempted fixes,
// both by asking the writer nicely, moved it by one percentage point.
//
// Repetition has the property severity lacks: it is an observed fact rather
// than the author's impression of their own bad day. So it gets its own field.
//
// WHAT THE BASE ALREADY SHOWS
// ===========================
// The same traps recur, and the lessons say so in prose that nothing can read:
// `git checkout --` after a mutation test is recorded three times (#211, #212,
// #280), and #267 opens by stating outright that it is the third occurrence.
// A SIGPIPE-under-pipefail trap is recorded twice, a year apart (#296, #364).
// The system had no way to know any of that.

import type Database from "better-sqlite3";
import { similarityFromDistance } from "./embeddings.js";
import type { VectorIndex } from "./vector.js";

/**
 * How similar a new lesson has to be to an old one to count as the same trap.
 *
 * Calibrated against the recurrences the base already contains, measured with
 * bge-m3 on 2026-08-12:
 *
 *   known repeats      #211~#212 0.708   #211~#280 0.731   #212~#280 0.751
 *                      #296~#364 0.783
 *   related but distinct   #296~#258 0.591   (both SIGPIPE, different traps)
 *   unrelated pairs        0.387 – 0.503
 *
 * 0.68 sits in the gap between "the same trap again" and "the same area".
 *
 * WHERE IT DOES NOT SEPARATE: two lessons from one session — `set -e` inside
 * `$( )` and a SIGPIPE race, the same CLASS of trap but not the same trap —
 * score 0.699, against 0.708 for the closest genuine repeat. A nine-thousandth
 * of a point is not a boundary, it is noise, and picking a number inside it
 * would be fitting to one pair. So the threshold stays where it keeps every
 * true repeat and admits the occasional near-miss, and the cost of being wrong
 * is bounded on purpose: ×1.1 in the ranking, and a line of text a reader can
 * check against the lesson it names.
 *
 * SMALL SAMPLE — five pairs. Widen it before treating the number as settled.
 */
export const RECURRENCE_THRESHOLD =
  Number(process.env.BRAIN_RECURRENCE_THRESHOLD) || 0.68;

/**
 * A passage shorter than this cannot establish a recurrence.
 *
 * BOILERPLATE MATCHES ITSELF PERFECTLY. The first run of this detector paired
 * two lessons about entirely different traps — `set -e` inside `$( )` and a
 * SIGPIPE race — at similarity 0.999, on a 148-character source-attribution
 * line the two happened to share verbatim. Their actual content matched at
 * 0.699. Taking the closest single passage is right for retrieval, where any
 * paragraph answering the question is a hit; it is wrong for identity, where a
 * shared footer says nothing about whether the trap is the same.
 */
export const MIN_PASSAGE_CHARS = 250;

/** Ranking multiplier caps out here — a tie-breaker, never a ranking of its own. */
export const MAX_RECURRENCE_BOOST = 1.3;

export interface Suggestion {
  /** An earlier lesson that looks like the same trap. A HINT, never a fact. */
  ofLesson: number;
  similarity: number;
}

/**
 * Multiplier for a lesson recorded `count` times. 1 → none, then +0.1 each,
 * bounded: three occurrences of a trap is a strong signal, thirty is not
 * thirty times stronger.
 */
export function recurrenceBoost(count: number | null | undefined): number {
  const n = Number(count) || 1;
  if (n <= 1) return 1;
  return Math.min(MAX_RECURRENCE_BOOST, 1 + (n - 1) * 0.1);
}

/**
 * The earlier lesson most likely to be the same trap — AS A SUGGESTION.
 *
 * WHY THIS DOES NOT WRITE ANYTHING. The first version counted recurrences
 * automatically by following nearest neighbours, and the base refused the idea
 * outright. Similarity is not transitive: A resembles B, B resembles C, and A
 * has nothing to do with C, so connected components merge everything. Measured
 * over all 364 lessons:
 *
 *   threshold 0.68 → largest cluster 205 lessons        meaningless
 *   threshold 0.75 → 28
 *   threshold 0.85 → 3, and the known repeats (0.708–0.751) drop out entirely
 *
 * There is no threshold that catches the repeats this base actually contains
 * and still says anything. A chain-following counter was worse: not even
 * idempotent, and it reported most of the base as a fourth occurrence.
 *
 * So the COUNT comes from `repeats`, which a writer states explicitly and a
 * reader can check, and this function only offers the pointer that makes
 * stating it easy. A suggestion that is wrong costs a sentence; a count that is
 * wrong is a claim about history nobody can verify.
 */
export function suggestRecurrence(
  db: Database.Database,
  vector: VectorIndex | null,
  lessonId: number
): Suggestion | null {
  if (!vector) return null;
  try {
    const chunks = db
      .prepare(
        "SELECT id FROM lesson_chunks WHERE lesson_id = ? AND LENGTH(text) >= ? ORDER BY ord"
      )
      .all(lessonId, MIN_PASSAGE_CHARS) as { id: number }[];
    if (!chunks.length) return null;

    const readVec = db.prepare(
      "SELECT embedding FROM chunks_vec WHERE chunk_id = ?"
    );
    // Both sides have to be substantial: a shared footer is not evidence in
    // either direction.
    const lessonOf = db.prepare(
      "SELECT lesson_id FROM lesson_chunks WHERE id = ? AND LENGTH(text) >= ?"
    );

    let best: Suggestion | null = null;
    for (const chunk of chunks) {
      const row = readVec.get(chunk.id) as { embedding: Buffer } | undefined;
      if (!row) continue;
      const vec = new Float32Array(
        row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength
        )
      );
      for (const hit of vector.knn(vec, 12)) {
        const owner = lessonOf.get(hit.id, MIN_PASSAGE_CHARS) as { lesson_id: number } | undefined;
        if (!owner || owner.lesson_id === lessonId) continue; // itself
        const similarity = similarityFromDistance(hit.distance);
        if (similarity < RECURRENCE_THRESHOLD) continue;
        if (!best || similarity > best.similarity) {
          best = { ofLesson: owner.lesson_id, similarity };
        }
      }
    }
    return best;
  } catch (err) {
    console.error(
      `⚠️ brain-mcp: could not look for an earlier account of this trap (${err instanceof Error ? err.message : String(err)})`
    );
    return null;
  }
}

/**
 * How many times a trap has been recorded, following the `repeats` links the
 * writers stated. Unlike a similarity chain this really is a chain: each link
 * is somebody's claim that two lessons are the same trap, and a reader can open
 * both and check.
 *
 * Cycle-safe. Returns 1 for a lesson that repeats nothing.
 */
export function recurrenceOf(db: Database.Database, lessonId: number): number {
  const get = db.prepare("SELECT repeats FROM lessons WHERE id = ?");
  const seen = new Set<number>([lessonId]);
  let count = 1;
  let at: number | null = lessonId;
  while (at !== null) {
    const row = get.get(at) as { repeats: number | null } | undefined;
    const next = row?.repeats ?? null;
    if (next === null || seen.has(next)) break;
    seen.add(next);
    count++;
    at = next;
  }
  return count;
}
