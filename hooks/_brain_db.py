"""Shared database access for the hooks.

The hooks used to open the database three separate ways. This is one, for the
same reason `agent-worktrees` now ships one copy of its shell function: two
copies of anything load-bearing drift, and the drift is silent.

Nothing here may raise into a hook. Every function either works or returns a
value that lets the caller carry on doing nothing — a hook that throws is a hook
that breaks somebody's session, and a memory system that breaks sessions gets
uninstalled long before it gets useful.
"""

import os
import re
import sqlite3

# Overridable so the tests can run against a throwaway directory. Without this
# the suite would read and write the state of whatever real session is open.
STATE_DIR = os.environ.get("BRAIN_STATE_DIR") or os.path.join(
    os.path.expanduser("~"), ".claude", "hooks", "brain", "state"
)

DB = os.environ.get(
    "BRAIN_DB",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "knowledge.db"),
)

# Columns added after the fact. Kept here as data rather than as DDL scattered
# through three files, and asserted against the TypeScript schema by the tests —
# so a column added on one side and forgotten on the other turns something red.
EXTRA_COLUMNS = {
    # How often a lesson has actually reached an agent's context, and when last.
    # Without these the system cannot answer the only question that matters —
    # "is any of this being used?" — and neither can its author.
    "shown_count": "INTEGER NOT NULL DEFAULT 0",
    "last_shown_at": "TEXT",
    # 'project' (the default) or 'global'. A lesson about a TOOL — a bash trap, a
    # git behaviour, an API's rate limit — is filed under whichever project was
    # open when it was learned, and was then invisible everywhere the mistake
    # would actually recur. Relevance search crosses projects anyway; this lets a
    # lesson say outright that it is not about one.
    "scope": "TEXT NOT NULL DEFAULT 'project'",
}


def connect(readonly=True, timeout=2.0):
    """Open the database, or return None. Never raises."""
    try:
        if readonly:
            return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=timeout)
        con = sqlite3.connect(DB, timeout=timeout)
        con.execute("PRAGMA busy_timeout = 2000")
        return con
    except Exception:
        return None


def columns(con, table="lessons"):
    try:
        return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
    except Exception:
        return set()


def migrate(con):
    """Add any missing columns. Idempotent, and safe to lose.

    Returns True when the schema is usable afterwards. A read-only or locked
    database returns False and the caller simply skips the feature that needed
    it — instrumentation is worth having, not worth failing a session for.
    """
    try:
        have = columns(con)
        if not have:
            return False
        for name, decl in EXTRA_COLUMNS.items():
            if name not in have:
                con.execute(f"ALTER TABLE lessons ADD COLUMN {name} {decl}")
        con.commit()
        return True
    except Exception:
        return False


# FTS5 treats a pile of punctuation as syntax, and a user's prompt is mostly
# punctuation. Everything that is not a word character becomes a space, tokens
# shorter than three characters go (they match everything and rank nothing), and
# what survives is OR-ed: an AND query over a whole sentence matches nothing.
_WORD = re.compile(r"[^\w]+", re.UNICODE)

# Words that appear in nearly every prompt and would drag in unrelated lessons.
STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "have", "has", "are",
    "was", "were", "not", "but", "you", "your", "can", "will", "would", "should",
    "make", "made", "please", "just", "how", "what", "why", "when", "where",
    "jest", "nie", "tak", "sie", "się", "the", "czy", "jak", "dla", "aby",
    "oraz", "ale", "tego", "tym", "przy", "moze", "może", "bylo", "było",
}


def fts_terms(text, max_terms=24):
    """The search terms in `text`: lowercased, de-duplicated, stopwords dropped.

    Mirrors `tokenizeQuery` in src/query.ts. The two are asserted to agree by the
    test suite, because a hook and a tool that disagree about what a word is will
    disagree about what the knowledge base contains.
    """
    if not text:
        return []
    words = [w.lower() for w in _WORD.split(str(text)) if len(w) >= 3]
    seen, terms = set(), []
    for w in words:
        if w in STOPWORDS or w in seen:
            continue
        seen.add(w)
        terms.append(w)
        if len(terms) >= max_terms:
            break
    return terms


def fts_query(text, max_terms=24):
    """A sanitised OR-query, or "" when there is nothing worth searching for."""
    # Quoted, so a token that happens to be an FTS5 keyword (NEAR, AND, OR) is
    # treated as text rather than as syntax.
    return " OR ".join(f'"{w}"' for w in fts_terms(text, max_terms))


def fts_prefix_query(text, max_terms=24):
    """An OR-query over stems, or "" when no term is long enough to stem.

    Polish inflects the end of a word: a lesson written about `zamówień` is
    invisible to a prompt that says `zamówieniach`, and both are the same thing.
    Two inflections only meet at the stem they share, and that stem is short —
    `kosztach` and `koszty` have five characters in common — so a long term is
    cut to a fixed cap rather than trimmed by a fixed amount. Mirrors
    `stemForPrefix` in src/query.ts; the TypeScript tests assert the two agree.

    Returns "" when nothing was cut — an identical query run twice is just
    noise in the ranking.
    """
    terms = fts_terms(text, max_terms)
    stems = [w[:5] if len(w) >= 6 else w for w in terms]
    if stems == terms:
        return ""
    return " OR ".join(f'"{s}"*' for s in stems)


def best_chunks(con, text, lesson_ids, max_terms=24):
    """The passage of each lesson that best matches `text`.

    The long lessons are the ones with the evidence in them, and they are written
    as "PROBLEM — … CAUSE — … FIX —". Truncating from the start spends the
    reader's attention on the setup and cuts before the answer; this returns the
    part that actually matched.

    Mirrors the chunk retrievers in src/search.ts. Returns {} rather than raising
    when the passage index is missing — a base written before it existed still
    answers from whole lessons, and a hook may never be the reason a prompt
    fails.
    """
    if not lesson_ids:
        return {}
    query = fts_query(text, max_terms)
    if not query:
        return {}
    placeholders = ",".join("?" for _ in lesson_ids)
    try:
        rows = con.execute(
            f"""
            SELECT c.lesson_id, c.text
            FROM lesson_chunks_fts f
            JOIN lesson_chunks c ON c.id = f.rowid
            WHERE lesson_chunks_fts MATCH ? AND c.lesson_id IN ({placeholders})
            ORDER BY bm25(lesson_chunks_fts)
            """,
            (query, *lesson_ids),
        ).fetchall()
    except Exception:
        return {}
    best = {}
    for lesson_id, chunk in rows:
        best.setdefault(lesson_id, chunk)  # rows arrive best-first
    return best
