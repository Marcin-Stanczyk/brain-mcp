#!/usr/bin/env python3
"""Stop hook — close the learning loop.

A memory that is only ever read decays. This hook asks, once per session, for a
lesson to be written when none was — turning brain-mcp from an occasional
scratchpad into an actual feedback loop.

It blocks AT MOST ONCE per session. Guards, in order:
  1. `stop_hook_active` in the payload  -> never block (already a continuation)
  2. marker file already flagged `asked` -> never block again
  3. session shorter than BRAIN_HOOK_MIN_SECONDS -> nothing to learn yet
  4. lesson count grew since SessionStart -> loop already closed, stay quiet

Fails open: any error exits 0 with no output. A broken hook can never trap a
session in a loop or stop it from ending.

Requires the SessionStart hook (session_context.py) — that is what writes the
baseline marker this compares against. Without a marker, this hook does nothing.
"""
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _brain_db  # noqa: E402
import sys
import time

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("BRAIN_DB") or os.path.join(_REPO, "data", "knowledge.db")

STATE_DIR = _brain_db.STATE_DIR   # one definition, in _brain_db
MIN_SECONDS = int(os.environ.get("BRAIN_HOOK_MIN_SECONDS", "180"))

GENERIC_PROMPT = (
    "Nothing was written to brain-mcp this session. If you learned something "
    "non-obvious — a trap in the code, an architectural decision, an external "
    "API constraint, a repeatable pattern — record it now with brain_learn "
    "(or brain_store_pattern for a reusable pattern). Do NOT record what is "
    "already visible in the code, in git history, or in CLAUDE.md. If the "
    "lesson is about a TOOL rather than this project — a shell trap, a git "
    "behaviour, an API limit — pass scope=\"global\" so it reaches the other "
    "repositories too. Default severity to `info`; reserve `critical` for "
    "things whose absence loses data, money, or production. If there "
    "genuinely was nothing worth keeping, say so in one sentence and finish."
)

INCIDENT_PROMPT = (
    "This session hit {n} incident(s) and recorded nothing to brain-mcp:\n"
    "\n{listing}\n"
    "\nEach of those is a mistake that was noticed and worked around. That is "
    "exactly the knowledge that disappears if it is not written down — and the "
    "evidence is still in this session, but will not be in the next one.\n"
    "\nFor any that had a cause which could repeat, call brain_learn using:\n"
    "  PROBLEM  — what went wrong, observably\n"
    "  CAUSE    — the mechanism, not the symptom\n"
    "  FIX      — what actually resolved it\n"
    "  VERIFY   — the check that proved it, and would have caught it earlier\n"
    # SEVERITY, CALIBRATED — AND THE BIAS NAMED.
    # This prompt only fires after something went wrong, so "it went wrong" is
    # true of everything it will ever ask about and cannot be what makes a
    # lesson critical. The line here used to read "use severity=critical if it
    # could destroy work again", which is an instruction to pick critical, and
    # the base shows it worked: of the lessons written in the days after the
    # tool's own severity guidance was added, 100% came out critical or
    # important. A description asking for restraint does not survive contact
    # with an agent that has just been burned; removing the nudge might.
    "\nSeverity is how much it costs someone NOT to know this, not how much it "
    "cost you to find out — you are being asked because something went wrong, "
    "so that part is already true of every answer:\n"
    "  critical  — ignoring it loses data, money, or production\n"
    "  important — ignoring it costs a rebuild or an hour of confusion\n"
    "  info      — worth knowing, costs nothing to miss (a good default)\n"
    "\nIf the lesson is about a TOOL rather than this project — a shell trap, a "
    "git behaviour, an API limit, anything that would repeat in a different "
    "repository — pass scope=\"global\" so it reaches the sessions where the "
    "mistake would actually recur.{global_hint}\n"
    "\nIf every one of them was routine, say so in one sentence and finish."
)


GLOBAL_PROJECTS = [p.strip() for p in os.environ.get(
    "BRAIN_HOOK_GLOBAL_PROJECTS", "").split(",") if p.strip()]


def global_hint():
    """The older, configured way of saying "this lesson is cross-cutting".

    `scope="global"` supersedes it and needs no configuration, so the main
    prompt names that unconditionally; this only adds the project-based route
    when somebody has actually set it up. The engine must not ship a project
    name — which projects are cross-cutting is a property of the user's
    knowledge base, not of this code.
    """
    if not GLOBAL_PROJECTS:
        return ""
    names = " or ".join(f"project={p}" for p in GLOBAL_PROJECTS)
    return (f" Lessons filed under {names} are injected into every session too.")


def read_incidents(session_id):
    p = os.path.join(STATE_DIR, f"{session_id}-incidents.jsonl")
    if not os.path.exists(p):
        return []
    out = []
    try:
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line:
                out.append(json.loads(line))
    except Exception:
        return out
    return out


def describe(inc):
    if inc.get("kind") == "revert":
        return f"  - undo ran ({inc.get('label')}): {inc.get('meaning')}\n" \
               f"      {str(inc.get('cmd',''))[:140]}"
    if inc.get("kind") == "retry":
        return f"  - command failed {inc.get('count')}x before moving on:\n" \
               f"      {str(inc.get('cmd',''))[:140]}"
    return f"  - {inc}"


def lessons_count() -> int:
    if not os.path.exists(DB):
        return -1
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2.0)
        try:
            return int(con.execute("SELECT COUNT(*) FROM lessons").fetchone()[0])
        finally:
            con.close()
    except Exception:
        return -1


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    # Guard 1 — this Stop is already a continuation caused by a hook.
    if payload.get("stop_hook_active"):
        return

    sid = payload.get("session_id") or "nosession"
    marker = os.path.join(STATE_DIR, f"{sid}.json")
    if not os.path.exists(marker):
        return  # no SessionStart baseline -> nothing to compare, stay quiet

    try:
        state = json.load(open(marker))
    except Exception:
        return

    # Guard 2 — already asked once in this session.
    if state.get("asked"):
        return

    started = state.get("started")
    baseline = state.get("baseline_lessons")
    if started is None or baseline is None:
        return

    # Guard 3 — too short to have learned anything.
    if time.time() - started < MIN_SECONDS:
        return

    current = lessons_count()
    if current < 0:
        return

    # Guard 4 — something was already written; the loop closed on its own.
    if current > baseline:
        state["asked"] = True
        try:
            json.dump(state, open(marker, "w"))
        except Exception:
            pass
        return

    state["asked"] = True
    try:
        json.dump(state, open(marker, "w"))
    except Exception:
        # If the marker can't be flagged we would risk asking again — don't ask.
        return

    # Prefer the evidence-based prompt: naming the actual incidents produces a
    # far better lesson than asking "did you learn anything", because the model
    # is reminded of a specific event instead of scanning the whole session.
    incidents = read_incidents(sid)
    if incidents:
        listing = "\n".join(describe(i) for i in incidents[:6])
        if len(incidents) > 6:
            listing += f"\n  - …and {len(incidents) - 6} more"
        reason = INCIDENT_PROMPT.format(n=len(incidents), listing=listing,
                                        global_hint=global_hint())
    else:
        reason = GENERIC_PROMPT

    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never trap or break session end
    sys.exit(0)
