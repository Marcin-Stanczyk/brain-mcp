// Severity as a ranking input, and what happens when everything claims it.
//
// A fixed `critical → ×1.25` assumes critical is rare. Measured on the live base
// on 2026-08-08 it was 118 lessons out of 303, with `important` another 155:
// 90% of everything carried a raised severity. The boost was rewarding almost
// the whole base and separating nothing, while looking like a working feature.
//
// Re-judging 303 lessons is not a fix anyone performs. Deriving the boost from
// how much a label actually narrows the field is, and it keeps working as the
// base changes — including in the direction of getting worse.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import DatabaseCtor from "better-sqlite3";
import { initDB, createTools } from "../src/tools.js";
import { severityBoosts, searchLessons, MAX_SEVERITY_BOOST } from "../src/search.js";

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-mcp-severity-"));
});
after(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
/** A throwaway base with the given severities, in the given quantities. */
const baseWith = (counts: Record<string, number>) => {
  const db = initDB(join(workDir, `sev-${dbCounter++}.db`));
  const insert = db.prepare(
    "INSERT INTO lessons (content, category, tags, severity, scope) VALUES (?, 'gotcha', '[]', ?, 'project')"
  );
  let n = 0;
  for (const [severity, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) insert.run(`lesson number ${n++} about deployment`, severity);
  }
  return db;
};

// ── The curve ───────────────────────────────────────────────────────────────

test("a rare severity is worth something, a ubiquitous one is not", () => {
  const rare = severityBoosts(baseWith({ critical: 5, info: 95 }));
  const everywhere = severityBoosts(baseWith({ critical: 95, info: 5 }));

  assert.ok(rare.critical > everywhere.critical, "the same label is worth less when it is everywhere");
  assert.ok(rare.critical > 1.2, "5% critical genuinely narrows the field");
  assert.ok(everywhere.critical < 1.05, "95% critical narrows nothing, and the boost says so");
});

test("the boost is bounded, so severity can never decide a ranking by itself", () => {
  // It is a tie-breaker between lessons the retrievers already agreed on. A
  // label alone must never be able to promote something unrelated.
  const boosts = severityBoosts(baseWith({ critical: 1, info: 999 }));
  assert.ok(boosts.critical <= MAX_SEVERITY_BOOST, `bounded by ${MAX_SEVERITY_BOOST}`);
  assert.ok(boosts.critical > 1, "but still positive");
});

test("only labels that claim urgency can earn a boost", () => {
  // `info` being rare does not make an info lesson important — that is the
  // whole content of the label. Rewarding rarity as such would invert it.
  const boosts = severityBoosts(baseWith({ info: 2, critical: 50, important: 48 }));
  assert.equal(boosts.info, undefined);
  assert.equal(boosts.tip, undefined);
  assert.ok(boosts.critical, "critical and important are the only two that can");
  assert.ok(boosts.important);
});

test("an empty or unreadable base yields no boosts rather than throwing", () => {
  assert.deepEqual(severityBoosts(baseWith({})), {});

  const broken = new DatabaseCtor(join(workDir, "no-lessons-table.db"));
  assert.deepEqual(severityBoosts(broken), {}, "a base without the table must not throw into a search");
  broken.close();
});

// ── The effect on ranking ───────────────────────────────────────────────────

test("severity orders two equally relevant lessons, and only those", async () => {
  const db = initDB(join(workDir, "ranking.db"));
  const insert = db.prepare(
    "INSERT INTO lessons (content, category, tags, severity, scope) VALUES (?, 'gotcha', '[]', ?, 'project')"
  );
  // Same words, so the retrievers rank them identically and severity is the
  // only thing left to separate them.
  const infoId = Number(insert.run("the deploy pipeline clears the cache", "info").lastInsertRowid);
  const critId = Number(insert.run("the deploy pipeline clears the cache", "critical").lastInsertRowid);
  // Padding, so `critical` is rare enough to be worth something.
  for (let i = 0; i < 40; i++) insert.run(`unrelated lesson ${i} about invoices`, "info");

  const { rows } = await searchLessons(
    db,
    { query: "deploy pipeline cache", limit: 5 },
    { severityBoost: severityBoosts(db) }
  );
  const ids = rows.map((r) => Number(r.id));
  assert.ok(ids.indexOf(critId) < ids.indexOf(infoId), "the critical one goes first");

  // ...and cannot reach a lesson the query is not about.
  const { rows: unrelated } = await searchLessons(
    db,
    { query: "invoices", limit: 3 },
    { severityBoost: severityBoosts(db) }
  );
  assert.ok(
    !unrelated.map((r) => Number(r.id)).includes(critId),
    "a boost is not a way into results the query does not match"
  );
  db.close();
});

// ── Saying so ───────────────────────────────────────────────────────────────

test("brain_status warns when severity has stopped selecting", async () => {
  const inflated = baseWith({ critical: 40, important: 50, info: 10 });
  const status = createTools(inflated, join(workDir, "code")).find((t) => t.name === "brain_status")!;
  const out = (await status.handler({})).content.map((c) => c.text).join("\n");

  assert.match(out, /### Severity/);
  assert.match(out, /ranking boost ×/, "the effective multiplier is shown, not just the count");
  assert.match(out, /90% of lessons are critical or important/);
  assert.match(out, /cannot order anything/, "and what that costs is said plainly");
  inflated.close();

  const healthy = baseWith({ critical: 5, important: 15, info: 80 });
  const ok = createTools(healthy, join(workDir, "code")).find((t) => t.name === "brain_status")!;
  const okOut = (await ok.handler({})).content.map((c) => c.text).join("\n");
  assert.ok(!/cannot order anything/.test(okOut), "no warning when the labels still mean something");
  healthy.close();
});
