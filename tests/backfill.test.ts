// Healing the vector backlog without anybody noticing it was there.
//
// Passages are written on every brain_learn; vectors only when a backend was
// configured AND reachable at that moment. The two drift apart for ordinary
// reasons — a session started before embeddings were configured, an offline
// laptop, a model mid-pull. Measured on the live base minutes after wiring
// embeddings in: 4 of 1128 passages had no vector.
//
// "Run brain_reindex" is a fine repair and a poor design: it needs somebody to
// notice, and the symptom of not noticing is that some lessons are silently
// unreachable by meaning while every report says healthy.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import { initDB } from "../src/tools.js";
import { loadVectorIndex, type VectorIndex } from "../src/vector.js";
import { ensureChunks } from "../src/chunk.js";
import { backfillEmbeddings, BACKFILL_MAX_FAILURES } from "../src/backfill.js";

let workDir: string;
let db: Database.Database;
let vector: VectorIndex;

const DIM = 8;
const fakeVec = () => Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
const noTick = () => Promise.resolve();

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "brain-backfill-"));
  db = initDB(join(workDir, "k.db"));
  const insert = db.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')");
  for (let i = 0; i < 5; i++) insert.run(`a lesson about deployment number ${i}`);
  // Seeding by raw SQL bypasses the passage indexing brain_learn performs —
  // the same trap that once had the eval scoring a retriever that was not
  // running. ensureChunks is exactly the repair the server applies on startup.
  ensureChunks(db);
  const v = await loadVectorIndex(db);
  assert.ok(v, "sqlite-vec loads on this platform");
  vector = v;
});
after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

test("a backlog is embedded, and a second run has nothing left to do", async () => {
  const pending = vector.unembeddedChunks().length;
  assert.ok(pending >= 5, "passages exist without vectors");

  const first = await backfillEmbeddings({
    db, vector, embedder: async () => fakeVec(), model: "m", log: () => {}, tick: noTick,
  });
  assert.equal(first.embedded, pending);
  assert.equal(first.remaining, 0);

  const second = await backfillEmbeddings({
    db, vector, embedder: async () => { throw new Error("must not be called"); },
    model: "m", log: () => {}, tick: noTick,
  });
  assert.equal(second.embedded, 0, "idempotent — nothing is re-embedded");
});

test("a dead backend leaves the backlog for next time instead of hammering it", async () => {
  const fresh = initDB(join(workDir, "dead.db"));
  const insert = fresh.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')");
  for (let i = 0; i < 20; i++) insert.run(`another lesson about caching number ${i}`);
  ensureChunks(fresh);
  const v = await loadVectorIndex(fresh);
  assert.ok(v);

  let calls = 0;
  const logs: string[] = [];
  const result = await backfillEmbeddings({
    db: fresh, vector: v!, model: "m", log: (m) => logs.push(m), tick: noTick,
    embedder: async () => { calls++; throw new Error("backend down"); },
  });

  assert.equal(calls, BACKFILL_MAX_FAILURES, "it stops rather than trying all twenty");
  assert.equal(result.embedded, 0);
  assert.ok(result.remaining > 0, "and says the work is still outstanding");
  assert.ok(logs.some((l) => /retrying on the next start/.test(l)), "without treating it as an error");
  fresh.close();
});

test("a stumble part-way through does not abandon the rest", async () => {
  const fresh = initDB(join(workDir, "flaky.db"));
  const insert = fresh.prepare("INSERT INTO lessons (content, category, tags) VALUES (?, 'gotcha', '[]')");
  for (let i = 0; i < 6; i++) insert.run(`a lesson about invoices number ${i}`);
  ensureChunks(fresh);
  const v = await loadVectorIndex(fresh);

  let n = 0;
  const result = await backfillEmbeddings({
    db: fresh, vector: v!, model: "m", log: () => {}, tick: noTick,
    // Fails once, then recovers: the counter resets on success, so a single
    // blip must not cost the remaining passages.
    embedder: async () => { n++; if (n === 2) throw new Error("blip"); return fakeVec(); },
  });
  assert.equal(result.failed, 1);
  assert.ok(result.embedded >= 5, "the counter resets on success, so the rest still got embedded");
  assert.equal(result.remaining, 1, "only the one that stumbled is left, for the next start");

  // ...and the next start picks up exactly that one.
  const again = await backfillEmbeddings({
    db: fresh, vector: v!, model: "m", log: () => {}, tick: noTick,
    embedder: async () => fakeVec(),
  });
  assert.equal(again.embedded, 1);
  assert.equal(again.remaining, 0);
  fresh.close();
});

test("nothing to do is not an event", async () => {
  const empty = initDB(join(workDir, "empty.db"));
  const v = await loadVectorIndex(empty);
  const logs: string[] = [];
  const result = await backfillEmbeddings({
    db: empty, vector: v!, model: "m", log: (m) => logs.push(m), tick: noTick,
    embedder: async () => fakeVec(),
  });
  assert.deepEqual(result, { embedded: 0, failed: 0, remaining: 0 });
  assert.equal(logs.length, 0, "a healthy base starts silently");
  empty.close();
});
