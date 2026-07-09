import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { initDB, createTools } from "./tools.js";
import { embeddingsConfigFromEnv, createEmbedder } from "./embeddings.js";
import { loadVectorIndex } from "./vector.js";
import { registerResources } from "./resources.js";

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

const db = initDB(DB_PATH);

async function main() {
  // Optional hybrid search layer. Both pieces degrade gracefully:
  // - embeddings are OFF unless BRAIN_EMBEDDINGS_URL is set (opt-in, local Ollama)
  // - sqlite-vec failing to load → FTS5-only mode, never a crash
  const embeddingsConfig = embeddingsConfigFromEnv();
  const vector = embeddingsConfig ? await loadVectorIndex(db) : null;
  const embedder = embeddingsConfig ? createEmbedder(embeddingsConfig) : null;

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

main().catch(console.error);
