# Brain MCP — a local knowledge base for AI coding assistants

Brain MCP is a **local MCP (Model Context Protocol) server** that acts as long-term memory for AI coding assistants such as GitHub Copilot Chat, Claude Code, or any other MCP-capable client. It stores lessons, reusable patterns, and project context in a local SQLite database on your machine.

**Key point:** everything stays on your computer. No cloud. No cost. The only (optional) network call is to a **local** embeddings server you run yourself (e.g. Ollama), and it is off by default — see [Hybrid vector search](#hybrid-vector-search-optional).

Features:

- **Hybrid search** — FTS5 keyword search always; plus vector/semantic search (sqlite-vec + local Ollama embeddings) when you opt in, merged with reciprocal rank fusion
- **MCP resources** — browse lessons and project summaries as `brain://` resources, no tool calls needed
- **Export/import** — human-readable markdown or lossless JSON, with content-hash dedupe on import
- **Project scanner** — indexes your code directory's tech stacks from metadata files
- **Soft-delete** — archived lessons are never lost, always restorable

## Architecture

```
MCP client (VS Code Copilot Chat, Claude Code, ...)
    │
    ├── Sends JSON-RPC over stdio ──→ brain-mcp (Node.js process)
    │                                      │
    │                                      ├── SQLite DB (knowledge.db)
    │                                      │   ├── lessons            (lessons / insights)
    │                                      │   ├── lessons_fts        (full-text search, FTS5)
    │                                      │   ├── lessons_vec        (vector index, sqlite-vec — optional)
    │                                      │   ├── lesson_embeddings  (embedding bookkeeping)
    │                                      │   ├── lessons_archive    (soft-deleted lessons)
    │                                      │   ├── project_index      (project scans)
    │                                      │   └── patterns           (architectural patterns)
    │                                      │
    │                                      ├── File system scanner
    │                                      │   └── Reads your code directory
    │                                      │       (package.json, README, composer.json)
    │                                      │
    │                                      └── OPTIONAL, opt-in via BRAIN_EMBEDDINGS_URL:
    │                                          local embeddings server (Ollama)
    │                                          http://localhost:11434 — the ONLY network call
    │
    ├── The client uses the brain_* tools like any other MCP tool
    └── ...and can browse brain://lessons/{id} & brain://projects/{name} resources
```

### Files

| File | Role |
|------|------|
| `src/index.ts` | Server entry point — wires tools + resources to the MCP stdio transport |
| `src/tools.ts` | Core logic — DB setup, project scanner, the 11 MCP tools |
| `src/embeddings.ts` | Optional embeddings client (Ollama) + reciprocal rank fusion |
| `src/vector.ts` | sqlite-vec vector index (loads the extension, degrades gracefully) |
| `src/resources.ts` | MCP resources: `brain://lessons/{id}`, `brain://projects/{name}` |
| `tests/*.test.ts` | Test suites (`node:test`, temp DBs, fixture dirs, mocked embeddings HTTP) |
| `dist/index.js` | Compiled JS (what your MCP client runs) |
| `data/knowledge.db` | SQLite database with all knowledge (WAL mode, gitignored) |
| `package.json` | Dependencies: MCP SDK, better-sqlite3, sqlite-vec, zod (all pinned exact) |
| `tsconfig.json` | TypeScript config (ES2022, strict) |

### Dependencies (minimal, pinned to exact versions)

- `@modelcontextprotocol/sdk` — the official MCP protocol implementation
- `better-sqlite3` — native SQLite driver (fast, no async overhead)
- `sqlite-vec` — SQLite vector search extension (prebuilt binaries; optional at runtime — if it can't load on your platform, brain-mcp runs FTS5-only)
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
| `BRAIN_EMBEDDINGS_URL` | *(unset — embeddings OFF)* | Base URL of a **local** Ollama-compatible embeddings server, e.g. `http://localhost:11434`. Setting this is the opt-in switch for hybrid vector search — and the only way brain-mcp ever makes a network call. |
| `BRAIN_EMBEDDINGS_MODEL` | `nomic-embed-text` | Embedding model to request from that server |
| `BRAIN_EMBEDDINGS_TIMEOUT_MS` | `4000` | Timeout per embeddings request (AbortSignal) |

## Hybrid vector search (optional)

By default `brain_recall` is pure SQLite FTS5 (keyword search, zero network). If you run [Ollama](https://ollama.com) locally you can add semantic search on top:

```bash
ollama pull nomic-embed-text          # one-time, ~270 MB
export BRAIN_EMBEDDINGS_URL=http://localhost:11434
# optional: export BRAIN_EMBEDDINGS_MODEL=nomic-embed-text
```

(or put those in the `env` block of your MCP client config). What changes:

- `brain_learn` embeds each new lesson on write (calls `POST /api/embeddings` on your local Ollama). If Ollama is down, the lesson is **saved anyway** and marked unembedded.
- `brain_recall` runs **both** retrievers — FTS5 and KNN over the sqlite-vec index — and merges them with reciprocal rank fusion (k=60). Each hit is annotated with which retriever(s) found it (`matched: fts+vector`). If the embeddings server is unreachable, recall **silently falls back to FTS5-only** — it never fails because embeddings are down.
- `brain_reindex` batch-embeds any backlog of unembedded lessons (`force: true` rebuilds the whole index — use after switching models).
- `brain_status` shows the embeddings mode (disabled / enabled / enabled-but-unreachable) and embedded/unembedded counts.

Embeddings are stored in a `vec0` virtual table (sqlite-vec) inside the same `knowledge.db`. If the sqlite-vec extension cannot load on your platform, brain-mcp logs one warning and keeps running FTS5-only — the vector layer can never crash the server.

**Endpoint contract:** brain-mcp calls the classic Ollama embeddings route `POST {BRAIN_EMBEDDINGS_URL}/api/embeddings` with `{"model": ..., "prompt": ...}` and expects `{"embedding": [...]}`. Anything that speaks this API works (it does not use the OpenAI-compatible route).

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

## The 11 tools

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

### 9. `brain_reindex` — (re)build the vector index

Only useful with embeddings enabled. Embeds every lesson that has no vector yet (e.g. saved while Ollama was down, or imported). `force: true` drops the index and re-embeds everything — required after changing `BRAIN_EMBEDDINGS_MODEL`. Reports progress and aborts early if the endpoint keeps failing.

```js
brain_reindex({})            // embed the backlog
brain_reindex({ force: true }) // full rebuild
```

### 10. `brain_export` — export the knowledge base

- `format: "markdown"` — human-readable, lessons grouped by category (plus patterns)
- `format: "json"` — lossless, re-importable with `brain_import`
- With `path` — writes the file **inside the data directory only** (path-validated, symlink-safe; escaping paths are refused)
- Without `path` — returns the export inline, capped at 64 KB

```js
brain_export({ format: "json", path: "brain-backup.json" })
```

### 11. `brain_import` — import a JSON export

Reads a `brain_export` JSON file (must live inside the data directory) and inserts its lessons and patterns. **Duplicates are skipped by SHA-256 content hash**, so importing the same file twice is a no-op. Imported lessons are not embedded yet — run `brain_reindex` afterwards if you use hybrid search.

```js
brain_import({ path: "brain-backup.json" })
```

## MCP resources — browse without tool calls

Besides tools, brain-mcp exposes the knowledge base as **MCP resources** (`resources/list` + `resources/read`), so clients can browse it like documents:

| URI | Content |
|-----|---------|
| `brain://lessons/{id}` | One lesson as markdown (content, severity, tags, project, source) |
| `brain://projects/{name}` | Project summary: path, stack, status, and all related lessons |

Clients that support resource browsing (Claude Code `@`-mentions, VS Code, MCP Inspector) list up to the 200 most recent lessons and all indexed projects.

## Security model

### ⚠️ The ONE network call (opt-in, off by default)

brain-mcp makes **zero** network calls out of the box. There is exactly **one** code path that can perform HTTP requests: the optional embeddings client, and it only exists if **you** set `BRAIN_EMBEDDINGS_URL`. When set, brain-mcp POSTs lesson/query text to `{BRAIN_EMBEDDINGS_URL}/api/embeddings` — intended to be a **local Ollama instance on your own machine** (`http://localhost:11434`). Nothing else is ever contacted, no telemetry, no cloud. Unset the variable and the network code path is dead again. Every request carries a short abort timeout, and every failure degrades to local-only FTS5 behavior.

### What brain-mcp does

- Reads files ONLY from your code directory (metadata: `package.json`, `README.md`, `composer.json`)
- The scanner is confined to the scan root: symlinked directories are skipped, and every file read
  resolves symlinks first and refuses anything that lands outside `BRAIN_CODE_DIR`
- File reads are capped at 1 MiB per file — a giant file cannot exhaust memory
- Writes ONLY to its SQLite database (local file) — plus `brain_export` files, which are
  path-validated (symlinks resolved) and confined to the data directory; escaping paths and
  overwriting the database file are refused. `brain_import` reads are confined the same way
  and size-capped
- Communicates ONLY over stdio (stdin/stdout with the client)
- No HTTP server, no open ports
- Sends nothing to the internet by default — the only network code is the opt-in local
  embeddings call described above, gated on `BRAIN_EMBEDDINGS_URL`
- All SQL queries use prepared statements (parameterized) — no string-interpolated SQL
- Every tool's input is validated with Zod (length caps on all strings, bounded `limit`, enum categories)
- LIKE queries use an ESCAPE clause (no SQL injection via wildcards)
- `brain_forget` requires an explicit `confirm: true` (Zod-enforced) — without it you only get a preview
- The vector layer is fail-safe: if sqlite-vec can't load or the embeddings server is down,
  everything keeps working FTS5-only — the server never crashes because of it
- All dependencies are pinned to exact versions; CI runs build + tests on Node 20 and 22

### What brain-mcp does NOT do

- Does not read source code contents (only project metadata)
- Has no internet access unless you opt into local embeddings — and then it talks only to the
  one URL you configured (your own machine)
- Does not store passwords, tokens, or API keys
- Does not modify any files in your projects (exports go to its own data directory)
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

Or ask the agent to run `brain_export({ format: "json", path: "backup.json" })` — the JSON lands in `data/` and can be re-imported (with dedupe) via `brain_import` on any machine.

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
No. Zero network calls by default — everything is local, stdio only. If you opt into hybrid search via `BRAIN_EMBEDDINGS_URL`, lesson text is sent to that one URL, which is meant to be an Ollama server running on your own machine.

**Q: Do I need Ollama / embeddings?**
No. Without them `brain_recall` uses SQLite FTS5 keyword search, exactly as before. Embeddings only add semantic ("fuzzy meaning") matching on top.

**Q: What if the database gets corrupted?**
SQLite in WAL mode is very resilient. Worst case — delete the DB file and start fresh.

**Q: Can I move brain to another machine?**
Yes — copy the whole `brain-mcp/` folder and update the paths in your MCP client config.

**Q: Does the assistant use brain automatically?**
Yes, when it deems it useful. You can also ask explicitly: *"check brain"*.

## License

MIT — see [LICENSE](LICENSE).
