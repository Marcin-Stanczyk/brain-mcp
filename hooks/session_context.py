#!/usr/bin/env python3
"""SessionStart hook — inject what brain already knows about this project.

Why a hook and not a tool call: hooks cannot invoke MCP tools (MCP is JSON-RPC
inside the agent's session; a hook is a separate process). So this reads the
SQLite database directly, read-only. That is also cheaper — zero model
round-trips, the knowledge is simply present from the first token.

It injects two things:
  1. Lessons stored for the current project, criticals first.
  2. A note when a graphify code graph exists, so the agent queries the graph
     instead of grepping. (Optional — skipped silently if you don't use graphify.)

Database location, in order of precedence:
  1. $BRAIN_DB
  2. <repo>/data/knowledge.db   (derived from this file's location)

Fails open: any error exits 0 with no output, so a broken hook can never stop a
session from starting.
"""
import json
import os
import sqlite3
import sys
import time

# <repo>/hooks/session_context.py -> <repo>/data/knowledge.db
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("BRAIN_DB") or os.path.join(_REPO, "data", "knowledge.db")

MAX_LESSONS = int(os.environ.get("BRAIN_HOOK_MAX_LESSONS", "12"))
MAX_CHARS = int(os.environ.get("BRAIN_HOOK_MAX_CHARS", "4000"))
# Projects whose `critical` lessons are cross-cutting and injected in every
# session regardless of cwd — tooling traps, harness rules, destructive-command
# lessons. Comma-separated. Set to "" to disable.
GLOBAL_PROJECTS = [p for p in os.environ.get(
    "BRAIN_HOOK_GLOBAL_PROJECTS", "claude-code-setup").split(",") if p.strip()]
MAX_GLOBAL_CRITICALS = int(os.environ.get("BRAIN_HOOK_MAX_GLOBAL", "4"))
SNIPPET_CHARS = 220
STATE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "hooks", "brain", "state")


def project_name(cwd: str) -> str:
    return os.path.basename(cwd.rstrip("/")) or "unknown"


def find_graph(cwd: str):
    """Look for graphify-out/graph.json in cwd and up to 3 levels above."""
    d = os.path.abspath(cwd)
    for _ in range(4):
        g = os.path.join(d, "graphify-out", "graph.json")
        if os.path.exists(g):
            nodes = None
            try:
                # read the manifest, never parse the multi-MB graph.json
                with open(os.path.join(d, "graphify-out", "manifest.json")) as f:
                    man = json.load(f)
                nodes = man.get("node_count") or None
            except Exception:
                pass
            return os.path.relpath(g, cwd), nodes
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None, None


def connect_ro():
    if not os.path.exists(DB):
        return None
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2.0)
    except Exception:
        return None


def fetch_lessons(project: str):
    """Lessons for this project, plus cross-cutting criticals from anywhere.

    Project-scoped recall alone has a blind spot: a critical lesson about
    tooling ("never propagate an edit with cp") gets filed under whatever
    project was open when it was learned, and is then invisible everywhere
    else — including the projects where the mistake would actually recur.
    Criticals from GLOBAL_PROJECTS are therefore injected regardless of cwd.
    """
    con = connect_ro()
    if con is None:
        return []
    try:
        # The second clause makes git worktrees inherit the parent project's
        # lessons: cwd "myapp-hotfix" still matches project "myapp".
        rows = con.execute(
            "SELECT category, content, severity, project FROM lessons "
            "WHERE project = ? OR ? LIKE project || '%' "
            "ORDER BY CASE severity WHEN 'critical' THEN 0 "
            "WHEN 'important' THEN 1 WHEN 'high' THEN 1 ELSE 2 END, "
            "updated_at DESC LIMIT ?",
            (project, project, MAX_LESSONS),
        ).fetchall()
        seen = {r[1] for r in rows}
        room = max(0, MAX_LESSONS + MAX_GLOBAL_CRITICALS - len(rows))
        if room and GLOBAL_PROJECTS:
            marks = ",".join("?" * len(GLOBAL_PROJECTS))
            extra = con.execute(
                f"SELECT category, content, severity, project FROM lessons "
                f"WHERE severity = 'critical' AND project IN ({marks}) "
                f"ORDER BY updated_at DESC LIMIT ?",
                (*GLOBAL_PROJECTS, min(room, MAX_GLOBAL_CRITICALS)),
            ).fetchall()
            rows += [r for r in extra if r[1] not in seen]
        return rows
    except Exception:
        return []
    finally:
        con.close()


def write_marker(session_id: str):
    """Record the lesson count at session start.

    The Stop hook compares against this to tell whether anything was learned.
    """
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        n = -1
        con = connect_ro()
        if con is not None:
            try:
                n = int(con.execute("SELECT COUNT(*) FROM lessons").fetchone()[0])
            finally:
                con.close()
        with open(os.path.join(STATE_DIR, f"{session_id}.json"), "w") as f:
            json.dump({"started": time.time(), "baseline_lessons": n}, f)
        cutoff = time.time() - 7 * 86400
        for fn in os.listdir(STATE_DIR):
            p = os.path.join(STATE_DIR, fn)
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    cwd = payload.get("cwd") or os.getcwd()
    project = project_name(cwd)
    write_marker(payload.get("session_id") or "nosession")

    parts = []
    lessons = fetch_lessons(project)
    if lessons:
        parts.append(f"## brain-mcp memory — {project} ({len(lessons)} lessons)")
        parts.append(
            "Knowledge from earlier sessions. Verify before acting on it — it may "
            "be stale relative to the current code."
        )
        for cat, content, sev, proj in lessons:
            flag = "!" if sev in ("critical", "important", "high") else "-"
            # mark cross-cutting criticals so they aren't mistaken for
            # something specific to the project currently open
            tag = f"[{cat}]" if proj == project else f"[{cat} · {proj}]"
            one = " ".join(str(content).split())[:SNIPPET_CHARS]
            parts.append(f"{flag} {tag} {one}")
        parts.append(
            "\nUse `brain_recall` to read any of these in full, and `brain_learn` "
            "to record anything non-obvious you discover this session."
        )

    graph, nodes = find_graph(cwd)
    if graph:
        size = f", {nodes} nodes" if nodes else ""
        parts.append(f"\n## graphify code graph available ({graph}{size})")
        parts.append(
            "This project has a prebuilt knowledge graph. For questions about "
            "architecture, dependencies, or where code lives, query the graph "
            "(`graphify explain \"X\"`, `graphify path \"A\" \"B\"`) BEFORE grepping "
            "or bulk-reading files — it is the cheaper way to navigate."
        )

    if not parts:
        return

    text = "\n".join(parts)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "\n… (truncated)"

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        }
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never block session start
    sys.exit(0)
