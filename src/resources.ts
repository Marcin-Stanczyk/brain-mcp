// MCP resources — lets clients browse the knowledge base (resources/list +
// resources/read) without making tool calls:
//   brain://lessons/{id}     one lesson, rendered as markdown
//   brain://projects/{name}  per-project summary (stack, lessons, patterns)

import type Database from "better-sqlite3";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";

const LIST_LIMIT = 200; // resources/list stays bounded no matter how big the DB gets

export interface ResourceEntry {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

// ── Lessons ─────────────────────────────────────────────────────────────────

export function listLessonResources(db: Database.Database): ResourceEntry[] {
  const rows = db
    .prepare(
      `SELECT id, category, project, severity, content FROM lessons
       ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`
    )
    .all() as { id: number; category: string; project: string | null; severity: string; content: string }[];

  return rows.map((r) => ({
    uri: `brain://lessons/${r.id}`,
    name: `Lesson #${r.id} [${r.category}]${r.project ? ` (${r.project})` : ""}`,
    description: r.content.slice(0, 120) + (r.content.length > 120 ? "…" : ""),
    mimeType: "text/markdown",
  }));
}

export function readLessonResource(db: Database.Database, id: number): string | null {
  const r = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;

  let text = `# Lesson #${r.id} [${r.category}]\n\n`;
  text += `${r.content}\n\n`;
  text += `| Field | Value |\n|-------|-------|\n`;
  text += `| Severity | ${r.severity} |\n`;
  text += `| Project | ${r.project || "general"} |\n`;
  text += `| Tags | ${r.tags} |\n`;
  if (r.source) text += `| Source | ${r.source} |\n`;
  text += `| Created | ${r.created_at} |\n`;
  return text;
}

// ── Projects ────────────────────────────────────────────────────────────────

export function listProjectResources(db: Database.Database): ResourceEntry[] {
  const rows = db
    .prepare(
      `SELECT name, description, stack FROM project_index ORDER BY name LIMIT ${LIST_LIMIT}`
    )
    .all() as { name: string; description: string | null; stack: string }[];

  return rows.map((r) => ({
    uri: `brain://projects/${encodeURIComponent(r.name)}`,
    name: `Project: ${r.name}`,
    description: r.description || undefined,
    mimeType: "text/markdown",
  }));
}

export function readProjectResource(db: Database.Database, name: string): string | null {
  const p = db.prepare("SELECT * FROM project_index WHERE name = ?").get(name) as
    | Record<string, unknown>
    | undefined;
  const lessons = db
    .prepare(
      "SELECT id, category, severity, content FROM lessons WHERE project = ? ORDER BY severity DESC, created_at DESC"
    )
    .all(name) as Record<string, unknown>[];
  if (!p && !lessons.length) return null;

  let text = `# Project: ${name}\n\n`;
  if (p) {
    text += `- Path: ${p.path}\n`;
    text += `- Stack: ${p.stack}\n`;
    text += `- Status: ${p.status}\n`;
    text += `- Description: ${p.description || "none"}\n`;
    text += `- Last scanned: ${p.last_scanned}\n\n`;
  }
  if (lessons.length) {
    text += `## Lessons (${lessons.length})\n\n`;
    for (const l of lessons) {
      text += `- [${l.category}/${l.severity}] ${l.content} (brain://lessons/${l.id})\n`;
    }
  }
  return text;
}

// ── SDK registration ────────────────────────────────────────────────────────

export function registerResources(server: McpServer, db: Database.Database): void {
  server.registerResource(
    "lessons",
    new ResourceTemplate("brain://lessons/{id}", {
      list: () => ({ resources: listLessonResources(db) }),
    }),
    {
      title: "Brain lessons",
      description: "Stored lessons, insights, and gotchas from the local knowledge base",
      mimeType: "text/markdown",
    },
    (uri, variables) => {
      const id = Number(variables.id);
      const text = Number.isInteger(id) && id > 0 ? readLessonResource(db, id) : null;
      if (text === null) throw new Error(`No lesson with id ${String(variables.id)}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource(
    "projects",
    new ResourceTemplate("brain://projects/{name}", {
      list: () => ({ resources: listProjectResources(db) }),
    }),
    {
      title: "Brain project summaries",
      description: "Per-project summaries: stack, status, and related lessons",
      mimeType: "text/markdown",
    },
    (uri, variables) => {
      const name = decodeURIComponent(String(variables.name));
      const text = readProjectResource(db, name);
      if (text === null) throw new Error(`No indexed project named "${name}"`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );
}
