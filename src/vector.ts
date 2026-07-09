// sqlite-vec vector index layer.
//
// Entirely optional: if the sqlite-vec extension cannot be loaded (package
// missing, unsupported platform, SQLite built without extension loading, ...)
// `loadVectorIndex` warns once on stderr and returns null — the server keeps
// running with FTS5-only search. Nothing in this module may crash the server.

import type Database from "better-sqlite3";

export interface KnnHit {
  id: number;
  distance: number;
}

export interface VectorIndex {
  /** Dimension of the current vec0 table, or null if no vector stored yet. */
  dim(): number | null;
  /** Model the stored vectors were produced with (null before first upsert). */
  model(): string | null;
  /** Insert or replace the embedding for a lesson. Creates the vec0 table lazily. */
  upsert(lessonId: number, vec: Float32Array, model: string): void;
  /** Remove embeddings for the given lesson ids (no-op for unknown ids). */
  remove(lessonIds: number[]): void;
  /** K nearest neighbours of `vec`. Returns [] on dimension mismatch. */
  knn(vec: Float32Array, k: number): KnnHit[];
  /** Number of lessons that currently have an embedding. */
  embeddedCount(): number;
  /** Lesson ids (active lessons) that have no embedding yet. */
  unembeddedLessonIds(): number[];
  /** Drop all stored vectors (used by brain_reindex force). */
  clear(): void;
  /** Delete embeddings whose lesson no longer exists. Returns count removed. */
  pruneOrphans(): number;
}

function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

const META_DIM = "vec_dim";
const META_MODEL = "vec_model";

class SqliteVecIndex implements VectorIndex {
  constructor(private db: Database.Database) {
    // Tracking table is plain SQLite — safe to create unconditionally.
    db.exec(`
      CREATE TABLE IF NOT EXISTS lesson_embeddings (
        lesson_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS brain_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
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
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lessons_vec'")
      .get();
    return row !== undefined;
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
      `CREATE VIRTUAL TABLE lessons_vec USING vec0(lesson_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`
    );
    this.setMeta(META_DIM, String(dim));
    this.setMeta(META_MODEL, model);
  }

  upsert(lessonId: number, vec: Float32Array, model: string): void {
    this.ensureTable(vec.length, model);
    const write = this.db.transaction(() => {
      // vec0 has no ON CONFLICT support — delete then insert.
      this.db.prepare("DELETE FROM lessons_vec WHERE lesson_id = ?").run(BigInt(lessonId));
      this.db
        .prepare("INSERT INTO lessons_vec (lesson_id, embedding) VALUES (?, ?)")
        .run(BigInt(lessonId), toBlob(vec));
      this.db
        .prepare(
          "INSERT OR REPLACE INTO lesson_embeddings (lesson_id, model, dim, created_at) VALUES (?, ?, ?, datetime('now'))"
        )
        .run(lessonId, model, vec.length);
    });
    write();
  }

  remove(lessonIds: number[]): void {
    if (!lessonIds.length) return;
    const hasVec = this.hasVecTable();
    const run = this.db.transaction(() => {
      for (const id of lessonIds) {
        if (hasVec) {
          this.db.prepare("DELETE FROM lessons_vec WHERE lesson_id = ?").run(BigInt(id));
        }
        this.db.prepare("DELETE FROM lesson_embeddings WHERE lesson_id = ?").run(id);
      }
    });
    run();
  }

  knn(vec: Float32Array, k: number): KnnHit[] {
    if (!this.hasVecTable()) return [];
    const dim = this.dim();
    if (dim !== null && dim !== vec.length) return []; // model changed — cannot compare
    const rows = this.db
      .prepare(
        `SELECT lesson_id AS id, distance
         FROM lessons_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(toBlob(vec), BigInt(Math.max(1, Math.floor(k)))) as KnnHit[];
    return rows;
  }

  embeddedCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM lesson_embeddings e JOIN lessons l ON l.id = e.lesson_id"
      )
      .get() as { c: number };
    return row.c;
  }

  unembeddedLessonIds(): number[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM lessons WHERE id NOT IN (SELECT lesson_id FROM lesson_embeddings) ORDER BY id"
      )
      .all() as { id: number }[];
    return rows.map((r) => r.id);
  }

  clear(): void {
    const run = this.db.transaction(() => {
      if (this.hasVecTable()) this.db.exec("DROP TABLE lessons_vec");
      this.db.exec("DELETE FROM lesson_embeddings");
      this.db.prepare("DELETE FROM brain_meta WHERE key IN (?, ?)").run(META_DIM, META_MODEL);
    });
    run();
  }

  pruneOrphans(): number {
    const orphans = this.db
      .prepare(
        "SELECT lesson_id AS id FROM lesson_embeddings WHERE lesson_id NOT IN (SELECT id FROM lessons)"
      )
      .all() as { id: number }[];
    this.remove(orphans.map((o) => o.id));
    return orphans.length;
  }
}

let warnedOnce = false;

/**
 * Try to load the sqlite-vec extension into `db` and return a VectorIndex.
 * Returns null (after warning once on stderr) when the extension is
 * unavailable for any reason: package not installed, unsupported platform,
 * extension loading disabled. The caller treats null as "FTS5-only mode".
 *
 * The import is dynamic on purpose: a missing/broken sqlite-vec package must
 * degrade to FTS5-only search, never crash the server at startup.
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
        `⚠️ brain-mcp: sqlite-vec unavailable (${err instanceof Error ? err.message : String(err)}) — vector search disabled, using FTS5 only.`
      );
    }
    return null;
  }
}
