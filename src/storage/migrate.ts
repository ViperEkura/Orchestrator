import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore } from './store.js';
import { lockDirectory } from './files.js';
import type { RuntimeEvent, State } from '../core/domain.js';

/** One-time, read-only SQLite import. Publish a new directory only after successful replay. */
export async function migrateLegacy(source: string, destination: string) {
  source = resolve(source); destination = resolve(destination);
  if (!existsSync(source)) throw new Error(`Legacy database not found: ${source}`);
  if (existsSync(destination)) throw new Error('Migration destination must not exist; choose an empty new data directory');
  const unlock = lockDirectory(dirname(source));
  let store: StateStore | undefined;
  try {
    const { DatabaseSync } = await import('node:sqlite'); // Never loaded during normal startup.
    const db = new DatabaseSync(source, { readOnly: true });
    let state: State; let events: RuntimeEvent[];
    try {
      const row = db.prepare('SELECT json FROM state WHERE id=1').get() as { json: string } | undefined;
      if (!row) throw new Error('Legacy database has no saved state');
      state = JSON.parse(row.json) as State;
      events = (db.prepare('SELECT seq,json FROM events ORDER BY seq').all() as { seq: number; json: string }[]).map(row => ({ ...JSON.parse(row.json), seq: row.seq }));
    } finally { db.close(); }
    const staging = join(dirname(destination), `.orchestrator-import-${randomUUID()}`);
    mkdirSync(staging, { recursive: true }); store = new StateStore(staging);
    for (const session of Object.values(state.sessions)) {
      const tasks = Object.values(state.tasks).filter(task => task.sessionId === session.id);
      const last = tasks.at(-1);
      const legacyWorkspace = last && join(dirname(source), 'workspaces', last.id);
      session.cwd = legacyWorkspace && existsSync(legacyWorkspace) ? legacyWorkspace : dirname(dirname(source));
      session.workspace = 'project'; // Retain legacy workspace permissions and files; new children default to read-only.
      const ids = new Set(tasks.map(task => task.id));
      store.change('migration.session', { source, sessionId: session.id }, next => {
        next.sessions[session.id] = session;
        for (const task of tasks) next.tasks[task.id] = task;
        for (const run of Object.values(state.runs)) if (ids.has(run.taskId)) next.runs[run.id] = run;
        for (const approval of Object.values(state.approvals)) if (ids.has(approval.taskId)) next.approvals[approval.id] = approval;
        for (const task of tasks) if (state.budgets[task.id]) next.budgets[task.id] = state.budgets[task.id]!;
      }, { sessionId: session.id });
    }
    for (const old of Object.values(state.artifacts)) {
      const content = (old as unknown as { content?: string }).content ?? '';
      const artifact = store.saveArtifact(old.taskId, old.runId, old.id, content, old.mediaType);
      store.change('artifact.created', { artifactId: old.id }, next => { next.artifacts[old.id] = artifact; }, { taskId: old.taskId, runId: old.runId });
    }
    for (const event of events) store.change('legacy.event', event, () => {}, {
      ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.runId ? { runId: event.runId } : {})
    });
    const expected = store.snapshot(); store.close();
    store = new StateStore(staging);
    if (JSON.stringify(store.snapshot()) !== JSON.stringify(expected)) throw new Error('Migration replay verification failed');
    store.close();
    renameSync(staging, destination);
    return { sessions: Object.keys(state.sessions).length, events: events.length, destination };
  } finally { store?.close(); unlock(); }
}
