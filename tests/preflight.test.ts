// Startup failures, and turning them into instructions.
//
// The ABI mismatch is the worst bug this project has had, not because it is
// hard but because of where it lands. better-sqlite3 throws while the module
// graph is being evaluated — before the MCP handshake, before any code of ours
// runs — so the client reports "could not connect", the real message goes to a
// stderr nobody reads, and the user concludes the knowledge base is gone. It
// happened here, and it happened intermittently, because `"command": "node"`
// resolves through PATH and a version manager makes that a coin flip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { diagnoseStartupError, reportStartupFailure } from "../src/preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Diagnosis ───────────────────────────────────────────────────────────────

test("an ABI mismatch is named, with both versions and the way out", () => {
  // Verbatim from the failure on 2026-08-08.
  const err = Object.assign(
    new Error(
      "The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\n" +
      "NODE_MODULE_VERSION 147. This version of Node.js requires\nNODE_MODULE_VERSION 137. " +
      "Please try re-compiling or re-installing the module"
    ),
    { code: "ERR_DLOPEN_FAILED" }
  );

  const d = diagnoseStartupError(err);
  assert.equal(d?.kind, "abi-mismatch");
  assert.match(d!.message, /147/, "the ABI it was built for");
  assert.match(d!.message, /137/, "and the one this node wants");
  assert.match(d!.message, /npm rebuild better-sqlite3/, "what to run");
  assert.match(d!.message, /process\.execPath/, "and how to stop it recurring");
  assert.match(d!.message, /Restart the MCP client/, "a running server keeps the old module");
});

test("the same mismatch is caught without the error code", () => {
  // `bindings` rethrows a plain Error in some paths — matching only on
  // ERR_DLOPEN_FAILED would miss it and print a bare stack trace instead.
  const d = diagnoseStartupError(new Error("was compiled against a different Node.js version"));
  assert.equal(d?.kind, "abi-mismatch");
  assert.match(d!.message, new RegExp(process.version.replace(/\./g, "\\.")), "names the running node");
});

test("a missing dependency and an unreadable database each get their own answer", () => {
  const missing = diagnoseStartupError(
    Object.assign(new Error("Cannot find module 'better-sqlite3'"), { code: "MODULE_NOT_FOUND" })
  );
  assert.equal(missing?.kind, "missing-module");
  assert.match(missing!.message, /npm install/);

  const db = diagnoseStartupError(new Error("SQLITE_CANTOPEN: unable to open database file"));
  assert.equal(db?.kind, "database");
  assert.match(db!.message, /BRAIN_DB/);
});

test("an unrecognised failure is not dressed up as a known one", () => {
  assert.equal(diagnoseStartupError(new Error("something else entirely")), null);
  assert.equal(diagnoseStartupError(null), null);
  assert.equal(diagnoseStartupError(undefined), null);
});

test("reporting always keeps the original error", () => {
  // A diagnosis that swallows the evidence is worse than the stack trace it
  // replaced — the next person debugging it has less to work with, not more.
  const lines: string[] = [];
  reportStartupFailure(new Error("was compiled against a different Node.js version"), (s) => lines.push(s));
  const out = lines.join("\n");
  assert.match(out, /cannot start/);
  assert.match(out, /Original error:/);

  lines.length = 0;
  reportStartupFailure(new Error("wholly unexpected"), (s) => lines.push(s));
  assert.match(lines.join("\n"), /wholly unexpected/, "unknown errors are still printed in full");
});

// ── The doctor ──────────────────────────────────────────────────────────────

test("npm run doctor reports on every area and exits cleanly on a healthy checkout", () => {
  // Pointed at a throwaway database so the check reflects this checkout rather
  // than whatever the developer's real base happens to contain.
  const dir = mkdtempSync(join(tmpdir(), "brain-doctor-"));
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs")], {
      encoding: "utf-8",
      env: { ...process.env, BRAIN_DB: join(dir, "knowledge.db") },
    });
    for (const section of ["Runtime", "Build", "Database", "MCP client configuration", "Hooks"]) {
      assert.match(out, new RegExp(section), `reports on ${section}`);
    }
    assert.match(out, /better-sqlite3 loads under this node/, "the check that matters most");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
