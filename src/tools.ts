import { z, type ZodRawShape } from "zod";
import Database from "better-sqlite3";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "fs";
import { join, dirname, sep } from "path";

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

// ── Tool definitions ────────────────────────────────────────────────────────

type TextResult = { content: { type: "text"; text: string }[] };

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<TextResult>;
}

export function createTools(db: Database.Database, codeDir: string): ToolDef[] {
  const tools: ToolDef[] = [];

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

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Lesson #${result.lastInsertRowid} stored [${category}] ${severity === "critical" ? "⚠️ CRITICAL" : ""}\n\nTags: ${(tags || []).join(", ") || "none"}\nProject: ${project || "general"}\n\n"${content.slice(0, 100)}${content.length > 100 ? "…" : ""}"`,
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

      if (query.trim()) {
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
        params.push(limit || 10);

        results = db.prepare(sql).all(...params);
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
        return `${sev} #${r.id} [${r.category}] ${r.project ? `(${r.project})` : ""}\n${r.content}\n${r.tags ? `Tags: ${r.tags}` : ""} | ${r.created_at}`;
      }).join("\n\n---\n\n");

      return {
        content: [{ type: "text" as const, text: `Found ${results.length} lessons:\n\n${formatted}` }],
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
          return 0;
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

        return rows.length;
      });

      const archived = archiveAndDelete();

      return {
        content: [{ type: "text" as const, text: `📦 Archived ${archived} lesson(s) → lessons_archive table.\nReason: ${reason}\n\nData is preserved and can be restored.` }],
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

  return tools;
}
