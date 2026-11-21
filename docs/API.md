# HTTP and SSE API

Default server: `http://127.0.0.1:4317`. POST requests require `Content-Type: application/json`. When configured, every request requires `Authorization: Bearer <ORCHESTRATOR_TOKEN>`. Non-loopback binds require a token of at least 24 characters. Browser origins must match the server origin.

| Method | Path | Request / response |
|---|---|---|
| GET | `/health` | Status and version |
| GET | `/v1/snapshot` | `{ state, lastSeq }` |
| GET | `/v1/info` | Workspace, model, provider, default agent; no credentials |
| GET | `/v1/agents` | Agent definitions |
| GET | `/v1/events?after=123` | SSE replay and live events |
| POST | `/v1/tasks` | `{ objective, agentId?, sessionId?, delegations? }` → task |
| POST | `/v1/tasks/:id/cancel` | `{}` → `{ ok: true }` |
| POST | `/v1/tasks/:id/retry` | `{}` → new run |
| POST | `/v1/approvals/:id` | `{ decision: "approved" \| "denied" }` |

Submit with a session ID to continue its conversation and stored cwd; omit it for a new root session in the runtime's project. SDK/API IDs are full IDs; prefix resolution belongs to the TUI.

Snapshot state contains `sessions`, `tasks`, `runs`, `approvals`, `artifacts`, and `budgets`. Completed chat messages are in `runs[id].messages`. Sessions contain `cwd` and `workspace`; artifacts contain a path relative to the runtime data directory. Artifact content download is not exposed through HTTP yet.

## Events

Durable events carry an increasing global sequence and an SSE `id`:

```text
id: 123
data: {"seq":123,"type":"task.completed","at":"...","taskId":"...","data":{}}

```

Streamed text is transient and has no SSE `id`:

```text
data: {"seq":123,"type":"message.delta","at":"...","runId":"...","data":{"text":"Hello"},"transient":true}

```

Multiple deltas may share the same sequence. Do not deduplicate them or advance the durable cursor. They are not replayed after reconnect. Durable `message.completed` events make completed messages recoverable through a fresh snapshot.

Connect using `after` or `Last-Event-ID`; `after` takes precedence. The SDK reconnects after transport failures and stops on authentication failure or caller cancellation. Slow consumers are disconnected and can replay durable events. Migration retains old events inside `legacy.event` records; use the outer sequence for reconnects.

Typical client flow: fetch snapshot, subscribe after `lastSeq`, display transient text, and refresh state after durable mutations. All clients share the same runtime and permissions.

Errors use `{ "error": "..." }`: schema validation 400, authentication 401, host/origin denial 403, missing route 404, unsupported content type 415, and other request failures 409. POST bodies are capped at 64 KiB.

`delegations` accepts `{ agentId, objective, workspace?, after? }` entries. See [structured collaboration](COLLABORATION.md). `message.thinking` is a transient activity event without reasoning text; reasoning metadata remains in persisted messages for provider continuity.
