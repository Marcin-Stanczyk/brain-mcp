#!/usr/bin/env python3
"""Import Claude Code's per-project memory files into brain-mcp.

Claude Code writes memories as markdown under
`~/.claude/projects/<flattened-cwd>/memory/*.md`. Those files have no search
index — an agent finds them only when `MEMORY.md` happens to land in context.
brain-mcp has FTS5. This script moves the content into the indexed store so one
query reaches all of it.

The markdown files are LEFT IN PLACE. This copies content; it does not migrate.

Idempotent: `source` is the key. Re-running updates records whose file changed
and skips the rest, so you can wire it into a cron or run it after any session.

Usage:
    python3 scripts/import-claude-memory.py --dry-run
    python3 scripts/import-claude-memory.py
    python3 scripts/import-claude-memory.py --code-root ~/work --client-group _clients

Options:
    --code-root PATH      Where your projects live. Used to turn a flattened
                          memory-directory name back into a project name.
                          Default: $BRAIN_CODE_ROOT or ~/code
    --memory-root PATH    Default: ~/.claude/projects
    --client-group NAME    Repeatable. A top-level folder under --code-root that
                          holds client work. Memories from these projects are
                          filed under the `client` category wholesale — see
                          `classify()` for why. Default: none.
    --dry-run             Report what would change, write nothing.

Database: $BRAIN_DB, else <repo>/data/knowledge.db
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.environ.get("BRAIN_DB") or os.path.join(_REPO, "data", "knowledge.db")

# Categories accepted by brain_learn. Do not emit anything outside this set.
VALID = {
    "bug-fix", "architecture", "performance", "security", "deployment", "tooling",
    "pattern", "gotcha", "best-practice", "client", "seo", "i18n", "testing",
    "design", "marketing", "sales", "workflow", "business", "financial", "market",
    "client-feedback",
}

# Ordered by specificity — first match wins.
#
# Matching is deliberately done against the TITLE AND DESCRIPTION first, and only
# against the body as a fallback. Documents of a few thousand characters mention
# everything incidentally: matching on the body filed a pricing document under
# `i18n` merely because the product ships in ten languages, and put 26 of 94
# files under `deployment` because they happened to name a hosting provider.
CATEGORY_RULES = [
    ("financial",    r"pricing|price|revenue|setup fee|subscription|payout|invoice|billing|payment|refund"),
    ("i18n",         r"\bi18n\b|\bl10n\b|translation|locale|hreflang|multi-?lang"),
    ("seo",          r"\bseo\b|\bgeo\b|serp|keyword|crawl|sitemap|structured data|llms\.txt"),
    ("security",     r"secret|leak|credential|api-?token|api-?key|vulnerab|owasp|sanitiz|\bxss\b|\bcsrf\b|\bauth\b"),
    ("deployment",   r"deploy|ci-?cd|pipeline|rollback|staging|release|env-gap|server-convention|\binfra\b"),
    ("performance",  r"performance|speed|slow|cache|latency|core-web-vital|\bttfb\b|bundle"),
    ("testing",      r"\be2e\b|playwright|unit-?test|integration test|regression test"),
    ("marketing",    r"marketing|campaign|\bads?\b|prospect|funnel|newsletter|outreach|tracking|pixel|analytics"),
    ("sales",        r"\blead\b|pitch|\bicp\b|sales|proposal"),
    ("design",       r"\bui\b|\bux\b|layout|component|design|typography|accessibilit|frontend"),
    ("architecture", r"architect|structure|data-?model|schema|monorepo|constraint|invariant|drift"),
    ("bug-fix",      r"\bbug\b|broken|\bfix\b|regression|hotfix|invalid|missing|stale"),
    ("gotcha",       r"gotcha|pitfall|non-?obvious|counterintuitive|surprising"),
    ("business",     r"strategy|roadmap|business|portfolio|positioning|competitor|\bplan\b"),
]

SEVERITY_RULES = [
    ("critical",  r"\bcritical\b|revenue-critical|\bnever\b|must not|breaks production|data loss"),
    ("important", r"\bimportant\b|gotcha|constraint|\bdo not\b|caveat|watch out"),
]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--code-root",
                    default=os.environ.get("BRAIN_CODE_ROOT")
                    or os.path.expanduser("~/code"))
    ap.add_argument("--memory-root",
                    default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--client-group", action="append", default=[],
                    metavar="NAME",
                    help="folder under --code-root holding client work (repeatable)")
    return ap.parse_args()


def discover_projects(code_root: str):
    """Every directory name under code_root and its immediate subgroups.

    Longest first, so `myapp-api` wins over `myapp` when both exist.
    """
    names = set()
    if not os.path.isdir(code_root):
        return []
    tops = [d for d in os.listdir(code_root)
            if os.path.isdir(os.path.join(code_root, d)) and not d.startswith(".")]
    names.update(tops)
    for t in tops:
        sub = os.path.join(code_root, t)
        try:
            names.update(d for d in os.listdir(sub)
                         if os.path.isdir(os.path.join(sub, d)) and not d.startswith("."))
        except OSError:
            pass
    return sorted(names, key=len, reverse=True)


def derive_project(memdir: str, projects) -> str:
    """Flattened cwd -> project name.

    Claude Code flattens the working directory into the folder name, replacing
    separators with dashes, e.g. `-Users-me-code-group-myapp` for
    `/Users/me/code/group/myapp`. Underscores in real folder names also arrive as
    dashes in some versions, so both are normalised before matching.
    """
    flat = memdir.replace("_", "-")
    for p in projects:
        if flat.endswith("-" + p.replace("_", "-")):
            return p
    return flat.split("-")[-1] or "unknown"


def parse_memory(path: str):
    raw = open(path, encoding="utf-8", errors="replace").read()
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", raw, re.S)
    if not m:
        return None
    fm, body = m.group(1), m.group(2).strip()

    def field(key):
        mm = re.search(rf"^{key}:\s*(.+?)$", fm, re.M)
        return mm.group(1).strip().strip("\"'") if mm else ""

    mtype = re.search(r"^\s+type:\s*(\S+)", fm, re.M)
    return {
        "name": field("name") or os.path.basename(path)[:-3],
        "description": field("description"),
        "type": mtype.group(1) if mtype else "project",
        "body": body,
    }


def classify(rec, is_client=False):
    if rec["type"] in ("feedback", "user"):
        cat = "workflow"
    elif rec["type"] == "reference":
        cat = "tooling"
    elif is_client:
        # Client work is filed under `client`, unconditionally.
        #
        # Inferring a topic here produced noise instead of signal: a client whose
        # company name contains a common technical word was filed under that
        # word's category, and a migration note was filed under `deployment`
        # because it mentioned a staging server. Some records landed in `client`,
        # others scattered — and inconsistency is worse than either extreme,
        # because filtering by category then silently omits records without
        # telling you. The topic stays reachable: `project` holds the client,
        # `tags` hold topic tokens, and FTS5 indexes the whole body.
        cat = "client"
    else:
        topic = f"{rec['name']} {rec['description']}".lower()
        cat = None
        for name, pat in CATEGORY_RULES:
            if re.search(pat, topic, re.I):
                cat = name
                break
        if cat is None:  # fall back to the body only if the title said nothing
            for name, pat in CATEGORY_RULES:
                if re.search(pat, rec["body"], re.I):
                    cat = name
                    break
        if cat is None:
            cat = "business"

    sev = "info"
    for name, pat in SEVERITY_RULES:
        if re.search(pat, f"{rec['name']} {rec['body']}", re.I):
            sev = name
            break
    if cat not in VALID:
        raise AssertionError(f"invalid category {cat!r}")
    return cat, sev


def build_tags(rec, project):
    toks = [t for t in re.split(r"[-_\s]", rec["name"]) if len(t) > 2]
    out, seen = [], set()
    for t in ["imported-md", rec["type"], project, *toks[:6]]:
        tl = str(t).lower()
        if tl and tl not in seen:
            seen.add(tl)
            out.append(tl)
    return out[:10]


def main():
    args = parse_args()
    if not os.path.exists(args.db):
        print(f"error: database not found: {args.db}", file=sys.stderr)
        print("       build and start brain-mcp once, or set $BRAIN_DB.", file=sys.stderr)
        return 1
    if not os.path.isdir(args.memory_root):
        print(f"error: memory root not found: {args.memory_root}", file=sys.stderr)
        return 1

    projects = discover_projects(args.code_root)
    client_groups = [g.replace("_", "-").lower() for g in args.client_group]

    files = []
    for dirpath, _, names in os.walk(args.memory_root):
        if os.path.basename(dirpath) != "memory":
            continue
        files += [os.path.join(dirpath, n) for n in sorted(names)
                  if n.endswith(".md") and n != "MEMORY.md"]

    con = sqlite3.connect(args.db, timeout=15.0)
    con.execute("PRAGMA journal_mode=WAL")
    existing = dict(con.execute(
        "SELECT source, content FROM lessons WHERE source IS NOT NULL"))

    ins = upd = skip = bad = 0
    stats = {}
    for path in files:
        rec = parse_memory(path)
        if not rec or not rec["body"]:
            bad += 1
            continue

        memdir = os.path.basename(os.path.dirname(os.path.dirname(path)))
        project = derive_project(memdir, projects)
        is_client = any(g in memdir.replace("_", "-").lower() for g in client_groups)
        cat, sev = classify(rec, is_client)
        stats[cat] = stats.get(cat, 0) + 1

        content = (f"[{rec['name']}] {rec['description']}\n\n{rec['body']}"
                   if rec["description"] else rec["body"])
        source = f"claude-memory:{memdir}/{os.path.basename(path)}"
        mtime = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc) \
                        .strftime("%Y-%m-%d %H:%M:%S")
        tags = json.dumps(build_tags(rec, project))

        if source in existing:
            if existing[source] == content:
                skip += 1
                continue
            if not args.dry_run:
                con.execute(
                    "UPDATE lessons SET content=?, category=?, tags=?, project=?, "
                    "severity=?, updated_at=datetime('now') WHERE source=?",
                    (content, cat, tags, project, sev, source))
            upd += 1
        else:
            if not args.dry_run:
                con.execute(
                    "INSERT INTO lessons (category, tags, content, source, project, "
                    "severity, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (cat, tags, content, source, project, sev, mtime, mtime))
            ins += 1

    if not args.dry_run:
        con.commit()
    total = con.execute("SELECT COUNT(*) FROM lessons").fetchone()[0]
    con.close()

    tag = "[dry-run] " if args.dry_run else ""
    print(f"{tag}files: {len(files)}  new: {ins}  updated: {upd}  "
          f"unchanged: {skip}  unparsed: {bad}")
    print(f"{tag}lessons in database: {total}")
    if stats:
        print(f"{tag}categories: " + ", ".join(
            f"{k}={v}" for k, v in sorted(stats.items(), key=lambda kv: -kv[1])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
