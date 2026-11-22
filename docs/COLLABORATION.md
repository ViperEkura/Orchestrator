# Sub-agents and multi-agent execution

See [agent roles, workspace instructions and skills](AGENT_GUIDANCE.md) for configuration and examples.

The same runtime primitives support direct conversation, sub-agent delegation, and coordinated teams. They work with any injected ModelProvider; DemoProvider is only a deterministic example.

- **Direct conversation:** submit a task to the default `assistant`; continue with the returned session ID. Text streams through SSE and complete messages persist in JSONL.
- **Sub-agent:** submit one delegation, or let an authorized agent call `delegate_task` and `wait_tasks`. The child has a separate session and returns a structured result to its parent.
- **Team:** submit several delegations. Independent entries run concurrently; `after` entries wait for earlier plan entries. The parent receives results and produces the final answer.

```typescript
const task = await client.submit({
  objective: 'Assess this project and summarize the findings',
  delegations: [
    { agentId: 'researcher', objective: 'Inspect the implementation' },
    { agentId: 'reviewer', objective: 'Review the findings', after: [0] }
  ]
});
```

`after` contains zero-based plan indices and can only point backward, preventing cycles. Omit it for parallel work. All roles come from `agents/*.json`; the sample roles are replaceable. `workspace` defaults to `read-only`; choose `worktree` for a writable checkout of committed HEAD. Approvals and capability narrowing still apply.

Plans are stored with the parent task. Budget, depth, timeout, cancellation propagation, and restart recovery cover the whole task tree. A parent waiting for children holds no model permit, so a concurrency limit of one remains usable. Failed dependencies do not execute downstream work; failed children are visible in the parent result and task status.

This release implements parent-coordinated teams. Peer-to-peer mailboxes, autonomous shared-room debates, dynamic role generation, and automatic merging of worktrees are not implemented. Creating sub-agents is a runtime capability, not a separate provider or UI mode.
