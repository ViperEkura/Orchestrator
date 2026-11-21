import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StateStore } from '../src/storage/store.js';
import { loadConfig } from '../src/core/config.js';
import { atomicJSON } from '../src/storage/files.js';
import { defaultAgents, OrchestratorService } from '../src/core/runtime.js';
import { DemoProvider } from '../src/models/providers.js';
import { migrateLegacy } from '../src/storage/migrate.js';

function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]); }
async function temp() { return mkdtemp(join(tmpdir(), 'orchestrator-storage-')); }
function seed(store: StateStore, cwd: string) {
  store.change('session.created', {}, s => {
    s.sessions.s = { id: 's', cwd, workspace: 'project', createdAt: '2026-11-21' };
    s.runs.r = { id: 'r', taskId: 't', attempt: 1, status: 'queued', steps: 0, config: defaultAgents[0]!, messages: [{ role: 'user', content: 'unique-old-message' }] };
  }, { sessionId: 's' });
}

test('JSONL replays incrementally; new messages do not rewrite old history; single writer enforced', async () => {
  const dir = await temp(); let store = new StateStore(dir);
  try {
    seed(store, dir);
    assert.throws(() => new StateStore(dir), /already active/);
    store.change('message.completed', { message: 'new-message' }, s => { s.runs.r!.messages.push({ role: 'assistant', content: 'new-message' }); }, { sessionId: 's' });
    const log = files(dir).find(p => p.endsWith('.jsonl'))!;
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2); assert.ok(!lines[1]!.includes('unique-old-message'));
    const expected = store.snapshot(); store.close(); store = new StateStore(dir);
    assert.deepEqual(store.snapshot(), expected);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('incomplete final line is backed up and truncated; committed corruption is rejected', async () => {
  const dir = await temp(); let store = new StateStore(dir);
  try {
    seed(store, dir); const log = files(dir).find(p => p.endsWith('.jsonl'))!; store.close();
    const committed = readFileSync(log, 'utf8'); appendFileSync(log, '{"version":');
    store = new StateStore(dir); assert.equal(store.snapshot().lastSeq, 1); store.close();
    assert.equal(readFileSync(log, 'utf8'), committed); assert.ok(files(dir).some(p => p.includes('.torn-')));
    appendFileSync(log, 'invalid-json\n');
    assert.throws(() => new StateStore(dir));
    assert.ok(readFileSync(log, 'utf8').endsWith('invalid-json\n'));
    assert.ok(!existsSync(join(dir, 'runtime.lock')));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('streaming deltas are delivered live without consuming durable sequence numbers', async () => {
  const dir = await temp(); const store = new StateStore(dir);
  try {
    seed(store, dir); const seen: unknown[] = []; store.subscribe(e => seen.push(e));
    store.emit('message.delta', { text: 'live text' }, { runId: 'r' });
    assert.equal(store.snapshot().lastSeq, 1); assert.equal(store.events().length, 1);
    assert.deepEqual((seen[0] as { transient: boolean }).transient, true);
    assert.ok(!files(dir).filter(p => p.endsWith('.jsonl')).some(p => readFileSync(p, 'utf8').includes('live text')));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('global JSON settings, project overrides, environment precedence and editable agents', async () => {
  const dir = await temp(); const cwd = join(dir, 'project'); const home = join(dir, 'home'); mkdirSync(cwd);
  try {
    let config = loadConfig(cwd, { ORCHESTRATOR_DATA_DIR: home });
    assert.equal(config.settings.approvalMode, 'manual');
    assert.equal(loadConfig(cwd, { ORCHESTRATOR_DATA_DIR: home, ORCHESTRATOR_APPROVAL_MODE: 'agent' }).settings.approvalMode, 'agent');
    assert.throws(() => loadConfig(cwd, { ORCHESTRATOR_DATA_DIR: home, ORCHESTRATOR_APPROVAL_MODE: 'invalid' }));
    assert.equal(config.settings.concurrency, 3); assert.equal(config.agents.length, 4);
    atomicJSON(join(home, 'settings.json'), { provider: 'demo', concurrency: 2, port: 4000 });
    atomicJSON(join(cwd, '.orchestrator', 'settings.json'), { concurrency: 4, port: 5000 });
    atomicJSON(join(home, 'agents', 'reviewer.json'), { ...defaultAgents[2], name: 'Custom reviewer' });
    config = loadConfig(cwd, { ORCHESTRATOR_DATA_DIR: home, ORCHESTRATOR_PORT: '6000' });
    assert.equal(config.settings.concurrency, 4); assert.equal(config.settings.port, 6000);
    assert.equal(config.agents.find(a => a.id === 'reviewer')!.name, 'Custom reviewer');
    assert.ok(!files(dir).some(path => path.endsWith('.tmp')));
    atomicJSON(join(cwd, '.orchestrator', 'settings.json'), { concurrency: 0 });
    assert.throws(() => loadConfig(cwd, { ORCHESTRATOR_DATA_DIR: home }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sessions keep their project cwd across turns and restarts; artifacts live outside logs', async () => {
  const dir = await temp(); const project = join(dir, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'AGENTS.md'), 'Use the existing project files.');
  let store = new StateStore(join(dir, 'home'));
  let runtime = new OrchestratorService(store, new DemoProvider(), { workspaceDir: project });
  try {
    const first = runtime.submit({ objective: 'first', agentId: 'researcher' }); await runtime.waitUntilDone(first.id);
    writeFileSync(join(project, 'kept.txt'), 'persisted');
    const session = store.snapshot().state.sessions[first.sessionId]!;
    const artifact = Object.values(store.snapshot().state.artifacts)[0]!;
    assert.ok(existsSync(join(store.root, artifact.path))); assert.ok(!('content' in artifact));
    assert.match(store.snapshot().state.runs[first.runIds[0]!]!.config.systemPrompt, /Use the existing project files/);
    await runtime.close(); store.close();
    store = new StateStore(join(dir, 'home'));
    runtime = new OrchestratorService(store, new DemoProvider(), { workspaceDir: join(dir, 'another-project') });
    const next = runtime.submit({ objective: 'next', agentId: 'researcher', sessionId: first.sessionId }); await runtime.waitUntilDone(next.id);
    assert.equal(store.snapshot().state.sessions[first.sessionId]!.cwd, session.cwd);
    assert.ok(store.snapshot().state.runs[next.runIds[0]!]!.messages.some(m => m.role === 'tool' && m.content.includes('kept.txt')));
  } finally { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('read-only child sessions cannot acquire file-write or shell capabilities', async () => {
  const dir = await temp(); const store = new StateStore(join(dir, 'home'));
  const runtime = new OrchestratorService(store, new DemoProvider(), { workspaceDir: join(dir, 'project') });
  try {
    const root = runtime.submit({ objective: 'review project', agentId: 'coordinator' }); await runtime.waitUntilDone(root.id);
    const state = store.snapshot().state; const children = Object.values(state.tasks).filter(t => t.parentTaskId === root.id);
    for (const task of children) {
      assert.equal(state.sessions[task.sessionId]!.cwd, state.sessions[root.sessionId]!.cwd);
      const tools = state.runs[task.runIds[0]!]!.config.allowedTools;
      assert.ok(!tools.includes('write_file') && !tools.includes('run_command'));
    }
  } finally { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SQLite migration keeps the source bytes, preserves IDs/history, and rejects overwrite', async () => {
  const dir = await temp(); const source = join(dir, 'old', 'state.sqlite'); const destination = join(dir, 'new');
  mkdirSync(dirname(source));
  const { DatabaseSync } = await import('node:sqlite');
  const memory = new StateStore(':memory:');
  const runtime = new OrchestratorService(memory, new DemoProvider(), { workspaceDir: join(dir, 'project') });
  try {
    const task = runtime.submit({ objective: 'saved history', agentId: 'researcher' }); await runtime.waitUntilDone(task.id); await runtime.close();
    const state = memory.snapshot().state;
    // Recreate v0.1 metadata and artifact representation.
    for (const session of Object.values(state.sessions)) { delete (session as Partial<typeof session>).cwd; delete (session as Partial<typeof session>).workspace; }
    state.artifacts = {};
    const db = new DatabaseSync(source);
    db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,json TEXT); CREATE TABLE events(seq INTEGER PRIMARY KEY,json TEXT)');
    db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(state));
    for (const event of memory.events()) db.prepare('INSERT INTO events VALUES(?,?)').run(event.seq, JSON.stringify(event));
    db.close(); const before = readFileSync(source);
    const result = await migrateLegacy(source, destination); assert.equal(result.sessions, 1);
    assert.deepEqual(readFileSync(source), before);
    const restored = new StateStore(destination);
    try { assert.equal(restored.snapshot().state.tasks[task.id]!.result, state.tasks[task.id]!.result); assert.ok(restored.events().some(e => e.type === 'legacy.event')); }
    finally { restored.close(); }
    await assert.rejects(migrateLegacy(source, destination), /must not exist/);
  } finally { await runtime.close(); memory.close(); await rm(dir, { recursive: true, force: true }); }
});
