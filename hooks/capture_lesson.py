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
import time

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("BRAIN_DB") or os.path.join(_REPO, "data", "knowledge.db")

STATE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "hooks", "brain", "state")
MIN_SECONDS = int(os.environ.get("BRAIN_HOOK_MIN_SECONDS", "180"))

PROMPT = (
    "Nothing was written to brain-mcp this session. If you learned something "
    "non-obvious — a trap in the code, an architectural decision, an external "
    "API constraint, a repeatable pattern — record it now with brain_learn "
    "(or brain_store_pattern for a reusable pattern). Do NOT record what is "
    "already visible in the code, in git history, or in CLAUDE.md. If there "
    "genuinely was nothing worth keeping, say so in one sentence and finish."
)


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

    print(json.dumps({"decision": "block", "reason": PROMPT}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never trap or break session end
    sys.exit(0)
