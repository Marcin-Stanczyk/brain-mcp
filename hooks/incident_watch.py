#!/usr/bin/env python3
"""PostToolUse / PostToolUseFailure hook — catch mistakes when they happen.

The Stop hook asks for a lesson at the end of a session. That is too late for
the most valuable kind: a mistake made and corrected mid-session. By the time
the turn ends, the evidence (the exact command, the diff that revealed it) has
scrolled away and the model reconstructs it from memory, badly — or the session
already recorded something else, so the Stop prompt never fires at all.

This hook watches for the moment a mistake becomes visible and writes down the
FACTS immediately, so the eventual lesson is grounded in evidence rather than
recollection.

Two signals, chosen for precision over recall — a nagging hook gets disabled:

  revert   an undo command ran: git checkout --/restore/reset --hard/revert,
           git clean, stash drop, commit --amend, or a restore from a .bak file.
           Nobody reverts unless something went wrong. Injects a prompt
           immediately, because this is the moment the cause is still known.

  retry    the same command failed repeatedly. Recorded silently; a single
           failure is usually a typo, not a lesson. Only surfaced at Stop.

Incidents are appended to a per-session JSONL journal that the Stop hook reads,
so an unrecorded incident is raised specifically ("you reverted X") instead of
the generic "did you learn anything".

Fails open: any error exits 0 with no output.
"""
import json
import os
import re
import sys
import time

STATE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "hooks", "brain", "state")

# High-precision undo signals. Each entry: (label, regex, what it usually means)
REVERT_PATTERNS = [
    ("git-checkout-file", r"\bgit\s+checkout\s+(--\s|--theirs|--ours|HEAD\s+--)",
     "discarded working-tree changes"),
    ("git-restore", r"\bgit\s+restore\b", "discarded working-tree changes"),
    ("git-reset-hard", r"\bgit\s+reset\s+--hard\b", "threw away commits or changes"),
    ("git-revert", r"\bgit\s+revert\b", "reverted a commit"),
    ("git-clean", r"\bgit\s+clean\s+-[a-z]*f", "deleted untracked files"),
    ("git-stash-drop", r"\bgit\s+stash\s+(drop|clear)\b", "discarded stashed work"),
    ("git-amend", r"\bgit\s+commit\b.*--amend", "rewrote a commit that was wrong"),
    # Only a backup used as SOURCE is an undo. The naive version matched the
    # destination too, so `cp config.json config.json.bak` — creating a backup,
    # the most cautious thing anyone does — was reported as a revert. It fired
    # twice in one session on deliberate pre-change backups; two false alarms is
    # how a hook earns being switched off.
    ("restore-backup",
     r"\b(cp|mv|rsync)\b[^\n]*\S\.(bak|backup|orig)\b(?![\w./-]*\s*$)",
     "restored from a backup"),
    ("rebase-abort", r"\bgit\s+rebase\s+--abort\b", "abandoned a rebase"),
]

MAX_FAILS_BEFORE_INCIDENT = 2
MAX_CMD_CHARS = 400

# `python3 - <<'PY' ... PY` and friends carry a whole script as data. Text
# inside is not a command this shell runs, but it is still text this hook would
# scan — and a script that merely mentions `git checkout` (a test fixture, a
# docstring, a generated file) then reads as a revert. Observed three times in
# one session, including on this file's own tests.
_HEREDOC = re.compile(r"<<-?\s*[\"']?(\w+)[\"']?")


def strip_heredocs(cmd: str) -> str:
    """Return only the parts of a command the shell itself executes."""
    m = _HEREDOC.search(cmd)
    if not m:
        return cmd
    head = cmd[:m.end()]
    # Whatever follows the terminator is real shell again (e.g. `| tail -5`).
    end = re.search(rf"^{re.escape(m.group(1))}\s*$", cmd[m.end():], re.M)
    tail = cmd[m.end() + end.end():] if end else ""
    return head + tail

GLOBAL_PROJECTS = [p.strip() for p in os.environ.get(
    "BRAIN_HOOK_GLOBAL_PROJECTS", "").split(",") if p.strip()]


def global_hint():
    """Named only when configured — this engine ships no project names."""
    if not GLOBAL_PROJECTS:
        return ""
    names = " or ".join(f"project={p}" for p in GLOBAL_PROJECTS)
    return (f" For tooling lessons use {names} — those are injected into every "
            f"session regardless of directory.")


def journal_path(session_id):
    return os.path.join(STATE_DIR, f"{session_id}-incidents.jsonl")


def append(session_id, record):
    os.makedirs(STATE_DIR, exist_ok=True)
    record["ts"] = time.time()
    with open(journal_path(session_id), "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def fail_counter(session_id, key, bump=True):
    """Count repeated failures of the same command within a session."""
    p = os.path.join(STATE_DIR, f"{session_id}-fails.json")
    data = {}
    if os.path.exists(p):
        try:
            data = json.load(open(p))
        except Exception:
            data = {}
    n = data.get(key, 0) + (1 if bump else 0)
    if bump:
        data[key] = n
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            json.dump(data, open(p, "w"))
        except Exception:
            pass
    return n


PROMPT = (
    "An undo just ran ({label}: {meaning}).\n"
    "\n"
    "  {cmd}\n"
    "\n"
    "If this was a real mistake with a cause that would repeat — not a routine "
    "cleanup — record it NOW with brain_learn, while the cause is still known. "
    "Do it before continuing; at the end of the session the evidence is gone.\n"
    "\n"
    "Use this shape so the lesson is actionable later:\n"
    "  PROBLEM  — what went wrong, observably (the symptom you saw)\n"
    "  CAUSE    — the mechanism, not the symptom (why it was possible at all)\n"
    "  FIX      — what actually resolved it\n"
    "  VERIFY   — the check that proved the fix worked, and that would have "
    "caught this earlier\n"
    "\n"
    "Set severity=critical when the same mistake could destroy work again.{global_hint}\n"
    "\n"
    "If it was routine (discarding a scratch edit, aborting an experiment), "
    "ignore this and carry on."
)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    sid = payload.get("session_id") or "nosession"
    tool = payload.get("tool_name") or ""
    event = payload.get("hook_event_name") or ""
    cmd = ((payload.get("tool_input") or {}).get("command") or "")[:MAX_CMD_CHARS]

    if tool != "Bash" or not cmd:
        return

    # --- signal 2: repeated failure of the same command (silent) ---
    if event == "PostToolUseFailure":
        key = re.sub(r"\s+", " ", cmd.strip())[:120]
        n = fail_counter(sid, key)
        if n >= MAX_FAILS_BEFORE_INCIDENT:
            append(sid, {"kind": "retry", "count": n, "cmd": key,
                         "detail": f"failed {n}x"})
        return

    # --- signal 1: an undo ran (prompt immediately) ---
    scan = strip_heredocs(cmd)
    for label, pattern, meaning in REVERT_PATTERNS:
        if re.search(pattern, scan):
            append(sid, {"kind": "revert", "label": label, "cmd": cmd,
                         "meaning": meaning})
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": event or "PostToolUse",
                    "additionalContext": PROMPT.format(
                        label=label, meaning=meaning, cmd=cmd,
                        global_hint=global_hint()),
                }
            }))
            return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never interfere with tool execution
    sys.exit(0)
