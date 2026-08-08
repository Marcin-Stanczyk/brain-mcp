// `scope` — the column that decides whether a lesson can leave the project it
// was learned in.
//
// It was shipped, and then it did nothing. Two reasons, and this suite pins the
// fix for both. First, the project filter did not honour it: a lesson marked
// global was still stored under whichever project was open, so filtering by any
// other project hid it — exactly the invisibility the column exists to end.
// Second, nothing ever set it. Measured on the live base on 2026-08-08: 4
// lessons out of 303. A column nobody sets is a column that does not exist.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import { initDB, createTools, type ToolDef } from "../src/tools.js";
import { searchLessons } from "../src/search.js";
import { scopeCandidates, applyGlobalScope, knownProjectNames, MIN_TOOL_MARKERS } from "../src/scope.js";

let workDir: string;
let db: Database.Database;
let tools: ToolDef[];

const toolByName = (name: string): ToolDef => {
  const t = tools.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t;
};
const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

const insert = (row: {
  content: string; category?: string; project?: string | null; scope?: string; severity?: string;
}) =>
  Number(
    db.prepare(
      `INSERT INTO lessons (content, category, tags, project, severity, scope)
       VALUES (?, ?, '[]', ?, ?, ?)`
    ).run(
      row.content, row.category ?? "gotcha", row.project ?? null,
      row.severity ?? "info", row.scope ?? "project"
    ).lastInsertRowid
  );

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "brain-mcp-scope-"));
  db = initDB(join(workDir, "knowledge.db"));
  tools = createTools(db, join(workDir, "code"), { dataDir: workDir });
});

after(() => {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── The filter ──────────────────────────────────────────────────────────────

test("a global lesson crosses the project filter it was filed under", async () => {
  const globalId = insert({
    content: "set -euo pipefail plus a pipe into head exits 141 on SIGPIPE, silently",
    project: "alpha",
    scope: "global",
  });
  insert({ content: "alpha uses a bespoke pricing table", project: "alpha" });
  const betaId = insert({ content: "beta pipes build output into head for the summary", project: "beta" });

  const { rows } = await searchLessons(db, { query: "pipe head", project: "beta", limit: 10 });
  const ids = rows.map((r) => Number(r.id));

  assert.ok(ids.includes(globalId), "the global lesson reaches a project it was not learned in");
  assert.ok(ids.includes(betaId), "and the project's own lesson is still there");
});

test("a project-scoped lesson does not leak into other projects", async () => {
  const alphaOnly = insert({ content: "alpha invoices are numbered from a shared counter", project: "alpha" });
  const { rows } = await searchLessons(db, { query: "invoices counter", project: "beta", limit: 10 });
  assert.ok(
    !rows.map((r) => Number(r.id)).includes(alphaOnly),
    "crossing the filter is what `global` buys — it is not the default"
  );
});

// ── The detector ────────────────────────────────────────────────────────────

test("a lesson about a tool that names no project is proposed", () => {
  const id = insert({
    content: "git checkout -- <file> restores from HEAD, so after a mutation test it throws away the uncommitted fix as well. Commit first.",
    project: "alpha",
  });
  const proposed = scopeCandidates(db).find((c) => c.id === id);
  assert.ok(proposed, "proposed");
  assert.ok(
    proposed!.matched.length >= MIN_TOOL_MARKERS,
    "and carries the evidence that made it a proposal"
  );
  assert.ok(proposed!.matched.includes("git"));
});

test("a lesson that names a project is left alone however many tools it mentions", () => {
  // Without this half the heuristic claims every lesson that happens to say
  // "git", which is most of them, and proposing everything is proposing nothing.
  const id = insert({
    content: "The alpha deploy script uses ssh and rsync, and the git tag has to be pushed first",
    project: "alpha",
  });
  assert.ok(
    !scopeCandidates(db).some((c) => c.id === id),
    "naming a project makes the tools incidental"
  );
});

test("lessons already global are not proposed again", () => {
  const id = insert({
    content: "npm rebuild compiles via gyp and often fails; npm install may fetch a prebuilt for the current node",
    project: "alpha",
    scope: "global",
  });
  assert.ok(!scopeCandidates(db).some((c) => c.id === id));
});

test("one tool word is not enough", () => {
  const id = insert({ content: "The nightly report is written to json", project: "gamma" });
  assert.ok(
    !scopeCandidates(db).some((c) => c.id === id),
    "a single incidental mention is not evidence"
  );
});

test("known project names come from both the lessons and the project index", () => {
  const names = knownProjectNames(db);
  assert.ok(names.has("alpha") && names.has("beta"), "projects seen on lessons");
});

// ── Applying ────────────────────────────────────────────────────────────────

test("applying is explicit, idempotent, and does not look like an edit", () => {
  const id = insert({
    content: "docker compose down removes named volumes only with the -v flag, and bash history will not warn you",
    project: "alpha",
  });
  const before = db.prepare("SELECT updated_at, created_at FROM lessons WHERE id = ?").get(id) as
    { updated_at: string; created_at: string };

  assert.equal(applyGlobalScope(db, [id]), 1, "the row changed");
  assert.equal(applyGlobalScope(db, [id]), 0, "applying twice changes nothing");
  assert.equal(applyGlobalScope(db, []), 0);

  const after = db.prepare("SELECT scope, updated_at FROM lessons WHERE id = ?").get(id) as
    { scope: string; updated_at: string };
  assert.equal(after.scope, "global");
  // Where a lesson applies is not a revision of what it says, and the session
  // digest orders by recency — reclassifying must not promote it forever.
  assert.equal(after.updated_at, before.updated_at, "updated_at untouched");
});

test("brain_rescope refuses to write without being told exactly what to write", async () => {
  const rescope = toolByName("brain_rescope");

  const refused = textOf(await rescope.handler({ apply: true }));
  assert.match(refused, /Nothing to apply/, "apply without ids is refused, not guessed at");

  const listed = textOf(await rescope.handler({}));
  assert.match(listed, /proposals, not findings/, "the default lists and explains rather than writing");
  assert.match(listed, /evidence:/, "with the words that triggered each proposal");
});
