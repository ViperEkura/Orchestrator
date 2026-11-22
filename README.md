# Orchestrator

English | [简体中文](docs/zh-CN.md)

Orchestrator is a local-first TypeScript multi-agent runtime with a terminal UI, a web client, and a Windows desktop app. All three use the same JSON configuration, JSONL conversation history, and tool approvals. The interface defaults to English.

## Start

Requires Node.js 24.14+ and npm. Git is needed only for writable child worktrees.

```powershell
cd C:\Develop\Orchestrator
npm.cmd ci
npm.cmd run build
npm.cmd start -- init
npm.cmd run tui
```

`npm.cmd run demo` runs deterministic examples without API credentials. To work on another project, use `npm.cmd run tui -- --cwd C:\Develop\MyProject`.

Startup shows help for a new conversation; use `/resume` to reopen saved history. Assistant replies render Markdown, including bold text and responsive tables. The last completed approval returns automatically to the input box.

The terminal uses a conversation-first layout inspired by Pi and Codex: messages, one composer, and temporary selection panels. See [TUI shortcuts](docs/TUI.md) and the shared [Interface design](docs/INTERFACE_DESIGN.md).

Type a message and press Enter for direct Assistant conversation. Use `/delegate reviewer task` for a sub-agent or `/team researcher,reviewer task` for a team. See [collaboration APIs](docs/COLLABORATION.md). Type `/` or a prefix such as `/ap` for inline suggestions: arrows select, Tab completes, Esc closes. Enter fills an incomplete command; a subsequent Enter executes it. IDs accept unique prefixes.

| Command | Action |
|---|---|
| `/new` | Start a direct conversation |
| `/history` | Search user inputs and jump to a turn (Ctrl+R) |
| `/resume` | Search and switch saved conversations |
| `/agents` | Open the task tree; Enter inspects a child |
| `/approvals` | Open pending approvals |
| `/delegate <agent> <task>` | Create one child task |
| `/team <agent1,agent2> <task>` | Execute a configurable team |
| `/use <task-id>` | Select a conversation |
| `/approve <approval-id>` | Approve one tool call |
| `/deny <approval-id>` | Deny one tool call |
| `/cancel [task-id]` | Cancel the selected task or named task and its children |
| `/retry <task-id>` | Retry a failed, cancelled, or interrupted leaf task |
| `/help` | Open the inline suggestions |
| `/quit` | Exit |

Scroll with Up/Down or the mouse wheel, page with PageUp/PageDown, and jump between user turns with Alt+Up/Down. Home shows the beginning; End resumes following the latest reply. Browsing history preserves your draft and reading position while new text streams.

The embedded TUI stops its runtime on exit. For a persistent server, run `npm.cmd run server`, then connect using `npm.cmd run tui -- --url http://127.0.0.1:4317`. Only one runtime can own a data directory.

## Configuration and files

`~` means the OS user home. Set `ORCHESTRATOR_DATA_DIR` to relocate application data.

```text
~/.orchestrator/
  settings.json
  agents/<agent-id>.json
  sessions/<project-hash>/<session-id>.jsonl
  sessions/_system/runtime.jsonl
  artifacts/<session-id>/<artifact-id>.json
  worktrees/<session-id>/
  runtime.lock

<project>/
  .orchestrator/settings.json  # optional project overrides
  AGENTS.md                    # optional project instructions
  ...source files...
```

Settings precedence: defaults → global JSON → project JSON → environment. Missing global settings and built-in agent files are created on startup. Edit existing agent JSON to customize roles; restart to load changes. Each run snapshots its agent configuration and project instructions.

Example project settings:

```json
{
  "provider": "compatible",
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model",
  "concurrency": 3,
  "maxSteps": 40,
  "maxTasks": 16,
  "maxDepth": 3,
  "runTimeoutMs": 300000
}
```

Provider defaults to `demo`; host and server port default to `127.0.0.1:4317`. Embedded TUI uses a free port. The real provider supports streaming Chat Completions with tool calls. Supply secrets through environment variables or reference an existing OpenCode-style credential file:

```powershell
$env:LLM_API_KEY = 'your-api-key'
npm.cmd run tui
```

### Optional environment overrides

To start a demo server, save the following as `.env` in the repository root. To use a model provider, change `demo` to `compatible` and fill in the three `LLM_*` variables.

```dotenv
ORCHESTRATOR_PROVIDER=demo
ORCHESTRATOR_HOST=127.0.0.1
ORCHESTRATOR_PORT=4317
ORCHESTRATOR_APPROVAL_MODE=manual
# ORCHESTRATOR_DATA_DIR=C:/Develop/orchestrator-data
# ORCHESTRATOR_TOKEN=replace-with-a-long-random-token
# LLM_BASE_URL=https://your-provider.example/v1
# LLM_MODEL=your-model
# LLM_API_KEY=your-api-key
```

Load the file explicitly from the repository root. Set `ORCHESTRATOR_TOKEN` to a random value of at least 24 characters when binding the server to a non-loopback address.

```powershell
node --env-file=.env --import tsx src/main.ts server
```

## Sessions and workspaces

- A root session keeps its project `cwd` across turns and restarts. `/new` starts a separate conversation using the runtime's project directory.
- Children get separate sessions and share the parent's directory with read-only tools by default. Tool permissions can only narrow through delegation.
- Delegating with `workspace: "worktree"` creates a detached Git checkout of committed `HEAD`. Uncommitted files are not copied. Worktrees are kept for inspection; merging and cleanup are manual.
- Read-only children cannot create writable descendants. Writes and host shell commands require per-call approval. Project `AGENTS.md` is added to the run's instructions.

The demo keyword `approval` (or `审批`) requests writable child worktrees and therefore needs a Git repository with a commit. The normal demo works without Git.

## Persistence and recovery

Each durable change appends one versioned JSONL record containing an event and incremental state patches. Completed messages, approvals, tasks, and results survive restart. Up to eight completed turns, including tool pairs and provider reasoning metadata, are carried into model context. Text deltas are live-only; a reconnect restores completed messages, not unfinished streamed text. Artifact JSON files contain `{ "mediaType": "...", "content": "..." }`; state holds their relative paths.

Startup replays all logs in global sequence order. An incomplete final line is backed up and removed; invalid committed records cause an error. Unfinished runs become `interrupted`, without automatically repeating tool side effects. Back up the entire data directory: individual session logs cannot yet be independently deleted or imported because sequence numbers and task references span files.

The old SQLite database is imported automatically only when the new data directory does not exist. Otherwise choose a new destination explicitly:

```powershell
npm.cmd start -- migrate C:\Develop\Orchestrator\.orchestrator\state.sqlite --output C:\Develop\Orchestrator-history
```

Migration verifies replay before publishing the new directory, keeps IDs and legacy events, and leaves SQLite and old workspace files in place. Existing sessions retain their latest legacy workspace; new sessions use the project directory. SQLite is loaded only during migration, so normal startup no longer emits its experimental warning.

## Boundaries and verification

This release is single-process and single-user. Logs are plain text and loaded into memory; mutation diffing still clones in-memory state. It targets small local projects. No automatic compaction, independent session deletion, distributed workers, or per-agent model routing yet.

File tools reject path traversal and symlinks. Approved shell commands run with host permissions; a worktree is not a security sandbox. Trusted extensions must accurately declare read-only behavior. Remote clients share access to all sessions; use a trusted network or TLS proxy. Cross-origin browser requests are rejected by default.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
```

See [architecture and class diagram](docs/ARCHITECTURE.md), [API](docs/API.md), [extensions](docs/EXTENDING.md), and [validation](docs/VALIDATION.md). No open-source license has been selected.

## DeepSeek / OpenCode credential reuse

The local installation is configured for DeepSeek V4.1 Flash with high thinking effort. The portable source package contains no credential or user settings. To reproduce the setup, use:

```json
{
  "provider": "compatible",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "defaultAgent": "assistant",
  "thinking": "enabled",
  "reasoningEffort": "high",
  "maxOutputTokens": 8192,
  "credentials": {
    "file": "C:/Users/YOU/.local/share/opencode/auth.json",
    "provider": "deepseek"
  }
}
```

The referenced entry must contain `{ "type": "api", "key": "..." }`. Orchestrator reads the key at startup without copying it into settings or logs. `LLM_API_KEY` takes precedence. Provider reasoning metadata is retained and sent back when continuing tool-enabled conversations, as required by [DeepSeek's thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/).

Approval defaults to **manual** and pending requests open automatically. Use `/approval manual`, `/approval agent`, or `/approval all` to switch the running server; set `approvalMode` in settings.json for the startup default. See [approval behavior](docs/TUI.md#approval-modes-and-automatic-prompts).

## Source layout

```text
src/
  main.ts              CLI entry
  index.ts             Public package exports
  core/                Domain, runtime, approvals, config, workspaces
  storage/             JSONL store, atomic files, legacy migration
  models/              Demo and compatible model providers
  tools/               Tool registry and built-in tools
  transport/           HTTP server, client SDK, shared SSE parser
  clients/
    tui/               App, editor, project/team/settings/output panels, transcript
    shared/            Shared client labels and approval choices
    web/               Browser and desktop interface
    desktop/           Native Windows host
```

The CLI remains `src/main.ts`; public exports remain in `src/index.ts`. The `orchestrator/client` package export resolves to `transport/client`. Tests stay in `tests/` and import the relevant modules directly.

Built-in `grep`, `glob`, recursive listing, paged reads, exact edits, recoverable tool outputs, user questions and task plans are available. Read [tool arguments and limits](docs/TOOLS.md). Ripgrep is installed with npm dependencies; no global `rg` command is required.

## Graphical clients

Run `npm run desktop` for an native Windows app, or `npm run web` and open the printed local URL. Both share your existing runtime, conversations, approvals and agents. See [Desktop and web clients](docs/CLIENTS.md) for launch options and scope.

Model profiles can be added and selected in both clients, including custom Chat Completions URLs and API keys. See [Model configuration and switching](docs/MODELS.md). Running tasks retain their original model; selections apply to new turns.

## Multi-agent task control

See [multi-agent execution](docs/SWARM.md) for task graphs, recovery, targeted messages, budgets and verified Git integration. Open `/tasks` in the TUI or **Tasks** in the graphical client.
