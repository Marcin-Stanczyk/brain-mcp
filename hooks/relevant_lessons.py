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
import math
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _brain_db as bd  # noqa: E402
import _brain_vec as bv  # noqa: E402

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

# Added (bm25 is lower-is-better) to anything only the stem query found, so a
# morphological match can fill a slot but never take one from an exact match.
PREFIX_PENALTY = 2.0

# Below this, a "match" is a coincidence of one common word. Tuned to keep the
# hook silent rather than chatty: an irrelevant hit costs more than a miss,
# because it is what teaches the reader to stop reading.
MIN_TERMS = 2

# HOW MUCH OF THE QUESTION A LESSON HAS TO ACTUALLY CONTAIN.
#
# Ranking alone cannot answer "is anything here relevant?" — it only orders
# whatever came back, so the top three of a bad list are still three. Measured
# on the live base on 2026-08-08 the hook fired on 8 prompts out of 10, spending
# ~840 tokens on WooCommerce deploy lessons in reply to "napisz mi funkcję
# sortującą tablicę". Those hits shared exactly ONE term with the question; the
# genuinely relevant ones shared three to five. Coverage separates them where
# bm25 does not, because bm25 is relative to the other candidates and this is a
# question about the question.
#
# Worse than the noise was what the never-repeat rule did with it: asking the
# same thing five times in one session returned fifteen DIFFERENT lessons,
# descending into the ranking — by the fifth prompt they were the 13th to 15th
# best, still at full price. A floor turns that into silence, which is the
# correct answer to "I have already told you everything I know about this".
MIN_COVERED_TERMS = 2
MIN_COVERAGE_RATIO = 0.6

# Weights for merging the lexical ordering with the semantic one, mirroring
# RETRIEVER_WEIGHTS in src/search.ts. Lexical leads because it is precise about
# the words actually used; the vector arm exists to reach the lessons that share
# meaning and no vocabulary at all.
RRF_K = 60

# THE VECTOR ARM OUTWEIGHS THE LEXICAL ONE, WHICH LOOKS BACKWARDS AND IS NOT.
# It has already passed a bar: only passages above MIN_SIMILARITY reach the
# fusion at all. The lexical list is unfiltered and up to sixty rows deep, and
# its tail is close to noise. The first attempt weighted lexical higher over the
# full list and the result was that vectors changed NOTHING — the head of a
# 60-row list at weight 2.0 outscores the best possible vector hit at 1.5, so
# every slot was already taken before the semantic arm was consulted.
W_LEXICAL = float(os.environ.get("BRAIN_W_LEXICAL", "1.5"))
W_VECTOR = float(os.environ.get("BRAIN_W_VECTOR", "2.0"))

# Only the head of the lexical ranking competes, for the same reason. Roughly
# three times MAX_LESSONS: enough candidates to fill the slots, few enough that
# the tail cannot crowd out semantic evidence. Below this the fusion is
# unaffected when no backend is configured — the top three of the top eight are
# the top three.
#
# CALIBRATED ON THREE JUDGED QUESTIONS, WHICH IS THIN. Depth 6 scored marginally
# better and 8 is the more conservative pick; redo it properly against a real
# judged set before treating either number as load-bearing.
LEX_DEPTH = int(os.environ.get("BRAIN_LEX_DEPTH", "8"))
# ...but capped, because a ratio alone scales the wrong way. A ten-word question
# would demand six shared terms, which no lesson has, so the hook would fall
# silent exactly when the user finally gave it plenty to work with. Three shared
# terms is strong evidence however long the question is.
MAX_COVERAGE_FLOOR = 3


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


def _fuse(scored, vector_hits):
    """Merge the lexical ordering with the semantic one by reciprocal rank.

    Unweighted RRF would give both lists' top hit the same score, which is wrong
    when they differ in precision — the lexical arm knows which words were
    actually used. Ties break towards the lexical order, which is deterministic.
    """
    lexical_order = [r[1] for r in scored if r[0] != 0.0][:LEX_DEPTH]
    points = {}
    for rank, lid in enumerate(lexical_order):
        points[lid] = points.get(lid, 0.0) + W_LEXICAL / (RRF_K + rank + 1)
    for rank, (lid, _sim, _chunk) in enumerate(vector_hits[:LEX_DEPTH]):
        points[lid] = points.get(lid, 0.0) + W_VECTOR / (RRF_K + rank + 1)

    by_id = {r[1]: r for r in scored}
    ordered = sorted(points, key=lambda lid: (-points[lid], by_id[lid][0] if lid in by_id else 0))
    return [by_id[lid] for lid in ordered if lid in by_id]


def search(prompt, project, exclude):
    """Rank lessons by relevance to the prompt, across every project."""
    if len(bd.fts_terms(prompt)) < MIN_TERMS:
        return []
    query = bd.fts_query(prompt)
    if not query:
        return []

    con = bd.connect(readonly=True)
    if con is None:
        return []
    try:
        has_scope = "scope" in bd.columns(con)
        scope_col = "COALESCE(l.scope, 'project')" if has_scope else "'project'"
        sql = f"""
            SELECT l.id, l.category, l.content, l.severity, l.project,
                   {scope_col} AS scope, bm25(lessons_fts) AS rank
            FROM lessons_fts
            JOIN lessons l ON l.id = lessons_fts.rowid
            WHERE lessons_fts MATCH ?
            ORDER BY rank
            LIMIT 60
            """
        rows = con.execute(sql, (query,)).fetchall()

        # A SECOND PASS OVER STEMS, NOT A REPLACEMENT FOR THE FIRST.
        # `zamówieniach` in the prompt and `zamówienia` in the lesson are one
        # word to a reader and two to FTS5. The stem query finds those, and
        # PREFIX_PENALTY keeps them below anything the exact query matched —
        # a shared stem is weaker evidence than a shared word, not equal to it.
        prefix = bd.fts_prefix_query(prompt)
        if prefix:
            seen_ids = {r[0] for r in rows}
            for row in con.execute(sql, (prefix,)).fetchall():
                if row[0] not in seen_ids:
                    rows.append(row[:6] + (float(row[6]) + PREFIX_PENALTY,))
    except Exception:
        return []
    finally:
        con.close()

    # The stems the retrievers matched on, so a lesson found through an inflected
    # form counts the word it actually shares rather than being penalised twice.
    stems = [w[:5] if len(w) >= 6 else w for w in bd.fts_terms(prompt)]
    floor = min(MAX_COVERAGE_FLOOR,
                max(MIN_COVERED_TERMS, math.ceil(len(stems) * MIN_COVERAGE_RATIO)))

    scored = []
    for lid, cat, content, sev, proj, scope, rank in rows:
        if lid in exclude:
            continue
        # A lesson has to contain enough of the question to be worth 800 tokens
        # of somebody's context. Below the floor there is no ranking to do.
        if sum(1 for stem in stems if stem in str(content).lower()) < floor:
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

    # SEMANTIC EVIDENCE, WHICH THE COVERAGE FLOOR ABOVE CANNOT SEE.
    # An English question about a Polish lesson shares meaning and, by
    # construction, no terms — so vector hits are collected separately and are
    # never subject to the floor. Silence when the backend is unreachable: the
    # lexical ordering is already complete.
    vector_hits = []
    con = bd.connect(readonly=True)
    if con is not None:
        try:
            vec = bv.embed(prompt)
            if vec:
                by_id = {r[1]: r for r in scored}
                for lid, sim, chunk in sorted(
                    bv.nearest_passages(con, vec, k=30), key=lambda r: -r[1]
                ):
                    if lid in exclude:
                        continue
                    if lid in by_id:
                        vector_hits.append((lid, sim, chunk))
                        continue
                    row = con.execute(
                        "SELECT id, category, content, severity, project FROM lessons WHERE id = ?",
                        (lid,),
                    ).fetchone()
                    if row:
                        # score 0.0: it plays no part in the lexical ordering,
                        # only in the fusion below.
                        scored.append((0.0, row[0], row[1], row[2], row[3], row[4]))
                        vector_hits.append((lid, sim, chunk))
        except Exception:
            vector_hits = []
        finally:
            con.close()

    top = _fuse(scored, vector_hits)[:MAX_LESSONS]

    # Replace the head of each long lesson with the passage that matched. A
    # second, cheap query rather than a join: only a handful of lessons survive
    # the ranking, and the passage index is the one part of the schema a base
    # written before it existed will not have.
    con = bd.connect(readonly=True)
    if con is not None:
        try:
            chunks = bd.best_chunks(con, prompt, [row[1] for row in top])
        except Exception:
            chunks = {}
        finally:
            con.close()
        # A lesson found by meaning has no shared words for best_chunks to rank,
        # so the passage the vector arm matched is the only one that makes sense.
        for lid, _sim, chunk in vector_hits:
            chunks.setdefault(lid, chunk)
        top = [row + (chunks.get(row[1]),) for row in top]
    else:
        top = [row + (None,) for row in top]

    return top


def render(hits, project):
    parts = [
        "## brain-mcp — lessons that match what you just asked",
        "Retrieved by relevance to this prompt, from every project rather than "
        "only the current one. Verify before acting: a lesson records what was "
        "true when it was written.",
    ]
    for _score, lid, cat, content, sev, proj, chunk in hits:
        where = "this project" if proj == project else (proj or "unfiled")
        full = str(content).strip()
        # SHOW THE PART THAT MATCHED, NOT THE FIRST PART.
        # Truncating a "PROBLEM — … FIX —" lesson from the top delivers the
        # setup and cuts before the answer, which reads as a lesson that does
        # not say anything — the worst possible use of the three slots.
        if chunk and len(full) > MAX_CHARS_PER_LESSON:
            text = str(chunk).strip()
            suffix = f"\n… matching passage of a {len(full)}-character lesson"
        else:
            text = full
            suffix = ""
        if len(text) > MAX_CHARS_PER_LESSON:
            text = text[:MAX_CHARS_PER_LESSON].rstrip() + " …"
        parts.append(f"\n### #{lid} · {cat} · {sev} · {where}\n{text}{suffix}")
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
