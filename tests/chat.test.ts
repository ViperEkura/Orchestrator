import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/storage/store.js';
import { OrchestratorService } from '../src/core/runtime.js';
import { resolveApiKey } from '../src/core/config.js';
import type { Message, ModelProvider, ToolSpec } from '../src/core/domain.js';

test('default agent streams a direct two-turn conversation and retains reasoning context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-chat-'));
  const store = new StateStore(join(dir, 'data')); const requests: Message[][] = [];
  const provider: ModelProvider = { async *stream(messages) {
    requests.push(structuredClone(messages));
    yield { type: 'reasoning', text: 'Provider reasoning metadata' };
    yield { type: 'text', text: 'Hello ' }; yield { type: 'text', text: 'there' };
  } };
  const runtime = new OrchestratorService(store, provider, { workspaceDir: dir });
  const events: string[] = []; const liveReasoning: unknown[] = [];
  store.subscribe(event => { events.push(event.type); if (event.type === 'message.thinking') liveReasoning.push(event.data); });
  try {
    const first = runtime.submit({ objective: 'Hello' }); await runtime.waitUntilDone(first.id);
    assert.equal(first.agentId, 'assistant');
    const second = runtime.submit({ objective: 'Continue', sessionId: first.sessionId }); await runtime.waitUntilDone(second.id);
    assert.equal(Object.keys(store.snapshot().state.tasks).length, 2);
    assert.equal(store.snapshot().state.tasks[second.id]!.result, 'Hello there');
    assert.equal(requests[1]!.filter(message => message.content === 'Hello').length, 1);
    assert.ok(requests[1]!.some(message => message.reasoningContent === 'Provider reasoning metadata'));
    assert.ok(events.indexOf('message.delta') < events.indexOf('message.completed'));
    assert.deepEqual(liveReasoning, [{ text: 'Provider reasoning metadata' }, { text: 'Provider reasoning metadata' }]);
    const restored = store.snapshot(); await runtime.close(); store.close();
    const reopened = new StateStore(join(dir, 'data'));
    try { assert.deepEqual(reopened.snapshot(), restored); }
    finally { reopened.close(); }
  } finally { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('structured sub-agent and team plans schedule dependencies and return results to the parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-team-')); const store = new StateStore(':memory:');
  const roles: string[] = []; const specs: ToolSpec[][] = []; const requests: Message[][] = [];
  const provider: ModelProvider = { async *stream(messages, tools) {
    roles.push(messages[0]!.content.match(/\[(\w+)\]/)![1]!); specs.push(tools); requests.push(structuredClone(messages));
    yield { type: 'text', text: `${roles.at(-1)} findings` };
  } };
  const runtime = new OrchestratorService(store, provider, { workspaceDir: dir, concurrency: 1 });
  try {
    const task = runtime.submit({ objective: 'Review project', delegations: [
      { agentId: 'researcher', objective: 'Inspect code' },
      { agentId: 'reviewer', objective: 'Review findings', after: [0] }
    ] });
    assert.equal((await runtime.waitUntilDone(task.id)).status, 'completed');
    assert.deepEqual(roles, ['researcher', 'reviewer', 'assistant']);
    assert.ok(requests[1]!.some(message => message.content.includes('researcher findings')));
    assert.ok(requests[2]!.some(message => message.content.includes('reviewer findings')));
    assert.ok(!specs[0]!.some(tool => tool.name === 'write_file'));
    assert.equal(Object.values(store.snapshot().state.tasks).filter(child => child.parentTaskId === task.id).length, 2);
    const sub = runtime.submit({ objective: 'One specialist', delegations: [{ agentId: 'reviewer', objective: 'Review this' }] });
    await runtime.waitUntilDone(sub.id);
    assert.equal(Object.values(store.snapshot().state.tasks).filter(child => child.parentTaskId === sub.id).length, 1);
    assert.throws(() => runtime.submit({ objective: 'cycle', delegations: [{ agentId: 'reviewer', objective: 'invalid', after: [0] }] }), /earlier plan/);
  } finally { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('credential references reuse API keys without putting secrets into settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-auth-')); const file = join(dir, 'auth.json');
  try {
    await writeFile(file, JSON.stringify({ deepseek: { type: 'api', key: 'fixture-key' } }));
    const settings = { credentials: { file, provider: 'deepseek' } };
    assert.equal(resolveApiKey(settings, {}), 'fixture-key');
    assert.equal(resolveApiKey(settings, { LLM_API_KEY: 'override' }), 'override');
    assert.ok(!JSON.stringify(settings).includes('fixture-key'));
    assert.throws(() => resolveApiKey({ credentials: { file, provider: 'missing' } }, {}), /API key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
