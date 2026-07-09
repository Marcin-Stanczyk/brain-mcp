# Brain MCP — a local knowledge base for AI coding assistants

Brain MCP is a **local MCP (Model Context Protocol) server** that acts as long-term memory for AI coding assistants such as GitHub Copilot Chat, Claude Code, or any other MCP-capable client. It stores lessons, reusable patterns, and project context in a local SQLite database on your machine.

**Key point:** everything stays on your computer. No cloud. No API calls. No cost.

## Architecture

```
MCP client (VS Code Copilot Chat, Claude Code, ...)
    │
    ├── Sends JSON-RPC over stdio ──→ brain-mcp (Node.js process)
    │                                      │
    │                                      ├── SQLite DB (knowledge.db)
    │                                      │   ├── lessons          (lessons / insights)
    │                                      │   ├── lessons_fts      (full-text search, FTS5)
    │                                      │   ├── lessons_archive  (soft-deleted lessons)
    │                                      │   ├── project_index    (project scans)
    │                                      │   └── patterns         (architectural patterns)
    │                                      │
    │                                      └── File system scanner
    │                                          └── Reads your code directory
    │                                              (package.json, README, composer.json)
    │
    └── The client uses the brain_* tools like any other MCP tool
```

### Files

| File | Role |
|------|------|
| `src/index.ts` | Server entry point — wires the tools to the MCP stdio transport |
| `src/tools.ts` | Core logic — DB setup, project scanner, the 8 MCP tools |
| `tests/brain.test.ts` | Test suite (`node:test`, runs against a temp DB and fixture dir) |
| `dist/index.js` | Compiled JS (what your MCP client runs) |
| `data/knowledge.db` | SQLite database with all knowledge (WAL mode, gitignored) |
| `package.json` | Dependencies: MCP SDK, better-sqlite3, zod (all pinned to exact versions) |
| `tsconfig.json` | TypeScript config (ES2022, strict) |

### Dependencies (minimal, pinned to exact versions)

- `@modelcontextprotocol/sdk` — the official MCP protocol implementation
- `better-sqlite3` — native SQLite driver (fast, no async overhead)
- `zod` — tool input validation

Requires Node.js >= 20.

## Installation

```bash
git clone <this repo> brain-mcp
cd brain-mcp
npm install
npm run build
```

The database is created automatically on first run (default: `data/knowledge.db` inside the repo).

### Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRAIN_CODE_DIR` | `~/code` | Directory that `brain_scan_projects` scans for projects |
| `BRAIN_DB` | `<repo>/data/knowledge.db` | Path to the SQLite database file |

### VS Code (Copilot Chat)

Add the server to your MCP config (`mcp.json` — open it via **Command Palette → "MCP: Open User Configuration"**):

```jsonc
{
  "servers": {
    "brain": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/brain-mcp/dist/index.js"],
      "env": {
        "BRAIN_CODE_DIR": "/absolute/path/to/your/code/folder"
      }
    }
  }
}
```

Restart the MCP server (or VS Code) and the `brain_*` tools appear in Copilot Chat automatically.

### Generic MCP clients (Claude Code, Claude Desktop, etc.)

Any client that supports stdio MCP servers works. For example, with Claude Code:

```bash
claude mcp add brain -e BRAIN_CODE_DIR=$HOME/code -- node /absolute/path/to/brain-mcp/dist/index.js
```

Or in a JSON-based client config:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/absolute/path/to/brain-mcp/dist/index.js"],
      "env": { "BRAIN_CODE_DIR": "/home/you/code" }
    }
  }
}
```

## The 8 tools

### 1. `brain_learn` — store a lesson

Saves an insight, gotcha, or problem solution to the database.

**When the agent should use it:** after fixing a hard bug, discovering a gotcha, or finding the best approach to something.

```js
brain_learn({
  content: "Cloudflare D1 does not support ALTER TABLE ADD COLUMN IF NOT EXISTS — wrap it in try/catch",
  category: "gotcha",
  tags: ["cloudflare", "d1", "sql"],
  project: "my-webapp",
  severity: "important"
})
```

**Categories:** `bug-fix`, `architecture`, `performance`, `security`, `deployment`, `tooling`, `pattern`, `gotcha`, `best-practice`, `client`, `seo`, `i18n`, `testing`, `design`, `marketing`, `sales`, `workflow`, `business`, `financial`, `market`, `client-feedback`

**Severity:** `critical` (never forget), `important`, `info`, `tip`

### 2. `brain_recall` — search the knowledge base

Full-text search across the whole database, with optional category and project filters.

**When the agent should use it:** before starting work on a task — check for known issues and gotchas.

```js
brain_recall({ query: "cloudflare deployment", project: "my-webapp" })
```

### 3. `brain_scan_projects` — index your code directory

Automatically indexes every project in your code directory (`BRAIN_CODE_DIR`, default `~/code`) — detects the tech stack from `package.json`, `composer.json`, `Dockerfile`, etc.

```js
brain_scan_projects({})
// → Scanned 12 projects: my-webapp (React, Vite, Tailwind), my-api (Hono, CF Workers)...
```

### 4. `brain_project_context` — project context

Fetches the full context of one project: stack, description, all lessons, and patterns.

```js
brain_project_context({ project: "my-webapp" })
```

### 5. `brain_store_pattern` — store a pattern

Saves a reusable architectural pattern with a code example.

```js
brain_store_pattern({
  name: "Pages Functions auth middleware",
  pattern_type: "auth",
  description: "Bearer token validation in an onRequest handler",
  example: "export const onRequest: PagesFunction = async (ctx) => { ... }",
  projects: ["my-webapp"]
})
```

### 6. `brain_status` — dashboard

How many lessons, patterns, and projects are stored, broken down by category and project.

### 7. `brain_forget` — archive knowledge (soft-delete)

Archives outdated or incorrect lessons into `lessons_archive` — nothing is permanently lost. Requires `confirm: true` as a safety check; calling without it shows a preview of what would be archived.

### 8. `brain_restore` — restore archived lessons

Lists archived lessons and restores them back to the active set by ID.

## Security model

### What brain-mcp does

- Reads files ONLY from your code directory (metadata: `package.json`, `README.md`, `composer.json`)
- The scanner is confined to the scan root: symlinked directories are skipped, and every file read
  resolves symlinks first and refuses anything that lands outside `BRAIN_CODE_DIR`
- File reads are capped at 1 MiB per file — a giant file cannot exhaust memory
- Writes ONLY to its SQLite database (local file)
- Communicates ONLY over stdio (stdin/stdout with the client)
- No HTTP server, no open ports
- Sends nothing to the internet — the code imports no network module at all
  (`fs`, `path`, `os`, `url`, SQLite, Zod, and the MCP stdio transport only)
- All SQL queries use prepared statements (parameterized) — no string-interpolated SQL
- Every tool's input is validated with Zod (length caps on all strings, bounded `limit`, enum categories)
- LIKE queries use an ESCAPE clause (no SQL injection via wildcards)
- `brain_forget` requires an explicit `confirm: true` (Zod-enforced) — without it you only get a preview
- All dependencies are pinned to exact versions; CI runs build + tests on Node 20 and 22

### What brain-mcp does NOT do

- Does not read source code contents (only project metadata)
- Has no internet access
- Does not store passwords, tokens, or API keys
- Does not modify any files in your projects
- Does not run any system commands

### The database

- `data/` is gitignored — your knowledge never ends up in the repo
- SQLite WAL mode — safe for concurrent reads
- Backup: just copy the `knowledge.db` file

## Working with brain effectively

### Workflow: session start

1. **New chat** → brain is automatically available as an MCP tool
2. Tell the agent: *"Check brain_project_context for my-webapp and brain_recall for known issues before starting"*
3. The agent pulls the context and avoids repeating past mistakes

### Workflow: during work

- After solving a hard problem: *"Save this to brain as a lesson"*
- Before a complex task: *"Check brain for anything about [topic]"*

### Workflow: session end

- *"Save the key takeaways from this session to brain"*

### Prompt examples

| You want to... | Say... |
|----------------|--------|
| Check known issues | *"brain_recall: deployment issues my-webapp"* |
| Store a lesson | *"Save to brain: D1 bindings require wrangler.toml config, not env vars"* |
| See what's stored | *"Show brain_status"* |
| Get project context | *"Give me the full brain_project_context for my-webapp"* |
| Index projects | *"Run brain_scan_projects"* |
| Remove a wrong lesson | *"brain_forget lesson #42"* |

### Pro tips

1. **You don't have to call tools manually** — the agent decides when to use `brain_*` if you describe what you need in natural language.

2. **Quality > quantity** — 50 valuable lessons beat 500 trivial ones. Store:
   - Solutions to problems that took >15 minutes
   - Gotchas specific to your tools
   - Architectural patterns you keep repeating
   - Decisions and their rationale (ADR-style)

3. **Severity matters:**
   - `critical` — could break production
   - `important` — will save hours of work
   - `info` — useful, not critical
   - `tip` — nice to know

## Maintenance

### Backup

```bash
cp data/knowledge.db ~/Backups/brain-$(date +%Y%m%d).db
```

For automated backups to a USB drive on macOS, see `scripts/backup-to-usb.sh` and the launchd template `scripts/com.example.brain-mcp-backup.plist`.

### Rebuild after code changes

```bash
npm run build
# Your MCP client restarts the server automatically (or restart it manually)
```

### Reset the database (start fresh)

```bash
rm data/knowledge.db
# The database is recreated on the next server start
```

### Smoke test

```bash
npm run build
node scripts/smoke-test.cjs
```

## FAQ

**Q: Does brain-mcp slow down my editor?**
Not noticeably. The server starts in <100 ms, uses ~30 MB RAM, and SQLite queries take <1 ms.

**Q: Does my data go to the cloud?**
No. Zero network calls. Everything is local, stdio only.

**Q: What if the database gets corrupted?**
SQLite in WAL mode is very resilient. Worst case — delete the DB file and start fresh.

**Q: Can I move brain to another machine?**
Yes — copy the whole `brain-mcp/` folder and update the paths in your MCP client config.

**Q: Does the assistant use brain automatically?**
Yes, when it deems it useful. You can also ask explicitly: *"check brain"*.

## License

MIT — see [LICENSE](LICENSE).
