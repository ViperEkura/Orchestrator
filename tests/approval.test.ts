import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { OrchestratorService } from '../src/core/runtime.js';
import { StateStore } from '../src/storage/store.js';
import { ToolRegistry } from '../src/tools/index.js';
import { completeInput } from '../src/clients/tui/completions.js';
import type { ApprovalMode, ModelProvider } from '../src/core/domain.js';

async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await pause(10); }
  throw new Error('Timed out');
}
function fixture(mode: ApprovalMode, answer = 'approve', allowed = true) {
  const store = new StateStore(':memory:'); const tools = new ToolRegistry(); let executed = 0; let reviews = 0;
  tools.register({ name: 'guarded', description: 'Guarded operation', approval: true, schema: z.object({ value: z.string() }).strict(),
    async execute() { executed++; return 'done'; } });
  const provider: ModelProvider = { async *stream(messages, specs, signal) {
    if (messages[0]?.content.startsWith('[approval-review]')) {
      reviews++; assert.deepEqual(specs, []);
      assert.equal(JSON.parse(messages[1]!.content).userRequest, 'Perform the guarded operation');
      if (answer === 'error') throw new Error('Network failure');
      if (answer === 'wait') { await pause(10000, undefined, { signal }); return; }
      yield { type: 'text', text: answer === 'invalid' ? 'not JSON' : JSON.stringify({ decision: answer, reason: 'Review explanation' }) };
    } else if (messages.some(m => m.role === 'tool')) yield { type: 'text', text: 'Finished' };
    else yield { type: 'tool', call: { id: 'call', name: 'guarded', arguments: '{"value":"test"}' } };
  } };
  const runtime = new OrchestratorService(store, provider, { workspaceDir: process.cwd(), approvalMode: mode, tools,
    agents: [{ id: 'assistant', name: 'Assistant', systemPrompt: '', allowedTools: allowed ? ['guarded'] : [] }] });
  return { store, runtime, executed: () => executed, reviews: () => reviews,
    start: () => runtime.submit({ objective: 'Perform the guarded operation' }),
    async close() { await runtime.close(); store.close(); } };
}

for (const [mode, answer, expected] of [
  ['manual', 'approve', 'pending'], ['all', 'approve', 'approved'],
  ['agent', 'approve', 'approved'], ['agent', 'deny', 'denied'], ['agent', 'manual', 'pending'],
  ['agent', 'invalid', 'pending'], ['agent', 'error', 'pending']
] as const) test('approval ' + mode + ' / ' + answer + ' -> ' + expected, async () => {
  const f = fixture(mode, answer);
  try {
    const task = f.start(); await until(() => Object.keys(f.store.snapshot().state.approvals).length === 1);
    const approval = Object.values(f.store.snapshot().state.approvals)[0]!;
    assert.equal(approval.mode, mode); assert.equal(approval.status, expected); assert.ok(approval.reason);
    if (expected === 'pending') { assert.equal(f.executed(), 0); f.runtime.resolveApproval(approval.id, 'approved'); }
    assert.equal((await f.runtime.waitUntilDone(task.id)).status, 'completed');
    assert.equal(f.executed(), expected === 'denied' ? 0 : 1);
    assert.equal(f.reviews(), mode === 'agent' ? 1 : 0);
    assert.equal(f.store.snapshot().state.budgets[task.id]!.stepsUsed, mode === 'agent' ? 3 : 2);
  } finally { await f.close(); }
});

test('mode changes affect new calls, never resolve an already pending request', async () => {
  const f = fixture('manual');
  try {
    const task = f.start(); await until(() => Object.keys(f.store.snapshot().state.approvals).length === 1);
    const approval = Object.values(f.store.snapshot().state.approvals)[0]!;
    f.runtime.setApprovalMode('all'); await pause(20);
    assert.equal(f.store.snapshot().state.approvals[approval.id]!.status, 'pending'); assert.equal(f.executed(), 0);
    f.runtime.resolveApproval(approval.id, 'denied'); await f.runtime.waitUntilDone(task.id);
    await f.runtime.waitUntilDone(f.start().id); assert.equal(f.executed(), 1);
  } finally { await f.close(); }
});

test('allow all does not grant tools outside the agent capability list', async () => {
  const f = fixture('all', 'approve', false);
  try {
    const task = f.start(); await f.runtime.waitUntilDone(task.id);
    assert.equal(f.executed(), 0); assert.equal(Object.keys(f.store.snapshot().state.approvals).length, 0);
    assert.ok(f.store.snapshot().state.runs[task.runIds[0]!]!.messages.some(m => m.content.includes('not allowed')));
  } finally { await f.close(); }
});

test('cancelling an in-flight agent review neither executes nor creates an approval popup', async () => {
  const f = fixture('agent', 'wait');
  try {
    const task = f.start(); await until(() => f.reviews() === 1); f.runtime.cancel(task.id);
    assert.equal((await f.runtime.waitUntilDone(task.id)).status, 'cancelled');
    assert.equal(f.executed(), 0); assert.equal(Object.keys(f.store.snapshot().state.approvals).length, 0);
  } finally { await f.close(); }
});

test('approval modes complete in place, even before a snapshot is loaded', () => {
  assert.deepEqual(completeInput('/approval ').map(c => c.value), ['/approval manual', '/approval agent', '/approval all']);
  assert.deepEqual(completeInput('/approval ag').map(c => c.value), ['/approval agent']);
});
