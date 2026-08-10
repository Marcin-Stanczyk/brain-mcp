import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { embeddingsConfigFromEnv, createEmbedder, withCircuitBreaker } from "./embeddings.js";
import { loadVectorIndex } from "./vector.js";
import { registerResources } from "./resources.js";
import { reportStartupFailure } from "./preflight.js";

// Directory that gets scanned for projects (BRAIN_CODE_DIR, legacy CODE_DIR, default: ~/code)
const CODE_DIR = process.env.BRAIN_CODE_DIR || process.env.CODE_DIR || join(homedir(), "code");
// SQLite database location (BRAIN_DB, default: <this package>/data/knowledge.db)
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.BRAIN_DB || join(PACKAGE_ROOT, "data/knowledge.db");

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "brain-mcp",
  version: "1.1.0",
});

async function main() {
  // Imported here rather than at the top on purpose. ./tools.js pulls in
  // better-sqlite3, a native module that throws while the module graph is being
  // evaluated when it was built for a different Node ABI — before any handler of
  // ours could run, so the crash reaches the user as "the server would not
  // connect". Inside the try, it reaches them as instructions.
  const { initDB, createTools } = await import("./tools.js");
  const db = initDB(DB_PATH);

  // Optional hybrid search layer. Both pieces degrade gracefully:
  // - embeddings are OFF unless BRAIN_EMBEDDINGS_URL is set (opt-in, local Ollama)
  // - sqlite-vec failing to load → FTS5-only mode, never a crash
  const embeddingsConfig = embeddingsConfigFromEnv();
  const vector = embeddingsConfig ? await loadVectorIndex(db) : null;
  // Wrapped so a backend that hangs costs one timeout for the session rather
  // than one per question — see withCircuitBreaker.
  const embedder = embeddingsConfig
    ? withCircuitBreaker(createEmbedder(embeddingsConfig), {
        onOpen: (failures) =>
          console.error(
            `⚠️ brain-mcp: embeddings backend failed ${failures}× in a row — pausing vector search for a minute, lexical retrievers continue.`
          ),
      })
    : null;

  for (const tool of createTools(db, CODE_DIR, {
    dataDir: dirname(DB_PATH),
    vector,
    embedder,
    embeddingsConfig,
  })) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }

  registerResources(server, db);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `🧠 Brain MCP server running${embeddingsConfig ? (vector ? ` (hybrid search: ${embeddingsConfig.model})` : " (FTS5-only: sqlite-vec unavailable)") : ""}`
  );
}

main().catch((err) => {
  reportStartupFailure(err);
  process.exitCode = 1;
});
