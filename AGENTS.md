# Working on Orchestrator

Keep client-specific rendering in `src/clients/tui` or `src/clients/web`. Both clients use the transport API. Put shared presentation logic in `src/clients/shared` and agent lifecycle behavior in `src/core`.

When delegating independent work, give each child a bounded objective, the relevant paths and a way to verify its result. Reuse an idle child for follow-up on the same objective. Separate writable work by file or worktree and review child results before integrating changes.

Run `npm run check` and `npm test` for runtime changes. Use `npm run test:web` on Windows for changes to the browser UI or the packaged desktop host. Use temporary data directories for tests.

See [agent guidance](docs/AGENT_GUIDANCE.md) for instruction precedence, role configuration and skill discovery.
