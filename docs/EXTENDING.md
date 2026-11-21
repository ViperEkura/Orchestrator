# Extending Orchestrator

## Agents

Edit `~/.orchestrator/agents/<id>.json` and restart:

```json
{
  "id": "researcher",
  "name": "Researcher",
  "systemPrompt": "Inspect the project and explain your findings in English.",
  "allowedTools": ["list_files", "read_file"]
}
```

Agent IDs must be unique. Missing built-in files are seeded on startup; edit their contents to customize them. Each run snapshots its definition. Delegation intersects parent and child tool lists, then strips non-read-only tools for read-only sessions.

## Tools

Register trusted TypeScript code through `ToolRegistry`. Use Zod schemas for arguments. Mark `readOnly: true` only for tools without write/command side effects; otherwise omit it. Set `approval: true` for user-approved side effects. The runtime validates arguments and permissions before execution.

```typescript
import { z } from 'zod';
import { createTools } from './src/index.js';

const tools = createTools();
tools.register({
  name: 'project_name',
  description: 'Return the active project directory.',
  schema: z.object({}).strict(),
  approval: false,
  readOnly: true,
  async execute(_args, context) { return { cwd: context.workspace }; }
});
```

Pass this registry as `options.tools` in the runtime constructor and allow the tool in the relevant agent definitions. Honor `context.signal` and use workspace path validation for file access. Extensions are trusted code, not sandboxed plugins.

`delegate_task` accepts `{ agentId, objective, dependsOn?, workspace? }`. Workspace defaults to `read-only`; `worktree` requests a writable checkout of committed HEAD. The child still needs write/command capabilities and per-call approvals. Worktree changes are not automatically merged.

## Models

Implement `ModelProvider.stream(messages, tools, signal)` as an async iterable of `{ type: "text", text }` and complete `{ type: "tool", call: { id, name, arguments } }` chunks. Assemble partial tool-call arguments before yielding the call; honor cancellation. Inject the provider into `OrchestratorService`. Built-in roles currently share one provider.

## Embedding

```typescript
import { loadConfig, StateStore, OrchestratorService, DemoProvider } from './src/index.js';

const { home, cwd, settings, agents } = loadConfig(process.cwd());
const store = new StateStore(home);
const runtime = new OrchestratorService(store, new DemoProvider(), {
  ...settings, agents, workspaceDir: cwd
});
try {
  const task = runtime.submit({ objective: 'Inspect this project' });
  console.log(await runtime.waitUntilDone(task.id));
} finally {
  await runtime.close();
  store.close();
}
```

The store takes a data directory, not a SQLite filename. `:memory:` is suitable for tests but does not write artifact bodies to disk. Keep JSON values lossless and serializable. Use the API client for multiple interfaces instead of opening the same directory from multiple runtimes.
