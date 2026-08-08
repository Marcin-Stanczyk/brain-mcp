// Finding lessons that are filed under a project but are really about a tool.
//
// WHY
// ===
// A lesson learned while working on one repository — that `set -euo pipefail`
// turns a broken pipe into a silent exit, that `git checkout --` throws away
// uncommitted work, that a native module refuses to load under the wrong Node —
// is filed under whichever project happened to be open. It then stays invisible
// in every project where the same mistake is waiting.
//
// The `scope` column exists to end that. Measured on the live base on
// 2026-08-08 it had ended it for 4 lessons out of 303: the mechanism was
// shipped, nothing used it, and nothing noticed. A column nobody sets is a
// column that does not exist.
//
// WHAT THIS DOES NOT DO
// =====================
// It does not reclassify anything. It proposes, with the evidence that made it
// propose, and the caller decides — 299 rows rewritten by a keyword heuristic
// is a worse outcome than 299 rows left alone, because a wrong `global` is
// noise injected into every future search in every project.

import type Database from "better-sqlite3";
import { tokenizeQuery } from "./query.js";

/**
 * Vocabulary that suggests a lesson is about the environment rather than the
 * codebase: shells, version control, package managers, protocols, the machine.
 *
 * Deliberately nouns for *tools*, not for problems. "timeout" and "cache" were
 * tried and removed — every project has both, and including them made the
 * detector propose most of the base, which is the same as proposing nothing.
 */
export const TOOL_MARKERS: ReadonlySet<string> = new Set([
  // shell & unix
  "bash", "zsh", "shell", "pipefail", "sigpipe", "stdin", "stdout", "stderr",
  "cron", "crontab", "ssh", "scp", "rsync", "chmod", "sudo", "grep", "sed", "awk",
  // version control
  "git", "rebase", "commit", "branch", "worktree", "stash", "checkout", "merge",
  // package managers & runtimes
  "npm", "npx", "node", "pnpm", "yarn", "pip", "composer", "brew", "docker",
  "nvm", "fnm", "asdf", "gyp", "abi", "prebuilt",
  // protocols & formats
  "http", "https", "json", "yaml", "regex", "utf", "unicode", "sql", "sqlite",
  "fts5", "wal", "curl", "webhook", "oauth",
  // the harness itself
  "mcp", "hook", "hooks", "agent", "claude", "llm", "prompt", "token", "tokens",
]);

export interface ScopeCandidate {
  id: number;
  project: string | null;
  severity: string | null;
  /** First line of the lesson, for a human to recognise it by. */
  preview: string;
  /** The tool words that triggered the proposal — the evidence. */
  matched: string[];
}

/** How many tool words a lesson needs before it is worth proposing. */
export const MIN_TOOL_MARKERS = 2;

/**
 * Project names that appear anywhere in the base or the project index.
 *
 * A lesson that names a project is about that project, whatever else it
 * mentions. This is the half of the heuristic that keeps it honest: without it,
 * "the deploy script for kamar uses ssh and rsync" reads as a global lesson
 * about ssh.
 */
export function knownProjectNames(db: Database.Database): Set<string> {
  const names = new Set<string>();
  const add = (v: unknown) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s.length >= 3) names.add(s);
  };
  try {
    for (const r of db.prepare("SELECT DISTINCT project FROM lessons WHERE project IS NOT NULL").all() as { project: string }[]) {
      add(r.project);
    }
  } catch { /* base without lessons */ }
  try {
    for (const r of db.prepare("SELECT name FROM project_index").all() as { name: string }[]) {
      add(r.name);
    }
  } catch { /* no project index yet */ }
  return names;
}

/**
 * Lessons filed under a project that look like they are about a tool.
 *
 * A candidate mentions at least MIN_TOOL_MARKERS distinct tool words and names
 * no project at all. Both halves matter: the first finds environment lessons,
 * the second stops it claiming every lesson that happens to mention git.
 */
export function scopeCandidates(db: Database.Database, limit = 50): ScopeCandidate[] {
  const projects = knownProjectNames(db);
  const rows = db
    .prepare(
      `SELECT id, project, severity, content
       FROM lessons
       WHERE COALESCE(scope, 'project') <> 'global'
       ORDER BY id`
    )
    .all() as { id: number; project: string | null; severity: string | null; content: string }[];

  const candidates: ScopeCandidate[] = [];
  for (const row of rows) {
    const terms = new Set(tokenizeQuery(row.content));
    // A lesson that names any project — its own or another — is about that
    // project. Whatever tools it mentions are incidental to it.
    let namesAProject = false;
    for (const name of projects) {
      // Project names are often hyphenated (`kanarix-app`); the tokenizer split
      // them, so check the parts as well as the whole.
      const parts = tokenizeQuery(name);
      if (parts.length && parts.every((p) => terms.has(p))) {
        namesAProject = true;
        break;
      }
    }
    if (namesAProject) continue;

    const matched = [...terms].filter((t) => TOOL_MARKERS.has(t)).sort();
    if (matched.length < MIN_TOOL_MARKERS) continue;

    candidates.push({
      id: row.id,
      project: row.project,
      severity: row.severity,
      preview: firstLine(row.content),
      matched,
    });
    if (candidates.length >= limit) break;
  }
  // Most evidence first: the strongest proposals should be the ones a reader
  // sees before their patience runs out.
  return candidates.sort((a, b) => b.matched.length - a.matched.length || a.id - b.id);
}

function firstLine(content: string, max = 110): string {
  const line = String(content).split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Mark the given lessons as global. Returns how many rows actually changed. */
export function applyGlobalScope(db: Database.Database, ids: readonly number[]): number {
  if (!ids.length) return 0;
  // updated_at is deliberately untouched: reclassifying where a lesson applies
  // is not a revision of what it says, and the session digest orders by recency.
  const stmt = db.prepare(
    "UPDATE lessons SET scope = 'global' WHERE id = ? AND COALESCE(scope, 'project') <> 'global'"
  );
  let changed = 0;
  const run = db.transaction((list: readonly number[]) => {
    for (const id of list) changed += stmt.run(id).changes;
  });
  run(ids);
  return changed;
}
