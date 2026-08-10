#!/usr/bin/env node
// npm run doctor — check the things that actually broke.
//
// Every check here corresponds to a failure that happened on a real machine and
// presented as something else:
//
//   * a native module built for the wrong Node ABI, which the MCP client
//     reported as "could not connect";
//   * an MCP config pointing at a directory that had been moved months earlier,
//     so the server was simply absent and nothing said so;
//   * `"command": "node"` resolving through PATH under a version manager, which
//     made the first failure intermittent and therefore hard to believe;
//   * a stale dist/, so a fixed bug kept reproducing.
//
// Read-only. It never edits a config; it prints what is wrong and what to run.

import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, platform } from "os";
import { createRequire } from "module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "package.json"));

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => { warnings++; console.log(`  ⚠️  ${m}`); };
const bad = (m) => { failures++; console.log(`  ❌ ${m}`); };
const section = (t) => console.log(`\n${t}`);

// ── Runtime and the native module ───────────────────────────────────────────

section("Runtime");
ok(`node ${process.version} at ${process.execPath}`);

let Database = null;
try {
  Database = require("better-sqlite3");
  ok("better-sqlite3 loads under this node");
} catch (err) {
  const msg = String(err?.message ?? err);
  if (/NODE_MODULE_VERSION|different Node\.js version/i.test(msg)) {
    bad(
      "better-sqlite3 was built for a different node ABI.\n" +
      `       Rebuild for this one:  npm rebuild better-sqlite3   (or: npm install better-sqlite3)\n` +
      `       Then pin your MCP config to ${process.execPath} instead of bare "node".`
    );
  } else {
    bad(`better-sqlite3 will not load: ${msg}\n       Try: npm install`);
  }
}

// ── Build freshness ─────────────────────────────────────────────────────────

section("Build");
const dist = join(ROOT, "dist", "index.js");
if (!existsSync(dist)) {
  bad("dist/index.js is missing — run: npm run build");
} else {
  const newestSource = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => statSync(join(ROOT, "src", f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  if (newestSource > statSync(dist).mtimeMs) {
    // A stale dist is why a fixed bug keeps reproducing: the server runs the
    // compiled copy, and nothing about the symptom says which one it is.
    warn("dist/ is older than src/ — the server is running last build's code. Run: npm run build");
  } else {
    ok("dist/ is newer than src/");
  }
}

// ── Database ────────────────────────────────────────────────────────────────

section("Database");
const dbPath = process.env.BRAIN_DB || join(ROOT, "data", "knowledge.db");
if (!Database) {
  warn(`skipped — better-sqlite3 is unavailable (${dbPath})`);
} else if (!existsSync(dbPath)) {
  warn(`no database at ${dbPath} yet — it is created on first server start`);
} else {
  try {
    const db = new Database(dbPath, { readonly: true });
    const one = (sql) => Object.values(db.prepare(sql).get())[0];
    const lessons = one("SELECT COUNT(*) FROM lessons");
    ok(`${dbPath} — ${lessons} lessons, journal mode ${db.pragma("journal_mode", { simple: true })}`);

    try {
      db.prepare("SELECT COUNT(*) FROM lessons_fts").get();
      ok("FTS5 index present");
    } catch {
      bad("lessons_fts is missing — search cannot work. Recreate by starting the server once.");
    }

    // The passage index is maintained from TypeScript, not by a trigger, so it
    // is the one that can silently fall behind.
    try {
      const chunks = one("SELECT COUNT(*) FROM lesson_chunks");
      // Coverage, not volume. "1060 passages across 304 lessons" reads healthy
      // and is compatible with one lesson having none — which is exactly what
      // this check found the first time it ran, and that lesson was invisible
      // to the retriever that reads long lessons well.
      const uncovered = one(
        "SELECT COUNT(*) FROM lessons WHERE id NOT IN (SELECT lesson_id FROM lesson_chunks)"
      );
      if (lessons > 0 && chunks === 0) {
        warn("passage index is empty — restart the server, or run brain_reindex");
      } else if (uncovered > 0) {
        warn(`${uncovered} lesson(s) have no passages — restart the server, or run brain_reindex`);
      } else {
        ok(`passage index: ${chunks} passages covering all ${lessons} lessons`);
      }
    } catch {
      warn("passage index missing — it is built on the next server start");
    }

    const globals = one("SELECT COUNT(*) FROM lessons WHERE COALESCE(scope,'project') = 'global'");
    if (lessons >= 50 && globals / lessons < 0.05) {
      warn(
        `only ${globals} of ${lessons} lessons are marked global — tool lessons filed under ` +
        `one project stay invisible in the others. Run brain_rescope to see candidates.`
      );
    }
    db.close();
  } catch (err) {
    bad(`cannot read ${dbPath}: ${err?.message ?? err}`);
  }
}

// ── sqlite-vec and embeddings ───────────────────────────────────────────────

// ── MCP client configuration ────────────────────────────────────────────────
// This is where the two worst failures lived: a path that no longer existed,
// and a bare `node` that resolved differently depending on the launching shell.

section("MCP client configuration");
const entry = join(ROOT, "dist", "index.js");
const configs = [
  { label: "Claude Code (~/.claude.json)", path: join(homedir(), ".claude.json"), key: "mcpServers" },
  ...(platform() === "darwin"
    ? [{
        label: "VS Code (Code/User/mcp.json)",
        path: join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json"),
        key: "servers",
      }]
    : []),
];

let sawAnyEntry = false;
/** env the MCP client will actually launch the server with. */
const declaredEnv = {};
for (const cfg of configs) {
  if (!existsSync(cfg.path)) continue;
  let servers;
  try {
    servers = JSON.parse(readFileSync(cfg.path, "utf-8"))[cfg.key] ?? {};
  } catch (err) {
    warn(`${cfg.label}: cannot parse (${err?.message ?? err})`);
    continue;
  }
  for (const [name, server] of Object.entries(servers)) {
    const args = server?.args ?? [];
    if (!args.some((a) => String(a).includes("brain-mcp"))) continue;
    sawAnyEntry = true;
    Object.assign(declaredEnv, server?.env ?? {});

    const target = args.find((a) => String(a).endsWith(".js"));
    if (target && !existsSync(target)) {
      bad(`${cfg.label} → "${name}" points at ${target}, which does not exist.\n       Expected: ${entry}`);
    } else if (target && target !== entry) {
      warn(`${cfg.label} → "${name}" runs ${target}, not this checkout (${entry})`);
    } else {
      ok(`${cfg.label} → "${name}" points at this checkout`);
    }

    const cmd = String(server?.command ?? "");
    if (cmd === "node" || cmd === "") {
      warn(
        `${cfg.label} → "${name}" uses bare "node", which resolves through PATH.\n` +
        `       With a version manager that is a coin flip, and the loser is an ABI crash\n` +
        `       before the MCP handshake. Pin it: "command": "${process.execPath}"`
      );
    } else if (!existsSync(cmd)) {
      bad(`${cfg.label} → "${name}" command does not exist: ${cmd}`);
    } else {
      ok(`${cfg.label} → "${name}" runs ${cmd}`);
    }
  }
}
if (!sawAnyEntry) warn("no MCP client config mentions brain-mcp — the server is registered nowhere");

// ── sqlite-vec and embeddings ───────────────────────────────────────────────
// Read from the MCP CONFIG, not from this process's environment. The server is
// launched by the client with the env declared there, so checking `process.env`
// answers a question about the shell running the doctor and reports "off" for
// an installation that is on.

section("Semantic search (optional)");
const declaredUrl = declaredEnv.BRAIN_EMBEDDINGS_URL || process.env.BRAIN_EMBEDDINGS_URL;
const declaredModel = declaredEnv.BRAIN_EMBEDDINGS_MODEL || process.env.BRAIN_EMBEDDINGS_MODEL;
if (!declaredUrl) {
  ok("off — lexical retrievers only (set BRAIN_EMBEDDINGS_URL in your MCP config to add it)");
} else {
  ok(`${declaredUrl}${declaredModel ? ` — model ${declaredModel}` : ""}`);
  try {
    require.resolve("sqlite-vec");
    ok("sqlite-vec is installed");
  } catch {
    bad("sqlite-vec is not installed, so vectors cannot be stored: npm install sqlite-vec");
  }
  // A backend named in the config and not answering is worse than one that was
  // never configured: recall silently degrades to lexical and nothing says so.
  try {
    const res = await fetch(new URL("/api/version", declaredUrl), {
      signal: AbortSignal.timeout(3000),
    });
    ok(`backend reachable (${(await res.json()).version ?? "ok"})`);
  } catch (err) {
    bad(
      `backend at ${declaredUrl} is NOT reachable (${err?.message ?? err}).\n` +
      "       Recall degrades to lexical-only without saying so. Start it, e.g.: brew services start ollama"
    );
  }

  if (Database && existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const chunks = Object.values(db.prepare("SELECT COUNT(*) FROM lesson_chunks").get())[0];
      const embedded = Object.values(
        db.prepare("SELECT COUNT(*) FROM chunk_embeddings e JOIN lesson_chunks c ON c.id = e.chunk_id").get()
      )[0];
      if (embedded < chunks) {
        warn(`${chunks - embedded} of ${chunks} passages have no vector — run brain_reindex`);
      } else {
        ok(`all ${chunks} passages embedded`);
      }
      db.close();
    } catch {
      warn("no vector bookkeeping yet — run brain_reindex once the server has started");
    }
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

section("Hooks");
const settingsPath = join(homedir(), ".claude", "settings.json");
if (!existsSync(settingsPath)) {
  warn(`${settingsPath} not found — hooks are not installed (npm run hooks:install)`);
} else {
  let hooks = {};
  try {
    hooks = JSON.parse(readFileSync(settingsPath, "utf-8")).hooks ?? {};
  } catch (err) {
    warn(`cannot parse ${settingsPath}: ${err?.message ?? err}`);
  }
  const registered = new Set();
  for (const matchers of Object.values(hooks)) {
    for (const m of matchers ?? []) {
      for (const h of m.hooks ?? []) {
        const match = String(h.command ?? "").match(/hooks\/(\w+\.py)/);
        if (match) registered.add(match[1]);
      }
    }
  }
  // relevant_lessons is the one that makes retrieval automatic. Without it the
  // knowledge base is a library you have to remember to consult.
  for (const name of ["relevant_lessons.py", "session_context.py", "capture_lesson.py", "incident_watch.py"]) {
    const file = join(ROOT, "hooks", name);
    if (!existsSync(file)) bad(`hooks/${name} is missing from this checkout`);
    else if (!registered.has(name)) warn(`hooks/${name} exists but is not registered (npm run hooks:install)`);
    else ok(`${name} registered`);
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────

console.log();
if (failures) {
  console.log(`❌ ${failures} problem(s), ${warnings} warning(s).`);
  process.exitCode = 1;
} else if (warnings) {
  console.log(`⚠️  No blocking problems, ${warnings} warning(s).`);
} else {
  console.log("✅ Everything checks out.");
}
