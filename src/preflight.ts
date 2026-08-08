// Turning a startup crash into an instruction.
//
// better-sqlite3 is a native module: compiled against one Node ABI, it refuses
// to load under another. With a version manager in play, `"command": "node"` in
// an MCP config resolves through PATH, which depends on whichever shell happened
// to launch the client — so the server works, or does not, by coincidence.
//
// The failure is bad out of proportion to its cause. It happens while the module
// graph is being evaluated, before the MCP handshake, so the client never sees a
// server at all and reports a connection problem. The actual message —
// NODE_MODULE_VERSION 147 versus 137 — goes to a stderr nobody is reading, and
// the user is left believing the knowledge base is unreachable.
//
// Everything here is a pure function of an error, so the messages can be tested
// rather than hoped for.

export interface StartupDiagnosis {
  /** Short label for what went wrong. */
  kind: "abi-mismatch" | "missing-module" | "database" | "unknown";
  /** What to print. Ends with something the reader can do. */
  message: string;
}

const ABI_HINT =
  "The Node that runs the server must be the Node the module was built for.\n" +
  "  1. Point your MCP config at an absolute path instead of bare `node`:\n" +
  "       node -p \"process.execPath\"      # the path to pin\n" +
  "  2. Rebuild against it:\n" +
  "       npm rebuild better-sqlite3     # or: npm install better-sqlite3\n" +
  "  3. Restart the MCP client fully — a running server keeps the old module.";

/**
 * Explain a startup failure, or return null when it is not one this knows.
 *
 * Deliberately matches on the error text as well as the code: the same mismatch
 * surfaces as ERR_DLOPEN_FAILED, as a bare Error from `bindings`, and as a
 * MODULE_NOT_FOUND when a prebuilt was never fetched.
 */
export function diagnoseStartupError(err: unknown): StartupDiagnosis | null {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const code = (err as { code?: string } | null)?.code ?? "";

  if (/NODE_MODULE_VERSION|different Node\.js version/i.test(message) || code === "ERR_DLOPEN_FAILED") {
    // Node wraps this message across lines, so nothing here may assume that two
    // words printed next to each other are separated by a space.
    const versions = message.match(/NODE_MODULE_VERSION\s+(\d+)[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/);
    const detail = versions
      ? `The native module was built for Node ABI ${versions[1]}; this Node (${process.version}) wants ${versions[2]}.`
      : `A native module refused to load under this Node (${process.version}).`;
    return {
      kind: "abi-mismatch",
      message: `brain-mcp cannot start: ${detail}\n\n${ABI_HINT}`,
    };
  }

  if (code === "MODULE_NOT_FOUND" || /Cannot find module/i.test(message)) {
    return {
      kind: "missing-module",
      message:
        `brain-mcp cannot start: a dependency is missing (${message}).\n\n` +
        "  npm install     # in the brain-mcp directory\n" +
        "  npm run build",
    };
  }

  if (/SQLITE_|unable to open database|no such table/i.test(message)) {
    return {
      kind: "database",
      message:
        `brain-mcp cannot start: the database could not be opened (${message}).\n\n` +
        "  Check BRAIN_DB, and that the data directory exists and is writable.\n" +
        "  A missing database is created on startup; an unreadable one is not.",
    };
  }

  return null;
}

/**
 * Print the best explanation available for a fatal startup error.
 *
 * Always says something actionable, and always includes the original error —
 * a diagnosis that swallows the evidence is worse than the raw stack trace it
 * replaced.
 */
export function reportStartupFailure(err: unknown, log: (s: string) => void = console.error): void {
  const diagnosed = diagnoseStartupError(err);
  if (diagnosed) {
    log(`\n❌ ${diagnosed.message}\n`);
    log(`Original error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return;
  }
  log(`\n❌ brain-mcp failed to start.`);
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
}
