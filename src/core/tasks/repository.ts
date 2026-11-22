import type { StateStore } from '../../storage/store.js';
import type { State, Task } from '../domain.js';

/** Scheduler reads task metadata without cloning every conversation. */
export class TaskRepository {
  constructor(readonly store: StateStore) {}
  tasks(): Task[] { return this.store.select(state => Object.values(state.tasks)); }
  task(id: string): Task { const task = this.store.select(state => state.tasks[id]); if (!task) throw new Error('Unknown task'); return task; }
  run(id: string) { const run = this.store.select(state => state.runs[id]); if (!run) throw new Error('Unknown run'); return run; }
  changeRun(runId: string, type: string, data: unknown, mutate: (state: State) => void) {
    const taskId = this.store.select(state => state.runs[runId]!.taskId), rootId = this.task(taskId).rootId;
    return this.store.transaction({ tasks:[taskId], runs:[runId], budgets:[rootId] }, type, data, mutate, { taskId, runId });
  }
}
