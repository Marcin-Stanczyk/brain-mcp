# Brain MCP — a local knowledge base for AI coding assistants

Brain MCP is a **local MCP (Model Context Protocol) server** that acts as long-term memory for AI coding assistants such as GitHub Copilot Chat, Claude Code, or any other MCP-capable client. It stores lessons, reusable patterns, and project context in a local SQLite database on your machine.

**Key point:** everything stays on your computer. No cloud. No cost. The only (optional) network call is to a **local** embeddings server you run yourself (e.g. Ollama), and it is off by default — see [Hybrid vector search](#hybrid-vector-search-optional).

Features:

- **Search you can ask in a sentence** — five lexical retrievers over whole lessons and over passages, merged by weighted reciprocal rank fusion; plus vector search (sqlite-vec + a local embeddings server) when you opt in
- **Measured, not asserted** — a committed corpus of judged queries, scored by `npm run eval` and enforced in CI, so a ranking change produces a number rather than an impression
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
    │                                      │   ├── lesson_chunks      (passages — one paragraph each)
    │                                      │   ├── lesson_chunks_fts  (passage full-text index, FTS5)
    │                                      │   ├── chunks_vec         (passage vectors, sqlite-vec — optional)
    │                                      │   ├── chunk_embeddings   (embedding bookkeeping)
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
| `src/tools.ts` | Tool definitions and presentation — DB setup, project scanner, the 12 MCP tools |
| `src/query.ts` | Turns a question into FTS5 queries — tokenizing, stopwords, stemming |
| `src/search.ts` | Retrieval — runs the retrievers, fuses them, returns rows (no formatting) |
| `src/chunk.ts` | Splits lessons into passages and keeps that index in step |
| `src/scope.ts` | Proposes lessons that are about a tool rather than a project |
| `src/metrics.ts` | recall@k, precision@k, MRR — so ranking changes produce numbers |
| `src/preflight.ts` | Turns a startup crash (ABI mismatch, missing module) into instructions |
| `src/backfill.ts` | Embeds the vector backlog on startup, without blocking the transport |
| `src/embeddings.ts` | Optional embeddings client (Ollama) + weighted reciprocal rank fusion |
| `src/vector.ts` | sqlite-vec vector index (loads the extension, degrades gracefully) |
| `src/resources.ts` | MCP resources: `brain://lessons/{id}`, `brain://projects/{name}` |
| `hooks/session_context.py` | `SessionStart` hook — injects this project's lessons (reads SQLite read-only) |
| `hooks/relevant_lessons.py` | `UserPromptSubmit` hook — searches on the prompt, when the task is finally known |
| `hooks/_brain_db.py` | Shared DB access + the tokenizer the hooks and `src/query.ts` agree on |
| `hooks/capture_lesson.py` | `Stop` hook — asks once for a lesson, naming the incidents that were recorded |
| `hooks/incident_watch.py` | `PostToolUse` hook — catches undo commands and repeat failures as they happen |
| `scripts/install-hooks.mjs` | Registers/removes the hooks in Claude Code settings (merging, idempotent) |
| `scripts/import-claude-memory.py` | Imports Claude Code's `memory/*.md` files into the indexed store |
| `scripts/doctor.mjs` | `npm run doctor` — checks node ABI, build, indexes, MCP config, hooks |
| `scripts/eval.mjs` | `npm run eval` — retrieval quality report against the judged query set |
| `scripts/sweep.mjs` | `npm run eval:sweep` — derives the vector similarity floor by measuring it |
| `hooks/_brain_vec.py` | Semantic search for the hooks — embeddings, vec0, a file-backed breaker |
| `tests/eval/hook_eval.py` | `npm run eval:hook` — the hook's ranking, on the tool's judged queries |
| `tests/eval/` | Committed fixture corpus + judged queries, with CI thresholds |
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

### Recommended setup — read this first

A knowledge base only pays off if something **writes to it** and something **reads it back**. Register the MCP server alone and you get a passive store: the tools exist, but nothing reminds anyone to use them. In practice that means lessons trickle in at well under one per day and the agent starts most sessions blind to what it already learned.

Three steps close the loop:

```bash
# 1 — build
git clone <this repo> brain-mcp
cd brain-mcp
npm install

# 2 — build + register the lifecycle hooks in Claude Code
npm run setup

# 3 — register the MCP server itself (see the client sections below)
claude mcp add brain-mcp -- node "$(pwd)/dist/index.js"
```

The database is created automatically on first run (default: `data/knowledge.db` inside the repo).

### What the hooks do

`npm run setup` (or `npm run hooks:install`) registers these in `~/.claude/settings.json`:

| Hook | Script | Effect |
|------|--------|--------|
| `SessionStart` | `hooks/session_context.py` | Reads the database directly and injects this project's lessons — criticals first — before the first token. Also injects `critical` lessons from `BRAIN_HOOK_GLOBAL_PROJECTS` regardless of directory, and flags when a [graphify](https://github.com/Graphify-Labs/graphify) code graph exists so the agent queries the graph instead of grepping — but only after verifying the graph is current, by comparing every indexed file's mtime against the graph's. A stale index is worse than none: this hook is what tells the agent to trust it over grep, so it is also what has to withdraw that advice. |
| `UserPromptSubmit` | `hooks/relevant_lessons.py` | Searches the FTS5 index for lessons that match **what you just asked**, across every project, and injects the top three in full. This is the hook that makes stored knowledge arrive at the moment it can change a decision — see [Why relevance, and why not at session start](#why-relevance-and-why-not-at-session-start). Stays silent when nothing matches, never repeats a lesson within a session, and records that a lesson was shown. |
| `PostToolUse` / `PostToolUseFailure` | `hooks/incident_watch.py` | Watches Bash for the moment a mistake becomes visible: an undo command (`git checkout --`, `restore`, `reset --hard`, `revert`, `clean`, `stash drop`, `commit --amend`, restoring from a `.bak`/`.backup`/`.orig` file — **restoring**, not creating one; that distinction is positional, not textual, and two regex attempts got it wrong) or the same command failing repeatedly. Undos prompt for a lesson **immediately**, while the cause is still known; repeat failures are logged silently. |
| `Stop` | `hooks/capture_lesson.py` | If the session wrote nothing, asks **once** for a lesson — naming the specific incidents `incident_watch` recorded, rather than asking "did you learn anything". |

### Why relevance, and why not at session start

`SessionStart` runs before anybody knows what the session is about. The best it
can do is guess, and for a long time the guess was: the twelve most recent
lessons of the open project, severity first, truncated to 220 characters each.
Measured against 297 stored lessons in August 2026, that guess meant:

| | |
|---|---|
| Lessons that could ever be seen outside their own project | **6 of 297** (2%) |
| Lessons a session in the largest project could see | **12 of 124** |
| `critical` lessons in that project | 60 — so the twelve slots never reached `important` or `info` at all |
| Ranking | severity, then `updated_at DESC`. Recency. Never relevance. |
| Recorded uses | none — nothing in the schema said a lesson had ever been read |

Writing was enforced by a **blocking** `Stop` hook; reading was one preview at
the start and nothing afterwards. The system was very good at capturing lessons
and close to inert at recalling them.

No amount of tuning `SessionStart` fixes that, because the problem is timing.
`UserPromptSubmit` is the first moment the task is known, so that is where the
search belongs — and the search itself already existed: `brain_recall` does it
well, it was simply left to the model's discretion, and a model does not know
what it does not know.

Two consequences worth stating plainly:

- **The current project wins ties, it does not win outright.** A lesson about a
  bash trap learned in one repository is precisely the lesson that prevents the
  same mistake in another, and project-scoped recall is what made it invisible.
- **Silence is a feature.** The hook stays quiet unless something genuinely
  matches. A memory system that answers every prompt with three vaguely related
  paragraphs teaches people to skim past the block that will one day matter.

Lessons now carry `shown_count` and `last_shown_at`, so "is any of this being
used?" is a query rather than an impression. Nothing writes `updated_at` when
they change — showing a lesson must not make it look freshly written, or it
would float to the top of the recency-ordered session digest and stay there.

### Why capture at the moment, not at the end

The most valuable lesson is a mistake made and corrected mid-session, and that is
exactly the one a session-end prompt misses. By the time the turn ends the
evidence has scrolled away and the model reconstructs it from memory — or the
session already recorded something unrelated, so the prompt never fires at all.

`incident_watch.py` optimises for precision over recall, because a hook that
nags gets disabled. It only fires on undo commands, where the base rate of "an
actual mistake happened" is close to 1 — nobody reverts unless something went
wrong. Routine commands (`git status`, `git add`, `git diff`, `npm test`) stay
silent. A single failed command stays silent too; it is usually a typo, not a
lesson. Both prompts ask for the same four-part shape — PROBLEM, CAUSE, FIX,
VERIFY — so the recorded lesson carries the mechanism and the check that would
catch it earlier, not just a description of the symptom.

Hooks cannot call MCP tools — a hook is a separate process, MCP is JSON-RPC inside the agent's session. So `SessionStart` opens the SQLite file read-only. That is also cheaper than a tool call: zero model round-trips, and the knowledge is simply present from the start.

All four hooks **fail open**. Any error exits 0 with no output, so a broken hook can never stop a session from starting or trap one in a loop. The `Stop` hook additionally guards against loops four ways: it respects `stop_hook_active`, blocks at most once per session (tracked by a per-session marker), stays quiet for sessions under `BRAIN_HOOK_MIN_SECONDS`, and never asks when the lesson count already grew.

### Cross-cutting lessons

A lesson is stored against a project, and `SessionStart` normally injects only
the current project's. That leaves a gap: a `critical` lesson about tooling —
"this command silently overwrites a newer file" — is filed under whichever
project was open when it was learned, and is then invisible in every other
project, including the ones where the mistake would recur.

Nominate one or more projects whose criticals should follow you everywhere:

```bash
npm run hooks:install -- --global-projects tooling
# or several:  --global-projects tooling,infra
```

The value is written into the hook command in *your* `settings.json`, not into
this repo — which projects are cross-cutting is a property of your knowledge
base, not of this engine. Those entries are tagged `[category · project]` in the
injection so they are not mistaken for something local, and capped at
`BRAIN_HOOK_MAX_GLOBAL`.

```bash
npm run hooks:status      # show what is registered, write nothing
npm run hooks:install     # idempotent — re-run after moving the repo
npm run hooks:uninstall   # clean removal
node scripts/install-hooks.mjs --project   # register in ./.claude/settings.json instead
```

The installer **merges** into your settings: it identifies its own entries by the absolute path to this repo's `hooks/` directory, so it leaves any other hooks you have alone, and `--uninstall` removes exactly its own. It backs up `settings.json` before the first change and never touches your database.

> Setup is a deliberate opt-in rather than an automatic `postinstall`. `npm run setup` writes to `~/.claude/settings.json` — a file outside this project — and a package that modifies your global agent configuration as a side effect of `npm install` is not a package you should trust. One command, run knowingly.

### Tuning the hooks (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRAIN_HOOK_MAX_LESSONS` | `12` | Lessons injected at session start |
| `BRAIN_HOOK_MAX_CHARS` | `4000` | Hard cap on the injected block, so the hook can never balloon your context |
| `BRAIN_HOOK_MIN_SECONDS` | `180` | Sessions shorter than this are never asked for a lesson |
| `BRAIN_HOOK_GLOBAL_PROJECTS` | *(empty — off)* | Comma-separated projects whose `critical` lessons are injected in every session, whatever the directory. Tooling traps belong here: a lesson filed under one project is invisible in the others, including the ones where the mistake would recur. Set it with `--global-projects` at install time (see below) rather than editing this repo. |
| `BRAIN_HOOK_MAX_GLOBAL` | `4` | Cap on those cross-cutting entries |

Typical cost of the `SessionStart` injection is 600–850 tokens on a project with real history — roughly one avoided re-investigation pays for a month of it.

### Optional — import existing Claude Code memory

Claude Code writes its own per-project memories as markdown under `~/.claude/projects/<project>/memory/`. Those files have **no search index**; an agent finds them only when `MEMORY.md` happens to land in context. If you have accumulated any, move the content into the indexed store:

```bash
python3 scripts/import-claude-memory.py --dry-run
python3 scripts/import-claude-memory.py
```

The markdown files are left in place — this copies content, it does not migrate. It is idempotent (keyed on `source`), so re-running updates changed files and skips the rest. Pass `--code-root` if your projects do not live in `~/code`, and `--client-group <folder>` for folders holding client work.

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

## The 12 tools

### 1. `brain_learn` — store a lesson

Takes `scope: "global"` for a lesson about a **tool** rather than a project — a
shell trap, a git behaviour, an API limit. Those recur everywhere, and filing
them under whichever project happened to be open is what made them invisible in
the repositories where the mistake actually repeats. `UserPromptSubmit` boosts
them. The default stays `project`.

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

Search across the whole database, with optional category and project filters.

**When the agent should use it:** before starting work on a task — check for known issues and gotchas.

```js
brain_recall({ query: "cloudflare deployment", project: "my-webapp" })
```

**Ask it in a sentence.** The query is treated as a bag of terms, not as a phrase
that must appear verbatim, and three retrievers run over those terms and are
merged by weighted reciprocal rank fusion:

| Retriever | Matches | Weight | What it is for |
|-----------|---------|--------|----------------|
| `all` | every term, anywhere in the lesson | 3 | precision — a lesson about exactly this |
| `chunk-all` | every term inside **one paragraph** | 3 | the only way past bm25's length penalty into a long lesson |
| `any` | any term | 1.5 | recall — the question spans several lessons |
| `vector` | nearest **passages**, above a similarity floor | 1.5 | only when [embeddings](#hybrid-vector-search-optional) are enabled |
| `chunk-any` | any term in one paragraph | 1.2 | the passage index's recall arm |
| `prefix` | any stem | 0.6 | morphology — `zamówieniach` reaches `zamówień`, `backfilling` reaches `backfill` |

For a lesson longer than ~1000 characters, the response shows **the passage that
matched** rather than the first 1200 characters, with the whole text one
`brain://lessons/{id}` fetch away. The long lessons are the ones with the
evidence in them, and they are written as "PROBLEM — … CAUSE — … FIX —":
truncating from the top delivers the setup and cuts before the answer.

Results are annotated with the retrievers that found them (`matched: all+any`),
and the response names the terms actually searched for — including on a miss, so
a query that quietly reduced to two words is distinguishable from an empty base.

A hit carried only by shared words is also labelled with how many of them it
shares (`thin: 1/5 terms`), and a result set where every hit is thin carries a
caution. This is **reported, not enforced**: filtering on it was measured and
recall@5 fell from 100% to 79.4% with an eighth of all questions returning
nothing, because a real question spreads across lessons that each answer part of
it — a softer version of the implicit AND that made the base look empty to begin
with. The prompt hook, which speaks uninvited, does enforce it; the tool, which
was asked deliberately and whose caller can read the content, does not.

> **This is the fix for the bug that made brain-mcp look empty.** FTS5 joins bare
> terms with an implicit AND, so `brain_recall` used to demand a single lesson
> containing *every* word of the question. Asked
> `"wp eval koszty zamówień backfill lipiec"` against a base of 301 lessons it
> returned nothing — the same terms OR-ed returned 100. Punctuation was worse
> than useless: `"how do I fix (kamar) orders?"` raised `fts5: syntax error` out
> of the tool. Both are covered by `tests/recall.test.ts`.

Severity and scope act as tie-breakers only: a `critical` lesson and a `global`
one get a few percent, enough to order two equally relevant hits and never enough
to promote an irrelevant one.

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

### When the backend is not there

Semantic search is additive: every failure path degrades to the lexical
retrievers rather than to an error. What matters is that it degrades *quickly*.

A refused connection fails in milliseconds. The case that costs is a backend
which accepts the connection and never answers — a model loading under memory
pressure, a laptop waking from sleep. Measured against a socket that accepts and
hangs, every recall paid the full timeout and then returned exactly the
lexical-only result it would have returned instantly: five questions, fifty
seconds, nothing gained.

So the embedder sits behind a circuit breaker. **A timeout counts double**,
because it already spent the whole budget — one hang is enough to pause vector
search, while a single cheap failure is forgiven as a blip. After a minute one
probe is allowed through, so a backend that comes back is noticed without
anybody restarting anything. Five questions against a hung backend now cost one
timeout instead of five.

Two other silent failures are made loud: a dimension mismatch after a model
change (every query matches nothing while `brain_status` still says "enabled")
names itself and tells you to run `brain_reindex force:true`, and `npm run
doctor` pings the backend named in your MCP config rather than trusting that it
is up.

The vector index also heals itself. Passages are written on every `brain_learn`;
vectors only when a backend was configured **and** reachable at that moment, and
the two drift apart for ordinary reasons — a session started before embeddings
were configured, an offline laptop, a model mid-pull. On startup the server
embeds whatever backlog it finds, after the transport is connected so it answers
questions throughout, stopping after a few consecutive failures rather than
turning a dead backend into a thousand timeouts. "Run `brain_reindex`" is a fine
repair and a poor design: it needs somebody to notice, and the symptom of not
noticing is that some lessons are quietly unreachable by meaning while every
report says healthy.

### Tuning the similarity floor

KNN always returns *k* neighbours, and nearest is not the same as near — without
a floor the vector retriever answers every question, including the ones whose
answer is nothing. Wiring vectors in without one was measured: precision@1 rose
from 82% to 88% **and the true-negative rate collapsed from 100% to 0%**. Asked
about Kubernetes, a base containing nothing about Kubernetes returned five
lessons about bash and ABI mismatches, confidently.

Embeddings are normalised to unit length, so the floor is plain cosine
similarity and means the same thing whatever model produces it. It still belongs
to the *pair* of model and corpus, so re-derive it when you change models:

```bash
BRAIN_EMBEDDINGS_URL=http://localhost:11434 \
BRAIN_EMBEDDINGS_MODEL=bge-m3 npm run eval:sweep
```

Read the table for a plateau rather than a peak — a threshold on the edge of a
cliff is overfitted to the query set. With bge-m3 the plateau runs 0.45–0.52,
which is why `BRAIN_MIN_SIMILARITY` defaults to 0.5.

## Is it working?

Two commands answer that without guesswork.

```bash
npm run doctor    # is the installation sound?
npm run eval      # is the retrieval any good?
```

`doctor` checks the things that have actually broken: a native module built for
a different Node ABI (which an MCP client reports as "could not connect"), a
config pointing at a directory that moved, bare `node` in a config, a stale
`dist/`, an index that has fallen behind, and whether the hooks are registered.
It is read-only — it prints what is wrong and what to run.

`eval` scores retrieval against `tests/eval/`: a committed corpus and judged
queries, including ones that must return **nothing**. The same thresholds run in
`npm test`, so a ranking regression fails the build instead of being discovered
months later by someone concluding the knowledge base is empty.

`npm run eval:hook` scores the **prompt hook** against the same judged queries.
It has its own ranking — a separate Python implementation — and for a long time
it had no thresholds at all, which is backwards: it fires on every sentence and
decides what an agent reads before it starts, while the tool waits to be asked.
The gap cost two real defects that only measurement found. Metrics are @3
because the hook shows three lessons; recall past the third slot describes a
list nobody sees.

```
lexical-answerable — 19 queries
  recall@5        100.0%
  precision@1      82.4%
  MRR               0.897
  zero-result       0.0%
  true negatives  100.0%
```

Two of the 21 queries are marked `requiresSemantic`: an English question against
a Polish lesson shares meaning and no words at all, and no amount of lexical
tuning reaches it. With embeddings on, every judged query is satisfied:

| | lexical only | + nomic-embed-text | + bge-m3 |
|---|---|---|---|
| recall@5 (all 21) | 92.1% | 92.1% | **100%** |
| precision@1 | 82.4% | 88.2% | **94.1%** |
| MRR | 0.897 | 0.924 | **0.961** |
| true negatives | 100% | 100% | 100% |

`nomic-embed-text` is the obvious choice and it does not work here: it raised
precision and left the cross-lingual gap exactly where it was, because it is an
English-centric model and this base is written in two languages. Pick a
multilingual one.

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

### Pin the Node binary in your MCP config

`better-sqlite3` is a **native** module: it is compiled against one Node ABI and
refuses to load under another.

```
Error: The module 'better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 147. This version of Node.js
requires NODE_MODULE_VERSION 137.
```

So `"command": "node"` in an MCP config is a coin flip: it resolves through
`PATH`, and with a version manager (`fnm`, `nvm`, `asdf`) that depends on which
shell happened to launch your client. The server then dies at startup — and it
dies *before* the MCP handshake, so the client reports a connection problem
rather than an ABI problem.

Give it an absolute path to the same Node you build with:

```json
{
  "mcpServers": {
    "brain": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/brain-mcp/dist/index.js"]
    }
  }
}
```

```bash
node -p "process.execPath"   # the path to pin
npm rebuild better-sqlite3   # after any Node upgrade
```

### Reset the database (start fresh)

```bash
rm data/knowledge.db
# The database is recreated on the next server start
```

### Tests

```bash
npm test           # the MCP server (49 tests)
npm run test:hooks # the hooks (45 tests, standard library only)
npm run test:all   # both
```

The hooks are tested separately and in Python, because that is what they are:
plain scripts with no dependencies, so the suite needs nothing beyond the
interpreter that runs them. They had no tests at all until August 2026 while
`src/` had 39 — and they are the only mechanism by which anything stored here
ever reaches an agent.

A hook is a pure function of (stdin payload, database, cwd) → (stdout, exit
code). The suite covers the search and ranking, the per-session
no-repeat rule, the instrumentation (including that showing a lesson must not
touch `updated_at`), the `Stop` hook's four anti-loop guards, and — for every
hook — malformed JSON, an empty payload, a missing database, a corrupt database,
a read-only database and an unwritable state directory. **No hook may ever be
the reason a session fails.**

`tests/hardening.test.ts` covers the questions the happy path never asks: two
connections writing at once (a knowledge base shared by agents in separate
worktrees is the normal case, not an edge case), a lesson archived and the search
index not told, a round-trip of Polish prose with a fenced code block inside it —
run twice, because a round-trip that normalises something on the first pass looks
lossless from the second onwards — a truncated export file, and an embeddings
endpoint that is slow rather than dead.

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
