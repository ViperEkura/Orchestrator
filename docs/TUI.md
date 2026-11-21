# Terminal interface

The TUI uses a conversation-first layout: a compact model/workspace header, scrolling messages, one borderless composer with a subtle dark-gray background and padding, and a quiet status line. It runs in the alternate terminal screen and restores the original screen on exit. There is no permanent sidebar or tab bar. Startup opens a fresh help screen instead of automatically loading old Coordinator or demo output. Send a message to begin; use `/resume` to explicitly reopen history.

The design references [Pi's transcript/editor/footer](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md) and [Codex's temporary selection panels](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/mod.rs). It does not reproduce all their features or key bindings.

| Action | Shortcut or command |
|---|---|
| New direct conversation | Ctrl+N or `/new` |
| Search and resume conversations | Ctrl+P or `/resume` |
| Inspect task tree and child conversations | Ctrl+T or `/agents` |
| Review pending tool requests | Ctrl+O or `/approvals` |
| Return from a panel | Esc; unsent draft is preserved |
| Select and open an item | Up/Down, Enter |
| Scroll older/newer messages | Up/Down or mouse wheel; PageUp/PageDown for pages |
| Search user inputs and jump to a turn | Ctrl+R or `/history`; type a filter, Enter to jump |
| Previous/next user turn | Alt+Up / Alt+Down |
| Beginning / follow latest output | Home / End |
| Approve/deny the selected request | Y/N in the approval panel |
| Complete commands | `/`, Up/Down, Tab; Enter completes before executing |
| Delegate one child task | `/delegate reviewer review the API` |
| Run a configurable team | `/team researcher,reviewer inspect this project` |
| Stop a task tree | `/cancel` |

Selection panels temporarily replace the composer. Session panels accept a text filter. Approval cards use a subtle background without a border and size to their content. Commands display directly; file writes show the path and proposed contents. D toggles raw parameters and review metadata. Long content can be paged; the footer shows the visible line range. Multiple requests use a compact position counter and Up/Down navigation. The current workspace remains visible. After the final pending request is resolved, the panel closes automatically and restores the draft. This also works when another client resolves the request. An empty approval panel accepts Enter or Esc to return; typing returns to the composer. Thinking and tool calls appear inline in their user turn as collapsed rows. Click a disclosure row or press Ctrl+E to toggle the first visible row. Thinking shows only text actually returned by the model; tools expose their arguments, result and outcome. Expanding records never executes tools or submits the composer draft.

Ordinary input is handled by the Assistant. It responds directly unless delegation is explicitly requested or independent parallel work is authorized. `/delegate` and `/team` submit structured plans to the runtime: their creation does not depend on a model deciding to call a tool. Agent IDs are user-configurable JSON definitions, not hard-coded members of a team.

All turns in the selected conversation are available through scrolling. The History panel numbers each user input chronologically and searches only the selected conversation. Jumping positions that user input at the top of the transcript without changing the active task or resending anything. Browsing older messages pauses automatic following; new streamed text does not move the reading position. End resumes following. Opening and dismissing a selection panel preserves the reading position and unsent draft. Command-completion menus retain priority for Up/Down. Prior model context is not duplicated in the display. The current input editor is single-line; advanced cursor editing is not implemented. Assistant Markdown supports bold, italic, headings, lists, links, quotations, code blocks, and tables. Tables wrap cell contents using Unicode display widths; tables with too many columns become labelled rows rather than losing data. Code blocks preserve literal content without syntax highlighting. Partial streaming Markdown stays readable and is formatted as syntax completes. Stored messages remain raw Markdown; user input remains literal. Mouse-wheel capture uses SGR mouse reporting on compatible terminals; use Shift while selecting text if the terminal requires it, or use keyboard navigation when mouse reporting is unavailable. Minimum terminal size is 50 columns by 18 rows.

## Approval modes and automatic prompts

`/approval manual|agent|all` switches the running server mode; the header shows the active mode. Completion offers all three values. This affects new tool calls across its sessions and does not decide existing pending requests. For a persistent startup default, set `"approvalMode": "manual"` (or `agent`, `all`) in settings.json.

- **manual** (default): protected tool calls automatically open the approval panel.
- **agent**: a separate, tool-free call to the configured model reviews the exact operation against the user request. Clear decisions proceed or deny; uncertainty, invalid responses, errors or a 15-second review timeout fall back to a manual prompt. Demo mode also falls back to manual. Reviews count against the shared model-step budget.
- **all**: protected calls proceed without a prompt. Tool capabilities, argument validation and workspace path checks still apply; this is not an OS sandbox.

Each newly pending request opens automatically, including after reconnecting. Y approves, N denies, and the last decision returns to chat with the draft and reading anchor intact. Esc temporarily dismisses the panel; it does not decide the request. The same request does not repeatedly reopen. Ctrl+O reopens pending requests; new requests still trigger a prompt. Multiple agents share the queue. Decisions and review explanations are recorded in JSONL history.

Thinking streams live and is retained in completed assistant messages. Historical tool arguments/results use the existing message records; no duplicated history store is added. Expansion state belongs to the current TUI instance and defaults to collapsed on restart. Providers without reasoning text retain the normal activity indicator. Unfinished stream fragments are transient; large tool results still use the existing preview/artifact reference format.

Disclosure rows include a single-line preview: the opening thinking text, a tool command/path, a delegated objective, or other arguments. Whitespace is collapsed and long previews end with an ellipsis according to terminal display width. Full contents remain available on expansion.

Disclosure rows align only the name and preview. Only failed or denied tool calls use red; all other outcomes use gray. Thinking stays gray. Expanding a record reveals its explicit Status line. Column padding uses terminal display width, including Chinese characters; narrower terminals shrink the name column.
