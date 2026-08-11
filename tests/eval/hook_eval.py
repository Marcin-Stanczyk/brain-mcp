#!/usr/bin/env python3
"""Retrieval quality for the PROMPT HOOK, on the same judged queries as the tool.

WHY THIS EXISTS
===============
`brain_recall` has had thresholds in CI since the ranking was first measured.
The hook — which fires on every sentence, decides what an agent reads before it
starts, and does not depend on anybody remembering to ask — had none. Its
ranking is a separate implementation in Python: bm25, additive boosts, a
coverage floor, and a reciprocal-rank fusion with the vector arm.

That asymmetry cost something concrete. The first fusion weighted the lexical
arm above the vector one across its full sixty-row list, which meant vectors
changed NOTHING; it was caught by hand, on three questions, and only because
somebody thought to compare before and after. Then the weights were tuned on
those same three questions. Three is not a measurement.

So the hook is scored here against tests/eval/corpus.json and queries.json — the
judgements already written for the tool — and the numbers are asserted in
tests/hooks/test_hooks.py.

    npm run eval:hook                       # lexical only
    BRAIN_EMBEDDINGS_URL=... npm run eval:hook   # and with vectors

METRICS ARE @3, NOT @5. The hook shows three lessons. Recall past the third slot
describes a list nobody sees.
"""

import json
import os
import re
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "hooks"))

MAX_SLOTS = 3


def build_base(path):
    """A database holding exactly the fixture corpus, with passages.

    Seeding by raw SQL bypasses the passage indexing brain_learn performs, which
    is lesson #321 and has now bitten this project four times — so the passages
    are written here explicitly, on the same blank-line rule as src/chunk.ts.
    """
    corpus = json.load(open(os.path.join(HERE, "corpus.json"), encoding="utf-8"))["lessons"]
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE lessons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
          content TEXT NOT NULL, source TEXT, project TEXT,
          severity TEXT DEFAULT 'info',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          shown_count INTEGER NOT NULL DEFAULT 0, last_shown_at TEXT,
          scope TEXT NOT NULL DEFAULT 'project');
        CREATE VIRTUAL TABLE lessons_fts USING fts5(
          content, category, tags, source, project,
          content='lessons', content_rowid='id');
        CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN
          INSERT INTO lessons_fts(rowid, content, category, tags, source, project)
          VALUES (new.id, new.content, new.category, new.tags, new.source, new.project);
        END;
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
    id_by_key = {}
    for lesson in corpus:
        con.execute(
            "INSERT INTO lessons (content, category, project, severity, scope) VALUES (?,?,?,?,?)",
            (lesson["content"], lesson["category"], lesson.get("project"),
             lesson.get("severity", "info"), lesson.get("scope", "project")),
        )
        lid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        id_by_key[lesson["key"]] = lid
        for i, para in enumerate(p.strip() for p in re.split(r"\n\s*\n+", lesson["content"]) if p.strip()):
            con.execute("INSERT INTO lesson_chunks (lesson_id, ord, text) VALUES (?,?,?)",
                        (lid, i, para))
    con.commit()
    con.close()
    return id_by_key


def embed_base(path):
    """Embed every passage, or return False when no backend is configured."""
    import _brain_vec as bv
    cfg = bv.config()
    if not cfg:
        return False
    ext = bv._extension_path()
    if not ext:
        return False
    con = sqlite3.connect(path)
    con.enable_load_extension(True)
    con.load_extension(ext)
    rows = con.execute("SELECT id, text FROM lesson_chunks ORDER BY id").fetchall()
    first = bv.embed(rows[0][1], cfg, timeout=60)
    if not first:
        con.close()
        return False
    con.execute(
        f"CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[{len(first)}])"
    )
    for cid, text in rows:
        vec = first if cid == rows[0][0] else bv.embed(text, cfg, timeout=60)
        if not vec:
            continue
        con.execute("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?,?)",
                    (cid, bv._to_blob(vec)))
    con.commit()
    con.close()
    return True


def score(returned, relevant):
    """recall@3, precision@1 and reciprocal rank for one query."""
    top = returned[:MAX_SLOTS]
    rel = set(relevant)
    recall = len([i for i in top if i in rel]) / len(rel) if rel else 1.0
    prec1 = 1.0 if top and top[0] in rel else 0.0
    rr = next((1 / (i + 1) for i, x in enumerate(returned) if x in rel), 0.0)
    return recall, prec1, rr


def run():
    queries = json.load(open(os.path.join(HERE, "queries.json"), encoding="utf-8"))["queries"]
    tmp = tempfile.mkdtemp(prefix="brain-hookeval-")
    db = os.path.join(tmp, "knowledge.db")
    id_by_key = build_base(db)

    os.environ["BRAIN_DB"] = db
    os.environ["BRAIN_STATE_DIR"] = os.path.join(tmp, "state")
    vectors = embed_base(db)

    import relevant_lessons as rl

    pos, neg, silent = [], 0, 0
    failures = []
    for q in queries:
        want = [id_by_key[k] for k in q["relevant"]]
        got = [row[1] for row in rl.search(q["query"], q.get("project") or "fixture", set())]
        if not want:
            neg += 1
            if not got:
                silent += 1
            else:
                failures.append((q["query"], "(nic)", got))
            continue
        r, p1, rr = score(got, want)
        pos.append((r, p1, rr))
        if r < 1.0:
            failures.append((q["query"], q["relevant"], got))

    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0
    report = {
        "queries": len(queries),
        "vectors": vectors,
        "recall@3": mean([r for r, _, _ in pos]),
        "precision@1": mean([p for _, p, _ in pos]),
        "mrr": mean([rr for _, _, rr in pos]),
        "true_negatives": (silent / neg) if neg else 1.0,
    }
    return report, failures, tmp


def main():
    report, failures, tmp = run()
    label = "hook + wektory" if report["vectors"] else "hook, leksykalnie"
    print(f"{label} — {report['queries']} zapytań")
    print(f"  recall@3        {report['recall@3']*100:>5.1f}%")
    print(f"  precision@1     {report['precision@1']*100:>5.1f}%")
    print(f"  MRR             {report['mrr']:>5.3f}")
    print(f"  true negatives  {report['true_negatives']*100:>5.1f}%")
    if failures:
        print("\nnie w pełni zaspokojone (top 3):")
        for query, want, got in failures:
            print(f"  ✗ «{query}»\n      chciano: {want}\n      dostano: {got[:MAX_SLOTS]}")
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
