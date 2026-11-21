# Changelog

## Unreleased

- Replace the composer outline with a subtle dark-gray background, neutral input text, and padded spacing.

- Render assistant Markdown with inline emphasis, code blocks and responsive Unicode tables.
- Show startup help instead of automatically resuming old demo conversations.
- Close resolved approval panels automatically, preserving drafts and allowing escape while requests are pending.

- Add arrow/wheel scrolling, searchable user-turn navigation, adjacent-turn jumps, and stable history anchors during streaming.

- Add a conversation-first fullscreen TUI with searchable resume, agent/approval panels, history paging, and preserved drafts.
- Default to direct Assistant conversations; expose structured sub-agent/team plans with dependency scheduling.
- Add DeepSeek thinking metadata round-trips and references to existing OpenCode API credentials.

- Replace SQLite runtime snapshots with per-session incremental JSONL logs and file artifacts.
- Add global/project JSON settings, editable agent definitions, and environment overrides.
- Bind sessions to stable project directories and load project AGENTS.md instructions.
- Share directories through read-only child capabilities; support explicit writable Git worktrees.
- Preserve legacy SQLite data with a verified one-time importer.
- Keep streamed deltas live-only while persisting complete messages and replayable state changes.
- Default UI, built-in roles, and demo output to English; retain a Chinese guide.
- Show inline slash-command and ID suggestions with a single input prompt.

## 0.1.0 — 2026-11-21

- Initial TypeScript runtime, Ink TUI, HTTP/SSE API, and client SDK.
- Role definitions, child sessions, dependencies, budgets, and tool approvals.
- Demo and streaming Chat Completions providers.
- Original SQLite persistence, cancellation, leaf retries, and recovery.

### Approval modes

- Add manual, agent-reviewed and allow-all approval modes with config, API and TUI switching.
- Open pending approvals automatically and preserve drafts when returning to chat.
- Record automatic decisions and fall back to manual when model review is unavailable.

### Compact approval cards

- Replace the oversized approval list with a borderless operation card.
- Show commands and file contents directly; expand metadata with D.
- Remove duplicate status/help text and preserve paging and queue navigation.

### Collapsible conversation details

- Show model-provided thinking and tool calls inline, collapsed by default.
- Add mouse and Ctrl+E expansion for arguments, results and reasoning.
- Stream thinking into the same record used by completed history.

### Inline detail previews

- Add single-line thinking and tool argument previews to disclosure rows.
- Collapse whitespace and truncate long previews to terminal display width.

- Align disclosure names, statuses and previews in responsive terminal columns.
