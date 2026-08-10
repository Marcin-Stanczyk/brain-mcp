// Embedding the backlog, quietly, after the server is already answering.
//
// WHY THIS EXISTS
// ===============
// Passages get written on every brain_learn; vectors only get written when an
// embeddings backend is configured AND reachable at that moment. The two drift
// apart for ordinary reasons — a session whose server was started before the
// backend was configured, a laptop that was offline, a model that was being
// pulled. Measured on the live base minutes after wiring embeddings in: 4 of
// 1128 passages had no vector, written by a still-running server that predated
// the configuration change.
//
// The old answer was "run brain_reindex". That is a fine repair and a poor
// design: it requires somebody to notice, and the symptom of not noticing is
// that some lessons are quietly unreachable by meaning while everything reports
// healthy. So the server heals its own backlog on startup instead.
//
// WHAT IT MUST NOT DO
// ===================
// Block. The MCP transport is already connected when this runs, so the server
// answers questions throughout; passages are embedded one at a time with the
// event loop free between them. A dead backend must not turn this into a
// thousand timeouts either — the embedder is wrapped in a circuit breaker by
// the caller, so failures become instant, and this stops after a few of them
// regardless.

import type Database from "better-sqlite3";
import type { Embedder } from "./embeddings.js";
import type { VectorIndex } from "./vector.js";

/** Consecutive failures after which the backlog is left for next time. */
export const BACKFILL_MAX_FAILURES = 3;

export interface BackfillResult {
  embedded: number;
  failed: number;
  /** Passages still without a vector when this returned. */
  remaining: number;
}

export interface BackfillOptions {
  db: Database.Database;
  vector: VectorIndex;
  embedder: Embedder;
  model: string;
  /** Upper bound per run, so a huge base is spread over several starts. */
  limit?: number;
  log?: (message: string) => void;
  /** Yield between passages; injectable so tests do not sleep. */
  tick?: () => Promise<void>;
}

/**
 * Embed every passage that has no vector yet. Never throws.
 *
 * Returns what happened rather than logging only, so `brain_reindex` and the
 * tests can use the same path the server does.
 */
export async function backfillEmbeddings({
  db,
  vector,
  embedder,
  model,
  limit = 2000,
  log = console.error,
  tick = () => new Promise<void>((r) => setImmediate(r)),
}: BackfillOptions): Promise<BackfillResult> {
  let pending: { id: number; text: string }[];
  try {
    pending = vector.unembeddedChunks().slice(0, limit);
  } catch {
    return { embedded: 0, failed: 0, remaining: 0 };
  }
  if (!pending.length) return { embedded: 0, failed: 0, remaining: 0 };

  log(`🧠 brain-mcp: embedding ${pending.length} passage(s) in the background…`);

  let embedded = 0;
  let failed = 0;
  let consecutive = 0;
  for (const chunk of pending) {
    try {
      vector.upsert(chunk.id, await embedder(chunk.text), model);
      embedded++;
      consecutive = 0;
    } catch (err) {
      failed++;
      consecutive++;
      if (consecutive >= BACKFILL_MAX_FAILURES) {
        // Not an error worth shouting about: the lexical retrievers answer
        // everything meanwhile, and the next start will try again.
        log(
          `⚠️ brain-mcp: stopped embedding the backlog after ${consecutive} failures ` +
            `(${err instanceof Error ? err.message : String(err)}). ${embedded} done, ` +
            `retrying on the next start.`
        );
        break;
      }
    }
    await tick();
  }

  let remaining = 0;
  try {
    remaining = vector.unembeddedChunks().length;
  } catch { /* counted as zero */ }

  if (embedded) {
    log(
      `🧠 brain-mcp: embedded ${embedded} passage(s)` +
        (remaining ? `, ${remaining} still pending` : ", index complete") + "."
    );
  }
  return { embedded, failed, remaining };
}
