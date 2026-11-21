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

Selection panels temporarily replace the composer. Session panels accept a text filter. Approval panels show the exact arguments and workspace; long details can be paged. After the final pending request is resolved, the panel closes automatically and restores the draft. This also works when another client resolves the request. An empty approval panel accepts Enter or Esc to return; typing returns to the composer. Model reasoning is reported as a thinking indicator; only the final answer is displayed as chat text.

Ordinary input is handled by the Assistant. It responds directly unless delegation is explicitly requested or independent parallel work is authorized. `/delegate` and `/team` submit structured plans to the runtime: their creation does not depend on a model deciding to call a tool. Agent IDs are user-configurable JSON definitions, not hard-coded members of a team.

All turns in the selected conversation are available through scrolling. The History panel numbers each user input chronologically and searches only the selected conversation. Jumping positions that user input at the top of the transcript without changing the active task or resending anything. Browsing older messages pauses automatic following; new streamed text does not move the reading position. End resumes following. Opening and dismissing a selection panel preserves the reading position and unsent draft. Command-completion menus retain priority for Up/Down. Prior model context is not duplicated in the display. The current input editor is single-line; advanced cursor editing is not implemented. Assistant Markdown supports bold, italic, headings, lists, links, quotations, code blocks, and tables. Tables wrap cell contents using Unicode display widths; tables with too many columns become labelled rows rather than losing data. Code blocks preserve literal content without syntax highlighting. Partial streaming Markdown stays readable and is formatted as syntax completes. Stored messages remain raw Markdown; user input remains literal. Mouse-wheel capture uses SGR mouse reporting on compatible terminals; use Shift while selecting text if the terminal requires it, or use keyboard navigation when mouse reporting is unavailable. Minimum terminal size is 50 columns by 18 rows.
