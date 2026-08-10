// Optional local embeddings layer.
//
// This module contains the ONLY network call in the whole project, and it is
// strictly opt-in: nothing here runs unless the user sets BRAIN_EMBEDDINGS_URL
// (typically a local Ollama instance at http://localhost:11434). When the env
// var is absent, brain-mcp performs zero network I/O, exactly as before.

// ── Configuration ───────────────────────────────────────────────────────────

export interface EmbeddingsConfig {
  /** Base URL of an Ollama-compatible server, e.g. http://localhost:11434 */
  url: string;
  /** Embedding model name, e.g. nomic-embed-text */
  model: string;
  /** Per-request timeout in milliseconds */
  timeoutMs: number;
}

/**
 * MULTILINGUAL BY DEFAULT, BECAUSE THE MEASUREMENT INSISTED.
 *
 * nomic-embed-text was the obvious first choice and it does not work here.
 * Scored on the judged queries it raised precision@1 from 82.4% to 88.2% and
 * left the one thing embeddings were installed for exactly where it was: an
 * English question about a Polish lesson still returned nothing. It is an
 * English-centric model and this knowledge base is written in two languages,
 * often inside a single lesson.
 *
 * bge-m3 closes it. Same queries, same threshold sweep:
 *
 *   lexical only     recall@5 92.1%   precision@1 82.4%   MRR 0.897
 *   nomic @ 0.75     recall@5 92.1%   precision@1 88.2%   MRR 0.924
 *   bge-m3 @ 0.50    recall@5  100%   precision@1 94.1%   MRR 0.961
 *
 * all three at 100% true negatives. It costs 1.2 GB instead of 274 MB.
 */
export const DEFAULT_EMBEDDINGS_MODEL = "bge-m3";

/**
 * Ten seconds, not four. A model that is not resident has to be loaded first,
 * which took ~9s for bge-m3 on an M-series laptop; every call after that was
 * ~0.1s. The old 4s budget turned the first embedding of a session into a
 * timeout, and a timeout here silently degrades recall to lexical-only — the
 * failure would have looked like "embeddings do not help".
 */
export const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 10000;

/**
 * How long the backend should keep the model in memory after a request.
 * Ollama unloads after five minutes by default, so without this every quiet
 * spell is followed by a cold start on somebody's next question.
 */
export const KEEP_ALIVE = "30m";

/**
 * Read embeddings config from the environment.
 * Returns null when BRAIN_EMBEDDINGS_URL is not set — embeddings disabled,
 * no network call will ever be made.
 */
export function embeddingsConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): EmbeddingsConfig | null {
  const url = env.BRAIN_EMBEDDINGS_URL?.trim();
  if (!url) return null;
  const timeoutMs = Number(env.BRAIN_EMBEDDINGS_TIMEOUT_MS);
  return {
    url: url.replace(/\/+$/, ""),
    model: env.BRAIN_EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_EMBEDDINGS_TIMEOUT_MS,
  };
}

// ── Embedder (Ollama /api/embeddings) ───────────────────────────────────────

export type Embedder = (text: string) => Promise<Float32Array>;

/**
 * Create an embedder that POSTs to the classic Ollama embeddings endpoint:
 *   POST {url}/api/embeddings  { "model": ..., "prompt": ... }
 *   → { "embedding": [ ... ] }
 * Every request carries an AbortSignal timeout so a hung server can never
 * block a tool call for long. Throws on any failure — callers degrade
 * gracefully (save without embedding / fall back to FTS5-only search).
 */
export function createEmbedder(cfg: EmbeddingsConfig): Embedder {
  return async (text: string): Promise<Float32Array> => {
    const res = await fetch(`${cfg.url}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, prompt: text, keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`embeddings endpoint returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { embedding?: unknown };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error("embeddings endpoint returned no embedding");
    }
    const vec = new Float32Array(data.embedding.length);
    for (let i = 0; i < data.embedding.length; i++) {
      const v = data.embedding[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error("embeddings endpoint returned a non-numeric vector");
      }
      vec[i] = v;
    }
    return normalize(vec);
  };
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

/** Consecutive failures before the breaker opens. */
export const BREAKER_FAILURE_THRESHOLD = 2;

/** How long it stays open before allowing one probe through. */
export const BREAKER_COOLDOWN_MS = 60_000;

/** Did this failure cost us the whole timeout budget? */
function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "TimeoutError" || name === "AbortError";
}

export class EmbeddingsUnavailableError extends Error {
  constructor(msRemaining: number) {
    super(
      `embeddings backend marked unavailable after repeated failures; ` +
        `retrying in ${Math.ceil(msRemaining / 1000)}s`
    );
    this.name = "EmbeddingsUnavailableError";
  }
}

/**
 * Wrap an embedder so a dead backend costs ONE timeout, not one per question.
 *
 * A refused connection fails in milliseconds and needs no protection. The case
 * that does is a backend which accepts the connection and never answers — a
 * model loading under memory pressure, a laptop waking from sleep. Measured
 * against a socket that accepts and hangs: every recall paid the full 10s
 * timeout and then returned exactly the lexical-only result it would have
 * returned instantly. Three questions, thirty seconds, nothing gained.
 *
 * After `threshold` consecutive failures the breaker opens and calls fail
 * immediately; callers already degrade to lexical search, so the only change is
 * that they stop waiting first. One probe is allowed through after the cooldown
 * — a backend that comes back must be noticed without anybody restarting
 * anything.
 *
 * Deliberately not a retry: retrying a hung endpoint multiplies the wait.
 */
export function withCircuitBreaker(
  embed: Embedder,
  {
    threshold = BREAKER_FAILURE_THRESHOLD,
    cooldownMs = BREAKER_COOLDOWN_MS,
    now = () => Date.now(),
    onOpen,
  }: {
    threshold?: number;
    cooldownMs?: number;
    now?: () => number;
    onOpen?: (failures: number) => void;
  } = {}
): Embedder {
  let failures = 0;
  let openedAt: number | null = null;

  return async (text: string): Promise<Float32Array> => {
    if (openedAt !== null) {
      const elapsed = now() - openedAt;
      if (elapsed < cooldownMs) throw new EmbeddingsUnavailableError(cooldownMs - elapsed);
      // Cooldown over: let exactly one call through to find out.
      openedAt = null;
    }
    try {
      const vec = await embed(text);
      failures = 0;
      return vec;
    } catch (err) {
      // A TIMEOUT COUNTS DOUBLE, BECAUSE IT COST DOUBLE.
      // The breaker exists to stop paying for waiting, and the two failure
      // shapes are not equally expensive: a refused connection returns in
      // milliseconds and may well be a blip worth forgiving, while a timeout
      // has already spent the full budget. Weighting by what the failure cost
      // opens the breaker after ONE hang and still tolerates a single cheap
      // stumble.
      failures += isTimeout(err) ? threshold : 1;
      if (failures >= threshold) {
        openedAt = now();
        onOpen?.(failures);
      }
      throw err;
    }
  };
}

/**
 * Scale a vector to unit length, in place.
 *
 * WHY EVERY VECTOR IS NORMALISED HERE.
 * sqlite-vec's vec0 measures L2 distance. On raw embeddings that distance has
 * no portable meaning — measured with nomic-embed-text, relevant passages came
 * back between 7.4 and 14.3 and irrelevant ones from 12.4 up, so a useful
 * cutoff existed but was a magic number belonging to one model. Normalised, L2
 * and cosine are the same ordering and d² = 2 − 2·cos, so a threshold can be
 * stated as "at least this similar" and survives a change of model.
 *
 * A zero vector is returned unchanged rather than producing NaNs; it cannot be
 * similar to anything, which is the correct behaviour for an empty passage.
 */
function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity implied by an L2 distance between unit vectors. */
export function similarityFromDistance(distance: number): number {
  return 1 - (distance * distance) / 2;
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────────────

export const RRF_K = 60;

/** One retriever's ranking: ids ordered best-first. */
export interface RankedList {
  retriever: string;
  ids: number[];
  /**
   * How much this retriever's opinion counts, relative to the others. Default 1.
   *
   * Unweighted RRF gives every list's top hit the same score, which is wrong the
   * moment the lists differ in precision: a lesson that merely shares a word
   * stem with the question would tie with one that contains every word of it.
   * The weight is what keeps a forgiving retriever useful for filling the tail
   * without letting it take the top.
   */
  weight?: number;
}

export interface FusedHit {
  id: number;
  /** Sum over lists of weight / (k + rank), rank starting at 1. */
  score: number;
  /** Which retrievers returned this id (insertion order of `lists`). */
  retrievers: string[];
}

/**
 * Merge several ranked id lists with Reciprocal Rank Fusion:
 *   score(id) = Σ_lists weight_list / (k + rank_in_list)
 * Ids missing from a list contribute nothing for that list. Pure function.
 * Ties break deterministically: more retrievers first, then lower id.
 */
export function rrfFuse(lists: RankedList[], k: number = RRF_K): FusedHit[] {
  const hits = new Map<number, FusedHit>();
  for (const list of lists) {
    const weight = typeof list.weight === "number" && Number.isFinite(list.weight)
      ? list.weight
      : 1;
    const seen = new Set<number>();
    for (let rank = 0; rank < list.ids.length; rank++) {
      const id = list.ids[rank];
      if (seen.has(id)) continue; // ignore duplicate ids within one list
      seen.add(id);
      let hit = hits.get(id);
      if (!hit) {
        hit = { id, score: 0, retrievers: [] };
        hits.set(id, hit);
      }
      hit.score += weight / (k + rank + 1);
      if (!hit.retrievers.includes(list.retriever)) {
        hit.retrievers.push(list.retriever);
      }
    }
  }
  return [...hits.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.retrievers.length - a.retrievers.length ||
      a.id - b.id
  );
}
