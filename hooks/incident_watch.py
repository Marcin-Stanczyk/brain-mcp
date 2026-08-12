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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _brain_db as bd  # noqa: E402

# ONE DEFINITION, AND THIS FILE HELD THE SECOND ONE.
# `_brain_db.STATE_DIR` honours $BRAIN_STATE_DIR precisely so the tests can run
# against a throwaway directory; its own comment says that without the override
# "the suite would read and write the state of whatever real session is open".
# This hook hardcoded the path instead, so it did exactly that: every run of the
# test suite appended genuine incident records to the developer's live journal.
# Found by reading it — 37 of 102 recorded reverts turned out to be one line of
# test fixture, `cp /tmp/settings.json.bak-1 ~/.claude/settings.json`, replayed
# once per test run over three days.
STATE_DIR = bd.STATE_DIR

# High-precision undo signals. Each entry: (label, regex, what it usually means)
REVERT_PATTERNS = [
    ("git-checkout-file", r"git\s+checkout\s+(--\s|--theirs|--ours|HEAD\s+--)",
     "discarded working-tree changes"),
    ("git-restore", r"git\s+restore\b", "discarded working-tree changes"),
    ("git-reset-hard", r"git\s+reset\s+--hard\b", "threw away commits or changes"),
    ("git-revert", r"git\s+revert\b", "reverted a commit"),
    ("git-clean", r"git\s+clean\s+-[a-z]*f", "deleted untracked files"),
    ("git-stash-drop", r"git\s+stash\s+(drop|clear)\b", "discarded stashed work"),
    ("git-amend", r"git\s+commit\b.*--amend", "rewrote a commit that was wrong"),
    # Only a backup used as SOURCE is an undo. See restored_from_backup below —
    # this one is a function rather than a regex, because two regex attempts at it
    # both produced false alarms on the most cautious thing anybody does.
    ("restore-backup", None, "restored from a backup"),
    ("rebase-abort", r"git\s+rebase\s+--abort\b", "abandoned a rebase"),
]

MAX_FAILS_BEFORE_INCIDENT = 2
MAX_CMD_CHARS = 400

# `python3 - <<'PY' ... PY` and friends carry a whole script as data. Text
# inside is not a command this shell runs, but it is still text this hook would
# scan — and a script that merely mentions `git checkout` (a test fixture, a
# docstring, a generated file) then reads as a revert. Observed three times in
# one session, including on this file's own tests.
_HEREDOC = re.compile(r"<<-?\s*[\"']?(\w+)[\"']?")

# WHETHER A BACKUP WAS RESTORED, OR MERELY MADE.
# ---------------------------------------------------------------------------
# Twice now this has been answered with a regex and twice it has been wrong, in
# the same direction: reporting the creation of a backup as an undo. That is the
# worst possible false positive for this hook — taking a backup before a risky
# change is the most careful thing anyone does, and being scolded for it is
# exactly how a hook earns being switched off.
#
#   attempt 1  matched a .bak anywhere            -> `cp conf.json conf.json.bak`
#   attempt 2  excluded a .bak at END of command  -> `cp conf.json conf.bak-$(date +%s) && ls`
#
# The second failed because "is it last?" is a proxy for the real question, and
# the proxy breaks the moment anything follows: a `&&`, a redirect, a timestamp
# suffix. The real question is positional — is the backup a SOURCE or the
# DESTINATION? — so ask that instead.
_BACKUP_SUFFIX = re.compile(r"\.(bak|backup|orig)\b")
_SUBST = re.compile(r"\$\([^)]*\)|`[^`]*`")
_SEGMENT = re.compile(r"&&|\|\||[;|&\n]")
_ASSIGN = re.compile(r"^\w+=")
_COPIERS = ("cp", "mv", "rsync", "install")


# Destinations nobody keeps work in. A restore landing here cannot be undoing
# anything somebody would want a lesson about.
_TEMP_DEST = re.compile(r"^(?:/private)?/tmp/|^/var/folders/")


def restored_from_backup(cmd: str) -> bool:
    """True only when a .bak/.backup/.orig path is a SOURCE of a copy."""
    # Command substitutions go first: `$(date +%s)` splits into tokens that
    # shift every argument along and turn the destination into a "source".
    cleaned = _SUBST.sub("", cmd)
    for segment in _SEGMENT.split(cleaned):
        tokens = segment.split()
        i = 0
        while i < len(tokens) and (_ASSIGN.match(tokens[i]) or tokens[i] in ("sudo", "command", "env")):
            i += 1
        if i >= len(tokens) or os.path.basename(tokens[i]) not in _COPIERS:
            continue
        operands = [t for t in tokens[i + 1:] if not t.startswith("-")]
        if len(operands) < 2:
            continue
        if not any(_BACKUP_SUFFIX.search(o) for o in operands[:-1]):
            continue
        # RESTORING A FILE THAT ONLY LIVES IN /tmp UNDOES NOTHING.
        # The watcher exists to catch a mistake that was noticed and worked
        # around. A mutation-testing loop resets its scratch copy dozens of
        # times — `cp /tmp/k.bak /tmp/mut.php` — which is the shape of a restore
        # and the substance of a for-loop. Measured on the live journal: of the
        # three detections since the positional fix landed, two were exactly
        # this and one was a genuine restore into the working tree.
        if _TEMP_DEST.match(operands[-1].strip('"\'')):
            continue
        return True
    return False


def runs_command(scan: str, pattern: str) -> bool:
    """True when `pattern` matches a command the shell would actually RUN.

    A POSITIONAL QUESTION SOLVED TEXTUALLY IS THE FAILURE MODE OF THIS FILE.
    `re.search` over the whole command asks "does this text appear anywhere",
    when the question is "is this the command being executed". Observed on
    2026-08-12: a diagnostic that merely printed the words `git checkout -- po
    mutacji` inside an `echo` string was reported as an undo. Same shape as the
    backup/restore confusion that took two regex attempts to get right — and
    `restored_from_backup` already solved it by looking at where the operand
    sits, not at whether the text is present.

    So the match has to begin a segment: the start of the command, or just
    after `&&`, `||`, `;`, `|`, or a newline. Leading assignments and wrappers
    (`sudo`, `env FOO=1`) are stepped over, because those still run it.
    """
    for segment in _SEGMENT.split(scan):
        stripped = segment.strip()
        # Step over `FOO=bar` prefixes and wrappers that still execute what follows.
        while True:
            head = stripped.split(maxsplit=1)
            if len(head) < 2:
                break
            if _ASSIGN.match(head[0]) or head[0] in ("sudo", "command", "env", "time", "nohup"):
                stripped = head[1].lstrip()
                continue
            break
        m = re.match(pattern, stripped)
        if m:
            return True
    return False


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
        hit = restored_from_backup(scan) if pattern is None else runs_command(scan, pattern)
        if hit:
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
