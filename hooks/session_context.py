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
     The note is downgraded to a warning when the graph is behind HEAD: a stale
     index is worse than none, because this hook is what tells the agent to
     trust it over grep.

Database location, in order of precedence:
  1. $BRAIN_DB
  2. <repo>/data/knowledge.db   (derived from this file's location)

Fails open: any error exits 0 with no output, so a broken hook can never stop a
session from starting.
"""
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _brain_db  # noqa: E402
import subprocess
import sys
import time

# <repo>/hooks/session_context.py -> <repo>/data/knowledge.db
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("BRAIN_DB") or os.path.join(_REPO, "data", "knowledge.db")

MAX_LESSONS = int(os.environ.get("BRAIN_HOOK_MAX_LESSONS", "12"))
MAX_CHARS = int(os.environ.get("BRAIN_HOOK_MAX_CHARS", "4000"))
# Projects whose `critical` lessons are cross-cutting and injected in every
# session regardless of cwd — tooling traps, harness rules, destructive-command
# lessons. Comma-separated project names, empty (the default) disables it.
# Deliberately not defaulted to a project name: which projects are cross-cutting
# is a property of your knowledge base, not of this engine.
GLOBAL_PROJECTS = [p.strip() for p in os.environ.get(
    "BRAIN_HOOK_GLOBAL_PROJECTS", "").split(",") if p.strip()]
MAX_GLOBAL_CRITICALS = int(os.environ.get("BRAIN_HOOK_MAX_GLOBAL", "4"))
SNIPPET_CHARS = 220
STATE_DIR = _brain_db.STATE_DIR   # one definition, in _brain_db


def clip(text: str, limit: int) -> str:
    """Cut to `limit`, on a word boundary, with an ellipsis when shortened.

    Cutting mid-word ("wygladaja jak j") reads as a corrupted lesson rather than
    a shortened one, and the reader cannot tell which it is.
    """
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,.;:") + " …"


def project_name(cwd: str) -> str:
    return os.path.basename(cwd.rstrip("/")) or "unknown"


# graph.json can be tens of MB; built_at_commit is a top-level key written last,
# so a bounded tail read finds it without parsing the whole document.
GRAPH_TAIL_BYTES = 4096
GRAPH_PARSE_LIMIT = 32 * 1024 * 1024  # only fall back to a full parse below this
_COMMIT_RE = re.compile(rb'"built_at_commit"\s*:\s*"([0-9a-fA-F]{7,40})"')


def graph_commit(graph_path: str):
    """The commit a graph was built from, or None if it doesn't record one."""
    try:
        size = os.path.getsize(graph_path)
        with open(graph_path, "rb") as f:
            f.seek(max(0, size - GRAPH_TAIL_BYTES))
            m = _COMMIT_RE.search(f.read())
        if m:
            return m.group(1).decode()
        # Key isn't at the tail (different writer or key order) — parse, but only
        # if that is cheap enough to do on every session start.
        if size <= GRAPH_PARSE_LIMIT:
            with open(graph_path, encoding="utf-8") as f:
                return json.load(f).get("built_at_commit") or None
    except Exception:
        pass
    return None


def git(root: str, *args, timeout=2.0):
    """Run a read-only git command, returning stripped stdout or None."""
    try:
        r = subprocess.run(("git", "-C", root) + args, capture_output=True,
                           text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def outdated_sources(root: str, graph_path: str, manifest, limit=8000):
    """Indexed files that changed on disk after the graph was written.

    Timestamps, not commits, are the honest test of whether an index describes
    the current code. Commit comparison has two failure modes that timestamps
    do not: uncommitted edits look current, and an indexer that skips a commit
    without restamping looks permanently stale. This also keeps the engine
    indexer-agnostic — no language list, no coupling to which extensions some
    indexer decided are worth rebuilding for.

    Returns (changed, deleted), or (None, None) when it cannot be determined.
    """
    if not manifest:
        return None, None
    try:
        graph_mtime = os.path.getmtime(graph_path)
    except OSError:
        return None, None
    changed = deleted = 0
    for i, rel in enumerate(manifest):
        if i >= limit:  # pathological repo: stop rather than stall a session
            break
        try:
            if os.path.getmtime(os.path.join(root, rel)) > graph_mtime:
                changed += 1
        except OSError:
            deleted += 1
    return changed, deleted


def graph_drift(root: str, graph_path: str, manifest=None) -> dict:
    """How far a graph has fallen behind the working tree.

    Keys: changed/deleted (indexed files newer than the graph, None = unknown),
    behind (commits, informational only), is_repo.

    Freshness is decided by `changed`/`deleted`; the commit count only makes
    the message concrete. Note the two are independent — a graph can be zero
    commits behind and still stale from uncommitted edits.
    """
    out = {"is_repo": False, "behind": None, "changed": None, "deleted": None}
    out["changed"], out["deleted"] = outdated_sources(root, graph_path, manifest)

    head = git(root, "rev-parse", "HEAD")
    if head is None:
        return out
    out["is_repo"] = True

    built = graph_commit(graph_path)
    if not built:
        return out
    if head.startswith(built) or built.startswith(head):
        out["behind"] = 0
        return out
    n = git(root, "rev-list", "--count", f"{built}..HEAD")
    try:
        out["behind"] = int(n)
    except (TypeError, ValueError):
        pass  # unreachable commit: rewritten history or a different clone
    return out


def find_graph(cwd: str):
    """Look for graphify-out/graph.json in cwd and up to 3 levels above.

    Returns (relpath, files_indexed, drift) or (None, None, None).
    """
    d = os.path.abspath(cwd)
    for _ in range(4):
        out = os.path.join(d, "graphify-out")
        g = os.path.join(out, "graph.json")
        if os.path.exists(g):
            man = None
            try:
                # manifest.json maps source path -> hashes, one entry per
                # indexed file. It carries no node count — don't invent one.
                with open(os.path.join(out, "manifest.json")) as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict) and loaded:
                    man = loaded
            except Exception:
                pass
            files = len(man) if man else None
            return os.path.relpath(g, cwd), files, graph_drift(d, g, man)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None, None, None


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

        # LESSONS MARKED `global` BELONG IN EVERY SESSION — THAT IS THE COLUMN.
        # This hook filtered by project alone, so a session in any other
        # repository opened with none of them. Measured on 2026-08-10: twelve
        # lessons were marked global — `set -euo pipefail` piped into head,
        # `git checkout --` after a mutation test, a Stripe signature trap — and
        # a session in kanarix or vs-beauty saw zero. brain_recall and the
        # prompt hook were taught to cross the project boundary; this one was
        # not, which is the place it matters most: before the first token.
        if room and "scope" in {r[1] for r in con.execute("PRAGMA table_info(lessons)")}:
            extra = con.execute(
                "SELECT category, content, severity, project FROM lessons "
                "WHERE COALESCE(scope, 'project') = 'global' "
                "  AND project IS NOT ? "
                "ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, "
                "         updated_at DESC LIMIT ?",
                (project, min(room, MAX_GLOBAL_CRITICALS)),
            ).fetchall()
            for r in extra:
                if r[1] not in seen:
                    rows.append(r)
                    seen.add(r[1])
            room = max(0, MAX_LESSONS + MAX_GLOBAL_CRITICALS - len(rows))

        # Retained for bases that predate `scope`: naming whole projects as
        # cross-cutting was the older way of saying the same thing.
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


QUERY_HINT = ('`graphify explain "X"`, `graphify path "A" "B"`')


def graph_note(graph: str, files, drift: dict) -> str:
    """Phrase the graph note according to how much the graph can be trusted.

    This hook is the only thing telling the agent to prefer the graph over
    grep, so it is also the only thing that can withdraw that advice. Grep is
    always current; the graph is only as current as its last build.
    """
    behind = (drift or {}).get("behind")
    changed = (drift or {}).get("changed")
    deleted = (drift or {}).get("deleted") or 0
    size = f", {files} files indexed" if files else ""

    if changed is None:
        # No manifest, or it could not be read — nothing to compare against.
        return (
            f"\n## graphify code graph available, freshness UNVERIFIED ({graph}{size})\n"
            "A graph exists but its freshness cannot be checked (no readable "
            f"manifest). Use it to orient ({QUERY_HINT}), then confirm with grep "
            "before relying on it."
        )

    if not changed and not deleted:
        extra = (f" ({behind} commit(s) behind HEAD, none affecting indexed files)"
                 if behind else "")
        return (
            f"\n## graphify code graph available ({graph}{size}, verified current"
            f"{extra})\n"
            "Every indexed file is older than the graph. For questions about "
            "architecture, dependencies, or where code lives, query the graph "
            f"({QUERY_HINT}) BEFORE grepping or bulk-reading files — it is the "
            "cheaper way to navigate."
        )

    bits = []
    if changed:
        bits.append(f"{changed} indexed file(s) modified since it was built")
    if deleted:
        bits.append(f"{deleted} indexed file(s) no longer exist")
    if behind:
        bits.append(f"{behind} commit(s) behind HEAD")
    return (
        f"\n## graphify code graph is STALE ({graph}{size} — {'; '.join(bits)})\n"
        f"Use it only as a map of where things roughly are ({QUERY_HINT}). Do NOT "
        "treat an absent node as proof that code does not exist, and confirm "
        "anything load-bearing with grep or by reading the file — grep reflects "
        "what is on disk now, the graph reflects an earlier state.\n"
        "Refresh with `graphify update <repo>` when the answer depends on it."
    )


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
            one = clip(" ".join(str(content).split()), SNIPPET_CHARS)
            parts.append(f"{flag} {tag} {one}")
        parts.append(
            "\nUse `brain_recall` to read any of these in full, and `brain_learn` "
            "to record anything non-obvious you discover this session."
        )

    graph, files, drift = find_graph(cwd)
    if graph:
        parts.append(graph_note(graph, files, drift))

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
