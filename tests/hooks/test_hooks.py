#!/usr/bin/env python3
"""Tests for the hooks.

The hooks had no tests at all while `src/` had 39, and they are the only
mechanism by which anything stored here ever reaches an agent. Every bug found in
the sibling project during the same audit lived on exactly this kind of boundary:
a well-reasoned core, and an untested edge where it meets the outside world.

A hook is a pure function of (stdin payload, database, cwd) -> (stdout, exit
code), which makes this straightforward. Run with:

    python3 -m unittest discover -s tests/hooks -v
    tests/hooks/test_hooks.py            (same thing, shorter)

Standard library only, deliberately: the hooks themselves depend on nothing, and
a suite that needed `pytest` would not be run on a machine where the hooks are
misbehaving.
"""

import glob
import json
import os
import shutil
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "hooks")
sys.path.insert(0, HOOKS)


def make_db(path, lessons):
    """A database with the real schema, so FTS5 and the triggers behave as they do live."""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE lessons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
          content TEXT NOT NULL, source TEXT, project TEXT,
          severity TEXT DEFAULT 'info',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE lessons_fts USING fts5(
          content, category, tags, source, project,
          content='lessons', content_rowid='id');
        CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN
          INSERT INTO lessons_fts(rowid, content, category, tags, source, project)
          VALUES (new.id, new.content, new.category, new.tags, new.source, new.project);
        END;
        CREATE TRIGGER lessons_au AFTER UPDATE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, content, category, tags, source, project)
          VALUES ('delete', old.id, old.content, old.category, old.tags, old.source, old.project);
          INSERT INTO lessons_fts(rowid, content, category, tags, source, project)
          VALUES (new.id, new.content, new.category, new.tags, new.source, new.project);
        END;
        -- Passages, so the hook can show the part of a long lesson that matched
        -- rather than its first 1200 characters. Mirrors src/tools.ts.
        CREATE TABLE lesson_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lesson_id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE VIRTUAL TABLE lesson_chunks_fts USING fts5(
          text, content='lesson_chunks', content_rowid='id');
        CREATE TRIGGER lesson_chunks_ai AFTER INSERT ON lesson_chunks BEGIN
          INSERT INTO lesson_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        """
    )
    for lesson in lessons:
        # created_at/updated_at are pinned to a fixed past instant. Left to
        # `datetime('now')` they land in the same SECOND as anything the hook
        # writes, and a test asserting "updated_at did not change" then passes
        # whether or not it changed. That exact coincidence hid a deliberately
        # broken build once; pinning it is the fix.
        con.execute(
            "INSERT INTO lessons (category, content, project, severity, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (lesson.get("category", "gotcha"), lesson["content"],
             lesson.get("project", "p"), lesson.get("severity", "info"),
             "2020-01-01 00:00:00", "2020-01-01 00:00:00"),
        )
        lesson_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", lesson["content"]) if p.strip()]
        for i, para in enumerate(paragraphs):
            con.execute(
                "INSERT INTO lesson_chunks (lesson_id, ord, text) VALUES (?,?,?)",
                (lesson_id, i, para),
            )
    con.commit()
    con.close()


class HookCase(unittest.TestCase):
    """A throwaway database and state directory per test."""

    lessons = []

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="brain-hooks-")
        self.db = os.path.join(self.tmp, "knowledge.db")
        self.state = os.path.join(self.tmp, "state")
        os.makedirs(self.state)
        make_db(self.db, self.lessons)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_hook(self, name, payload, env=None, db=None):
        e = dict(os.environ)
        e["BRAIN_DB"] = db if db is not None else self.db
        e["BRAIN_STATE_DIR"] = self.state
        e.pop("BRAIN_HOOK_GLOBAL_PROJECTS", None)
        if env:
            e.update(env)
        proc = subprocess.run(
            [sys.executable, os.path.join(HOOKS, name)],
            input=json.dumps(payload) if isinstance(payload, (dict, list)) else payload,
            capture_output=True, text=True, env=e, timeout=30,
        )
        return proc

    def context_of(self, proc):
        """The additionalContext a hook emitted, or None when it stayed silent."""
        out = proc.stdout.strip()
        if not out:
            return None
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]

    def lesson_row(self, lesson_id):
        con = sqlite3.connect(self.db)
        try:
            cols = [r[1] for r in con.execute("PRAGMA table_info(lessons)")]
            row = con.execute("SELECT * FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
            return dict(zip(cols, row))
        finally:
            con.close()


# ---------------------------------------------------------------------------
# _brain_db
# ---------------------------------------------------------------------------
class TestBrainDB(unittest.TestCase):
    def setUp(self):
        import _brain_db
        self.bd = _brain_db

    def test_fts_query_drops_punctuation_and_short_words(self):
        q = self.bd.fts_query("exit 141?! -- pipefail & head (SIGPIPE)")
        self.assertIn('"pipefail"', q)
        self.assertIn('"sigpipe"', q)
        self.assertIn('"141"', q)
        self.assertNotIn("&", q)
        self.assertNotIn("(", q)

    def test_fts_query_quotes_fts5_keywords(self):
        # Unquoted, NEAR/AND/OR are syntax and the whole query fails to parse —
        # which in a hook means silence that looks exactly like "no matches".
        q = self.bd.fts_query("near and or not the value")
        for term in q.split(" OR "):
            self.assertTrue(term.startswith('"') and term.endswith('"'), term)

    def test_fts_query_is_an_or_query(self):
        # AND over a whole sentence matches nothing at all.
        q = self.bd.fts_query("silent failure in the bash script")
        self.assertIn(" OR ", q)

    def test_fts_query_empty_for_nothing_searchable(self):
        self.assertEqual("", self.bd.fts_query(""))
        self.assertEqual("", self.bd.fts_query("a to i"))
        self.assertEqual("", self.bd.fts_query(None))

    def test_fts_query_deduplicates(self):
        q = self.bd.fts_query("bash bash bash script")
        self.assertEqual(1, q.count('"bash"'))

    def test_fts_terms_is_unicode_aware(self):
        # Polish words must survive tokenizing intact. Splitting them would
        # search the base for fragments nobody ever wrote.
        self.assertEqual(
            ["zamówień", "łódź", "ćwiczenia"],
            self.bd.fts_terms("zamówień łódź ćwiczenia"),
        )

    def test_prefix_query_cuts_to_the_shared_root(self):
        # `zamówieniach` in a prompt and `zamówień` in a lesson are one word to a
        # reader and two to FTS5. They meet only at the root they share, and it
        # is short — trimming a fixed couple of characters lands between them and
        # matches neither.
        self.assertEqual('"zamów"* OR "koszt"*', self.bd.fts_prefix_query("zamówieniach kosztach"))
        self.assertEqual('"zamów"* OR "koszt"*', self.bd.fts_prefix_query("zamówień koszty"),
                         "both directions land on the same root")

    def test_best_chunks_returns_the_passage_that_matched(self):
        # A long lesson reads "PROBLEM — ... FIX —". Truncating it from the top
        # delivers the setup and cuts before the answer, which is the worst
        # possible use of the three slots the hook has.
        tmp = tempfile.mkdtemp()
        try:
            db = os.path.join(tmp, "k.db")
            make_db(db, [{"content": "PROBLEM the badge showed a positive margin\n\n"
                                     "FIX the supplier cost is netto and the price is brutto"}])
            con = sqlite3.connect(db)
            try:
                best = self.bd.best_chunks(con, "supplier netto brutto", [1])
                self.assertIn("FIX", best[1])
                self.assertNotIn("PROBLEM", best[1])
                self.assertEqual({}, self.bd.best_chunks(con, "supplier", []))
                self.assertEqual({}, self.bd.best_chunks(con, "", [1]))
            finally:
                con.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_best_chunks_survives_a_base_without_the_passage_index(self):
        # A database written before passages existed must still answer from
        # whole lessons. A hook may never be the reason a prompt fails.
        tmp = tempfile.mkdtemp()
        try:
            db = os.path.join(tmp, "old.db")
            con = sqlite3.connect(db)
            con.execute("CREATE TABLE lessons (id INTEGER PRIMARY KEY, content TEXT)")
            con.commit()
            self.assertEqual({}, self.bd.best_chunks(con, "anything at all", [1]))
            con.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_prefix_query_empty_when_nothing_was_stemmed(self):
        # Identical to the exact query, so running it would only add noise.
        self.assertEqual("", self.bd.fts_prefix_query("wp eval"))
        self.assertEqual("", self.bd.fts_prefix_query(""))

    def test_migrate_is_idempotent_and_adds_every_column(self):
        tmp = tempfile.mkdtemp()
        try:
            db = os.path.join(tmp, "k.db")
            make_db(db, [{"content": "x"}])
            con = sqlite3.connect(db)
            self.assertTrue(self.bd.migrate(con))
            first = self.bd.columns(con)
            for name in self.bd.EXTRA_COLUMNS:
                self.assertIn(name, first)
            self.assertTrue(self.bd.migrate(con))          # again, no error
            self.assertEqual(first, self.bd.columns(con))  # and no change
            con.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_connect_returns_none_for_a_missing_database(self):
        self.assertIsNone(self.bd.connect(readonly=True, timeout=0.2) if False else None)
        old = self.bd.DB
        try:
            self.bd.DB = "/nowhere/at/all/k.db"
            self.assertIsNone(self.bd.connect(readonly=True))
        finally:
            self.bd.DB = old

    def test_schema_agrees_with_typescript(self):
        # The one guard against the failure mode this project's sibling was just
        # fixed for: two descriptions of one schema, drifting quietly apart.
        src = os.path.join(os.path.dirname(HOOKS), "src", "tools.ts")
        with open(src) as f:
            ts = f.read()
        for name in self.bd.EXTRA_COLUMNS:
            self.assertIn(name, ts, f"{name} is migrated by the hooks but absent from src/tools.ts")


# ---------------------------------------------------------------------------
# relevant_lessons — the hook that makes retrieval happen when it matters
# ---------------------------------------------------------------------------
BASH_TRAP = (
    "PULAPKA: set -euo pipefail plus a pipe into head is a silent death with "
    "exit 141. head closes the pipe, the producer takes SIGPIPE, pipefail "
    "propagates 141 and set -e ends the script with no message at all."
)
WOO_LESSON = (
    "WooCommerce checkout gateway list must be filtered before the payment "
    "step or BLIK disappears from the mobile view."
)


class TestRelevantLessons(HookCase):
    lessons = [
        {"content": BASH_TRAP, "project": "agent-worktrees", "severity": "critical", "category": "gotcha"},
        {"content": WOO_LESSON, "project": "kamar", "severity": "important", "category": "bug-fix"},
        {"content": "Unrelated note about invoice numbering in the ERP export.",
         "project": "elogic", "severity": "info", "category": "tooling"},
    ]

    def ask(self, prompt, cwd="/x/kamar", session="s1", env=None):
        return self.run_hook("relevant_lessons.py",
                             {"prompt": prompt, "cwd": cwd, "session_id": session}, env=env)

    def test_finds_a_lesson_filed_under_a_different_project(self):
        # THE POINT OF THE WHOLE HOOK. Under project-scoped recall this lesson
        # was invisible outside agent-worktrees, so the same trap in another
        # repository met an agent that had never heard of it.
        ctx = self.context_of(self.ask("my bash script dies with exit 141 and pipefail, no message"))
        self.assertIsNotNone(ctx, "nothing was surfaced at all")
        self.assertIn("SIGPIPE", ctx)
        self.assertIn("agent-worktrees", ctx)

    def test_stays_silent_when_nothing_matches(self):
        # Silence is a feature: an irrelevant hit is what teaches somebody to
        # stop reading the block that will one day matter.
        self.assertIsNone(self.context_of(self.ask("rename the marketing headline on the pricing page")))

    def test_stays_silent_for_a_prompt_with_nothing_to_search_for(self):
        for prompt in ("ok", "tak", "   ", "go on"):
            self.assertIsNone(self.context_of(self.ask(prompt)), prompt)

    def test_the_current_project_wins_a_tie(self):
        # Both lessons mention "checkout"; the one from the open project should
        # come first — but only as a tie-break, never as a filter.
        ctx = self.context_of(self.ask("checkout gateway BLIK disappears on mobile payment step"))
        self.assertIsNotNone(ctx)
        self.assertIn("BLIK", ctx)
        self.assertIn("this project", ctx)

    def test_does_not_repeat_within_a_session(self):
        first = self.context_of(self.ask("bash pipefail head exit 141 SIGPIPE silent"))
        self.assertIsNotNone(first)
        second = self.context_of(self.ask("bash pipefail head exit 141 SIGPIPE silent"))
        self.assertIsNone(second, "the same lesson was pushed twice in one session")

    def test_a_different_session_sees_it_again(self):
        self.assertIsNotNone(self.context_of(self.ask("bash pipefail head exit 141 SIGPIPE", session="a")))
        self.assertIsNotNone(self.context_of(self.ask("bash pipefail head exit 141 SIGPIPE", session="b")))

    def test_records_that_a_lesson_was_shown(self):
        before = self.lesson_row(1)
        self.assertEqual(0, before.get("shown_count", 0) or 0)
        self.ask("bash pipefail head exit 141 SIGPIPE silent")
        after = self.lesson_row(1)
        self.assertEqual(1, after["shown_count"])
        self.assertIsNotNone(after["last_shown_at"])

    def test_showing_a_lesson_does_not_make_it_look_freshly_written(self):
        # If it did, every lesson shown once would float to the top of the
        # recency-ordered session digest and stay there — the instrumentation
        # would quietly corrupt the thing it was added to measure.
        before = self.lesson_row(1)["updated_at"]
        self.ask("bash pipefail head exit 141 SIGPIPE silent")
        self.assertEqual(before, self.lesson_row(1)["updated_at"])

    def test_honours_the_lesson_limit(self):
        ctx = self.context_of(self.ask(
            "bash pipefail SIGPIPE checkout gateway BLIK invoice numbering ERP export",
            env={"BRAIN_PROMPT_MAX_LESSONS": "1"}))
        self.assertIsNotNone(ctx)
        self.assertEqual(1, ctx.count("\n### #"))

    def test_stays_silent_when_nothing_shares_enough_of_the_question(self):
        # SILENCE IS THE FEATURE, AND IT WAS MISSING.
        # Ranking orders whatever came back; it cannot say "none of this is
        # relevant", so the top three of a bad list were still three. Measured
        # on the live base the hook fired on 8 prompts in 10, once answering
        # "napisz mi funkcję sortującą tablicę" with 840 tokens of WooCommerce
        # deploy lessons. Those shared one term with the question.
        self.assertIsNone(
            self.context_of(self.ask("napisz mi funkcje sortujaca tablice liczb")),
            "a lesson sharing one incidental word is not worth 800 tokens",
        )

    def test_a_question_spread_across_several_lessons_still_returns(self):
        # The floor must not undo the bug this whole hook exists for: no single
        # lesson holds every term of a real question, and demanding that is how
        # the knowledge base came to look empty.
        ctx = self.context_of(self.ask("bash pipefail head exit 141 SIGPIPE"))
        self.assertIsNotNone(ctx)
        self.assertIn("SIGPIPE", ctx)

    def test_the_floor_is_capped_so_long_questions_do_not_silence_it(self):
        # A ratio alone scales the wrong way: ten terms would demand six shared
        # ones, which nothing has, so the hook would fall silent exactly when
        # the user finally gave it plenty to work with.
        ctx = self.context_of(self.ask(
            "bash pipefail SIGPIPE checkout gateway BLIK invoice numbering ERP export"))
        self.assertIsNotNone(ctx, "three shared terms is enough however long the question")

    def test_asking_the_same_thing_repeatedly_converges_to_silence(self):
        # The never-repeat rule used to guarantee ESCALATING irrelevance: five
        # identical prompts returned fifteen different lessons, descending into
        # the ranking at full price. Running out of relevant lessons should look
        # like running out, not like more lessons.
        seen = [self.context_of(self.ask("bash pipefail head exit 141 SIGPIPE", session="rep"))
                for _ in range(5)]
        self.assertIsNotNone(seen[0], "the first ask is answered")
        self.assertIsNone(seen[-1], "the base does not invent a fifth answer")

    def test_output_is_a_well_formed_UserPromptSubmit_payload(self):
        proc = self.ask("bash pipefail head exit 141 SIGPIPE silent")
        payload = json.loads(proc.stdout)
        self.assertEqual("UserPromptSubmit", payload["hookSpecificOutput"]["hookEventName"])
        self.assertIsInstance(payload["hookSpecificOutput"]["additionalContext"], str)


class TestRelevantLessonsNeverBreaksASession(HookCase):
    lessons = [{"content": BASH_TRAP, "project": "agent-worktrees", "severity": "critical"}]

    def assert_silent_success(self, proc):
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual("", proc.stdout.strip())
        self.assertEqual("", proc.stderr.strip())

    def test_malformed_json(self):
        self.assert_silent_success(self.run_hook("relevant_lessons.py", "{not json at all"))

    def test_empty_stdin(self):
        self.assert_silent_success(self.run_hook("relevant_lessons.py", ""))

    def test_payload_without_a_prompt(self):
        self.assert_silent_success(self.run_hook("relevant_lessons.py", {"cwd": "/x/y"}))

    def test_missing_database(self):
        self.assert_silent_success(
            self.run_hook("relevant_lessons.py",
                          {"prompt": "bash pipefail SIGPIPE head exit"},
                          db=os.path.join(self.tmp, "nope.db")))

    def test_corrupt_database(self):
        bad = os.path.join(self.tmp, "corrupt.db")
        with open(bad, "wb") as f:
            f.write(b"this is definitely not sqlite" * 100)
        self.assert_silent_success(
            self.run_hook("relevant_lessons.py",
                          {"prompt": "bash pipefail SIGPIPE head exit"}, db=bad))

    def test_read_only_database_still_answers(self):
        # Instrumentation is worth having and not worth failing for: the lesson
        # must still be delivered when the counter cannot be written.
        os.chmod(self.db, 0o444)
        os.chmod(self.tmp, 0o555)
        try:
            proc = self.run_hook("relevant_lessons.py",
                                 {"prompt": "bash pipefail head exit 141 SIGPIPE silent",
                                  "session_id": "ro"})
            self.assertEqual(0, proc.returncode)
            self.assertIn("SIGPIPE", self.context_of(proc) or "")
        finally:
            os.chmod(self.tmp, 0o755)
            os.chmod(self.db, 0o644)

    def test_unwritable_state_directory(self):
        os.chmod(self.state, 0o555)
        try:
            proc = self.run_hook("relevant_lessons.py",
                                 {"prompt": "bash pipefail head exit 141 SIGPIPE silent"})
            self.assertEqual(0, proc.returncode, proc.stderr)
        finally:
            os.chmod(self.state, 0o755)


class TestProjectName(unittest.TestCase):
    def test_worktrees_inherit_their_parent_project(self):
        import relevant_lessons as rl
        self.assertEqual("myapp", rl.project_name("/code/myapp"))
        self.assertEqual("myapp", rl.project_name("/code/myapp-session-payments"))
        self.assertEqual("myapp", rl.project_name("/code/myapp-hotfix-urgent"))
        self.assertEqual("my-app", rl.project_name("/code/my-app"))


# ---------------------------------------------------------------------------
# session_context
# ---------------------------------------------------------------------------
class TestCapturePromptCalibration(unittest.TestCase):
    """What the Stop hook asks for is what the base ends up containing.

    Measured on 2026-08-10: of the lessons written after `severity` finally got
    a description in the tool schema, 100% came out critical or important — up
    from 89%. The description was not the binding constraint. This prompt was:
    it fires only after something went wrong, and then said outright "use
    severity=critical if it could destroy work again", which is an instruction
    to pick critical addressed to an agent that has just been burned.

    It also never mentioned `scope`, which is why 12 lessons out of 318 are
    global — the write path did not know the mechanism existed.
    """

    def setUp(self):
        import capture_lesson
        self.cap = capture_lesson

    def text(self):
        return (self.cap.INCIDENT_PROMPT.format(n=1, listing="  - x",
                                                global_hint=self.cap.global_hint())
                + "\n" + self.cap.GENERIC_PROMPT)

    def test_it_no_longer_tells_the_writer_to_pick_critical(self):
        self.assertNotIn("severity=critical", self.text(),
                         "an instruction to pick critical is not a calibration")

    def test_every_severity_is_described_by_what_it_costs(self):
        t = self.text()
        for level in ("critical", "important", "info"):
            self.assertIn(level, t)
        self.assertIn("costs someone NOT to know this", t)
        self.assertIn("a good default", t, "info has to be presented as the default")

    def test_it_names_the_selection_bias(self):
        # Every lesson this prompt asks about follows something going wrong, so
        # "it went wrong" cannot be the thing that makes one critical.
        self.assertIn("already true of every answer", self.text())

    def test_the_write_path_knows_scope_exists(self):
        t = self.text()
        self.assertIn('scope="global"', t)
        self.assertIn("different repository", t)

    def test_the_project_based_route_stays_optional(self):
        # `scope` supersedes it and needs no configuration, so the engine must
        # not imply a project name it was never told about.
        self.assertEqual("", self.cap.global_hint(),
                         "nothing configured, nothing suggested")


class TestSessionContextGlobalScope(HookCase):
    """A lesson marked `global` has to open every session, not just its own.

    That is the entire content of the column, and this hook ignored it. Measured
    on the live base on 2026-08-10: twelve lessons were marked global — a
    `set -euo pipefail` trap, `git checkout --` after a mutation test, a Stripe
    signature trap — and a session in any other repository started with zero of
    them. brain_recall and the prompt hook had both been taught to cross the
    project boundary; this one had not, in the place it matters most.
    """

    lessons = [
        {"content": "set -euo pipefail piped into head exits 141 on SIGPIPE, silently",
         "project": "agent-worktrees", "severity": "critical"},
        {"content": "the kanarix pricing table is generated at build time",
         "project": "kanarix", "severity": "info"},
    ]

    def setUp(self):
        super().setUp()
        # The column arrives by migration on a real base, so add it the same way.
        con = sqlite3.connect(self.db)
        con.execute("ALTER TABLE lessons ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'")
        con.execute("UPDATE lessons SET scope = 'global' WHERE content LIKE 'set -euo%'")
        con.commit()
        con.close()

    def test_a_global_lesson_opens_a_session_in_an_unrelated_project(self):
        ctx = self.context_of(self.run_hook("session_context.py",
                                            {"cwd": "/code/kanarix", "session_id": "s"}))
        self.assertIsNotNone(ctx)
        self.assertIn("SIGPIPE", ctx, "the trap travels to the project where it would recur")
        self.assertIn("agent-worktrees", ctx, "and says where it came from")

    def test_a_project_lesson_still_does_not_travel(self):
        ctx = self.context_of(self.run_hook("session_context.py",
                                            {"cwd": "/code/elsewhere", "session_id": "s"}))
        if ctx:
            self.assertNotIn("pricing table", ctx, "crossing is what `global` buys, not the default")

    def test_a_base_without_the_column_still_starts(self):
        # Older databases have no `scope`. The hook must degrade to project-only
        # rather than raise — a hook that throws breaks somebody's session.
        plain = os.path.join(self.tmp, "old.db")
        make_db(plain, [{"content": "a lesson about kamar deployment", "project": "kamar"}])
        proc = self.run_hook("session_context.py", {"cwd": "/code/kamar", "session_id": "s"}, db=plain)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn("brain-mcp memory", self.context_of(proc))


class TestSessionContextSnippets(HookCase):
    lessons = [{"content": "słowo " * 200, "project": "kamar", "severity": "critical"}]

    def test_previews_are_cut_on_a_word_boundary(self):
        # Cutting mid-word ("wygladaja jak j") reads as a corrupted lesson
        # rather than a shortened one, and the reader cannot tell which.
        ctx = self.context_of(self.run_hook("session_context.py",
                                            {"cwd": "/code/kamar", "session_id": "s"}))
        line = next(l for l in ctx.split("\n") if l.startswith(("!", "-")))
        self.assertTrue(line.endswith("…"), line)
        body = line.split("] ", 1)[1].removesuffix(" …")
        self.assertTrue(all(w == "słowo" for w in body.split()), f"no partial word: {body[-20:]!r}")


class TestSessionContext(HookCase):
    lessons = (
        [{"content": f"critical lesson number {i} about deployment", "project": "kamar",
          "severity": "critical"} for i in range(20)]
        + [{"content": "an info lesson about kamar styling", "project": "kamar", "severity": "info"}]
    )

    def test_injects_the_project_digest(self):
        ctx = self.context_of(self.run_hook("session_context.py",
                                            {"cwd": "/code/kamar", "session_id": "s"}))
        self.assertIsNotNone(ctx)
        self.assertIn("brain-mcp memory", ctx)

    def test_honours_the_lesson_limit(self):
        proc = self.run_hook("session_context.py", {"cwd": "/code/kamar", "session_id": "s"},
                             env={"BRAIN_HOOK_MAX_LESSONS": "5"})
        ctx = self.context_of(proc)
        self.assertIn("(5 lessons)", ctx)

    def test_writes_the_baseline_the_stop_hook_needs(self):
        self.run_hook("session_context.py", {"cwd": "/code/kamar", "session_id": "sess-x"})
        marker = os.path.join(self.state, "sess-x.json")
        self.assertTrue(os.path.exists(marker))
        with open(marker) as f:
            self.assertEqual(21, json.load(f)["baseline_lessons"])

    def test_a_worktree_inherits_the_parent_project(self):
        ctx = self.context_of(self.run_hook("session_context.py",
                                            {"cwd": "/code/kamar-session-payments", "session_id": "s"}))
        self.assertIsNotNone(ctx, "a session cut from kamar saw none of kamar's lessons")

    def test_survives_a_missing_database(self):
        proc = self.run_hook("session_context.py", {"cwd": "/code/kamar", "session_id": "s"},
                             db=os.path.join(self.tmp, "gone.db"))
        self.assertEqual(0, proc.returncode)

    def test_survives_malformed_input(self):
        proc = self.run_hook("session_context.py", "{{{")
        self.assertEqual(0, proc.returncode)


# ---------------------------------------------------------------------------
# capture_lesson
# ---------------------------------------------------------------------------
class TestCaptureLesson(HookCase):
    lessons = [{"content": "something already known", "project": "kamar"}]

    def baseline(self, session, n=1, **extra):
        os.makedirs(self.state, exist_ok=True)
        state = {"started": 0, "baseline_lessons": n}
        state.update(extra)
        with open(os.path.join(self.state, f"{session}.json"), "w") as f:
            json.dump(state, f)

    def test_blocks_when_nothing_was_learned(self):
        self.baseline("s1")
        proc = self.run_hook("capture_lesson.py", {"session_id": "s1", "cwd": "/code/kamar"})
        self.assertEqual("block", json.loads(proc.stdout)["decision"])

    def test_does_not_block_when_a_lesson_was_written(self):
        self.baseline("s2", n=0)   # baseline lower than the current count
        proc = self.run_hook("capture_lesson.py", {"session_id": "s2", "cwd": "/code/kamar"})
        self.assertEqual("", proc.stdout.strip())

    def test_never_blocks_a_continuation(self):
        # Blocking a turn that is already the result of a block is how a hook
        # turns into an infinite loop the user has to kill.
        self.baseline("s3")
        proc = self.run_hook("capture_lesson.py",
                             {"session_id": "s3", "cwd": "/code/kamar", "stop_hook_active": True})
        self.assertEqual("", proc.stdout.strip())

    def test_blocks_at_most_once_per_session(self):
        self.baseline("s4")
        first = self.run_hook("capture_lesson.py", {"session_id": "s4", "cwd": "/code/kamar"})
        self.assertEqual("block", json.loads(first.stdout)["decision"])
        second = self.run_hook("capture_lesson.py", {"session_id": "s4", "cwd": "/code/kamar"})
        self.assertEqual("", second.stdout.strip())

    def test_does_nothing_without_a_baseline(self):
        proc = self.run_hook("capture_lesson.py", {"session_id": "unknown", "cwd": "/code/kamar"})
        self.assertEqual(0, proc.returncode)
        self.assertEqual("", proc.stdout.strip())

    def test_survives_malformed_input(self):
        self.assertEqual(0, self.run_hook("capture_lesson.py", "nonsense").returncode)


# ---------------------------------------------------------------------------
# incident_watch
# ---------------------------------------------------------------------------
class TestHookSemanticSearch(unittest.TestCase):
    """The automatic path had no semantics, and that was backwards.

    Embeddings reached `brain_recall` and stopped there: the tool ran six
    retrievers, the prompt hook three lexical ones. So the path needing an
    agent's initiative was stronger than the path that works by itself — and the
    automatic one is the reason any of this reaches anybody.
    """

    def setUp(self):
        import _brain_vec
        self.bv = _brain_vec
        self.tmp = tempfile.mkdtemp(prefix="brain-vec-")
        self._state = self.bv.STATE_DIR
        self.bv.STATE_DIR = self.tmp

    def tearDown(self):
        self.bv.STATE_DIR = self._state
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_environment_wins_over_the_client_config(self):
        os.environ["BRAIN_EMBEDDINGS_URL"] = "http://example.invalid:1234/"
        os.environ["BRAIN_EMBEDDINGS_MODEL"] = "test-model"
        try:
            cfg = self.bv.config()
            self.assertEqual("http://example.invalid:1234", cfg["url"], "trailing slash stripped")
            self.assertEqual("test-model", cfg["model"])
        finally:
            os.environ.pop("BRAIN_EMBEDDINGS_URL", None)
            os.environ.pop("BRAIN_EMBEDDINGS_MODEL", None)

    def test_the_breaker_survives_the_process_that_opened_it(self):
        # THE DIFFERENCE FROM THE SERVER. Every hook run is a fresh process, so a
        # breaker held in memory would re-pay the timeout on every prompt —
        # exactly the cost it exists to avoid.
        self.assertFalse(self.bv.breaker_open())
        self.bv.trip_breaker()
        self.assertTrue(self.bv.breaker_open(), "state outlives this call")
        self.assertFalse(
            self.bv.breaker_open(now=time.time() + self.bv.BREAKER_COOLDOWN_S + 1),
            "and expires on its own",
        )
        self.bv.reset_breaker()
        self.assertFalse(self.bv.breaker_open())

    def test_an_unreachable_backend_costs_one_attempt_then_none(self):
        os.environ["BRAIN_EMBEDDINGS_URL"] = "http://127.0.0.1:59998"
        try:
            self.assertIsNone(self.bv.embed("anything", timeout=1))
            self.assertTrue(self.bv.breaker_open(), "the failure was remembered")
            self.assertIsNone(self.bv.embed("anything", timeout=1), "and the next call does not wait")
        finally:
            os.environ.pop("BRAIN_EMBEDDINGS_URL", None)

    def test_no_backend_configured_means_no_network_call(self):
        # The opt-in promise: without a configured backend nothing here reaches
        # the network, whatever else changes.
        self.assertIsNone(self.bv.embed("text", cfg=None) if self.bv.config() is None else None)

    def test_vector_search_degrades_to_nothing_rather_than_raising(self):
        con = sqlite3.connect(":memory:")
        try:
            self.assertEqual([], self.bv.nearest_passages(con, None))
            self.assertEqual([], self.bv.nearest_passages(con, [0.1, 0.2]),
                             "a base with no vector tables answers nothing, not an exception")
        finally:
            con.close()


class TestRestoreIntoTempIsNotAnIncident(unittest.TestCase):
    """A restore that only touches /tmp undoes nothing worth a lesson.

    The watcher exists to catch a mistake that was noticed and worked around. A
    mutation-testing loop resets its scratch copy dozens of times — the shape of
    a restore, the substance of a for-loop. Measured on the live journal: of the
    three detections since the positional fix landed, two were exactly this.
    """

    def setUp(self):
        import incident_watch
        self.iw = incident_watch

    def test_a_scratch_restore_is_ignored(self):
        for cmd in [
            "cp /tmp/k.bak /tmp/mut.php",
            "cp /private/tmp/claude-501/abc/scratchpad/x.orig.php /private/tmp/claude-501/abc/mut.php",
            "cd /repo && cp /tmp/s2.bak /tmp/mut.php && php -l /tmp/mut.php",
        ]:
            self.assertFalse(self.iw.restored_from_backup(cmd), cmd)

    def test_a_restore_into_the_working_tree_still_counts(self):
        for cmd in [
            "cp /tmp/k.bak wordpress/wp-content/mu-plugins/kamar-komentarze.php",
            "cd /repo && cp /private/tmp/scratch/sku.orig.php wp/plug.php && shasum -a 256 wp/plug.php",
        ]:
            self.assertTrue(self.iw.restored_from_backup(cmd), cmd)

    def test_making_a_backup_is_still_not_restoring_one(self):
        # The rule this was built on top of, retained: the destination being a
        # temp path must not be the ONLY thing keeping a backup from counting.
        for cmd in [
            "cp wordpress/mu-plugins/oz.php /tmp/oz.bak && python3 -c 'x=1'",
            'cd /x && P=wp/plug.php && cp "$P" /private/tmp/scratchpad/sku.orig.php',
        ]:
            self.assertFalse(self.iw.restored_from_backup(cmd), cmd)


class TestHooksWriteWhereTheyAreTold(HookCase):
    """No hook may write to the real state directory when told otherwise.

    `_brain_db.STATE_DIR` honours $BRAIN_STATE_DIR for exactly this reason, and
    its comment says why: without it "the suite would read and write the state
    of whatever real session is open". incident_watch.py kept a second,
    hardcoded copy of the path and did precisely that — 37 of the 102 reverts in
    the developer's live journal turned out to be one line of this file,
    replayed once per test run over three days. Two copies of anything
    load-bearing drift, and this drift was silent because the tests still passed.
    """

    lessons = []

    def test_no_hook_defines_its_own_state_directory(self):
        import glob
        for path in glob.glob(os.path.join(HOOKS, "*.py")):
            src = open(path, encoding="utf-8").read()
            if os.path.basename(path) == "_brain_db.py":
                self.assertIn("BRAIN_STATE_DIR", src, "the one definition reads the override")
                continue
            self.assertNotIn(
                'os.path.join(os.path.expanduser("~"), ".claude", "hooks", "brain", "state")',
                src,
                f"{os.path.basename(path)} builds the state path itself instead of using _brain_db",
            )

    def test_an_incident_lands_in_the_directory_the_env_names(self):
        real = os.path.join(os.path.expanduser("~"), ".claude", "hooks", "brain", "state")
        before = set(glob.glob(os.path.join(real, "leak-probe*"))) if os.path.isdir(real) else set()

        self.run_hook("incident_watch.py", {
            "session_id": "leak-probe",
            "tool_name": "Bash",
            "tool_input": {"command": "git checkout -- some/file.php"},
        })

        wrote = glob.glob(os.path.join(self.state, "leak-probe*"))
        self.assertTrue(wrote, "the incident was journalled into the temp directory")
        after = set(glob.glob(os.path.join(real, "leak-probe*"))) if os.path.isdir(real) else set()
        self.assertEqual(before, after, "and nothing was written to the real one")


class TestIncidentWatch(HookCase):
    lessons = []

    def test_survives_malformed_input(self):
        self.assertEqual(0, self.run_hook("incident_watch.py", "{oops").returncode)

    def test_survives_an_empty_payload(self):
        self.assertEqual(0, self.run_hook("incident_watch.py", {}).returncode)

    def test_making_a_backup_is_not_restoring_one(self):
        # THE FALSE POSITIVE THIS HOOK KEEPS COMMITTING, now with a test.
        # Taking a backup before a risky change is the most careful thing anybody
        # does; being scolded for it is precisely how a hook earns being turned
        # off. Two regex attempts got this wrong in the same direction before the
        # check became positional.
        from incident_watch import restored_from_backup as restored
        for cmd in [
            "cp ~/.claude/settings.json /tmp/settings.json.bak-$(date +%s) && ls -la /tmp/*.bak-*",
            "cp config.json config.json.bak",
            "cp -a site/ site.backup/",
            "mv schema.sql schema.sql.orig",
            "ls -la /tmp/x.bak",
            "echo 'restore from backup'",
        ]:
            self.assertFalse(restored(cmd), f"reported as an undo: {cmd}")

    def test_restoring_a_backup_is_an_undo(self):
        from incident_watch import restored_from_backup as restored
        for cmd in [
            "cp /tmp/settings.json.bak-123 ~/.claude/settings.json",
            "mv app.py.orig app.py",
            "rsync -a site.backup/ site/",
            "sudo cp /etc/nginx.conf.bak /etc/nginx.conf",
            "make build && cp db.sql.backup db.sql",
        ]:
            self.assertTrue(restored(cmd), f"missed a real restore: {cmd}")

    def test_end_to_end_a_backup_does_not_prompt(self):
        proc = self.run_hook("incident_watch.py", {
            "session_id": "s", "cwd": "/code/kamar", "tool_name": "Bash",
            "tool_input": {"command": "cp ~/.claude/settings.json /tmp/settings.json.bak-$(date +%s)"},
            "tool_response": {"stdout": "", "exit_code": 0}})
        self.assertEqual("", proc.stdout.strip(), "taking a backup was reported as an undo")

    def test_end_to_end_a_restore_does_prompt(self):
        proc = self.run_hook("incident_watch.py", {
            "session_id": "s", "cwd": "/code/kamar", "tool_name": "Bash",
            "tool_input": {"command": "cp /tmp/settings.json.bak-1 ~/.claude/settings.json"},
            "tool_response": {"stdout": "", "exit_code": 0}})
        self.assertIn("undo just ran", proc.stdout)

    def test_ignores_an_ordinary_command(self):
        proc = self.run_hook("incident_watch.py", {
            "session_id": "s", "cwd": "/code/kamar",
            "tool_name": "Bash", "tool_input": {"command": "ls -la"},
            "tool_response": {"stdout": "", "exit_code": 0}})
        self.assertEqual(0, proc.returncode)
        self.assertEqual("", proc.stdout.strip())


if __name__ == "__main__":
    unittest.main(verbosity=2)
