# Validation

Validated on Windows with Node.js 24.14 and npm 11.12.

## Automated checks

Type check and production build passed. All 51 tests passed, covering:

- Direct two-turn streaming, persisted messages, and retained provider reasoning metadata.
- Structured sub-agent/team plans, API/SDK transport, sibling dependencies, concurrency permits, and shared budgets.
- Approval/denial, descendant cancellation, deadlines, retries, and interrupted-run recovery.
- File traversal/symlink rejection and command cancellation.
- HTTP authentication/origin checks, SSE replay, transient deltas, and fragmented model streams.
- Incremental JSONL replay, single-writer locking, tail repair, and committed-corruption rejection.
- Configuration precedence, editable roles, credential references, and environment overrides.
- Stable cwd, project instructions, artifacts, read-only children, writable worktrees, and legacy migration.
- TUI session search/switching, history paging, draft preservation, new-chat targeting, approval actions, delegation/team commands, compact layouts, arrow/wheel scrolling, user-turn search/jumps, and stable reading positions during streaming.

Commands: `npm.cmd run check`, `npm.cmd test`, `npm.cmd run build`.

## Manual and live checks — 2026-11-21

- Compiled TUI launched in an isolated Windows terminal with alternate-screen rendering. Exiting restored the original screen.
- Compiled demo completed three tasks; reopening its data directory restored tasks, artifact references, and durable events.
- Real DeepSeek V4.1 Flash (`deepseek-flash`), thinking enabled and high effort: two synthetic streaming turns passed context recall, with six content chunks received.
- Real-model coordinated team: Assistant + Researcher + Reviewer all completed; the parent synthesized the child results, with nine content chunks received. No project files or user conversation history were sent by these checks.
- The first team smoke test intentionally capped output at 512 tokens; one child's reasoning exhausted that cap. Retesting with 2048 passed. The user's configured limit is 8192.

Credentials were read from the existing OpenCode credential file and never printed or packaged. Global settings were backed up before modification. Existing running user processes were not stopped.

Normal startup does not import SQLite. Legacy migration tests may emit Node's experimental SQLite warning. This remains a local, single-user runtime; it is not load-tested for distributed operation. Remaining work includes compaction, independent session export/deletion, artifact downloads, advanced input editing, peer mailboxes, and actual web/desktop interfaces.

Additional checks cover Markdown emphasis, Unicode table alignment/wrapping, escaped pipes, literal code, partial streams, terminal-control removal, live/persisted layout equivalence, startup help, and automatic return from approval queues resolved locally or by another client.

Approval-mode checks cover manual/agent/all execution, agent denial, uncertain/invalid/failed review fallback, cancellation during review, shared review budgets, capability enforcement, API/config validation, and in-place mode completion. TUI regression checks cover automatic arrival, dismiss/reopen behavior, unchanged queue counts with new IDs, multiple pending requests, external decisions, and draft/reading-anchor preservation. Agent decisions use a mocked provider in these checks; no new live-model approval quality evaluation was performed.

Compact approval follow-up: production build and all six TUI tests passed, including raw command display, detail expansion, long-content paging, and a 50-column terminal. The runtime was unchanged.
