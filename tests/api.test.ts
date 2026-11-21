import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { StateStore } from '../src/store.js';
import { OrchestratorService } from '../src/runtime.js';
import { DemoProvider, CompatibleProvider, readSSE } from '../src/models.js';
import { startServer } from '../src/server.js';
import { OrchestratorClient } from '../src/client.js';

test('HTTP SDK, bearer auth, origin checks and replayable SSE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-api-'));
  const store = new StateStore(':memory:'); const runtime = new OrchestratorService(store, new DemoProvider(), { workspaceDir: dir });
  const server = await startServer(runtime, { port: 0, token: 'test-secret' });
  try {
    assert.equal((await fetch(`${server.url}/v1/snapshot`)).status, 401);
    assert.equal((await fetch(`${server.url}/v1/snapshot`, { headers: { Authorization: 'Bearer test-secret', Origin: 'https://untrusted.example' } })).status, 403);
    const client = new OrchestratorClient(server.url, 'test-secret'); const initial = await client.snapshot();
    const task = await client.submit({ objective: 'API integration' }); await runtime.waitUntilDone(task.id);
    const controller = new AbortController(); const events = client.events(initial.lastSeq, controller.signal);
    assert.equal((await events.next()).value?.type, 'task.created'); controller.abort(); await events.return(undefined);
    assert.equal((await client.snapshot()).state.tasks[task.id]!.status, 'completed');
    const team = await client.submit({ objective: 'Structured API team', delegations: [{ agentId: 'researcher', objective: 'Inspect' }, { agentId: 'reviewer', objective: 'Review', after: [0] }] });
    await runtime.waitUntilDone(team.id);
    assert.equal(Object.values((await client.snapshot()).state.tasks).filter(child => child.parentTaskId === team.id).length, 2);
    await assert.rejects(client.submit({ objective: 'Invalid plan', delegations: [{ agentId: 'reviewer', objective: 'Review', after: [0] }] }), /earlier plan/);
    assert.equal((await fetch(`${server.url}/v1/tasks`, { method: 'POST', headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' }, body: '{"objective":""}' })).status, 400);
  } finally { await server.close(); await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SSE parsing supports fragmented UTF-8, CRLF and multiple data lines', async () => {
  const bytes = new TextEncoder().encode(': comment\r\ndata: 你好\r\ndata: second\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } });
  const items: string[] = []; for await (const data of readSSE(stream)) items.push(data);
  assert.deepEqual(items, ['你好\nsecond', '[DONE]']);
});

test('compatible provider assembles tool fragments and sends the expected request', async () => {
  let body: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ reasoning_content: 'thinking' }, { content: 'hello' }, { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }, { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }]) res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const provider = new CompatibleProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test', model: 'test-model', thinking: 'enabled', reasoningEffort: 'high' });
    const chunks = [];
    for await (const chunk of provider.stream([{ role: 'assistant', content: 'prior', reasoningContent: 'prior metadata' }, { role: 'user', content: 'test' }], [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }], new AbortController().signal)) chunks.push(chunk);
    assert.deepEqual(chunks, [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hello' }, { type: 'tool', call: { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' } }]);
    assert.equal((body.messages as { reasoning_content?: string }[])[0]?.reasoning_content, 'prior metadata');
    assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.model, 'test-model'); assert.equal(body.stream, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('public binding requires a strong token', async () => {
  const store = new StateStore(':memory:'); const runtime = new OrchestratorService(store, new DemoProvider(), { workspaceDir: tmpdir() });
  try { await assert.rejects(startServer(runtime, { host: '0.0.0.0', port: 0 }), /bearer token/); }
  finally { await runtime.close(); store.close(); }
});

test('HTTP SDK delivers transient deltas without advancing the durable cursor', async () => {
  const store = new StateStore(':memory:');
  const runtime = new OrchestratorService(store, new DemoProvider(), { workspaceDir: tmpdir() });
  const server = await startServer(runtime, { port: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const events = new OrchestratorClient(server.url).events(0, controller.signal);
  try {
    store.change('test.ready', {}, () => {});
    while ((await events.next()).value?.type !== 'test.ready') {
      if (controller.signal.aborted) throw new Error('SSE subscription timed out');
    }
    const cursor = store.snapshot().lastSeq;
    store.emit('message.delta', { text: 'first' }, {});
    store.emit('message.delta', { text: 'second' }, {});
    store.change('test.done', {}, () => {});
    const first = (await events.next()).value;
    const second = (await events.next()).value;
    const done = (await events.next()).value;
    assert.equal(first?.transient, true);
    assert.equal(first?.seq, cursor);
    assert.deepEqual(second?.data, { text: 'second' });
    assert.equal(second?.seq, cursor);
    assert.equal(done?.type, 'test.done');
    assert.equal(done?.seq, cursor + 1);
  } finally {
    clearTimeout(timer); controller.abort(); await events.return(undefined);
    await server.close(); await runtime.close(); store.close();
  }
});
