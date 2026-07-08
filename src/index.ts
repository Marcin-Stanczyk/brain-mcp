import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { join, basename, extname, relative, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { glob } from "glob";

// Directory that gets scanned for projects (BRAIN_CODE_DIR, legacy CODE_DIR, default: ~/code)
const CODE_DIR = process.env.BRAIN_CODE_DIR || process.env.CODE_DIR || join(homedir(), "code");
// SQLite database location (BRAIN_DB, default: <this package>/data/knowledge.db)
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.BRAIN_DB || join(PACKAGE_ROOT, "data/knowledge.db");

// ── Database Setup ──────────────────────────────────────────────────────────

function initDB(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
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

// ── Project Scanner ─────────────────────────────────────────────────────────

interface ProjectInfo {
  path: string;
  name: string;
  stack: string[];
  description: string;
  status: string;
  metadata: Record<string, unknown>;
}

function detectStack(projectPath: string): string[] {
  const stack: string[] = [];
  const has = (f: string) => existsSync(join(projectPath, f));

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf-8"));
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
      const composer = JSON.parse(readFileSync(join(projectPath, "composer.json"), "utf-8"));
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

function scanProjects(db: Database.Database): ProjectInfo[] {
  const results: ProjectInfo[] = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "vendor"]);

  try {
    const entries = readdirSync(CODE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;

      const projectPath = join(CODE_DIR, entry.name);
      const hasPackageJson = existsSync(join(projectPath, "package.json"));
      const hasComposer = existsSync(join(projectPath, "composer.json"));
      const hasReadme = existsSync(join(projectPath, "README.md"));
      const hasGit = existsSync(join(projectPath, ".git"));

      if (!hasPackageJson && !hasComposer && !hasGit) continue;

      const stack = detectStack(projectPath);
      let description = "";

      if (hasPackageJson) {
        try {
          const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf-8"));
          description = pkg.description || "";
        } catch { /* ignore */ }
      }

      if (!description && hasReadme) {
        try {
          const readme = readFileSync(join(projectPath, "README.md"), "utf-8");
          const firstLine = readme.split("\n").find((l: string) => l.trim() && !l.startsWith("#"));
          description = firstLine?.slice(0, 200) || "";
        } catch { /* ignore */ }
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

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "brain-mcp",
  version: "1.0.0",
});

const db = initDB();

// Tool: Learn — store a lesson/insight/pattern
server.tool(
  "brain_learn",
  "Store a lesson, insight, or pattern learned during work. Use after solving a problem, discovering a gotcha, or finding a useful approach.",
  {
    content: z.string().max(10000).describe("The lesson or insight to remember"),
    category: z.enum([
      "bug-fix", "architecture", "performance", "security", "deployment",
      "tooling", "pattern", "gotcha", "best-practice", "client", "seo",
      "i18n", "testing", "design", "marketing", "sales", "workflow",
      "business", "financial", "market", "client-feedback",
    ]).describe("Category of the lesson"),
    tags: z.array(z.string()).optional().describe("Tags for searchability"),
    project: z.string().optional().describe("Which project this relates to"),
    source: z.string().optional().describe("Where this was learned (file, URL, conversation)"),
    severity: z.enum(["critical", "important", "info", "tip"]).optional().default("info"),
  },
  async ({ content, category, tags, project, source, severity }) => {
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
  }
);

// Sanitize FTS5 query: quote tokens with special chars (hyphens, dots) that FTS5 misinterprets as operators
function sanitizeFTS5Query(query: string): string {
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

// Tool: Recall — search the knowledge base
server.tool(
  "brain_recall",
  "Search the knowledge base for lessons, patterns, and insights. Use before starting work on a topic to check for known gotchas and best practices.",
  {
    query: z.string().describe("What to search for"),
    category: z.string().optional().describe("Filter by category"),
    project: z.string().optional().describe("Filter by project"),
    limit: z.number().optional().default(10).describe("Max results"),
  },
  async ({ query, category, project, limit }) => {
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

    const formatted = (results as Record<string, unknown>[]).map((r, i) => {
      const sev = r.severity === "critical" ? "🔴" : r.severity === "important" ? "🟡" : "🔵";
      return `${sev} #${r.id} [${r.category}] ${r.project ? `(${r.project})` : ""}\n${r.content}\n${r.tags ? `Tags: ${r.tags}` : ""} | ${r.created_at}`;
    }).join("\n\n---\n\n");

    return {
      content: [{ type: "text" as const, text: `Found ${results.length} lessons:\n\n${formatted}` }],
    };
  }
);

// Tool: Scan projects
server.tool(
  "brain_scan_projects",
  "Scan the configured code directory (BRAIN_CODE_DIR, default ~/code) to discover and index all projects, their tech stacks, and structure.",
  {},
  async () => {
    const projects = scanProjects(db);

    const summary = projects.map((p) =>
      `📁 ${p.name} — ${p.stack.join(", ") || "unknown stack"} ${p.description ? `\n   ${p.description}` : ""}`
    ).join("\n");

    return {
      content: [{
        type: "text" as const,
        text: `Scanned ${projects.length} projects in ${CODE_DIR}:\n\n${summary}`,
      }],
    };
  }
);

// Tool: Get project context
server.tool(
  "brain_project_context",
  "Get full context about a specific project — stack, structure, lessons learned, and patterns.",
  {
    project: z.string().describe("Project name (folder name inside the scanned code directory)"),
  },
  async ({ project }) => {
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
  }
);

// Tool: Store a pattern
server.tool(
  "brain_store_pattern",
  "Store a reusable code pattern or architectural approach discovered across projects.",
  {
    name: z.string().describe("Short pattern name"),
    pattern_type: z.enum([
      "api", "component", "auth", "database", "caching", "deployment",
      "testing", "i18n", "seo", "styling", "state-management", "error-handling",
    ]),
    description: z.string().max(5000).describe("How and when to use this pattern"),
    example: z.string().max(10000).optional().describe("Code example"),
    projects: z.array(z.string()).describe("Which projects use this pattern"),
  },
  async ({ name, pattern_type, description, example, projects }) => {
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
  }
);

// Tool: Brain status
server.tool(
  "brain_status",
  "Get overview of the knowledge base — how many lessons, patterns, projects indexed.",
  {},
  async () => {
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
  }
);

// Tool: Archive lessons (soft-delete — never loses data)
server.tool(
  "brain_forget",
  "Archive a lesson (soft-delete). Moves to archive table — nothing is permanently lost. Use to clean up outdated or incorrect knowledge.",
  {
    id: z.number().optional().describe("Specific lesson ID to archive"),
    category: z.string().optional().describe("Archive all in this category"),
    project: z.string().optional().describe("Archive all for this project"),
    reason: z.string().optional().default("outdated").describe("Why this is being archived"),
    confirm: z.boolean().describe("Must be true to execute archival"),
  },
  async ({ id, category, project, reason, confirm }) => {
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
  }
);

// Tool: Restore archived lessons
server.tool(
  "brain_restore",
  "Restore a previously archived lesson back to active lessons. List archived lessons by calling with no id and confirm=false.",
  {
    id: z.number().optional().describe("Archive ID to restore. Omit to list archived lessons."),
    confirm: z.boolean().optional().default(false).describe("Must be true to execute restore"),
  },
  async ({ id, confirm }) => {
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
  }
);

// ── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🧠 Brain MCP server running");
}

main().catch(console.error);
