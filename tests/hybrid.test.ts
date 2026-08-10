// Hybrid vector search tests.
//
// The embeddings HTTP endpoint is mocked with a local node:http server that
// returns deterministic bag-of-words vectors — no real network access, no
// Ollama needed. sqlite-vec must load on this platform (darwin/linux
// x64+arm64, windows x64) for most of these tests.
// Run with: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import { initDB, createTools, type ToolDef } from "../src/tools.js";
import { searchLessons } from "../src/search.js";
import {
  rrfFuse,
  createEmbedder,
  embeddingsConfigFromEnv,
  similarityFromDistance,
  DEFAULT_EMBEDDINGS_MODEL,
  KEEP_ALIVE,
  type EmbeddingsConfig,
} from "../src/embeddings.js";
import { MIN_VECTOR_SIMILARITY } from "../src/search.js";
import { loadVectorIndex, type VectorIndex } from "../src/vector.js";

// ── RRF merge logic (pure function) ─────────────────────────────────────────

test("rrfFuse merges two ranked lists with reciprocal rank fusion (k=60)", () => {
  const fused = rrfFuse([
    { retriever: "fts", ids: [1, 2, 3] },
    { retriever: "vector", ids: [3, 1] },
  ]);

  const byId = new Map(fused.map((h) => [h.id, h]));
  // id 1: rank 1 in fts + rank 2 in vector
  assert.ok(Math.abs(byId.get(1)!.score - (1 / 61 + 1 / 62)) < 1e-12);
  // id 3: rank 3 in fts + rank 1 in vector
  assert.ok(Math.abs(byId.get(3)!.score - (1 / 63 + 1 / 61)) < 1e-12);
  // id 2: rank 2 in fts only
  assert.ok(Math.abs(byId.get(2)!.score - 1 / 62) < 1e-12);

  assert.deepEqual(fused.map((h) => h.id), [1, 3, 2], "fused order by descending score");
  assert.deepEqual(byId.get(1)!.retrievers, ["fts", "vector"]);
  assert.deepEqual(byId.get(2)!.retrievers, ["fts"]);
  assert.deepEqual(byId.get(3)!.retrievers, ["fts", "vector"]);
});

test("rrfFuse ignores duplicate ids within one list and honours custom k", () => {
  const fused = rrfFuse([{ retriever: "fts", ids: [7, 7, 7] }], 1);
  assert.equal(fused.length, 1);
  assert.ok(Math.abs(fused[0].score - 1 / 2) < 1e-12, "only the first occurrence counts, k=1");

  assert.deepEqual(rrfFuse([]), [], "no lists → no hits");
});

test("rrfFuse tie-break: seen-by-more-retrievers wins, then lower id", () => {
  const fused = rrfFuse([
    { retriever: "a", ids: [10, 20] },
    { retriever: "b", ids: [20, 10] },
  ]);
  // identical scores → lower id first
  assert.deepEqual(fused.map((h) => h.id), [10, 20]);
});

// ── embeddingsConfigFromEnv ─────────────────────────────────────────────────

test("embeddings are disabled unless BRAIN_EMBEDDINGS_URL is set", () => {
  assert.equal(embeddingsConfigFromEnv({}), null);
  assert.equal(embeddingsConfigFromEnv({ BRAIN_EMBEDDINGS_MODEL: "x" }), null);

  const cfg = embeddingsConfigFromEnv({ BRAIN_EMBEDDINGS_URL: "http://localhost:11434/" });
  assert.ok(cfg);
  assert.equal(cfg.url, "http://localhost:11434", "trailing slash stripped");
  assert.equal(cfg.model, DEFAULT_EMBEDDINGS_MODEL);
  assert.ok(cfg.timeoutMs > 0);

  const custom = embeddingsConfigFromEnv({
    BRAIN_EMBEDDINGS_URL: "http://127.0.0.1:9999",
    BRAIN_EMBEDDINGS_MODEL: "mxbai-embed-large",
    BRAIN_EMBEDDINGS_TIMEOUT_MS: "1500",
  });
  assert.equal(custom!.model, "mxbai-embed-large");
  assert.equal(custom!.timeoutMs, 1500);
});

// ── Mock Ollama-compatible embeddings server (test-only, localhost) ─────────

const DIM = 16;

/** Deterministic bag-of-words embedding: similar texts → nearby vectors. */
function mockEmbedding(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let httpServer: Server;
let serverDown = false; // when true the mock returns HTTP 500
let embedCalls = 0;
let cfg: EmbeddingsConfig;

let workDir: string;
let codeDir: string;
let db: Database.Database;
let vector: VectorIndex;
let tools: ToolDef[];

const toolByName = (name: string): ToolDef => {
  const t = tools.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t;
};
const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

before(async () => {
  httpServer = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/embeddings") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      embedCalls++;
      if (serverDown) {
        res.writeHead(500).end("boom");
        return;
      }
      const { prompt } = JSON.parse(body) as { model: string; prompt: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embedding: mockEmbedding(prompt) }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  assert.ok(addr && typeof addr === "object");
  cfg = { url: `http://127.0.0.1:${addr.port}`, model: "mock-model", timeoutMs: 2000 };

  workDir = mkdtempSync(join(tmpdir(), "brain-hybrid-test-"));
  codeDir = join(workDir, "code");
  mkdirSync(codeDir, { recursive: true });
  db = initDB(join(workDir, "test-knowledge.db"));

  const vec = await loadVectorIndex(db);
  assert.ok(vec, "sqlite-vec loads on this platform (darwin/linux x64+arm64, win x64)");
  vector = vec;

  tools = createTools(db, codeDir, {
    dataDir: workDir,
    vector,
    embedder: createEmbedder(cfg),
    embeddingsConfig: cfg,
  });
});

after(() => {
  httpServer.close();
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── brain_learn embeds on write ─────────────────────────────────────────────

test("brain_learn embeds the lesson when the endpoint is up", async () => {
  const learned = await toolByName("brain_learn").handler({
    content: "sqlite vector similarity search needs the vec0 virtual table",
    category: "pattern",
    tags: ["sqlite", "vectors"],
  });
  assert.match(textOf(learned), /Embedded: yes/);
  assert.equal(vector.embeddedCount(), 1);
  assert.equal(vector.dim(), DIM);
  assert.equal(vector.model(), "mock-model");
});

test("brain_recall runs hybrid search and annotates retrievers", async () => {
  const learn = toolByName("brain_learn");
  await learn.handler({
    content: "Redis cache invalidation strategy for session tokens",
    category: "pattern",
  });
  await learn.handler({
    content: "WooCommerce checkout hooks fire in priority order",
    category: "gotcha",
  });

  const found = await toolByName("brain_recall").handler({
    query: "sqlite vector similarity",
    limit: 5,
  });
  const text = textOf(found);
  assert.match(text, /\(hybrid: lexical \+ vector, RRF-fused\)/, "hybrid mode note present");
  assert.match(text, /matched: .*vector/, "top hit found by the vector retriever too");
  assert.match(text, /matched: all\+/, "and by the all-terms lexical retriever");
  assert.ok(text.includes("vec0 virtual table"), "the relevant lesson is returned");
});

test("hybrid recall respects category filter on vector hits too", async () => {
  const found = await toolByName("brain_recall").handler({
    query: "sqlite vector similarity",
    category: "gotcha",
    limit: 5,
  });
  const text = textOf(found);
  assert.ok(!text.includes("vec0 virtual table"), "pattern-category lesson filtered out");
});

// ── Graceful degradation ────────────────────────────────────────────────────

test("brain_learn still saves when the embeddings endpoint is down (marked unembedded)", async () => {
  serverDown = true;
  try {
    const learned = await toolByName("brain_learn").handler({
      content: "Cloudflare Workers CPU limit is 30s on paid plans",
      category: "gotcha",
    });
    const text = textOf(learned);
    assert.match(text, /Lesson #\d+ stored/, "lesson saved despite embedding failure");
    assert.match(text, /Embedded: no/, "marked unembedded");
    // The unit is a passage now: a short lesson is one, and a long one leaves
    // several pending. Either way the backlog is non-empty and reindex sees it.
    assert.ok(vector.unembeddedChunks().length >= 1, "the passage is left for brain_reindex");
  } finally {
    serverDown = false;
  }
});

test("brain_recall silently falls back to FTS5 when embeddings are unreachable", async () => {
  serverDown = true;
  try {
    const found = await toolByName("brain_recall").handler({
      query: "cloudflare workers cpu limit",
      limit: 5,
    });
    const text = textOf(found);
    assert.match(text, /Found \d+ lessons/, "recall never fails because embeddings are down");
    assert.ok(!text.includes("hybrid"), "no hybrid note in fallback mode");
    // The lexical retrievers still name themselves. They are what answered, and
    // which one answered is the difference between "the base knows this well"
    // and "this matched on a stem" — worth saying even with vectors down.
    assert.ok(!/matched:[^\n]*vector/.test(text), "no vector annotation in fallback mode");
    assert.match(text, /matched: (all|any|prefix)/, "lexical retrievers still annotated");
    assert.ok(text.includes("Cloudflare Workers CPU limit"));
  } finally {
    serverDown = false;
  }
});

test("recall works FTS5-only when embeddings are disabled entirely (no options)", async () => {
  const plainTools = createTools(db, codeDir); // no vector, no embedder
  const recall = plainTools.find((t) => t.name === "brain_recall")!;
  const before = embedCalls;
  const found = await recall.handler({ query: "sqlite vector similarity", limit: 5 });
  const text = textOf(found);
  assert.match(text, /Found \d+ lessons/);
  assert.ok(!text.includes("hybrid"));
  assert.equal(embedCalls, before, "no network call is ever made when disabled");
});

test("vector layer unavailable (sqlite-vec failed) → tools run FTS5-only, no crash", async () => {
  const degradedTools = createTools(db, codeDir, {
    dataDir: workDir,
    vector: null, // simulates loadVectorIndex() returning null
    embedder: createEmbedder(cfg),
    embeddingsConfig: cfg,
  });
  const recall = degradedTools.find((t) => t.name === "brain_recall")!;
  const text = textOf(await recall.handler({ query: "sqlite vector", limit: 5 }));
  assert.match(text, /Found \d+ lessons/);
  assert.ok(!text.includes("hybrid"));

  const reindex = degradedTools.find((t) => t.name === "brain_reindex")!;
  assert.match(textOf(await reindex.handler({})), /sqlite-vec extension failed to load/);

  const status = degradedTools.find((t) => t.name === "brain_status")!;
  assert.match(textOf(await status.handler({})), /vector index unavailable/);
});

// ── brain_reindex ───────────────────────────────────────────────────────────

test("brain_reindex embeds the backlog left by an outage", async () => {
  const pending = vector.unembeddedChunks().length;
  assert.ok(pending >= 1, "something is pending from the outage");

  const result = await toolByName("brain_reindex").handler({});
  const text = textOf(result);
  assert.match(text, /Reindex complete/);
  assert.match(text, new RegExp(`Embedded: ${pending}/${pending} passage`));
  assert.match(text, /Still unembedded: 0 passage/);
  assert.equal(vector.unembeddedChunks().length, 0);
  // The passage index is rebuilt unconditionally, so this reports on it too.
  assert.match(text, /Passage index rebuilt/);
});

test("brain_reindex force:true re-embeds everything", async () => {
  const total = (db.prepare("SELECT COUNT(*) c FROM lesson_chunks").get() as { c: number }).c;
  const result = await toolByName("brain_reindex").handler({ force: true });
  const text = textOf(result);
  assert.match(text, new RegExp(`Embedded: ${total}/${total} passage`));
  assert.equal(vector.embeddedCount(), total);
});

test("brain_reindex aborts after repeated failures instead of hammering a dead endpoint", async () => {
  await toolByName("brain_learn").handler({ content: "lesson while endpoint down A", category: "tooling" });
  serverDown = true;
  try {
    // the learn above happened while up; force a backlog while down
    await toolByName("brain_learn").handler({ content: "lesson while endpoint down B", category: "tooling" });
    await toolByName("brain_learn").handler({ content: "lesson while endpoint down C", category: "tooling" });
    await toolByName("brain_learn").handler({ content: "lesson while endpoint down D", category: "tooling" });
    const result = await toolByName("brain_reindex").handler({});
    assert.match(textOf(result), /ABORTED/);
  } finally {
    serverDown = false;
  }
  const result = await toolByName("brain_reindex").handler({});
  assert.match(textOf(result), /Still unembedded: 0/, "recovers once the endpoint is back");
});

// ── brain_forget cleans up vectors ──────────────────────────────────────────

test("archiving a lesson removes its embedding", async () => {
  const learned = await toolByName("brain_learn").handler({
    content: "temporary lesson that will be archived",
    category: "tooling",
  });
  const id = Number(textOf(learned).match(/Lesson #(\d+)/)?.[1]);
  const beforeCount = vector.embeddedCount();

  const chunksOfLesson =
    (db.prepare("SELECT COUNT(*) c FROM lesson_chunks WHERE lesson_id = ?").get(id) as { c: number }).c;

  await toolByName("brain_forget").handler({ id, confirm: true, reason: "test" });
  assert.equal(vector.embeddedCount(), beforeCount - chunksOfLesson);
  // The vectors hang off the passages, so they can only be found by joining
  // through them — archiving has to drop the vectors FIRST or they survive as
  // orphans that keep answering questions about a lesson that is gone.
  assert.equal(vector.pruneOrphans(), 0, "no vector outlived its passage");
});

// ── Distance, similarity, and the floor ─────────────────────────────────────

test("every embedding is unit length, so distance means the same thing per model", async () => {
  // Raw L2 distance is a magic number belonging to one model: with
  // nomic-embed-text relevant passages landed between 7.4 and 14.3, with
  // bge-m3 between 0.36 and 0.75. Normalised, the ordering is cosine and the
  // threshold survives a change of model.
  const vec = await createEmbedder(cfg)("some text to embed");
  let sum = 0;
  for (const v of vec) sum += v * v;
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5, `unit length, got ${Math.sqrt(sum)}`);
});

test("similarity is recovered exactly from distance between unit vectors", () => {
  assert.ok(Math.abs(similarityFromDistance(0) - 1) < 1e-12, "identical vectors");
  assert.ok(Math.abs(similarityFromDistance(Math.SQRT2) - 0) < 1e-12, "orthogonal");
  assert.ok(Math.abs(similarityFromDistance(2) - -1) < 1e-12, "opposite");
});

test("the request asks the backend to keep the model resident", async () => {
  // Ollama unloads after five minutes, and a cold load took ~9s. Without this
  // every quiet spell ends in a timeout on somebody's next question, which
  // degrades silently to lexical-only and looks like "embeddings do not help".
  const seen: string[] = [];
  const spy = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embedding: mockEmbedding("x") }));
    });
  });
  await new Promise<void>((r) => spy.listen(0, "127.0.0.1", r));
  const addr = spy.address() as { port: number };
  try {
    await createEmbedder({ ...cfg, url: `http://127.0.0.1:${addr.port}` })("hello");
    assert.equal(JSON.parse(seen[0]).keep_alive, KEEP_ALIVE);
  } finally {
    spy.close();
  }
});

test("a distant passage is not named at all — nearest is not the same as near", async () => {
  // KNN ALWAYS RETURNS K NEIGHBOURS. Measured the first time vectors were
  // wired in: precision@1 rose 82%→88% and MRR 0.897→0.922, while the
  // true-negative rate collapsed from 100% to 0%. Asked about Kubernetes, a
  // base with nothing about Kubernetes answered with five lessons, confidently.
  assert.ok(MIN_VECTOR_SIMILARITY > 0, "there is a floor at all");

  const learned = await toolByName("brain_learn").handler({
    content: "zebra migration patterns across the Serengeti in the dry season",
    category: "client",
  });
  const id = Number(textOf(learned).match(/Lesson #(\d+)/)![1]);

  // The mock embedder is bag-of-words, so a query sharing no vocabulary is far
  // away in exactly the sense the floor is meant to catch.
  const { rows } = await searchLessons(
    db,
    { query: "quarterly amortisation schedule", limit: 10 },
    { vector, embedder: createEmbedder(cfg) }
  );
  assert.ok(
    !rows.map((r) => Number(r.id)).includes(id),
    "an unrelated lesson is not dragged in by being the least far away"
  );
});

// ── Passage-level embeddings ────────────────────────────────────────────────

test("a long lesson is embedded per passage, and found by the passage that matches", async () => {
  // ONE VECTOR PER LESSON AVERAGES ITS SUBJECTS INTO A POINT NEAR NONE OF THEM.
  // This lesson is about three things. The query names only the third, and with
  // a single whole-document vector the first two would drag it out of reach.
  const learned = await toolByName("brain_learn").handler({
    content:
      "PROBLEM — " + "the nightly export produced a file the importer rejected. ".repeat(12) +
      "\n\nCAUSE — " + "two components disagreed about the column order in the header. ".repeat(12) +
      "\n\nFIX — pin the schema with a checksum written by the exporter and verified by the importer before the first row is read",
    category: "deployment",
  });
  const id = Number(textOf(learned).match(/Lesson #(\d+)/)![1]);

  const chunks =
    (db.prepare("SELECT COUNT(*) c FROM lesson_chunks WHERE lesson_id = ?").get(id) as { c: number }).c;
  assert.ok(chunks >= 3, "split into passages");
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) c FROM chunk_embeddings e JOIN lesson_chunks c ON c.id = e.chunk_id WHERE c.lesson_id = ?"
    ).get(id) as { c: number }).c,
    chunks,
    "every passage carries its own vector"
  );

  const found = await toolByName("brain_recall").handler({
    query: "checksum verified before the first row is read",
    limit: 5,
  });
  const text = textOf(found);
  assert.ok(text.includes(`#${id}`), "the lesson is found by its last passage");
  assert.match(text, /matching passage of a \d+-character lesson/, "and that passage is what is shown");
  assert.match(text, /FIX —/, "the answer, not the problem statement");
});

test("a lesson-level vector index from an older version is dropped, not misread", async () => {
  // Its ids are lesson ids, and they now mean passage ids: kept, the index
  // would answer with passages that do not exist. Derived data — brain_reindex
  // rebuilds it — so dropping is the safe reading, not a loss.
  const old = initDB(join(workDir, "legacy-vectors.db"));
  old.exec("CREATE TABLE lessons_vec (lesson_id INTEGER PRIMARY KEY, embedding BLOB)");
  old.exec("CREATE TABLE lesson_embeddings (lesson_id INTEGER PRIMARY KEY, model TEXT, dim INTEGER)");
  old.prepare("INSERT INTO lessons_vec (lesson_id, embedding) VALUES (1, x'00')").run();

  const migrated = await loadVectorIndex(old);
  assert.ok(migrated, "the index still loads");
  assert.equal(
    (old.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'lessons_vec'").get() as { c: number }).c,
    0,
    "the lesson-keyed table is gone"
  );
  assert.equal(migrated!.embeddedCount(), 0, "and starts empty rather than wrong");
  old.close();
});

// ── brain_status embeddings reporting ───────────────────────────────────────

test("brain_status reports embeddings mode and embedded/unembedded counts", async () => {
  const up = textOf(await toolByName("brain_status").handler({}));
  assert.match(up, /Mode: enabled \(mock-model @ http:\/\/127\.0\.0\.1:\d+\)/);
  assert.match(up, /Embedded passages: \d+ \(covering \d+ lessons\) \| Unembedded passages: 0/);
  assert.ok(!up.includes("UNREACHABLE"));

  serverDown = true;
  try {
    const down = textOf(await toolByName("brain_status").handler({}));
    assert.match(down, /UNREACHABLE, recall falls back to FTS5-only/);
  } finally {
    serverDown = false;
  }

  const disabled = createTools(db, codeDir).find((t) => t.name === "brain_status")!;
  // Names the retrievers that ARE running. A bare "disabled" was read as a
  // broken install by an agent that then stopped trusting recall entirely.
  const status = textOf(await disabled.handler({}));
  assert.match(status, /Mode: lexical only/);
  assert.match(status, /BRAIN_EMBEDDINGS_URL/, "and still says how to add semantic search");
});
