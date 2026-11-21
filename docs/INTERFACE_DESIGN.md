# Interface design

Status: implemented baseline for the terminal, web and Windows desktop clients.
The desktop app embeds the web client, so both share layout, components and behavior.
UI copy is English by default. User messages and model responses keep their original language.

## Goals

1. Keep the conversation readable while agents work.
2. Make composing, reviewing and returning to a previous turn predictable.
3. Show useful summaries before implementation details.
4. Preserve drafts when switching conversations or reviewing requests.
5. Adapt to small windows without hiding the primary action.

## Information architecture

The runtime owns sessions, tasks, messages, approvals, questions and artifacts. Clients own
drafts, focus, scrolling, panel selection and disclosure expansion. Interface changes do not
rewrite stored messages or create a separate history format.

| Area | Primary content | Secondary content |
| --- | --- | --- |
| Navigation | Collapsible projects containing their conversations | Search, settings |
| Conversation | User turns and assistant responses | Collapsed thinking and tool records |
| Composer | Draft and send/stop | Agents, approval mode, model |
| Details | Agent tasks and saved outputs | Workspace path |
| Request | Proposed action or question | Arguments, identifiers, review metadata |

## Web and desktop layout

```text
┌──────┬──────────────────┬───────────────────────────────────────────┐
│ Rail │ Orchestrator     │ Conversation title               Details │
│      │ New chat         │ Project / agent                           │
│      │ Search           ├───────────────────────────┬───────────────┤
│      │                  │                           │ Agents        │
│      │ Projects         │        User message       │ Outputs       │
│      │   Conversations  │ Assistant response        │ Workspace     │
│      │   Title          │ › tool       preview      │               │
│      │   Project        │                           │ Optional      │
│      │                  │         ↓ Latest          │               │
│      │                  │ ┌───────────────────────┐ │               │
│      │                  │ │ Draft                 │ │               │
│      │                  │ │ Agents  Approval   ↑  │ │               │
│      │ Connection       │ └───────────────────────┘ │               │
└──────┴──────────────────┴───────────────────────────┴───────────────┘
```

The diagram shows regions, not visible borders. The composer uses a raised background;
only keyboard focus adds a subtle outline. There are no decorative dividers between messages.

### Dimensions and spacing

| Element | Baseline |
| --- | --- |
| Navigation rail / sidebar | 52 / 244 px; larger navigation at 1700 px |
| Header | 68 px; 66 px below 900 px |
| Conversation text | Maximum 840 px, centered |
| Message text | 15 px, 1.75 line height |
| User bubble | Up to 85% width, 12 × 18 px padding |
| Turn spacing | 40 px |
| Composer | 18 px radius, 16–18 px inner padding |
| Draft height | Grows to 220 px, then scrolls |
| Details | 290 px; 320 px on large displays |

### Palette

CSS tokens are defined in `src/web/style.css`.

| Token | Value | Purpose |
| --- | --- | --- |
| `--canvas` | `#191919` | Conversation background |
| `--surface` | `#222222` | Secondary surfaces |
| `--raised` | `#2b2b2b` | Composer |
| `--line` | `#343434` | Structural separators |
| `--text` | `#e7e7e7` | Primary text |
| `--muted` | `#a0a0a0` | Supporting text |
| `--accent` | `#a8c7fa` | Keyboard focus |

Thinking and successful/pending tool rows remain gray. Failed or denied tools use red;
their expanded contents also show an explicit outcome. Color is not the only source of status.

### Responsive behavior

- At 1150 px and below, details overlay the conversation rather than reducing its width.
- Below 900 px, navigation opens as a drawer with a dismissible backdrop. It starts closed.
- Below 540 px, suggestions stack, model text is hidden and composer controls may wrap.
- Search opens the drawer before focusing its field. Empty searches explain that no results match.
- Long commands, code and tables scroll within their own areas; the page must not overflow horizontally.
- The latest-output button is anchored to the composer, including while the draft grows.

### Project navigation and approval selector

Projects contain their conversations in an indented tree. The project row expands or collapses
its children; the adjacent plus button starts a new conversation in that folder. Collapsing a
project does not change the active conversation. Search filters child conversations while keeping
their project heading and temporarily expanding matches. Project and output rows share a 20 px
icon column, 10 px gap and 9 px horizontal padding; child conversations use one consistent indent.

Approval mode uses a shared dark popover in the composer and Settings. The menu opens above the
trigger when space permits, otherwise below; its position is clamped inside the viewport. Each
choice shows a label, explanation and selected checkmark. Arrow keys and Home/End move focus;
Enter/Space selects. Esc or outside click dismisses without changing the mode. Selection returns
focus to the trigger. The popover participates in the browser top layer, including inside dialogs.

### Keyboard and focus

| Action | Shortcut |
| --- | --- |
| New conversation | Ctrl/Cmd+N |
| Search conversations | Ctrl/Cmd+K |
| Send | Enter |
| Insert newline | Shift+Enter |
| Close dialog | Esc |

Native dialogs contain keyboard focus. Closing a dialog restores focus to its previous control
when that control still exists. IME composition must finish before Enter can send. Controls have
accessible labels and visible focus states. Animation respects reduced-motion preferences.

## Terminal layout

```text
 ORCHESTRATOR · model · Approval: manual
 project path

 CHAT · session · agent · Turn 2/3
 YOU
 User message

 ASSISTANT · completed
 › Thinking       Short preview
 › read_file      src/main.ts
 Assistant response

 Status or pending request
 ░ › Draft with visible cursor                                     ░
 ░   Additional lines                                              ░
 Enter send · Alt+Enter newline · ←→ edit · PgUp/PgDn history
```

- The header uses three rows, including its separating blank row.
- The transcript fills the remaining space. Composer height is deducted before selecting visible rows.
- The borderless composer uses `#202020`, two columns of horizontal padding and one row of vertical padding.
- Drafts grow to five visible lines; short terminals allocate fewer lines. The cursor stays visible.
- Slash suggestions appear inside the input surface and take priority over arrow-key editing.
- Session, history and agent panels use the same quiet background instead of bright frames.
- Approval and question panels temporarily replace the composer and return to it after resolution.
- The footer shows controls for the active surface, rather than a permanent list of all shortcuts.
- Minimum supported terminal size is 50 × 18. Smaller terminals show a resize message.

### Input and navigation

| Action | Shortcut |
| --- | --- |
| Send | Enter |
| Newline | Alt+Enter; Shift+Enter where supported; Ctrl+J where distinguishable |
| Move / insert at cursor | Left/Right, normal typing |
| Previous/next logical draft line | Up/Down while the draft is nonempty |
| Start/end of draft line | Ctrl+A / Ctrl+F |
| Delete before/at cursor | Backspace / Delete |
| Delete previous word | Ctrl+W |
| Scroll transcript | Mouse wheel, PageUp/PageDown; Up/Down when the draft is empty |
| First message / follow latest | Home / End |
| Previous/next user turn | Alt+Up / Alt+Down |
| Turn / session / agent panel | Ctrl+R / Ctrl+P / Ctrl+T |
| Toggle first visible activity record | Ctrl+E; or click a record |
| Return from a panel | Esc |

Home/End retain their existing transcript meaning; Ctrl+E retains its disclosure meaning.
Terminals differ in modified-Enter reporting. Multiline paste always preserves line breaks.
Editing and deletion operate on grapheme clusters, including joined emoji. Width calculations
use terminal cells, so Chinese text does not shift the cursor by the wrong number of columns.
The 16,000 UTF-16-unit input limit matches the runtime. A long paste keeps its existing suffix.

Each session keeps its own in-memory draft and cursor. New chat starts with an empty draft.
Approvals, questions and navigation do not overwrite the chat draft. Drafts are not persisted
across application restarts. Typing does not rebuild an unchanged transcript.

## Client feature parity

| Feature | Web / desktop | TUI |
| --- | --- | --- |
| Project conversation tree | Sidebar, folder disclosure | Ctrl+P, Left/Right, Enter |
| New chat in a project | Project plus button | Highlight project or its chat, press + |
| Open a directory | Add project dialog | Ctrl+A in project tree or /project path |
| Choose next-turn agents | Agents picker | Ctrl+L, Space, Enter |
| Select approval mode | Themed popover | Ctrl+S or /approval, arrows, Enter |
| Inspect agent conversations | Details panel | Ctrl+T; Ctrl+B returns to parent |
| Saved outputs | Details, paged output dialog | Ctrl+U, Enter, L for next page |
| Copy response / output | Clipboard buttons | /copy, or C in output viewer; OSC 52 required |
| Stop and retry | Composer stop / response retry | /cancel and /retry with ID completion |
| Model selection and custom endpoints | Composer model picker / Settings | /models; A adds URL, model and key |

Both clients use the same runtime operations, stored conversations and configured roles.
Neither client implements persistent named teams or distributed workers yet. Terminal panels
are temporary surfaces, rather than permanent desktop-style sidebars. The client-specific
keyboard and pointer affordances differ; permission and task semantics remain shared.

## Shared interaction rules

| State | Presentation | User action |
| --- | --- | --- |
| Empty conversation | Short introduction and suggested starting points | Type immediately |
| Generating | Live response with quiet activity indicator | Scroll freely; stop if needed |
| Reading history | Keep reading position; expose return-to-latest action | Jump to a user turn |
| Tool activity | Aligned name and single-line preview, collapsed initially | Expand arguments/result |
| Approval pending | Automatic compact request | Approve once, deny, or dismiss temporarily |
| Question pending | Choices plus custom answer | Submit an explicit answer |
| Failed task | Error text and available retry action | Review the error before retrying |

Dismissal never approves or denies a request. Requests resolved by another client close locally.
Expanded records are read-only views and never execute the operation again. Markdown remains
raw in storage and is rendered separately by each client. Math rendering is outside this design.

## Implementation map

| Responsibility | Files |
| --- | --- |
| Terminal orchestration and focus | `src/tui/app.tsx` |
| Shared approval choices and project labels | `src/ui/options.ts` |
| Terminal project/team/settings/output panels | `src/tui/workspace-panel.tsx` |
| Terminal input compatibility | `src/tui/input.ts` |
| Terminal editor and cursor layout | `src/tui/editor.ts`, `src/tui/composer.tsx` |
| Terminal transcript / Markdown | `src/tui/view.ts`, `src/tui/markdown.ts` |
| Browser layout and local UI state | `src/web/app.tsx` |
| Browser shared components | `src/web/components.tsx` |
| Browser visual rules | `src/web/style.css` |
| Model profile selection and custom endpoint forms | `src/web/model-picker.tsx`, `src/tui/model-panel.tsx` |
| Runtime subscription | `src/web/runtime.ts` |
| Native host | `src/desktop/Orchestrator.cs` |

## Validation and remaining work

Run `npm run check`, `npm test`, and `npm run test:web`. All test sources live under `tests/`:
Node/Ink tests are at the root; Playwright browser/native tests are in `tests/web/`.
The separate commands select different runners; they do not represent separate products.

Regression coverage includes Unicode cursor editing, multiline paste, per-session drafts,
terminal resizing, request resolution, Markdown, turn navigation, compact browser navigation,
dialog focus and native startup. Visual review should include a populated desktop conversation,
a 390 px viewport, and a narrow terminal with completions or a request open.

Remaining improvements: source-position scroll anchors across terminal reflow, visual-row vertical
cursor movement for soft wraps, persistent draft recovery, long-history virtualization, and a
unified reconnect/state reducer. These are follow-up work, not implied by this interface refresh.
