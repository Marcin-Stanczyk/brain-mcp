import { z, type ZodRawShape } from "zod";
import Database from "better-sqlite3";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { join, dirname, sep, basename, isAbsolute, resolve } from "path";
import { createHash } from "crypto";
import { rrfFuse, type Embedder, type EmbeddingsConfig } from "./embeddings.js";
import type { VectorIndex } from "./vector.js";

// ── Database Setup ──────────────────────────────────────────────────────────

export function initDB(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      source TEXT,
      project TEXT,
      severity TEXT DEFAULT 'info',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_index (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stack TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      status TEXT DEFAULT 'unknown',
      last_scanned TEXT,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      example TEXT,
      projects TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lessons_archive (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      source TEXT,
      project TEXT,
      severity TEXT DEFAULT 'info',
      created_at TEXT,
      archived_at TEXT DEFAULT (datetime('now')),
      archive_reason TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
      content, category, tags, source, project,
      content='lessons',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
      INSERT INTO lessons_fts(rowid, content, category, tags, source, project)
      VALUES (new.id, new.content, new.category, new.tags, new.source, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
      INSERT INTO lessons_fts(lessons_fts, rowid, content, category, tags, source, project)
      VALUES ('delete', old.id, old.content, old.category, old.tags, old.source, old.project);
    END;

    CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
      INSERT INTO lessons_fts(lessons_fts, rowid, content, category, tags, source, project)
      VALUES ('delete', old.id, old.content, old.category, old.tags, old.source, old.project);
      INSERT INTO lessons_fts(rowid, content, category, tags, source, project)
      VALUES (new.id, new.content, new.category, new.tags, new.source, new.project);
    END;
  `);

  return db;
}

// ── Safe file access for the project scanner ────────────────────────────────

/** Max bytes the scanner will read from a single metadata file (1 MiB). */
export const MAX_SCAN_FILE_BYTES = 1024 * 1024;

/**
 * Read a file for the scanner, safely:
 * - resolves symlinks and refuses to read anything outside `rootDir`
 * - refuses non-regular files and files larger than MAX_SCAN_FILE_BYTES
 * Returns null instead of throwing on any failure.
 */
export function safeReadFile(filePath: string, rootDir: string): string | null {
  try {
    const realRoot = realpathSync(rootDir);
    const real = realpathSync(filePath); // resolves symlinks; throws if missing
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null; // escapes scan root
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_SCAN_FILE_BYTES) return null;
    return readFileSync(real, "utf-8");
  } catch {
    return null;
  }
}

// ── Project Scanner ─────────────────────────────────────────────────────────

export interface ProjectInfo {
  path: string;
  name: string;
  stack: string[];
  description: string;
  status: string;
  metadata: Record<string, unknown>;
}

function detectStack(projectPath: string, rootDir: string): string[] {
  const stack: string[] = [];
  const has = (f: string) => existsSync(join(projectPath, f));

  if (has("package.json")) {
    try {
      const raw = safeReadFile(join(projectPath, "package.json"), rootDir);
      const pkg = raw ? JSON.parse(raw) : {};
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps["react"]) stack.push("React");
      if (allDeps["next"]) stack.push("Next.js");
      if (allDeps["vue"]) stack.push("Vue");
      if (allDeps["astro"]) stack.push("Astro");
      if (allDeps["hono"]) stack.push("Hono");
      if (allDeps["express"]) stack.push("Express");
      if (allDeps["typescript"] || has("tsconfig.json")) stack.push("TypeScript");
      if (allDeps["tailwindcss"]) stack.push("Tailwind CSS");
      if (allDeps["vite"] || has("vite.config.ts")) stack.push("Vite");
      if (allDeps["firebase"]) stack.push("Firebase");
      if (allDeps["wrangler"]) stack.push("Cloudflare");
      if (allDeps["@cloudflare/workers-types"]) stack.push("CF Workers");
      if (allDeps["stripe"]) stack.push("Stripe");
      if (allDeps["i18next"]) stack.push("i18next");
      if (allDeps["playwright"]) stack.push("Playwright");
      if (allDeps["vitest"]) stack.push("Vitest");
    } catch { /* ignore */ }
  }

  if (has("composer.json")) {
    stack.push("PHP");
    try {
      const raw = safeReadFile(join(projectPath, "composer.json"), rootDir);
      const composer = raw ? JSON.parse(raw) : {};
      if (composer.require?.["woocommerce/woocommerce"]) stack.push("WooCommerce");
    } catch { /* ignore */ }
  }

  if (has("wp-config.php") || has("wordpress/")) stack.push("WordPress");
  if (has("wrangler.toml")) stack.push("Cloudflare");
  if (has("firebase.json")) stack.push("Firebase");
  if (has("Dockerfile") || has("docker-compose.yml")) stack.push("Docker");
  if (has(".github/workflows")) stack.push("GitHub Actions");
  if (has("requirements.txt") || has("pyproject.toml")) stack.push("Python");

  return [...new Set(stack)];
}

export function scanProjects(db: Database.Database, codeDir: string): ProjectInfo[] {
  const results: ProjectInfo[] = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "vendor"]);

  try {
    const entries = readdirSync(codeDir, { withFileTypes: true });
    for (const entry of entries) {
      // Symlinked directories are skipped: following them could walk outside the scan root.
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() || skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;

      const projectPath = join(codeDir, entry.name);
      const hasPackageJson = existsSync(join(projectPath, "package.json"));
      const hasComposer = existsSync(join(projectPath, "composer.json"));
      const hasReadme = existsSync(join(projectPath, "README.md"));
      const hasGit = existsSync(join(projectPath, ".git"));

      if (!hasPackageJson && !hasComposer && !hasGit) continue;

      const stack = detectStack(projectPath, codeDir);
      let description = "";

      if (hasPackageJson) {
        try {
          const raw = safeReadFile(join(projectPath, "package.json"), codeDir);
          const pkg = raw ? JSON.parse(raw) : {};
          description = pkg.description || "";
        } catch { /* ignore */ }
      }

      if (!description && hasReadme) {
        const readme = safeReadFile(join(projectPath, "README.md"), codeDir);
        if (readme) {
          const firstLine = readme.split("\n").find((l: string) => l.trim() && !l.startsWith("#"));
          description = firstLine?.slice(0, 200) || "";
        }
      }

      const info: ProjectInfo = {
        path: projectPath,
        name: entry.name,
        stack,
        description,
        status: hasGit ? "active" : "unknown",
        metadata: {},
      };

      results.push(info);

      db.prepare(`
        INSERT OR REPLACE INTO project_index (path, name, stack, description, status, last_scanned, metadata)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(
        info.path,
        info.name,
        JSON.stringify(info.stack),
        info.description,
        info.status,
        JSON.stringify(info.metadata)
      );
    }
  } catch (err) {
    console.error("Scan error:", err);
  }

  return results;
}

// ── FTS5 query sanitizer ────────────────────────────────────────────────────

// Sanitize FTS5 query: quote tokens with special chars (hyphens, dots) that FTS5 misinterprets as operators
export function sanitizeFTS5Query(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map(token => {
      // If token contains special chars that FTS5 treats as operators, quote it
      if (/[-.]/.test(token) && !token.startsWith('"')) {
        return `"${token.replace(/"/g, '')}"`;
      }
      // Remove any standalone FTS5 operators that could cause errors
      if (/^(AND|OR|NOT|NEAR)$/i.test(token)) {
        return `"${token}"`;
      }
      return token;
    })
    .join(' ');
}

// ── Export/import helpers ───────────────────────────────────────────────────

/** Max bytes brain_export returns inline / brain_import reads from disk. */
export const MAX_INLINE_EXPORT_BYTES = 64 * 1024;
export const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Resolve a caller-supplied export/import path and confine it to `dataDir`
 * (same discipline as safeReadFile): the parent directory must already exist,
 * symlinks are resolved, and anything landing outside dataDir is rejected.
 * Returns the resolved absolute path, or null if the path is not allowed.
 */
export function resolveDataFilePath(requested: string, dataDir: string): string | null {
  try {
    const realData = realpathSync(dataDir);
    const abs = isAbsolute(requested) ? resolve(requested) : resolve(realData, requested);
    const name = basename(abs);
    if (!name || name === "." || name === "..") return null;
    const realParent = realpathSync(dirname(abs)); // parent must exist, symlinks resolved
    const target = join(realParent, name);
    // Must be strictly INSIDE the data dir (the dir itself is not a valid file path)
    if (!target.startsWith(realData + sep)) return null;
    return target;
  } catch {
    return null;
  }
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Tool definitions ────────────────────────────────────────────────────────

type TextResult = { content: { type: "text"; text: string }[] };

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<TextResult>;
}

export interface BrainOptions {
  /** Directory export/import files are confined to. Default: the DB's directory. */
  dataDir?: string;
  /** Vector index (sqlite-vec). null/undefined → FTS5-only mode. */
  vector?: VectorIndex | null;
  /** Embedding function. null/undefined → embeddings disabled. */
  embedder?: Embedder | null;
  /** Embeddings config (for status reporting). null/undefined → disabled. */
  embeddingsConfig?: EmbeddingsConfig | null;
}

export function createTools(
  db: Database.Database,
  codeDir: string,
  options: BrainOptions = {}
): ToolDef[] {
  const tools: ToolDef[] = [];
  const vector = options.vector ?? null;
  const embedder = options.embedder ?? null;
  const embeddingsConfig = options.embeddingsConfig ?? null;
  const dataDir =
    options.dataDir ?? (db.name && db.name !== ":memory:" ? dirname(db.name) : null);
  const hybridEnabled = Boolean(vector && embedder);

  /** Embed one lesson and store its vector. Returns true on success. */
  const embedLesson = (id: number, content: string): Promise<boolean> => {
    if (!vector || !embedder || !embeddingsConfig) return Promise.resolve(false);
    return embedder(content).then(
      (vec) => {
        vector.upsert(id, vec, embeddingsConfig.model);
        return true;
      },
      (err) => {
        console.error(
          `⚠️ brain-mcp: embedding failed for lesson #${id} (${err instanceof Error ? err.message : String(err)}) — saved without embedding, run brain_reindex later.`
        );
        return false;
      }
    );
  };

  // Tool: Learn — store a lesson/insight/pattern
  tools.push({
    name: "brain_learn",
    description:
      "Store a lesson, insight, or pattern learned during work. Use after solving a problem, discovering a gotcha, or finding a useful approach.",
    schema: {
      content: z.string().min(1).max(10000).describe("The lesson or insight to remember"),
      category: z.enum([
        "bug-fix", "architecture", "performance", "security", "deployment",
        "tooling", "pattern", "gotcha", "best-practice", "client", "seo",
        "i18n", "testing", "design", "marketing", "sales", "workflow",
        "business", "financial", "market", "client-feedback",
      ]).describe("Category of the lesson"),
      tags: z.array(z.string().max(100)).max(50).optional().describe("Tags for searchability"),
      project: z.string().max(200).optional().describe("Which project this relates to"),
      source: z.string().max(500).optional().describe("Where this was learned (file, URL, conversation)"),
      severity: z.enum(["critical", "important", "info", "tip"]).optional().default("info"),
    },
    handler: async ({ content, category, tags, project, source, severity }: {
      content: string;
      category: string;
      tags?: string[];
      project?: string;
      source?: string;
      severity?: string;
    }): Promise<TextResult> => {
      // Auto-detect project from tags if not explicitly provided
      let resolvedProject = project || null;
      if (!resolvedProject && tags?.length) {
        const knownProjects = db.prepare("SELECT name FROM project_index").all() as { name: string }[];
        const projectNames = new Set(knownProjects.map(p => p.name.toLowerCase()));
        for (const tag of tags) {
          if (projectNames.has(tag.toLowerCase())) {
            resolvedProject = tag;
            break;
          }
        }
      }

      const stmt = db.prepare(`
        INSERT INTO lessons (content, category, tags, project, source, severity)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        content,
        category,
        JSON.stringify(tags || []),
        resolvedProject,
        source || null,
        severity || "info"
      );

      // Optional: embed on write. Failure never blocks the save — the lesson
      // stays unembedded and brain_reindex can pick it up later.
      let embedNote = "";
      if (hybridEnabled) {
        const ok = await embedLesson(Number(result.lastInsertRowid), content);
        embedNote = ok ? "\nEmbedded: yes" : "\nEmbedded: no (endpoint unavailable — run brain_reindex later)";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Lesson #${result.lastInsertRowid} stored [${category}] ${severity === "critical" ? "⚠️ CRITICAL" : ""}\n\nTags: ${(tags || []).join(", ") || "none"}\nProject: ${project || "general"}${embedNote}\n\n"${content.slice(0, 100)}${content.length > 100 ? "…" : ""}"`,
          },
        ],
      };
    },
  });

  // Tool: Recall — search the knowledge base
  tools.push({
    name: "brain_recall",
    description:
      "Search the knowledge base for lessons, patterns, and insights. Use before starting work on a topic to check for known gotchas and best practices.",
    schema: {
      query: z.string().max(1000).describe("What to search for"),
      category: z.string().max(100).optional().describe("Filter by category"),
      project: z.string().max(200).optional().describe("Filter by project"),
      limit: z.number().int().min(1).max(100).optional().default(10).describe("Max results"),
    },
    handler: async ({ query, category, project, limit }: {
      query: string;
      category?: string;
      project?: string;
      limit?: number;
    }): Promise<TextResult> => {
      let results;
      // id → which retriever(s) found it (hybrid mode only)
      let matchedBy: Map<number, string[]> | null = null;
      let modeNote = "";

      if (query.trim()) {
        const max = limit || 10;
        // Over-fetch both retrievers so reciprocal rank fusion has depth to work with.
        const fetchN = Math.min(100, max * 5);

        const safeQuery = sanitizeFTS5Query(query);
        let sql = `
          SELECT l.id, l.content, l.category, l.tags, l.project, l.source, l.severity, l.created_at,
                 rank
          FROM lessons_fts fts
          JOIN lessons l ON l.id = fts.rowid
          WHERE lessons_fts MATCH ?
        `;
        const params: (string | number)[] = [safeQuery];

        if (category) {
          sql += ` AND l.category = ?`;
          params.push(category);
        }
        if (project) {
          sql += ` AND (l.project = ? OR l.tags LIKE ?)`;
          params.push(project);
          params.push(`%"${project}"%`);
        }

        sql += ` ORDER BY rank LIMIT ?`;
        params.push(fetchN);

        const ftsRows = db.prepare(sql).all(...params) as Record<string, unknown>[];

        results = ftsRows.slice(0, max);

        if (hybridEnabled) {
          // Hybrid mode: FTS5 + KNN, merged with reciprocal rank fusion.
          // Any embedding failure (Ollama down, model missing, dim mismatch)
          // silently falls back to the FTS5 results computed above.
          try {
            const queryVec = await embedder!(query);
            const knnHits = vector!.knn(queryVec, fetchN * 2);

            const rowById = new Map<number, Record<string, unknown>>();
            for (const row of ftsRows) rowById.set(Number(row.id), row);

            const getRow = db.prepare(
              "SELECT id, content, category, tags, project, source, severity, created_at FROM lessons WHERE id = ?"
            );
            const vecIds: number[] = [];
            for (const hit of knnHits) {
              let row = rowById.get(hit.id);
              if (!row) {
                row = getRow.get(hit.id) as Record<string, unknown> | undefined;
                if (!row) continue; // stale vector for a deleted lesson
                rowById.set(hit.id, row);
              }
              // Apply the same filters the FTS query used.
              if (category && row.category !== category) continue;
              if (
                project &&
                row.project !== project &&
                !String(row.tags ?? "").includes(`"${project}"`)
              ) continue;
              vecIds.push(hit.id);
              if (vecIds.length >= fetchN) break;
            }

            const fused = rrfFuse([
              { retriever: "fts", ids: ftsRows.map((r) => Number(r.id)) },
              { retriever: "vector", ids: vecIds },
            ]).slice(0, max);

            results = fused.map((h) => rowById.get(h.id)).filter(Boolean) as Record<string, unknown>[];
            matchedBy = new Map(fused.map((h) => [h.id, h.retrievers]));
            modeNote = " (hybrid: FTS5 + vector, RRF-fused)";
          } catch (err) {
            console.error(
              `⚠️ brain-mcp: hybrid recall degraded to FTS5-only (${err instanceof Error ? err.message : String(err)})`
            );
          }
        }
      } else {
        let sql = `SELECT * FROM lessons WHERE 1=1`;
        const params: (string | number)[] = [];

        if (category) {
          sql += ` AND category = ?`;
          params.push(category);
        }
        if (project) {
          sql += ` AND (project = ? OR tags LIKE ?)`;
          params.push(project);
          params.push(`%"${project}"%`);
        }

        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit || 10);

        results = db.prepare(sql).all(...params);
      }

      if (!results.length) {
        return {
          content: [{ type: "text" as const, text: "No matching lessons found." }],
        };
      }

      const formatted = (results as Record<string, unknown>[]).map((r) => {
        const sev = r.severity === "critical" ? "🔴" : r.severity === "important" ? "🟡" : "🔵";
        const via = matchedBy?.get(Number(r.id));
        const viaNote = via ? ` | matched: ${via.join("+")}` : "";
        return `${sev} #${r.id} [${r.category}] ${r.project ? `(${r.project})` : ""}\n${r.content}\n${r.tags ? `Tags: ${r.tags}` : ""} | ${r.created_at}${viaNote}`;
      }).join("\n\n---\n\n");

      return {
        content: [{ type: "text" as const, text: `Found ${results.length} lessons${modeNote}:\n\n${formatted}` }],
      };
    },
  });

  // Tool: Scan projects
  tools.push({
    name: "brain_scan_projects",
    description:
      "Scan the configured code directory (BRAIN_CODE_DIR, default ~/code) to discover and index all projects, their tech stacks, and structure.",
    schema: {},
    handler: async (): Promise<TextResult> => {
      const projects = scanProjects(db, codeDir);

      const summary = projects.map((p) =>
        `📁 ${p.name} — ${p.stack.join(", ") || "unknown stack"} ${p.description ? `\n   ${p.description}` : ""}`
      ).join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `Scanned ${projects.length} projects in ${codeDir}:\n\n${summary}`,
        }],
      };
    },
  });

  // Tool: Get project context
  tools.push({
    name: "brain_project_context",
    description:
      "Get full context about a specific project — stack, structure, lessons learned, and patterns.",
    schema: {
      project: z.string().min(1).max(200).describe("Project name (folder name inside the scanned code directory)"),
    },
    handler: async ({ project }: { project: string }): Promise<TextResult> => {
      const projectRow = db.prepare("SELECT * FROM project_index WHERE name = ?").get(project) as Record<string, unknown> | undefined;
      const lessons = db.prepare("SELECT * FROM lessons WHERE project = ? ORDER BY severity DESC, created_at DESC").all(project) as Record<string, unknown>[];
      const escapedProject = project.replace(/[%_]/g, '\\$&');
      const patterns = db.prepare("SELECT * FROM patterns WHERE projects LIKE ? ESCAPE '\\' ORDER BY created_at DESC").all(`%"${escapedProject}"%`) as Record<string, unknown>[];

      let output = "";

      if (projectRow) {
        output += `## Project: ${projectRow.name}\n`;
        output += `Path: ${projectRow.path}\n`;
        output += `Stack: ${projectRow.stack}\n`;
        output += `Status: ${projectRow.status}\n`;
        output += `Description: ${projectRow.description || "none"}\n`;
        output += `Last scanned: ${projectRow.last_scanned}\n\n`;
      } else {
        output += `## Project: ${project} (not indexed — run brain_scan_projects first)\n\n`;
      }

      if (lessons.length) {
        output += `### Lessons (${lessons.length})\n`;
        for (const l of lessons) {
          const sev = l.severity === "critical" ? "🔴" : l.severity === "important" ? "🟡" : "🔵";
          output += `${sev} [${l.category}] ${l.content}\n`;
        }
        output += "\n";
      }

      if (patterns.length) {
        output += `### Patterns (${patterns.length})\n`;
        for (const p of patterns) {
          output += `• ${p.name}: ${p.description}\n`;
        }
      }

      return {
        content: [{ type: "text" as const, text: output || `No data for project "${project}".` }],
      };
    },
  });

  // Tool: Store a pattern
  tools.push({
    name: "brain_store_pattern",
    description:
      "Store a reusable code pattern or architectural approach discovered across projects.",
    schema: {
      name: z.string().min(1).max(200).describe("Short pattern name"),
      pattern_type: z.enum([
        "api", "component", "auth", "database", "caching", "deployment",
        "testing", "i18n", "seo", "styling", "state-management", "error-handling",
      ]),
      description: z.string().min(1).max(5000).describe("How and when to use this pattern"),
      example: z.string().max(10000).optional().describe("Code example"),
      projects: z.array(z.string().max(200)).max(100).describe("Which projects use this pattern"),
    },
    handler: async ({ name, pattern_type, description, example, projects }: {
      name: string;
      pattern_type: string;
      description: string;
      example?: string;
      projects: string[];
    }): Promise<TextResult> => {
      db.prepare(`
        INSERT INTO patterns (pattern_type, name, description, example, projects)
        VALUES (?, ?, ?, ?, ?)
      `).run(pattern_type, name, description, example || null, JSON.stringify(projects));

      return {
        content: [{
          type: "text" as const,
          text: `✅ Pattern stored: "${name}" [${pattern_type}]\nUsed in: ${projects.join(", ")}`,
        }],
      };
    },
  });

  // Tool: Brain status
  tools.push({
    name: "brain_status",
    description:
      "Get overview of the knowledge base — how many lessons, patterns, projects indexed.",
    schema: {},
    handler: async (): Promise<TextResult> => {
      const lessons = db.prepare("SELECT COUNT(*) as count FROM lessons").get() as { count: number };
      const projects = db.prepare("SELECT COUNT(*) as count FROM project_index").get() as { count: number };
      const patterns = db.prepare("SELECT COUNT(*) as count FROM patterns").get() as { count: number };
      const byCat = db.prepare("SELECT category, COUNT(*) as count FROM lessons GROUP BY category ORDER BY count DESC").all() as { category: string; count: number }[];
      const byProject = db.prepare("SELECT project, COUNT(*) as count FROM lessons WHERE project IS NOT NULL GROUP BY project ORDER BY count DESC LIMIT 10").all() as { project: string; count: number }[];
      const critical = db.prepare("SELECT COUNT(*) as count FROM lessons WHERE severity = 'critical'").get() as { count: number };

      let output = `## 🧠 Brain Status\n\n`;
      output += `| Metric | Count |\n|--------|-------|\n`;
      output += `| Lessons | ${lessons.count} |\n`;
      output += `| Critical lessons | ${critical.count} |\n`;
      output += `| Patterns | ${patterns.count} |\n`;
      output += `| Projects indexed | ${projects.count} |\n\n`;

      // Embeddings / vector search status
      output += `### Embeddings\n`;
      if (!embeddingsConfig) {
        output += `Mode: disabled (set BRAIN_EMBEDDINGS_URL to enable hybrid search — see README)\n\n`;
      } else if (!vector) {
        output += `Mode: enabled (${embeddingsConfig.model}) but vector index unavailable — sqlite-vec failed to load, running FTS5-only\n\n`;
      } else {
        let reachable = false;
        if (embedder) {
          try {
            await embedder("ping");
            reachable = true;
          } catch { /* unreachable */ }
        }
        const embedded = vector.embeddedCount();
        const unembedded = lessons.count - embedded;
        output += reachable
          ? `Mode: enabled (${embeddingsConfig.model} @ ${embeddingsConfig.url})\n`
          : `Mode: enabled (${embeddingsConfig.model} @ ${embeddingsConfig.url}) — endpoint UNREACHABLE, recall falls back to FTS5-only\n`;
        output += `Embedded lessons: ${embedded} | Unembedded: ${unembedded}`;
        if (unembedded > 0) output += ` (run brain_reindex to embed them)`;
        output += `\n\n`;
      }

      if (byCat.length) {
        output += `### By Category\n`;
        for (const c of byCat) {
          output += `• ${c.category}: ${c.count}\n`;
        }
        output += "\n";
      }

      if (byProject.length) {
        output += `### By Project\n`;
        for (const p of byProject) {
          output += `• ${p.project}: ${p.count}\n`;
        }
      }

      return {
        content: [{ type: "text" as const, text: output }],
      };
    },
  });

  // Tool: Archive lessons (soft-delete — never loses data)
  tools.push({
    name: "brain_forget",
    description:
      "Archive a lesson (soft-delete). Moves to archive table — nothing is permanently lost. Use to clean up outdated or incorrect knowledge.",
    schema: {
      id: z.number().int().positive().optional().describe("Specific lesson ID to archive"),
      category: z.string().max(100).optional().describe("Archive all in this category"),
      project: z.string().max(200).optional().describe("Archive all for this project"),
      reason: z.string().max(500).optional().default("outdated").describe("Why this is being archived"),
      confirm: z.boolean().describe("Must be true to execute archival"),
    },
    handler: async ({ id, category, project, reason, confirm }: {
      id?: number;
      category?: string;
      project?: string;
      reason?: string;
      confirm: boolean;
    }): Promise<TextResult> => {
      if (!confirm) {
        // Preview what would be archived
        let preview;
        if (id) {
          preview = db.prepare("SELECT id, content, category, severity FROM lessons WHERE id = ?").all(id);
        } else if (category && project) {
          preview = db.prepare("SELECT id, content, category, severity FROM lessons WHERE category = ? AND project = ?").all(category, project);
        } else if (category) {
          preview = db.prepare("SELECT id, content, category, severity FROM lessons WHERE category = ?").all(category);
        } else if (project) {
          preview = db.prepare("SELECT id, content, category, severity FROM lessons WHERE project = ?").all(project);
        } else {
          return { content: [{ type: "text" as const, text: "Specify id, category, or project to archive." }] };
        }

        const items = (preview || []) as Record<string, unknown>[];
        if (!items.length) {
          return { content: [{ type: "text" as const, text: "No matching lessons found." }] };
        }

        const criticalCount = items.filter(i => i.severity === "critical").length;
        let text = `⚠️ Preview: ${items.length} lesson(s) would be archived:\n\n`;
        for (const item of items.slice(0, 10)) {
          const sev = item.severity === "critical" ? "🔴" : item.severity === "important" ? "🟡" : "🔵";
          text += `${sev} #${item.id} [${item.category}] ${(item.content as string).slice(0, 80)}...\n`;
        }
        if (items.length > 10) text += `\n...and ${items.length - 10} more\n`;
        if (criticalCount > 0) text += `\n🔴 WARNING: ${criticalCount} CRITICAL lesson(s) included! Are you sure?\n`;
        text += `\nSet confirm=true to proceed.`;

        return { content: [{ type: "text" as const, text }] };
      }

      // Archive: copy to archive table, then delete from lessons
      const archiveAndDelete = db.transaction(() => {
        let rows: Record<string, unknown>[];
        if (id) {
          rows = db.prepare("SELECT * FROM lessons WHERE id = ?").all(id) as Record<string, unknown>[];
        } else if (category && project) {
          rows = db.prepare("SELECT * FROM lessons WHERE category = ? AND project = ?").all(category, project) as Record<string, unknown>[];
        } else if (category) {
          rows = db.prepare("SELECT * FROM lessons WHERE category = ?").all(category) as Record<string, unknown>[];
        } else if (project) {
          rows = db.prepare("SELECT * FROM lessons WHERE project = ?").all(project) as Record<string, unknown>[];
        } else {
          return [] as number[];
        }

        const insertArchive = db.prepare(`
          INSERT OR REPLACE INTO lessons_archive (id, category, tags, content, source, project, severity, created_at, archived_at, archive_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
        `);
        const deleteLesson = db.prepare("DELETE FROM lessons WHERE id = ?");

        for (const row of rows) {
          insertArchive.run(row.id, row.category, row.tags, row.content, row.source, row.project, row.severity, row.created_at, reason || "outdated");
          deleteLesson.run(row.id);
        }

        return rows.map((row) => Number(row.id));
      });

      const archivedIds = archiveAndDelete();
      if (vector && archivedIds.length) {
        try {
          vector.remove(archivedIds);
        } catch (err) {
          console.error(`⚠️ brain-mcp: failed to drop vectors for archived lessons (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      return {
        content: [{ type: "text" as const, text: `📦 Archived ${archivedIds.length} lesson(s) → lessons_archive table.\nReason: ${reason}\n\nData is preserved and can be restored.` }],
      };
    },
  });

  // Tool: Restore archived lessons
  tools.push({
    name: "brain_restore",
    description:
      "Restore a previously archived lesson back to active lessons. List archived lessons by calling with no id and confirm=false.",
    schema: {
      id: z.number().int().positive().optional().describe("Archive ID to restore. Omit to list archived lessons."),
      confirm: z.boolean().optional().default(false).describe("Must be true to execute restore"),
    },
    handler: async ({ id, confirm }: { id?: number; confirm?: boolean }): Promise<TextResult> => {
      if (!id) {
        const archived = db.prepare(
          "SELECT id, category, content, project, archived_at, archive_reason FROM lessons_archive ORDER BY archived_at DESC LIMIT 20"
        ).all() as Record<string, unknown>[];

        if (!archived.length) {
          return { content: [{ type: "text" as const, text: "Archive is empty — no lessons have been archived." }] };
        }

        let text = `📦 Archived lessons (${archived.length}):\n\n`;
        for (const a of archived) {
          text += `#${a.id} [${a.category}] ${(a.content as string).slice(0, 80)}...\n  📅 ${a.archived_at} | Reason: ${a.archive_reason}\n\n`;
        }
        text += "Use brain_restore with id=<number> and confirm=true to restore.";
        return { content: [{ type: "text" as const, text }] };
      }

      if (!confirm) {
        const item = db.prepare("SELECT * FROM lessons_archive WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (!item) return { content: [{ type: "text" as const, text: `No archived lesson with id=${id}.` }] };
        return { content: [{ type: "text" as const, text: `Preview restore #${id}:\n[${item.category}] ${item.content}\nArchived: ${item.archived_at} | Reason: ${item.archive_reason}\n\nSet confirm=true to restore.` }] };
      }

      const restoreOp = db.transaction(() => {
        const row = db.prepare("SELECT * FROM lessons_archive WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (!row) return false;

        db.prepare(`
          INSERT OR REPLACE INTO lessons (id, category, tags, content, source, project, severity, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(row.id, row.category, row.tags, row.content, row.source, row.project, row.severity, row.created_at);

        db.prepare("DELETE FROM lessons_archive WHERE id = ?").run(id);
        return true;
      });

      const restored = restoreOp();
      if (!restored) return { content: [{ type: "text" as const, text: `No archived lesson with id=${id}.` }] };

      return { content: [{ type: "text" as const, text: `✅ Restored lesson #${id} back to active lessons.` }] };
    },
  });

  // Tool: Reindex embeddings
  tools.push({
    name: "brain_reindex",
    description:
      "Batch-embed all lessons that have no vector embedding yet (requires BRAIN_EMBEDDINGS_URL). With force:true, drops the vector index and re-embeds everything — use after changing the embedding model.",
    schema: {
      force: z.boolean().optional().default(false).describe("Re-embed ALL lessons, not just unembedded ones"),
    },
    handler: async ({ force }: { force?: boolean }): Promise<TextResult> => {
      if (!embeddingsConfig || !embedder) {
        return { content: [{ type: "text" as const, text: "Embeddings are disabled. Set BRAIN_EMBEDDINGS_URL (e.g. http://localhost:11434 for a local Ollama) to enable hybrid search." }] };
      }
      if (!vector) {
        return { content: [{ type: "text" as const, text: "Vector index unavailable — the sqlite-vec extension failed to load on this platform. Search runs FTS5-only." }] };
      }

      const pruned = vector.pruneOrphans();
      if (force) vector.clear();

      const ids = vector.unembeddedLessonIds();
      const getContent = db.prepare("SELECT content FROM lessons WHERE id = ?");

      let embedded = 0;
      let failed = 0;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;
      let aborted = false;

      for (const id of ids) {
        const row = getContent.get(id) as { content: string } | undefined;
        if (!row) continue;
        const ok = await embedLesson(id, row.content);
        if (ok) {
          embedded++;
          consecutiveFailures = 0;
        } else {
          failed++;
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            aborted = true;
            break;
          }
        }
      }

      const remaining = vector.unembeddedLessonIds().length;
      let text = `🔁 Reindex ${aborted ? "ABORTED (embeddings endpoint appears down)" : "complete"} (model: ${embeddingsConfig.model}${force ? ", force" : ""})\n\n`;
      text += `Embedded: ${embedded}/${ids.length}\n`;
      if (failed) text += `Failed: ${failed}\n`;
      if (pruned) text += `Pruned orphaned vectors: ${pruned}\n`;
      text += `Still unembedded: ${remaining}`;
      return { content: [{ type: "text" as const, text }] };
    },
  });

  // Tool: Export the knowledge base
  tools.push({
    name: "brain_export",
    description:
      "Export the knowledge base. format:'json' is lossless (re-importable via brain_import); format:'markdown' is human-readable, grouped by category. Writes to a path inside the data directory, or returns inline when no path is given (size-capped).",
    schema: {
      format: z.enum(["json", "markdown"]).optional().default("json").describe("Export format"),
      path: z.string().min(1).max(500).optional().describe("Output file path (relative to the data directory; must stay inside it). Omit to get the export inline."),
    },
    handler: async ({ format, path }: { format?: "json" | "markdown"; path?: string }): Promise<TextResult> => {
      const lessons = db.prepare("SELECT id, category, tags, content, source, project, severity, created_at, updated_at FROM lessons ORDER BY id").all() as Record<string, unknown>[];
      const patterns = db.prepare("SELECT id, pattern_type, name, description, example, projects, created_at FROM patterns ORDER BY id").all() as Record<string, unknown>[];

      const parseJSON = (s: unknown): unknown => {
        try { return JSON.parse(String(s)); } catch { return s; }
      };

      let payload: string;
      if (format === "markdown") {
        const byCategory = new Map<string, Record<string, unknown>[]>();
        for (const l of lessons) {
          const cat = String(l.category);
          if (!byCategory.has(cat)) byCategory.set(cat, []);
          byCategory.get(cat)!.push(l);
        }
        let md = `# Brain export\n\nExported: ${new Date().toISOString()}\nLessons: ${lessons.length} | Patterns: ${patterns.length}\n`;
        for (const [cat, items] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          md += `\n## ${cat} (${items.length})\n`;
          for (const l of items) {
            md += `\n### #${l.id} — ${l.severity}${l.project ? ` (${l.project})` : ""}\n\n${l.content}\n\n`;
            const tags = parseJSON(l.tags);
            if (Array.isArray(tags) && tags.length) md += `Tags: ${tags.join(", ")}\n`;
            if (l.source) md += `Source: ${l.source}\n`;
            md += `Created: ${l.created_at}\n`;
          }
        }
        if (patterns.length) {
          md += `\n## Patterns (${patterns.length})\n`;
          for (const p of patterns) {
            md += `\n### ${p.name} [${p.pattern_type}]\n\n${p.description}\n`;
            if (p.example) md += `\n\`\`\`\n${p.example}\n\`\`\`\n`;
            const projs = parseJSON(p.projects);
            if (Array.isArray(projs) && projs.length) md += `Projects: ${projs.join(", ")}\n`;
          }
        }
        payload = md;
      } else {
        payload = JSON.stringify(
          {
            brain_export_version: 1,
            exported_at: new Date().toISOString(),
            lessons: lessons.map((l) => ({ ...l, tags: parseJSON(l.tags) })),
            patterns: patterns.map((p) => ({ ...p, projects: parseJSON(p.projects) })),
          },
          null,
          2
        );
      }

      if (path) {
        if (!dataDir) {
          return { content: [{ type: "text" as const, text: "❌ No data directory configured — cannot write export files." }] };
        }
        const target = resolveDataFilePath(path, dataDir);
        if (!target) {
          return { content: [{ type: "text" as const, text: `❌ Refused: export path must stay inside the data directory (${dataDir}) and its parent must exist.` }] };
        }
        // Never overwrite the live database files.
        const dbBase = basename(db.name);
        if ([dbBase, `${dbBase}-wal`, `${dbBase}-shm`].includes(basename(target))) {
          return { content: [{ type: "text" as const, text: "❌ Refused: export path collides with the database file." }] };
        }
        writeFileSync(target, payload, "utf-8");
        return { content: [{ type: "text" as const, text: `✅ Exported ${lessons.length} lessons and ${patterns.length} patterns (${format}) → ${target}` }] };
      }

      if (Buffer.byteLength(payload, "utf-8") > MAX_INLINE_EXPORT_BYTES) {
        return { content: [{ type: "text" as const, text: `Export is larger than ${MAX_INLINE_EXPORT_BYTES} bytes — pass a path (inside the data directory) to write it to a file instead.` }] };
      }
      return { content: [{ type: "text" as const, text: payload }] };
    },
  });

  // Tool: Import a JSON export
  tools.push({
    name: "brain_import",
    description:
      "Import lessons and patterns from a JSON file produced by brain_export (file must live inside the data directory). Duplicates are skipped by content hash.",
    schema: {
      path: z.string().min(1).max(500).describe("JSON export file path (relative to the data directory)"),
    },
    handler: async ({ path }: { path: string }): Promise<TextResult> => {
      if (!dataDir) {
        return { content: [{ type: "text" as const, text: "❌ No data directory configured — cannot read import files." }] };
      }
      const target = resolveDataFilePath(path, dataDir);
      if (!target) {
        return { content: [{ type: "text" as const, text: `❌ Refused: import path must stay inside the data directory (${dataDir}).` }] };
      }

      let parsed: { brain_export_version?: number; lessons?: unknown; patterns?: unknown };
      try {
        const st = statSync(target);
        if (!st.isFile() || st.size > MAX_IMPORT_FILE_BYTES) {
          return { content: [{ type: "text" as const, text: `❌ Import file missing, not a regular file, or larger than ${MAX_IMPORT_FILE_BYTES} bytes.` }] };
        }
        parsed = JSON.parse(readFileSync(target, "utf-8"));
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Could not read import file: ${err instanceof Error ? err.message : String(err)}` }] };
      }
      if (parsed.brain_export_version !== 1 || !Array.isArray(parsed.lessons)) {
        return { content: [{ type: "text" as const, text: "❌ Not a brain_export JSON file (expected brain_export_version: 1 with a lessons array)." }] };
      }

      const existingHashes = new Set(
        (db.prepare("SELECT content FROM lessons").all() as { content: string }[])
          .map((r) => contentHash(r.content))
      );
      const existingPatternKeys = new Set(
        (db.prepare("SELECT pattern_type, name, description FROM patterns").all() as Record<string, string>[])
          .map((r) => contentHash(`${r.pattern_type} ${r.name} ${r.description}`))
      );

      const lessonSchema = z.object({
        content: z.string().min(1).max(10000),
        category: z.string().min(1).max(100),
        tags: z.array(z.string().max(100)).max(50).optional(),
        project: z.string().max(200).nullish(),
        source: z.string().max(500).nullish(),
        severity: z.string().max(50).nullish(),
        created_at: z.string().max(50).nullish(),
      });
      const patternSchema = z.object({
        pattern_type: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(5000),
        example: z.string().max(10000).nullish(),
        projects: z.array(z.string().max(200)).max(100).optional(),
      });

      let inserted = 0, skippedDupes = 0, skippedInvalid = 0, patternsInserted = 0;
      const insertLesson = db.prepare(`
        INSERT INTO lessons (content, category, tags, project, source, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
      `);
      const insertPattern = db.prepare(`
        INSERT INTO patterns (pattern_type, name, description, example, projects)
        VALUES (?, ?, ?, ?, ?)
      `);

      const runImport = db.transaction(() => {
        for (const raw of parsed.lessons as unknown[]) {
          const l = lessonSchema.safeParse(raw);
          if (!l.success) { skippedInvalid++; continue; }
          const hash = contentHash(l.data.content);
          if (existingHashes.has(hash)) { skippedDupes++; continue; }
          existingHashes.add(hash);
          insertLesson.run(
            l.data.content,
            l.data.category,
            JSON.stringify(l.data.tags || []),
            l.data.project ?? null,
            l.data.source ?? null,
            l.data.severity ?? "info",
            l.data.created_at ?? null
          );
          inserted++;
        }
        if (Array.isArray(parsed.patterns)) {
          for (const raw of parsed.patterns as unknown[]) {
            const p = patternSchema.safeParse(raw);
            if (!p.success) { skippedInvalid++; continue; }
            const key = contentHash(`${p.data.pattern_type} ${p.data.name} ${p.data.description}`);
            if (existingPatternKeys.has(key)) { skippedDupes++; continue; }
            existingPatternKeys.add(key);
            insertPattern.run(p.data.pattern_type, p.data.name, p.data.description, p.data.example ?? null, JSON.stringify(p.data.projects || []));
            patternsInserted++;
          }
        }
      });
      runImport();

      let text = `📥 Import complete from ${target}\n\n`;
      text += `Lessons inserted: ${inserted}\nPatterns inserted: ${patternsInserted}\nSkipped (duplicate content hash): ${skippedDupes}\n`;
      if (skippedInvalid) text += `Skipped (invalid entries): ${skippedInvalid}\n`;
      if (inserted && hybridEnabled) text += `\nImported lessons are not embedded yet — run brain_reindex to embed them.`;
      return { content: [{ type: "text" as const, text }] };
    },
  });

  return tools;
}
