import { terminal, type State, type Message } from '../domain.js';

/** Reuse recent turns, excluding unfinished tool exchanges left by cancellation. */
export function sessionHistory(state: State, sessionId: string, excludeTaskId: string): Message[] {
  const tasks = Object.values(state.tasks).filter(t => t.sessionId === sessionId && t.id !== excludeTaskId && terminal(t.status)).slice(-8);
  const turns: Message[][] = []; let size = 0;
  for (const task of tasks.reverse()) {
    const run = state.runs[task.runIds.at(-1)!];
    const start = run?.messages.findLastIndex(m => m.role === 'user' && m.content === task.objective) ?? -1;
    const messages = start >= 0 ? run!.messages.slice(start) : [];
    const completeCalls = new Set(messages.flatMap((message,i) => (message.toolCalls ?? []).filter(call => messages.slice(i+1).some(m => m.role==='tool' && m.toolCallId===call.id)).map(call=>call.id)));
    let turn = messages.filter(m=>m.role!=='tool'||completeCalls.has(m.toolCallId!)).map(message => {
      const copy = structuredClone(message);
      if (copy.toolCalls) { copy.toolCalls=copy.toolCalls.filter(call=>completeCalls.has(call.id)); if (!copy.toolCalls.length) delete copy.toolCalls; }
      return copy;
    });
    if (!turn.length || JSON.stringify(turn).length > 12000) turn = [
      {role:'user',content:task.objective},
      {role:'assistant',content:'Previous task '+task.status+' (excerpt): '+(task.result ?? task.error ?? 'No final result').slice(0,8000)}
    ];
    const length = JSON.stringify(turn).length;
    if (size+length>96000) break;
    size+=length;turns.unshift(turn);
  }
  return turns.flat();
}
