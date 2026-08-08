#!/usr/bin/env python3
"""UserPromptSubmit — surface the lessons that are relevant to THIS task.

WHY THIS HOOK EXISTS
====================
Everything else in brain-mcp was already good at capturing lessons and close to
inert at recalling them. Measured on 2026-08-08 against 297 stored lessons:

  * 6 of 297 (2%) could ever be seen outside the project they were filed under.
  * A session in the largest project saw 12 of its 124 — and since 60 of those
    are `critical`, the twelve slots never reached `important` or `info` at all.
  * Ranking was severity, then `updated_at DESC`. Recency. Never relevance.
  * Writing was enforced by a BLOCKING Stop hook. Reading was one 220-character
    preview at session start and nothing afterwards.

The deeper problem is one of timing, and no amount of tuning the SessionStart
hook fixes it: **at session start nobody knows what the session is about.** The
best possible answer to "which lessons matter?" before the first prompt is a
guess, and a guess spent 12 slots on the most recent criticals of one project.

So this hook runs when the task is finally known — on the prompt itself — and
searches the FTS5 index that the schema has always maintained and no hook ever
queried. `brain_recall` already does exactly this search, well, with hybrid
fusion; it was simply never invoked, because invoking it was left to the model's
discretion and the model does not know what it does not know.

WHAT IT DOES NOT DO
===================
It does not block, it does not nag, and it stays quiet unless something actually
matches. A memory system that interrupts every prompt with three vaguely related
paragraphs teaches people to ignore it, which is worse than silence — the lesson
that would have mattered arrives in a block already tuned out.
"""

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _brain_db as bd  # noqa: E402

# Deliberately small. Three relevant lessons get read; ten get skimmed.
MAX_LESSONS = int(os.environ.get("BRAIN_PROMPT_MAX_LESSONS", "3"))
MAX_CHARS_PER_LESSON = int(os.environ.get("BRAIN_PROMPT_MAX_LESSON_CHARS", "1200"))
MAX_CHARS = int(os.environ.get("BRAIN_PROMPT_MAX_CHARS", "3000"))

# bm25 is "lower is better", so boosts SUBTRACT. The numbers are deliberately
# coarse: this is a tie-breaker over a text-relevance score, not a ranking model.
# Anything finer would be false precision over a corpus of a few hundred rows.
BOOST_SAME_PROJECT = 2.0
BOOST_GLOBAL_SCOPE = 1.0
BOOST_SEVERITY = {"critical": 1.5, "important": 0.75, "high": 0.75}

# Below this, a "match" is a coincidence of one common word. Tuned to keep the
# hook silent rather than chatty: an irrelevant hit costs more than a miss,
# because it is what teaches the reader to stop reading.
MIN_TERMS = 2


def project_name(cwd):
    """The project a path belongs to, with worktrees folded into their parent.

    `myapp-session-payments` is `myapp`: a git worktree is the same project, and
    a lesson learned in the main checkout must reach the sessions cut from it.
    """
    base = os.path.basename(os.path.abspath(cwd or "."))
    return re.sub(r"-(session|hotfix|worktree)-.*$", "", base)


def already_shown(session_id):
    """Lesson ids this session has already been given, by any hook."""
    try:
        p = os.path.join(bd.STATE_DIR, f"{session_id}.json")
        with open(p) as f:
            return set(json.load(f).get("shown", []))
    except Exception:
        return set()


def record_shown(session_id, ids):
    """Remember what was shown, and count it on the lessons themselves.

    Read-modify-write rather than overwrite: the same marker file carries the
    Stop hook's baseline, and clobbering it would silently disable the prompt
    that asks for a lesson at the end of a session.
    """
    if not ids:
        return
    try:
        os.makedirs(bd.STATE_DIR, exist_ok=True)
        p = os.path.join(bd.STATE_DIR, f"{session_id}.json")
        state = {}
        try:
            with open(p) as f:
                state = json.load(f)
        except Exception:
            state = {}
        state["shown"] = sorted(set(state.get("shown", [])) | set(ids))
        with open(p, "w") as f:
            json.dump(state, f)
    except Exception:
        pass

    con = bd.connect(readonly=False)
    if con is None:
        return
    try:
        if not bd.migrate(con):
            return
        now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
        con.executemany(
            "UPDATE lessons SET shown_count = COALESCE(shown_count, 0) + 1, "
            "last_shown_at = ? WHERE id = ?",
            [(now, i) for i in ids],
        )
        con.commit()
    except Exception:
        pass
    finally:
        try:
            con.close()
        except Exception:
            pass


def search(prompt, project, exclude):
    """Rank lessons by relevance to the prompt, across every project."""
    query = bd.fts_query(prompt)
    if not query or query.count(" OR ") + 1 < MIN_TERMS:
        return []

    con = bd.connect(readonly=True)
    if con is None:
        return []
    try:
        has_scope = "scope" in bd.columns(con)
        scope_col = "COALESCE(l.scope, 'project')" if has_scope else "'project'"
        rows = con.execute(
            f"""
            SELECT l.id, l.category, l.content, l.severity, l.project,
                   {scope_col} AS scope, bm25(lessons_fts) AS rank
            FROM lessons_fts
            JOIN lessons l ON l.id = lessons_fts.rowid
            WHERE lessons_fts MATCH ?
            ORDER BY rank
            LIMIT 60
            """,
            (query,),
        ).fetchall()
    except Exception:
        return []
    finally:
        con.close()

    scored = []
    for lid, cat, content, sev, proj, scope, rank in rows:
        if lid in exclude:
            continue
        score = float(rank)
        # SAME PROJECT WINS TIES, IT DOES NOT WIN OUTRIGHT.
        # That asymmetry is the whole point: a bash trap learned in one
        # repository is exactly the lesson that stops the same mistake in
        # another, and project-scoped recall is what made it invisible.
        if proj and proj == project:
            score -= BOOST_SAME_PROJECT
        if scope == "global":
            score -= BOOST_GLOBAL_SCOPE
        score -= BOOST_SEVERITY.get(sev, 0.0)
        scored.append((score, lid, cat, content, sev, proj))

    scored.sort(key=lambda r: r[0])
    return scored[:MAX_LESSONS]


def render(hits, project):
    parts = [
        "## brain-mcp — lessons that match what you just asked",
        "Retrieved by relevance to this prompt, from every project rather than "
        "only the current one. Verify before acting: a lesson records what was "
        "true when it was written.",
    ]
    for _score, lid, cat, content, sev, proj in hits:
        where = "this project" if proj == project else (proj or "unfiled")
        text = str(content).strip()
        if len(text) > MAX_CHARS_PER_LESSON:
            text = text[:MAX_CHARS_PER_LESSON].rstrip() + " …"
        parts.append(f"\n### #{lid} · {cat} · {sev} · {where}\n{text}")
    out = "\n".join(parts)
    return out[:MAX_CHARS] if len(out) > MAX_CHARS else out


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    prompt = payload.get("prompt") or ""
    if not str(prompt).strip():
        return

    cwd = payload.get("cwd") or os.getcwd()
    session_id = payload.get("session_id") or "nosession"
    project = project_name(cwd)

    hits = search(prompt, project, already_shown(session_id))
    if not hits:
        return

    record_shown(session_id, [h[1] for h in hits])
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": render(hits, project),
        }
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # a memory system must never be the reason a prompt fails
    sys.exit(0)
