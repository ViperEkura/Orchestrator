import type { State, Task } from '../../core/domain.js';

/** Anchor child activity to its dispatch message, never to its completion time. */
export function childTaskTimeline(state: State, parent: Task) {
  const before: Task[] = [], after = new Map<string, Task[]>();
  const anchors = new Map<string, string>(), resultAnchors = new Map<string, string>();
  for (const runId of parent.runIds) {
    const run = state.runs[runId]; if (!run) continue;
    const start = run.messages.findLastIndex(m => m.role === 'user' && m.content === parent.objective);
    for (let i = start + 1; i < run.messages.length; i++) for (const call of run.messages[i]!.toolCalls ?? []) {
      if (!['delegate_task','followup_task'].includes(call.name)) continue;
      const key = runId + ':' + i;
      anchors.set(call.id, key);
      const result = run.messages.slice(i + 1).find(m => m.role === 'tool' && m.toolCallId === call.id);
      try { const value: unknown = JSON.parse(result?.content ?? 'null');
        if (value && typeof value === 'object' && 'taskId' in value && typeof value.taskId === 'string') resultAnchors.set(value.taskId, key);
      } catch { /* Pending or unsuccessful delegation has no result anchor. */ }
    }
  }
  for (const child of Object.values(state.tasks).filter(task => task.parentTaskId === parent.id)) {
    const key = resultAnchors.get(child.id) ?? (child.sourceCallId ? anchors.get(child.sourceCallId) : undefined);
    if (!key) before.push(child); // Preconfigured plans and legacy records precede parent work.
    else { const group = after.get(key) ?? []; group.push(child); after.set(key, group); }
  }
  return { before, after };
}
