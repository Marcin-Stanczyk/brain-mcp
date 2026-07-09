import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { initDB, createTools } from "./tools.js";

// Directory that gets scanned for projects (BRAIN_CODE_DIR, legacy CODE_DIR, default: ~/code)
const CODE_DIR = process.env.BRAIN_CODE_DIR || process.env.CODE_DIR || join(homedir(), "code");
// SQLite database location (BRAIN_DB, default: <this package>/data/knowledge.db)
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.BRAIN_DB || join(PACKAGE_ROOT, "data/knowledge.db");

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "brain-mcp",
  version: "1.0.0",
});

const db = initDB(DB_PATH);

for (const tool of createTools(db, CODE_DIR)) {
  server.tool(tool.name, tool.description, tool.schema, tool.handler);
}

// ── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🧠 Brain MCP server running");
}

main().catch(console.error);
