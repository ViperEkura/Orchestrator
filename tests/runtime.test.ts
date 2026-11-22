import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/storage/store.js';
import { OrchestratorService, Semaphore } from '../src/core/runtime.js';
import { DemoProvider } from '../src/models/providers.js';
import type { ModelProvider } from '../src/core/domain.js';
import { safePath, runCommand } from '../src/tools/index.js';

async function fixture(provider: ModelProvider = new DemoProvider(), options: Partial<ConstructorParameters<typeof OrchestratorService>[2]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
  const store = new StateStore(join(dir, 'data'));
  const runtime = new OrchestratorService(store, provider, { workspaceDir: join(dir, 'workspaces'), defaultAgent: 'coordinator', ...options });
  return { dir, store, runtime, async close() { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(10); }
}

test('two delegated agents finish with concurrency=1 and isolated sessions', async () => {
  const f = await fixture(undefined, { concurrency: 1 });
  try {
    const root = f.runtime.submit({ objective: 'test collaboration' });
    assert.equal((await f.runtime.waitUntilDone(root.id)).status, 'completed');
    const state = f.store.snapshot().state;
    assert.equal(Object.values(state.tasks).filter(t => t.parentTaskId === root.id).length, 2);
    assert.equal(new Set(Object.values(state.tasks).map(t => t.sessionId)).size, 3);
    for (const child of Object.values(state.tasks).filter(t => t.parentTaskId === root.id)) {
      const messages = state.runs[child.runIds[0]!]!.messages;
      assert.equal(messages.find(m => m.role === 'user')?.content, child.objective);
      assert.ok(!messages.some(m => m.role === 'user' && m.content === root.objective));
    }
    assert.ok(Object.values(state.tasks).every(t => t.status === 'completed'));
    assert.equal(Object.keys(state.artifacts).length, 3);
    assert.ok(f.store.events().some(e => e.type === 'run.waiting_children'));
  } finally { await f.close(); }
});

test('approved writes execute; denied writes do not; approvals cannot be reused', async () => {
  const f = await fixture();
  try {
    seedRepo(join(f.dir, 'workspaces'));
    const root = f.runtime.submit({ objective: 'approval workflow' });
    await until(() => Object.values(f.store.snapshot().state.approvals).filter(a => a.status === 'pending').length === 2);
    const [approved, denied] = Object.values(f.store.snapshot().state.approvals);
    f.runtime.resolveApproval(approved!.id, 'approved'); f.runtime.resolveApproval(denied!.id, 'denied');
    assert.throws(() => f.runtime.resolveApproval(approved!.id, 'approved'), /not pending/);
    assert.equal((await f.runtime.waitUntilDone(root.id)).status, 'completed');
    assert.match(await readFile(join(f.store.snapshot().state.sessions[f.store.snapshot().state.tasks[approved!.taskId]!.sessionId]!.cwd, 'report.txt'), 'utf8'), /Demo agent artifact/);
    await assert.rejects(readFile(join(f.store.snapshot().state.sessions[f.store.snapshot().state.tasks[denied!.taskId]!.sessionId]!.cwd, 'report.txt')), /ENOENT/);
    assert.ok(f.store.snapshot().state.runs[denied!.runId]!.messages.some(m => m.content.includes('User denied')));
  } finally { await f.close(); }
});

test('cancel propagates to children and pending approvals', async () => {
  const f = await fixture();
  try {
    seedRepo(join(f.dir, 'workspaces'));
    const root = f.runtime.submit({ objective: 'approval cancellation' });
    await until(() => Object.keys(f.store.snapshot().state.approvals).length === 2);
    f.runtime.cancel(root.id); await f.runtime.waitUntilDone(root.id); await f.runtime.close();
    assert.ok(Object.values(f.store.snapshot().state.tasks).every(t => t.status === 'cancelled'));
    assert.ok(Object.values(f.store.snapshot().state.approvals).every(a => a.status === 'cancelled'));
  } finally { await f.close(); }
});

test('session allows one active task and carries history into the next turn', async () => {
  const f = await fixture();
  try {
    const first = f.runtime.submit({ objective: 'first turn', agentId: 'researcher' });
    assert.throws(() => f.runtime.submit({ objective: 'overlap', sessionId: first.sessionId }), /active task/);
    await f.runtime.waitUntilDone(first.id);
    const second = f.runtime.submit({ objective: 'second turn', agentId: 'researcher', sessionId: first.sessionId });
    assert.ok(f.store.snapshot().state.runs[second.runIds[0]!]!.messages.some(m => m.content === 'first turn'));
    await f.runtime.waitUntilDone(second.id);
  } finally { await f.close(); }
});

test('shared step budget stops a looping model', async () => {
  const provider: ModelProvider = { async *stream() { yield { type: 'tool', call: { id: crypto.randomUUID(), name: 'list_files', arguments: '{}' } }; } };
  const f = await fixture(provider, { maxSteps: 2 });
  try {
    const task = f.runtime.submit({ objective: 'loop', agentId: 'researcher' });
    const done = await f.runtime.waitUntilDone(task.id);
    assert.equal(done.status, 'failed'); assert.match(done.error!, /budget/);
    assert.equal(f.store.snapshot().state.budgets[task.id]!.stepsUsed, 2);
  } finally { await f.close(); }
});

test('retry preserves failed attempts and appends a new run', async () => {
  let fail = true;
  const provider: ModelProvider = { async *stream() { if (fail) throw new Error('temporary failure'); yield { type: 'text', text: 'recovered' }; } };
  const f = await fixture(provider);
  try {
    const task = f.runtime.submit({ objective: 'retry', agentId: 'researcher' });
    await f.runtime.waitUntilDone(task.id); await delay(10); fail = false;
    assert.equal(f.runtime.retry(task.id).attempt, 2);
    assert.equal((await f.runtime.waitUntilDone(task.id)).status, 'completed');
    assert.equal(f.store.snapshot().state.runs[task.runIds[0]!]!.status, 'failed');
  } finally { await f.close(); }
});

test('dependencies start in order and provide their results to the dependent task', async () => {
  const provider: ModelProvider = { async *stream(messages, _tools, signal) {
    if (messages[0]!.content.includes('[coordinator]')) await delay(60000, undefined, { signal });
    else { await delay(20, undefined, { signal }); yield { type: 'text', text: 'dependency output' }; }
  } };
  const f = await fixture(provider);
  try {
    const root = f.runtime.submit({ objective: 'parent' });
    const first = f.runtime.delegate(root.runIds[0]!, { agentId: 'researcher', objective: 'first' });
    const second = f.runtime.delegate(root.runIds[0]!, { agentId: 'reviewer', objective: 'second', dependsOn: [first.id] });
    assert.throws(() => f.runtime.delegate(root.runIds[0]!, { agentId: 'reviewer', objective: 'cycle', dependsOn: [root.id] }), /sibling/);
    await f.runtime.waitUntilDone(second.id);
    const events = f.store.events();
    assert.ok(events.find(e => e.taskId === second.id && e.type === 'run.started')!.seq > events.find(e => e.taskId === first.id && e.type === 'run.completed')!.seq);
    assert.ok(f.store.snapshot().state.runs[second.runIds[0]!]!.messages.some(m => m.content.includes('Dependency results:')));
  } finally { await f.close(); }
});

test('independent agents overlap without exceeding model concurrency', async () => {
  let active = 0; let maximum = 0; const demo = new DemoProvider();
  const provider: ModelProvider = { async *stream(messages, tools, signal) {
    active++; maximum = Math.max(maximum, active);
    try { await delay(25, undefined, { signal }); yield* demo.stream(messages, tools, signal); } finally { active--; }
  } };
  const f = await fixture(provider, { concurrency: 2 });
  try { const task = f.runtime.submit({ objective: 'parallel' }); await f.runtime.waitUntilDone(task.id); assert.equal(maximum, 2); }
  finally { await f.close(); }
});

test('restart marks unfinished state interrupted without replaying tools', async () => {
  const f = await fixture();
  try {
    const task = f.runtime.submit({ objective: 'first', agentId: 'researcher' });
    await f.runtime.waitUntilDone(task.id); await f.runtime.close();
    const before = f.store.snapshot().lastSeq;
    f.store.change('test.simulated.crash', {}, s => { s.tasks[task.id]!.status = 'running'; s.runs[task.runIds[0]!]!.status = 'running'; });
    f.store.close();
    const reopened = new StateStore(join(f.dir, 'data'));
    const recovered = new OrchestratorService(reopened, new DemoProvider(), { workspaceDir: join(f.dir, 'workspaces') });
    assert.equal(reopened.snapshot().state.tasks[task.id]!.status, 'interrupted');
    assert.equal(reopened.events(before).at(-1)!.type, 'runtime.recovered');
    await recovered.close(); reopened.close();
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('failed store mutations roll back state and event cursor', () => {
  const store = new StateStore(':memory:');
  try {
    assert.throws(() => store.change('invalid', {}, s => { s.budgets.bad = { maxDepth: 1, maxSteps: 1, maxTasks: 1, stepsUsed: 0 }; throw new Error('rollback'); }));
    assert.deepEqual(store.snapshot().state.budgets, {}); assert.equal(store.snapshot().lastSeq, 0);
  } finally { store.close(); }
});

test('workspace tools reject traversal and absolute paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-path-'));
  try { await assert.rejects(safePath(dir, '../outside.txt'), /escapes/); await assert.rejects(safePath(dir, 'C:\\secret.txt'), /relative/); assert.equal(await safePath(dir, 'safe.txt'), join(await realpath(dir), 'safe.txt')); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelled permit waiters do not block subsequent work', async () => {
  const semaphore = new Semaphore(1); const controller = new AbortController();
  const release = await semaphore.acquire(new AbortController().signal);
  const wait = semaphore.acquire(controller.signal); controller.abort(new Error('cancelled'));
  await assert.rejects(wait, /cancelled/); release(); (await semaphore.acquire(AbortSignal.timeout(100)))();
});

test('cancellation terminates a real command process', async () => {
  const controller = new AbortController();
  const result = runCommand(process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', tmpdir(), 60000, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('test cancellation')), 300);
  try { await assert.rejects(result, /test cancellation/); } finally { clearTimeout(timer); }
});

test('run deadline clears pending approval instead of leaving an actionable stale request', async () => {
  const f = await fixture(undefined, { runTimeoutMs: 150 });
  try {
    const task = f.runtime.submit({ objective: 'approval deadline', agentId: 'researcher' });
    const done = await f.runtime.waitUntilDone(task.id);
    assert.equal(done.status, 'failed'); assert.match(done.error!, /deadline/);
    assert.ok(Object.values(f.store.snapshot().state.approvals).every(a => a.status === 'cancelled'));
  } finally { await f.close(); }
});

test('task budget prevents uncontrolled delegation and child tool permissions cannot grow', async () => {
  const provider: ModelProvider = { async *stream(_messages, _tools, signal) { await delay(60000, undefined, { signal }); } };
  const f = await fixture(provider, { maxTasks: 2, agents: [
    { id: 'coordinator', name: 'parent', systemPrompt: 'parent', allowedTools: ['delegate_task', 'list_files'] },
    { id: 'child', name: 'child', systemPrompt: 'child', allowedTools: ['list_files', 'run_command'] }
  ] });
  try {
    const root = f.runtime.submit({ objective: 'bounded' });
    const child = f.runtime.delegate(root.runIds[0]!, { agentId: 'child', objective: 'one' });
    assert.deepEqual(f.store.snapshot().state.runs[child.runIds[0]!]!.config.allowedTools, ['list_files']);
    assert.throws(() => f.runtime.delegate(root.runIds[0]!, { agentId: 'child', objective: 'two' }), /Task budget/);
  } finally { await f.close(); }
});

test('dependency failure propagates across multiple queued levels', async () => {
  const provider: ModelProvider = { async *stream(messages, _tools, signal) {
    if (messages[0]!.content.includes('[coordinator]')) await delay(60000, undefined, { signal });
    else throw new Error('child failed');
  } };
  const f = await fixture(provider);
  try {
    const root = f.runtime.submit({ objective: 'chain' });
    const a = f.runtime.delegate(root.runIds[0]!, { agentId: 'researcher', objective: 'a' });
    const b = f.runtime.delegate(root.runIds[0]!, { agentId: 'reviewer', objective: 'b', dependsOn: [a.id] });
    const c = f.runtime.delegate(root.runIds[0]!, { agentId: 'reviewer', objective: 'c', dependsOn: [b.id] });
    assert.equal((await f.runtime.waitUntilDone(c.id, 3000)).status, 'failed');
    assert.equal(f.store.snapshot().state.runs[c.runIds[0]!]!.steps, 0);
  } finally { await f.close(); }
});

function seedRepo(cwd: string) {
  execFileSync('git', ['init', '--quiet'], { cwd, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Test fixture', '--quiet'], { cwd, windowsHide: true });
}
