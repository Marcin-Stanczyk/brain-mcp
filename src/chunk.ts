// Splitting a lesson into passages, and keeping the passage index in step.
//
// WHY
// ===
// Two separate problems, one cause: the good lessons are long.
//
// Ranking. bm25 normalises by document length, so a 14 000-character lesson
// whose third paragraph answers the question exactly is scored as a mostly
// irrelevant document that happens to contain the words. Measured on the live
// base on 2026-08-08: 45 of 303 lessons ran past 3 000 characters, and those are
// the ones with the evidence in them — the long ones are long because somebody
// worked something out.
//
// Display. The prompt hook shows 1 200 characters per lesson, from the start.
// For a lesson that opens with "PROBLEM —" and reaches "FIX —" at character
// 2 400, that is the setup without the answer, cut mid-sentence.
//
// A passage index fixes both: the paragraph competes on its own length, and the
// paragraph that matched is the paragraph worth showing.
//
// WHY NOT TRIGGERS
// ================
// The lessons FTS index is maintained by SQL triggers. Chunking cannot be, since
// splitting prose is not expressible in SQLite, so every write path has to call
// reindexLessonChunks. That is a real cost and the reason rebuildAllChunks
// exists: any path that forgets is repaired by a rebuild, and initDB runs one
// when it finds the table empty against a non-empty base.

import type Database from "better-sqlite3";

/** Below this, a lesson is one passage and splitting it would only add noise. */
export const CHUNK_MIN = 400;

/** Above this, a passage is split further — it has stopped being one thought. */
export const CHUNK_MAX = 1000;

/**
 * Split a lesson into passages on its own structure.
 *
 * Blank lines first, because that is where the author already said "new
 * thought"; then single newlines, then sentence ends, and only then a hard cut.
 * Short neighbours are merged so the index does not fill with fragments that
 * match everything and rank nothing.
 */
export function splitIntoChunks(content: string): string[] {
  const text = String(content ?? "").trim();
  if (!text) return [];
  if (text.length <= CHUNK_MAX) return [text];

  const paragraphs = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= CHUNK_MAX) {
      pieces.push(paragraph);
      continue;
    }
    pieces.push(...splitOversized(paragraph));
  }

  // Merge forward while the result stays under CHUNK_MAX, so a heading line and
  // the paragraph it introduces stay in one passage rather than becoming a
  // three-word chunk that matches every query containing the heading.
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length < CHUNK_MIN && last.length + piece.length + 1 <= CHUNK_MAX) {
      merged[merged.length - 1] = `${last}\n${piece}`;
    } else {
      merged.push(piece);
    }
  }
  return merged.length ? merged : [text];
}

/** Break a too-long paragraph on the best boundary available. */
function splitOversized(paragraph: string): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_MAX) {
    const window = rest.slice(0, CHUNK_MAX);
    // Prefer a line break, then a sentence end, then give up and cut. `cut` is
    // the last resort rather than the rule: a passage that begins mid-word is
    // worse to read than one that runs slightly long.
    const cut =
      lastIndexOfAfter(window, "\n", CHUNK_MIN) ??
      lastSentenceEnd(window, CHUNK_MIN) ??
      CHUNK_MAX;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function lastIndexOfAfter(text: string, needle: string, min: number): number | null {
  const i = text.lastIndexOf(needle);
  return i >= min ? i : null;
}

function lastSentenceEnd(text: string, min: number): number | null {
  let best: number | null = null;
  const re = /[.!?…](\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= min) best = m.index + 1;
  }
  return best;
}

// ── Index maintenance ───────────────────────────────────────────────────────

/** Rewrite the passages for one lesson. Call after any content change. */
export function reindexLessonChunks(
  db: Database.Database,
  lessonId: number,
  content: string
): number {
  const remove = db.prepare("DELETE FROM lesson_chunks WHERE lesson_id = ?");
  const add = db.prepare(
    "INSERT INTO lesson_chunks (lesson_id, ord, text) VALUES (?, ?, ?)"
  );
  const chunks = splitIntoChunks(content);
  const write = db.transaction(() => {
    remove.run(lessonId);
    chunks.forEach((text, i) => add.run(lessonId, i, text));
  });
  write();
  return chunks.length;
}

/** Drop the passages of lessons that no longer exist, or were archived. */
export function removeLessonChunks(db: Database.Database, lessonIds: readonly number[]): void {
  if (!lessonIds.length) return;
  const remove = db.prepare("DELETE FROM lesson_chunks WHERE lesson_id = ?");
  const run = db.transaction((ids: readonly number[]) => {
    for (const id of ids) remove.run(id);
  });
  run(lessonIds);
}

/**
 * Rebuild every passage from scratch. Idempotent, and the repair for any write
 * path that forgot to reindex — which, unlike a trigger, is a thing that can
 * happen. Returns the number of passages written.
 */
export function rebuildAllChunks(db: Database.Database): number {
  const rows = db.prepare("SELECT id, content FROM lessons").all() as
    { id: number; content: string }[];
  const add = db.prepare("INSERT INTO lesson_chunks (lesson_id, ord, text) VALUES (?, ?, ?)");
  let total = 0;
  const write = db.transaction(() => {
    db.exec("DELETE FROM lesson_chunks");
    for (const row of rows) {
      splitIntoChunks(row.content).forEach((text, i) => {
        add.run(row.id, i, text);
        total++;
      });
    }
  });
  write();
  return total;
}

/**
 * Ensure every lesson has passages, and index the ones that do not.
 *
 * CHECKING FOR AN EMPTY TABLE IS NOT ENOUGH, which is how this was first
 * written and what `npm run doctor` caught: one lesson out of 304 had no
 * passages, because it was written by a path that did not reindex. An empty
 * table repairs itself on the next start; a table missing one row out of a
 * thousand never does, and the lesson simply stops being findable by the
 * retriever that reads long lessons well.
 *
 * Costs one indexed query on a populated base, so it can run on every start.
 * Never throws — a failure here must degrade to searching whole lessons, not
 * stop the server.
 */
export function ensureChunks(db: Database.Database): number {
  try {
    const missing = db
      .prepare(
        "SELECT id, content FROM lessons WHERE id NOT IN (SELECT lesson_id FROM lesson_chunks)"
      )
      .all() as { id: number; content: string }[];
    for (const lesson of missing) reindexLessonChunks(db, lesson.id, lesson.content);
    if (missing.length) {
      console.error(`ℹ️ brain-mcp: indexed passages for ${missing.length} lesson(s) that had none.`);
    }
    return missing.length;
  } catch (err) {
    console.error(
      `⚠️ brain-mcp: could not build the passage index (${err instanceof Error ? err.message : String(err)}) — searching whole lessons only.`
    );
    return 0;
  }
}
