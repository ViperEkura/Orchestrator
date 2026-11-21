import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atomicJSON, lockDirectory } from './files.js';
import type { Artifact, RuntimeEvent, Snapshot, State } from '../core/domain.js';

export const emptyState = (): State => ({ questions: {}, sessions: {}, tasks: {}, runs: {}, approvals: {}, artifacts: {}, budgets: {} });
type Patch = { path: string[]; op: 'set' | 'delete' | 'append'; value?: unknown };
type Record = { version: 1; event: RuntimeEvent; changes: Patch[] };
type ObjectMap = { [key: string]: unknown };
const object = (v: unknown): v is ObjectMap => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Persist field changes and array tails, not repeated copies of the entire history. */
function diff(before: unknown, after: unknown, path: string[] = []): Patch[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && after.length >= before.length && before.every((v, i) => isDeepStrictEqual(v, after[i])))
    return [{ path, op: 'append', value: after.slice(before.length) }];
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
    Object.hasOwn(after, key) ? diff(before[key], after[key], [...path, key]) : [{ path: [...path, key], op: 'delete' as const }]);
  return [{ path, op: 'set', value: after }];
}
function apply(state: State, changes: Patch[]) {
  for (const patch of changes) {
    if (!patch.path.length || patch.path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Invalid log patch path');
    let parent = state as unknown as ObjectMap;
    for (const key of patch.path.slice(0, -1)) {
      if (!object(parent[key])) throw new Error('Invalid log patch parent');
      parent = parent[key];
    }
    const key = patch.path.at(-1)!;
    if (patch.op === 'delete') delete parent[key];
    else if (patch.op === 'append') {
      if (!Array.isArray(parent[key]) || !Array.isArray(patch.value)) throw new Error('Invalid log array append');
      parent[key].push(...patch.value);
    } else if (patch.op === 'set') parent[key] = patch.value;
    else throw new Error('Unknown log patch operation');
  }
}

export class StateStore {
  readonly root: string;
  private state = emptyState();
  private memoryArtifacts = new Map<string, string>();
  private log: RuntimeEvent[] = [];
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private unlock?: () => void;
  private closed = false;
  constructor(root: string) {
    this.root = root === ':memory:' ? root : resolve(root);
    if (root === ':memory:') return;
    this.unlock = lockDirectory(this.root);
    try { this.restore(); } catch (error) { this.unlock(); throw error; }
  }
  private restore() {
    const folder = join(this.root, 'sessions');
    if (!existsSync(folder)) return;
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(dir, entry.name));
    } };
    walk(folder);
    const records: Record[] = [];
    const tails: { path: string; length: number }[] = [];
    for (const path of files) {
      const bytes = readFileSync(path); const end = bytes.lastIndexOf(10) + 1;
      if (end !== bytes.length) tails.push({ path, length: end });
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as Record;
        if (record.version !== 1 || !record.event || !Number.isSafeInteger(record.event.seq) || !Array.isArray(record.changes)) throw new Error(`Unsupported or corrupt log: ${path}`);
        records.push(record);
      }
    }
    records.sort((a, b) => a.event.seq - b.event.seq);
    for (const { event, changes } of records) {
      if (event.seq !== this.log.length + 1) throw new Error(`Missing or duplicate event sequence: ${event.seq}`);
      apply(this.state, changes); this.log.push(event);
    }
    // Validate the entire committed prefix before repairing incomplete final lines.
    for (const tail of tails) {
      writeFileSync(`${tail.path}.torn-${Date.now()}`, readFileSync(tail.path).subarray(tail.length), { flag: 'wx', mode: 0o600 });
      const fd = openSync(tail.path, 'r+');
      try { ftruncateSync(fd, tail.length); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  snapshot(): Snapshot { return { state: structuredClone(this.state), lastSeq: this.log.length }; }
  change(type: string, data: unknown, mutate: (state: State) => void, ids: { taskId?: string; runId?: string; sessionId?: string } = {}): RuntimeEvent {
    if (this.closed) throw new Error('Store is closed');
    const next = structuredClone(this.state); mutate(next);
    const task = ids.taskId ? next.tasks[ids.taskId] : undefined;
    const event: RuntimeEvent = { seq: this.log.length + 1, type, at: new Date().toISOString(), ...ids,
      ...(ids.sessionId || task ? { sessionId: ids.sessionId ?? task!.sessionId } : {}), data };
    const record: Record = { version: 1, event, changes: diff(this.state, next) };
    // Round-trip validation means live and restored state use identical JSON values.
    const encoded = JSON.stringify(record); const parsed = JSON.parse(encoded) as Record;
    const replay = structuredClone(this.state); apply(replay, parsed.changes);
    if (!isDeepStrictEqual(replay, next)) throw new Error('State must contain lossless JSON values');
    if (this.root !== ':memory:') {
      const session = event.sessionId ? next.sessions[event.sessionId] : undefined;
      const project = session ? createHash('sha256').update(process.platform === 'win32' ? session.cwd.toLowerCase() : session.cwd).digest('hex').slice(0, 16) : '_system';
      const name = event.sessionId ? encodeURIComponent(event.sessionId) : 'runtime';
      const path = join(this.root, 'sessions', project, `${name}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, 'a', 0o600); const size = statSync(path).size;
      try { writeFileSync(fd, encoded + '\n'); fsyncSync(fd); }
      catch (error) { ftruncateSync(fd, size); fsyncSync(fd); throw error; }
      finally { closeSync(fd); }
    }
    this.state = replay; this.log.push(parsed.event); this.publish(parsed.event);
    return structuredClone(parsed.event);
  }
  emit(type: string, data: unknown, ids: { taskId?: string; runId?: string }) {
    this.publish({ seq: this.log.length, type, data, ...ids, at: new Date().toISOString(), transient: true });
  }
  private publish(event: RuntimeEvent) {
    for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* disconnected client */ } }
  }
  events(after = 0, limit = 500): RuntimeEvent[] { return structuredClone(this.log.slice(after, after + limit)); }
  subscribe(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  saveArtifact(taskId: string, runId: string, id: string, content: string, mediaType: string): Artifact {
    const sessionId = this.state.tasks[taskId]!.sessionId;
    const path = join('artifacts', encodeURIComponent(sessionId), `${encodeURIComponent(id)}.json`);
    if (this.root !== ':memory:') atomicJSON(join(this.root, path), { mediaType, content });
    else this.memoryArtifacts.set(id, content);
    return { id, runId, taskId, path, mediaType };
  }
  readArtifact(id: string): string {
    const artifact = this.state.artifacts[id]; if (!artifact) throw new Error('Unknown artifact');
    if (this.root === ':memory:') return this.memoryArtifacts.get(id) ?? '';
    return (JSON.parse(readFileSync(join(this.root, artifact.path), 'utf8')) as { content: string }).content;
  }
  close() { if (this.closed) return; this.closed = true; this.listeners.clear(); this.unlock?.(); }
}
