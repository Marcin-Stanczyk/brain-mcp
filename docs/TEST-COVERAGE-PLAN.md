# Test coverage plan — pointer

The plan and its journal cover **both** `brain-mcp` and `agent-worktrees`, and
they live in one place rather than being copied into each repository:

- <https://github.com/Marcin-Stanczyk/agent-worktrees/blob/main/docs/TEST-COVERAGE-PLAN.md>
- <https://github.com/Marcin-Stanczyk/agent-worktrees/blob/main/docs/TEST-COVERAGE-JOURNAL.md>

A pointer and not a copy on purpose. The audit that produced the plan found that
`agent-worktrees` shipped the same shell function twice — once in `install.sh`,
once in the README — and that the two drifted until the installer was handing
every new user a broken one. A planning document duplicated across two
repositories fails the same way, more quietly.

What the plan asks of this repository, in short:

- **Phase 1 — the hooks.** `hooks/session_context.py`, `hooks/capture_lesson.py`
  and `hooks/incident_watch.py` have no tests, while `src/` has 39. The hooks are
  the only mechanism by which anything stored here ever reaches an agent.
- **Phase 2 — retrieval, made measurable.** Instrument usage before changing
  ranking: today nothing records that a lesson was ever read.
- **Phase 4 — the MCP surface beyond the happy path.** Concurrency,
  export/import fidelity, embeddings degradation.
