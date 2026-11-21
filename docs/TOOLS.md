# Built-in tools

Tool paths are relative to the task workspace. File access rejects traversal and symlink/junction components. These checks are not an OS sandbox; `run_command` still runs on the host.

| Tool | Main arguments | Behavior |
|---|---|---|
| `grep` | `pattern`, `path?`, `glob?`, `literal?`, `ignoreCase?`, `context?`, `limit?` | Regex or literal search, file paths, line numbers and context; no shell |
| `glob` | `pattern`, `path?`, `limit?` | Find files, e.g. `src/**/*.ts` |
| `list_files` | `path?`, `depth?`, `limit?` | Recursive directory listing; depth defaults to 1 |
| `read_file` | `path`, `offset?`, `limit?` | 1-based line offset, default 200 lines; returns totalLines and nextOffset |
| `apply_patch` | `path`, `edits: [{oldText,newText}]` | Exact replacements; each oldText must match once; validate every edit before writing |
| `write_file` | `path`, `content` | Write a complete file |
| `run_command` | `command`, `timeoutMs?` | Execute a host command; default 30s, maximum 60s |
| `read_artifact` | `artifactId`, `offset?`, `limit?` | 0-based character pages, default 12,000; current session or task tree only |
| `ask_user` | `question`, `options?` | Wait for a choice or custom answer, regardless of approval mode |
| `todo_write` | `items: [{text,status}]` | Replace this task's plan; statuses pending/in_progress/completed |
| `delegate_task` | `agentId`, `objective`, `workspace?`, `dependsOn?` | Start a child task |
| `wait_tasks` | `taskIds` | Wait for direct children |

Example model tool arguments (these are not TUI slash commands):

```json
{"pattern":"TODO|FIXME","glob":"src/**/*.ts","context":2}
{"path":"src","depth":3}
{"path":"src/core/runtime.ts","offset":100,"limit":80}
{"path":"config.txt","edits":[{"oldText":"enabled=false","newText":"enabled=true"}]}
{"question":"Which output format should I use?","options":["JSON","CSV"]}
```

## Search and file limits

- Search uses the project-installed [Microsoft ripgrep package](https://github.com/microsoft/vscode-ripgrep) and [ripgrep regex/glob semantics](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md). Glob matching uses [Node's path.matchesGlob](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern). No runtime download or global rg command is needed.
- Listing and glob skip `.git`, `node_modules`, `.orchestrator` and symlinks, cap traversal at 50,000 entries, and expose `truncated` when the result/scan limit is reached. Paths are workspace-relative; glob patterns also apply to workspace-relative paths. Listing depth is 1–20.
- Grep also observes ignore files. Context rows count toward its returned limit (default 100, maximum 500). Search has a 10-second timeout and 16 MiB JSON buffer ceiling; narrow the path/glob if exceeded. Search errors are reported instead of silently returning incomplete results.
- Reads and exact edits support UTF-8 text files up to 16 MiB, reject binary data, and bound read pages to 128,000 characters. `read_file` returns at most 2,000 lines per page. A single line over the page ceiling produces an explicit error.
- `apply_patch` is an exact replacement API, not a unified-diff parser. It normalizes replacement line endings to the file's existing LF/CRLF style. Missing or ambiguous old text fails before writing. Write and patch operations use the configured approval policy; the TUI displays removed/added snippets for patches.

## Execution and output

Consecutive tools marked both `readOnly` and `parallelSafe` run concurrently within the configured execution limit. This includes grep, glob, list_files, read_file and read_artifact. Writes and other calls form barriers; dependent queries should be issued in separate model responses. Tool results, including failures, are appended in request order.

Serialized results over 24,000 characters are saved once as artifacts, with an ID and preview in messages/events. `read_artifact` retrieves the full saved result in pages. Command output is decoded incrementally and retained up to 8,388,608 characters; exceeding that explicit ceiling terminates the command with `outputLimitReached`, instead of silently keeping only the tail. Timeouts and cancellation also terminate the process tree.

Questions and plans are persisted in JSONL. User waits consume no execution permit, but remain subject to the run deadline. Cancelling/restarting the runtime invalidates outstanding questions. A plan may contain at most 50 items and one in-progress item. Pristine built-in agent definitions gain these tools on startup; customized roles keep their explicit allowlists. MCP integration is deferred.
