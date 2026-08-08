// sqlite-vec vector index, over passages.
//
// Entirely optional: if the sqlite-vec extension cannot be loaded (package
// missing, unsupported platform, SQLite built without extension loading, ...)
// `loadVectorIndex` warns once on stderr and returns null — the server keeps
// running on the lexical retrievers. Nothing in this module may crash the server.
//
// WHY PASSAGES AND NOT LESSONS
// ============================
// One vector per lesson averages the whole document into a single point, and the
// lessons worth embedding are the long ones: on the live base 45 of 303 run past
// 3000 characters and one reaches 14735. A lesson that states a problem, works
// through a cause and ends with a fix has three subjects, and their mean is
// close to none of them. Embedding the passages the lexical retrievers already
// index keeps each vector about one thing, and lets the vector retriever say
// WHICH part matched — the same thing the chunk retrievers provide, so the
// display does not care which one found a lesson.

import type Database from "better-sqlite3";

export interface KnnHit {
  /** Passage id (lesson_chunks.id), not a lesson id. */
  id: number;
  distance: number;
}

export interface VectorIndex {
  /** Dimension of the current vec0 table, or null if no vector stored yet. */
  dim(): number | null;
  /** Model the stored vectors were produced with (null before first upsert). */
  model(): string | null;
  /** Insert or replace the embedding for one passage. Creates the table lazily. */
  upsert(chunkId: number, vec: Float32Array, model: string): void;
  /** Remove embeddings for every passage of the given lessons. */
  removeByLesson(lessonIds: readonly number[]): void;
  /** K nearest passages. Returns [] on dimension mismatch. */
  knn(vec: Float32Array, k: number): KnnHit[];
  /** Number of passages that currently have an embedding. */
  embeddedCount(): number;
  /** Lessons with at least one embedded passage — what a human counts. */
  embeddedLessonCount(): number;
  /** Passage ids that have no embedding yet, with their text. */
  unembeddedChunks(): { id: number; text: string }[];
  /** Drop all stored vectors (used by brain_reindex force). */
  clear(): void;
  /** Delete embeddings whose passage no longer exists. Returns count removed. */
  pruneOrphans(): number;
}

function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

const META_DIM = "vec_dim";
const META_MODEL = "vec_model";
const VEC_TABLE = "chunks_vec";

class SqliteVecIndex implements VectorIndex {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS brain_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // A base embedded before passages existed holds one vector per lesson in
    // `lessons_vec`. Those ids mean something else now, so keeping them would
    // return passages that do not exist. Dropped rather than migrated: the
    // vectors are derived data and brain_reindex rebuilds them.
    try {
      const stale = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lessons_vec'")
        .get();
      if (stale) {
        this.db.exec("DROP TABLE lessons_vec");
        this.db.exec("DROP TABLE IF EXISTS lesson_embeddings");
        this.db.prepare("DELETE FROM brain_meta WHERE key IN (?, ?)").run(META_DIM, META_MODEL);
        console.error(
          "ℹ️ brain-mcp: dropped the lesson-level vector index — embeddings are per passage now. Run brain_reindex to rebuild."
        );
      }
    } catch { /* nothing to migrate */ }
  }

  private meta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM brain_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO brain_meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  private hasVecTable(): boolean {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(VEC_TABLE) !== undefined
    );
  }

  dim(): number | null {
    if (!this.hasVecTable()) return null;
    const raw = this.meta(META_DIM);
    const dim = raw === null ? NaN : Number(raw);
    return Number.isInteger(dim) && dim > 0 ? dim : null;
  }

  model(): string | null {
    return this.hasVecTable() ? this.meta(META_MODEL) : null;
  }

  private ensureTable(dim: number, model: string): void {
    if (this.hasVecTable()) {
      const existing = this.dim();
      if (existing !== null && existing !== dim) {
        throw new Error(
          `embedding dimension mismatch: index has ${existing}, got ${dim}. ` +
            `Run brain_reindex with force:true to rebuild the index.`
        );
      }
      return;
    }
    // vec0 dimension is fixed at creation, so the table is created lazily on
    // the first upsert, when the model's dimension is known.
    this.db.exec(
      `CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`
    );
    this.setMeta(META_DIM, String(dim));
    this.setMeta(META_MODEL, model);
  }

  upsert(chunkId: number, vec: Float32Array, model: string): void {
    this.ensureTable(vec.length, model);
    const write = this.db.transaction(() => {
      // vec0 has no ON CONFLICT support — delete then insert.
      this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE chunk_id = ?`).run(BigInt(chunkId));
      this.db
        .prepare(`INSERT INTO ${VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`)
        .run(BigInt(chunkId), toBlob(vec));
      this.db
        .prepare(
          "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dim, created_at) VALUES (?, ?, ?, datetime('now'))"
        )
        .run(chunkId, model, vec.length);
    });
    write();
  }

  private removeChunks(chunkIds: readonly number[]): void {
    if (!chunkIds.length) return;
    const hasVec = this.hasVecTable();
    const run = this.db.transaction(() => {
      for (const id of chunkIds) {
        if (hasVec) this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE chunk_id = ?`).run(BigInt(id));
        this.db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?").run(id);
      }
    });
    run();
  }

  removeByLesson(lessonIds: readonly number[]): void {
    if (!lessonIds.length) return;
    // Must run BEFORE the passages themselves are deleted, or there is nothing
    // left to join against and the vectors survive as orphans.
    const placeholders = lessonIds.map(() => "?").join(",");
    let ids: number[];
    try {
      ids = (
        this.db
          .prepare(`SELECT id FROM lesson_chunks WHERE lesson_id IN (${placeholders})`)
          .all(...lessonIds) as { id: number }[]
      ).map((r) => r.id);
    } catch {
      return;
    }
    this.removeChunks(ids);
  }

  knn(vec: Float32Array, k: number): KnnHit[] {
    if (!this.hasVecTable()) return [];
    const dim = this.dim();
    if (dim !== null && dim !== vec.length) return []; // model changed — cannot compare
    return this.db
      .prepare(
        `SELECT chunk_id AS id, distance
         FROM ${VEC_TABLE}
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(toBlob(vec), BigInt(Math.max(1, Math.floor(k)))) as KnnHit[];
  }

  embeddedCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM chunk_embeddings e JOIN lesson_chunks c ON c.id = e.chunk_id"
      )
      .get() as { c: number };
    return row.c;
  }

  embeddedLessonCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT c.lesson_id) AS c FROM chunk_embeddings e JOIN lesson_chunks c ON c.id = e.chunk_id"
      )
      .get() as { c: number };
    return row.c;
  }

  unembeddedChunks(): { id: number; text: string }[] {
    return this.db
      .prepare(
        "SELECT id, text FROM lesson_chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_embeddings) ORDER BY id"
      )
      .all() as { id: number; text: string }[];
  }

  clear(): void {
    const run = this.db.transaction(() => {
      if (this.hasVecTable()) this.db.exec(`DROP TABLE ${VEC_TABLE}`);
      this.db.exec("DELETE FROM chunk_embeddings");
      this.db.prepare("DELETE FROM brain_meta WHERE key IN (?, ?)").run(META_DIM, META_MODEL);
    });
    run();
  }

  pruneOrphans(): number {
    const orphans = this.db
      .prepare(
        "SELECT chunk_id AS id FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT id FROM lesson_chunks)"
      )
      .all() as { id: number }[];
    this.removeChunks(orphans.map((o) => o.id));
    return orphans.length;
  }
}

let warnedOnce = false;

/**
 * Try to load the sqlite-vec extension into `db` and return a VectorIndex.
 * Returns null (after warning once on stderr) when the extension is
 * unavailable for any reason: package not installed, unsupported platform,
 * extension loading disabled. The caller treats null as "lexical-only mode".
 *
 * The import is dynamic on purpose: a missing/broken sqlite-vec package must
 * degrade to lexical-only search, never crash the server at startup.
 */
export async function loadVectorIndex(db: Database.Database): Promise<VectorIndex | null> {
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    return new SqliteVecIndex(db);
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.error(
        `⚠️ brain-mcp: sqlite-vec unavailable (${err instanceof Error ? err.message : String(err)}) — vector search disabled, using lexical retrievers only.`
      );
    }
    return null;
  }
}
