"""Semantic search for the hooks.

WHY THIS EXISTS
===============
Embeddings reached `brain_recall` and stopped there. The tool runs six
retrievers including vectors; the prompt hook — the one that fires on every
sentence and does not depend on an agent remembering to ask — ran three lexical
ones and nothing else. So the path requiring initiative was stronger than the
path that works by itself, which is backwards: the automatic one is the reason
the knowledge base reaches anybody at all.

WHAT IS DIFFERENT FROM THE SERVER
=================================
Every hook invocation is a FRESH PROCESS. The TypeScript circuit breaker keeps
its state in a closure, which here would mean re-paying the timeout on every
single prompt — the exact cost the breaker exists to avoid. So the breaker
state lives in a file.

Configuration is not passed to hooks either: the MCP server gets its environment
from the client's config entry, while a hook inherits whatever the client
happens to have. Rather than adding a second place to configure the same thing,
this reads the server's own entry. If no backend is configured there, hooks stay
lexical and make no network call — the opt-in promise is unchanged.

Nothing here may raise into a hook.
"""

import glob
import json
import math
import os
import time
import urllib.request

import _brain_db as _bd

# ONE DEFINITION. No fallback that rebuilds this path: the second copy is what
# had the test suite appending to the developer's live journal for three days,
# and a guard in tests/hooks catches exactly this line. _brain_db sits in the
# same directory as this file and every hook puts it on the path before
# importing either — if it is missing, nothing here would work anyway.
STATE_DIR = _bd.STATE_DIR

DEFAULT_MODEL = "bge-m3"
DEFAULT_TIMEOUT_S = 10.0

# Mirrors MIN_VECTOR_SIMILARITY in src/search.ts. KNN always returns k
# neighbours and nearest is not near: without a floor the vector arm answers
# every prompt, including the ones whose answer is silence.
MIN_SIMILARITY = float(os.environ.get("BRAIN_MIN_SIMILARITY", "0.5"))

# One hung call is enough — it already spent the whole budget.
BREAKER_COOLDOWN_S = 60.0

_CLIENT_CONFIGS = [
    os.path.join(os.path.expanduser("~"), ".claude.json"),
    os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                 "Code", "User", "mcp.json"),
]


def config():
    """Where the embeddings backend is, or None. Never raises.

    The environment wins so tests can point somewhere harmless; otherwise the
    MCP client's own entry for brain-mcp is the single source of truth.
    """
    url = os.environ.get("BRAIN_EMBEDDINGS_URL")
    model = os.environ.get("BRAIN_EMBEDDINGS_MODEL")
    if url:
        return {"url": url.rstrip("/"), "model": model or DEFAULT_MODEL}

    for path in _CLIENT_CONFIGS:
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except Exception:
            continue
        for key in ("mcpServers", "servers"):
            for server in (doc.get(key) or {}).values():
                args = server.get("args") or []
                if not any("brain-mcp" in str(a) for a in args):
                    continue
                env = server.get("env") or {}
                if env.get("BRAIN_EMBEDDINGS_URL"):
                    return {
                        "url": env["BRAIN_EMBEDDINGS_URL"].rstrip("/"),
                        "model": env.get("BRAIN_EMBEDDINGS_MODEL") or DEFAULT_MODEL,
                    }
    return None


# ── Circuit breaker, persisted because each hook run is a new process ────────

def _breaker_path():
    return os.path.join(STATE_DIR, "embeddings-breaker.json")


def breaker_open(now=None):
    """True while the backend is being left alone. Never raises."""
    now = time.time() if now is None else now
    try:
        with open(_breaker_path()) as f:
            opened = float(json.load(f).get("opened_at", 0))
    except Exception:
        return False
    return (now - opened) < BREAKER_COOLDOWN_S


def trip_breaker(now=None):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(_breaker_path(), "w") as f:
            json.dump({"opened_at": time.time() if now is None else now}, f)
    except Exception:
        pass


def reset_breaker():
    try:
        os.remove(_breaker_path())
    except Exception:
        pass


# ── Embedding ───────────────────────────────────────────────────────────────

def embed(text, cfg=None, timeout=DEFAULT_TIMEOUT_S):
    """A unit-length embedding of `text`, or None. Never raises.

    Unit length is not cosmetic: sqlite-vec measures L2, and only on normalised
    vectors is that the same ordering as cosine — which is what makes
    MIN_SIMILARITY mean the same thing here as in the server.
    """
    cfg = cfg or config()
    if not cfg or not text or breaker_open():
        return None
    body = json.dumps({
        "model": cfg["model"], "prompt": str(text), "keep_alive": "30m",
    }).encode()
    req = urllib.request.Request(
        f"{cfg['url']}/api/embeddings", data=body,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            vec = json.load(res).get("embedding")
    except Exception:
        trip_breaker()
        return None
    if not isinstance(vec, list) or not vec:
        trip_breaker()
        return None
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    reset_breaker()
    return [v / norm for v in vec]


# ── The vec0 extension ──────────────────────────────────────────────────────

def _extension_path():
    """The sqlite-vec binary shipped with the server's node_modules, or None."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for pattern in ("sqlite-vec-*/vec0.*", "sqlite-vec/build/vec0.*"):
        for path in glob.glob(os.path.join(root, "node_modules", pattern)):
            if path.rsplit(".", 1)[-1] in ("dylib", "so", "dll"):
                return path.rsplit(".", 1)[0]
    return None


def nearest_passages(con, vector, k=20):
    """[(lesson_id, similarity, passage_text)] above MIN_SIMILARITY.

    Returns [] for every failure — a missing extension, a base with no vectors,
    a dimension mismatch after a model change. The lexical retrievers answer
    regardless, and a hook may never be the reason a prompt fails.
    """
    if not vector:
        return []
    ext = _extension_path()
    if not ext:
        return []
    try:
        con.enable_load_extension(True)
        con.load_extension(ext)
    except Exception:
        return []
    finally:
        try:
            con.enable_load_extension(False)
        except Exception:
            pass

    blob = _to_blob(vector)
    try:
        rows = con.execute(
            """
            SELECT c.lesson_id, v.distance, c.text
            FROM chunks_vec v
            JOIN lesson_chunks c ON c.id = v.chunk_id
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY v.distance
            """,
            (blob, k),
        ).fetchall()
    except Exception:
        return []

    best = {}
    for lesson_id, distance, text in rows:
        similarity = 1 - (float(distance) ** 2) / 2
        if similarity < MIN_SIMILARITY:
            continue
        # A lesson ranks by its nearest passage; the rest would only crowd it.
        if lesson_id not in best:
            best[lesson_id] = (similarity, text)
    return [(lid, sim, txt) for lid, (sim, txt) in best.items()]


def _to_blob(vector):
    import struct
    return struct.pack(f"{len(vector)}f", *vector)
