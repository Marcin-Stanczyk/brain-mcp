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

export const DEFAULT_EMBEDDINGS_MODEL = "nomic-embed-text";
export const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 4000;

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
      body: JSON.stringify({ model: cfg.model, prompt: text }),
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
    return vec;
  };
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────────────

export const RRF_K = 60;

/** One retriever's ranking: ids ordered best-first. */
export interface RankedList {
  retriever: string;
  ids: number[];
}

export interface FusedHit {
  id: number;
  /** Sum over lists of 1 / (k + rank), rank starting at 1. */
  score: number;
  /** Which retrievers returned this id (insertion order of `lists`). */
  retrievers: string[];
}

/**
 * Merge several ranked id lists with Reciprocal Rank Fusion:
 *   score(id) = Σ_lists 1 / (k + rank_in_list)
 * Ids missing from a list contribute nothing for that list. Pure function.
 * Ties break deterministically: more retrievers first, then lower id.
 */
export function rrfFuse(lists: RankedList[], k: number = RRF_K): FusedHit[] {
  const hits = new Map<number, FusedHit>();
  for (const list of lists) {
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
      hit.score += 1 / (k + rank + 1);
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
