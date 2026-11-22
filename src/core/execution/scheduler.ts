import { terminal, type Task } from '../domain.js';

/** Readiness is independent of parentage. Round-robin roots avoid starving projects. */
export class Scheduler {
  private lastRoot = '';
  select(tasks: Task[], active: ReadonlySet<string>): { ready: Task[]; failed: Task[] } {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const failed: Task[] = [], groups = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.status !== 'queued' || active.has(task.id) || byId.get(task.rootId)?.paused) continue;
      const dependencies = task.dependsOn.map(id => byId.get(id));
      if (dependencies.some(dep => !dep || terminal(dep.status) && dep.status !== 'completed')) { failed.push(task); continue; }
      if (dependencies.some(dep => dep?.status !== 'completed')) continue;
      const group = groups.get(task.rootId) ?? []; group.push(task); groups.set(task.rootId, group);
    }
    for (const group of groups.values()) group.sort((a,b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt));
    const roots = [...groups.keys()], previous = roots.indexOf(this.lastRoot);
    if (previous >= 0) roots.push(...roots.splice(0, previous + 1));
    const ready: Task[] = [];
    while (roots.some(id => groups.get(id)!.length)) for (const id of roots) {
      const task = groups.get(id)!.shift(); if (task) ready.push(task);
    }
    if (ready[0]) this.lastRoot = ready[0].rootId;
    return { ready, failed };
  }
}
