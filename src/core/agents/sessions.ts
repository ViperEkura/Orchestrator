import { terminal, type State, type AgentSessionInfo } from '../domain.js';

export function isDescendantSession(state: State, sessionId: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  for (let id: string | undefined = sessionId; id && !seen.has(id); id = state.sessions[id]?.parentSessionId) {
    if (id === ancestorId) return true;
    seen.add(id);
  }
  return false;
}

/** Lifecycle is derived from durable tasks; idle sessions require no worker or timer. */
export function agentSessions(state: State, parentSessionId?: string): AgentSessionInfo[] {
  return Object.values(state.sessions).filter(s => s.parentSessionId && (!parentSessionId || s.parentSessionId === parentSessionId)).flatMap(session => {
    const tasks = Object.values(state.tasks).filter(t => t.sessionId === session.id);
    const task = tasks.find(t => !terminal(t.status)) ?? tasks.at(-1);
    if (!task) return [];
    return [{sessionId:session.id, parentSessionId:session.parentSessionId!, agentId:task.agentId,
      status:session.closedAt ? 'closed' : terminal(task.status) ? 'idle' : ['queued','running'].includes(task.status) ? 'running' : 'waiting',
      taskId:task.id, taskStatus:task.status, pendingMessages:session.mailbox?.filter(m => !m.deliveredRunId).length ?? 0}];
  });
}
