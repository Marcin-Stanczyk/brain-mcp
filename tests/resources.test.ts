// MCP resources tests: brain://lessons/{id} and brain://projects/{name},
// exercised both directly and through a real MCP client/server pair connected
// over the SDK's InMemoryTransport (resources/list + resources/read).
// Run with: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initDB, createTools, scanProjects, type ToolDef } from "../src/tools.js";
import {
  registerResources,
  listLessonResources,
  readLessonResource,
  listProjectResources,
  readProjectResource,
} from "../src/resources.js";

let workDir: string;
let codeDir: string;
let db: Database.Database;
let tools: ToolDef[];
let lessonId: number;
let server: McpServer;
let client: Client;

const textOf = (r: { content: { type: "text"; text: string }[] }) =>
  r.content.map((c) => c.text).join("\n");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "brain-resources-test-"));
  codeDir = join(workDir, "code");
  const proj = join(codeDir, "proj-x");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({ name: "proj-x", description: "Fixture project X", dependencies: { hono: "4.0.0" } })
  );

  db = initDB(join(workDir, "test-knowledge.db"));
  tools = createTools(db, codeDir);
  scanProjects(db, codeDir);

  const learn = tools.find((t) => t.name === "brain_learn")!;
  const learned = await learn.handler({
    content: "Hono middleware order matters for CORS",
    category: "gotcha",
    tags: ["hono"],
    project: "proj-x",
    severity: "important",
  });
  lessonId = Number(textOf(learned).match(/Lesson #(\d+)/)?.[1]);
  assert.ok(lessonId > 0);

  server = new McpServer({ name: "brain-mcp-test", version: "1.1.0" });
  registerResources(server, db);
  client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await server.close();
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ── Direct listing/reading functions ────────────────────────────────────────

test("listLessonResources / readLessonResource expose lessons", () => {
  const list = listLessonResources(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].uri, `brain://lessons/${lessonId}`);
  assert.match(list[0].name, /Lesson #\d+ \[gotcha\] \(proj-x\)/);
  assert.equal(list[0].mimeType, "text/markdown");

  const text = readLessonResource(db, lessonId);
  assert.ok(text);
  assert.match(text, /# Lesson #\d+ \[gotcha\]/);
  assert.ok(text.includes("Hono middleware order matters"));
  assert.ok(text.includes("| Severity | important |"));

  assert.equal(readLessonResource(db, 999999), null, "unknown id → null");
});

test("listProjectResources / readProjectResource expose project summaries", () => {
  const list = listProjectResources(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].uri, "brain://projects/proj-x");
  assert.equal(list[0].description, "Fixture project X");

  const text = readProjectResource(db, "proj-x");
  assert.ok(text);
  assert.match(text, /# Project: proj-x/);
  assert.ok(text.includes("Hono"), "stack included");
  assert.ok(text.includes("Hono middleware order matters"), "related lessons included");
  assert.ok(text.includes(`brain://lessons/${lessonId}`), "lessons cross-linked");

  assert.equal(readProjectResource(db, "nope"), null, "unknown project → null");
});

// ── Through a real MCP client (resources/list + resources/read) ─────────────

test("MCP client lists lesson and project resources", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes(`brain://lessons/${lessonId}`), "lesson listed via resources/list");
  assert.ok(uris.includes("brain://projects/proj-x"), "project listed via resources/list");
});

test("MCP client reads a lesson resource", async () => {
  const result = await client.readResource({ uri: `brain://lessons/${lessonId}` });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].uri, `brain://lessons/${lessonId}`);
  assert.equal(result.contents[0].mimeType, "text/markdown");
  assert.ok(String(result.contents[0].text).includes("Hono middleware order matters"));
});

test("MCP client reads a project resource", async () => {
  const result = await client.readResource({ uri: "brain://projects/proj-x" });
  assert.ok(String(result.contents[0].text).includes("# Project: proj-x"));
});

test("reading an unknown resource fails cleanly", async () => {
  await assert.rejects(
    client.readResource({ uri: "brain://lessons/424242" }),
    /No lesson with id/
  );
});
