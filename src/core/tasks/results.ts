import type { State } from '../domain.js';

/** Bound result previews across the whole batch; retain references to complete reports. */
export function taskResults(state: State, ids: string[]) {
  const unique = [...new Set(ids)];
  const limit = Math.min(1200, Math.floor(8000 / Math.max(1, unique.length)));
  return unique.map(id => {
    const task = state.tasks[id]!;
    const artifact = Object.values(state.artifacts).findLast(item => item.taskId === id && item.runId === task.runIds.at(-1) && item.mediaType === 'text/markdown');
    return { taskId: id, status: task.status,
      ...(task.result !== undefined ? { result: task.result.slice(0, limit), truncated: task.result.length > limit } : {}),
      ...(artifact ? { resultArtifactId: artifact.id } : {}),
      ...(task.error ? { error: task.error.slice(0, limit) } : {}) };
  });
}
