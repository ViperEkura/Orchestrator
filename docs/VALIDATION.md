# Validation

Validated on Windows with Node.js 24.14 and npm 11.12.

## Automated checks

Type check and production build passed. All 64 tests passed, covering:

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

Normal startup does not import SQLite. Legacy migration tests may emit Node's experimental SQLite warning. This remains a local, single-user runtime; it is not load-tested for distributed operation. Remaining work includes compaction, independent session export/deletion, artifact downloads, advanced input editing, peer mailboxes, and signed desktop installers.

Additional checks cover Markdown emphasis, Unicode table alignment/wrapping, escaped pipes, literal code, partial streams, terminal-control removal, live/persisted layout equivalence, startup help, and automatic return from approval queues resolved locally or by another client.

Approval-mode checks cover manual/agent/all execution, agent denial, uncertain/invalid/failed review fallback, cancellation during review, shared review budgets, capability enforcement, API/config validation, and in-place mode completion. TUI regression checks cover automatic arrival, dismiss/reopen behavior, unchanged queue counts with new IDs, multiple pending requests, external decisions, and draft/reading-anchor preservation. Agent decisions use a mocked provider in these checks; no new live-model approval quality evaluation was performed.

Compact approval follow-up: production build and all six TUI tests passed, including raw command display, detail expansion, long-content paging, and a 50-column terminal. The runtime was unchanged.

Collapsible history checks cover live reasoning payloads, exact snapshot restoration, default-collapsed records, tool errors, per-turn deduplication, live-to-persisted identity, actual mouse press/release coordinates, Ctrl+E, and composer draft preservation. All 54 tests and type checking passed.

Source layout refactor: type checking, all 54 tests and production build passed. Compiled CLI help and the orchestrator / orchestrator/client package exports load successfully from their new paths.

Coding-tool update: all 64 tests, type checking and production build passed. New integration checks cover bundled-ripgrep search/exclusions, Windows canonical paths, symlink rejection, paged large-file reads, CRLF-preserving exact edits, parallel reads with write barriers, ordered error results, question answers/cancellation/recovery/deadlines, task plans, cross-session artifact rejection, complete 40k-character command output, role upgrades and table row separators. Question-card choices, custom text, drafts and narrow-terminal paging are exercised through Ink input streams.

Graphical client update: 64 runtime/TUI tests passed; browser integration covers streaming, Markdown sanitization, approvals, questions, teams, projects, cancellation, output paging, history and responsive layout. The packaged Windows exe is separately exercised for startup, messaging, reload and clean shutdown. Test data is isolated; no paid model calls are made.

## Interface refresh — 2026-11-22

Type checking and the Windows package build passed. All 68 Node/Ink tests and 6 Playwright browser/native tests passed. Added coverage for grapheme-aware cursor editing, multiline paste, per-session drafts, compact navigation, empty search results and dialog focus restoration. Desktop (1440 px) and compact (390 px) screenshots were reviewed. Browser tests now live under tests/web/. Initial sandbox-only localhost and junction failures passed when rerun with the required execution permissions.

## TUI/client parity — 2026-11-22

Build and type checking passed. All 71 Node/Ink tests and 8 browser/native tests passed. New coverage exercises grouped projects, project-specific submissions, registered agent selection, approval mode changes, output paging, parent navigation and 50 × 18 terminal bounds. Backspace (DEL) and forward Delete are tested separately through Ink input handling.

## Custom models — 2026-11-22

Type checking, production build and Windows packaging passed. All 75 Node/Ink tests and 9 browser/native tests passed. Coverage includes per-run model pinning, child inheritance, profile persistence, project selection scope, separate credential storage, environment credentials, masked TUI input and browser add/select flows. The final key-input adjustment passed its targeted TUI test. The model picker screenshot was reviewed. These checks use local test providers; custom remote endpoints were not contacted.

## Multi-agent execution — 2026-11-22

Type checking, production build and Windows packaging passed. All 88 Node/Ink tests and 10 browser/native tests passed. A final targeted scale check ran 50 delegated tasks with real JSONL persistence, bounded concurrency, dependency ordering and exact reopen/replay equality (about 3.3 seconds on this machine with a deterministic provider; not an external-model throughput benchmark).

New coverage includes scoped transaction rollback, root fairness, paused dispatch, dependency cycles, idempotent targeted messages, acceptance gates, shared/per-profile limits, token-budget exhaustion, abortable rate waits, pending-approval recovery, stale execution generations, uncertain external effects, completed-tool receipts and late messages before task finalization. Real temporary Git repositories exercise isolated integration, failed verification, stale target rejection and explicit fast-forward application. TUI task controls and browser acceptance controls run against their respective interfaces; desktop and 390 px layouts were checked. No paid model calls were used. Remote workers and distributed failover were not tested or implemented.

Reusable-agent validation: 103 Node/Ink tests passed, including idle persistence and restart, queued-message delivery, late messages during final output, role/permission preservation, follow-up budgets across parent turns, recursive close, and TUI continuation/navigation. All 11 browser/native-client checks passed, including idle child follow-up, close and Parent navigation. The Windows package is rebuilt from the reorganized source. Providers in these tests are deterministic; no external model quality or remote-worker scalability is claimed.
