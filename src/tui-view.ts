import wrapAnsi from 'wrap-ansi';
import { renderMarkdown } from './markdown.js';
import type { State, Task } from './domain.js';

export type View = 'Chat' | 'History' | 'Sessions' | 'Agents' | 'Approvals';
export const views: View[] = ['Chat', 'History', 'Sessions', 'Agents', 'Approvals'];
export type Line = { text: string; color?: string; bold?: boolean; selected?: boolean; turnId?: string; turnLine?: number };
export const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const short = (id: string) => id.slice(0, 8);
export const statusColor = (status: string) => status === 'completed' ? 'green' : ['failed', 'interrupted'].includes(status) ? 'red' : 'yellow';
export const wrap = (text: string, width: number) => wrapAnsi(clean(text).replace(/\t/g, '  '), Math.max(1, width), { hard: true, trim: false }).split('\n');
export function conversations(state?: State): Task[] {
  const latest = new Map<string, Task>();
  for (const task of Object.values(state?.tasks ?? {})) if (!task.parentTaskId) { latest.delete(task.sessionId); latest.set(task.sessionId, task); }
  return [...latest.values()].reverse();
}
export function transcript(state: State | undefined, sessionId: string | undefined, streaming: Record<string, string>, width: number): Line[] {
  if (!state || !sessionId) return [];
  const lines: Line[] = [];
  const add = (text: string, color?: string, bold = false) => lines.push(...wrap(text, width).map(text => ({ text, color, bold })));
  for (const task of Object.values(state.tasks).filter(task => task.sessionId === sessionId)) {
    const turnStart = lines.length;
    add('YOU', 'cyan', true); add(task.objective); add('');
    for (const runId of task.runIds) {
      const run = state.runs[runId]; if (!run) continue;
      add(`${run.config.name.toUpperCase()} · ${run.status}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`, statusColor(run.status), true);
      // Previous turns are copied into model context; display only this turn's new messages.
      const start = run.messages.findLastIndex(message => message.role === 'user');
      for (const message of run.messages.slice(start + 1)) {
        if (message.role === 'assistant' && message.content) lines.push(...renderMarkdown(message.content, width).map(text => ({ text })));
        if (message.toolCalls?.length) add(message.toolCalls.map(call => `Tool: ${call.name}`).join(' · '), 'gray');
      }
      if (streaming[runId]) lines.push(...renderMarkdown(streaming[runId]!, width, false).map(text => ({ text })));
      add('');
    }
    if (task.error) add(task.error, 'red');
    for (let i = turnStart; i < lines.length; i++) { lines[i]!.turnId = task.id; lines[i]!.turnLine = i - turnStart; }
  }
  return lines;
}

export type HistoryAnchor = { turnId: string; line: number };
export function historyTop(lines: Line[], height: number, anchor?: HistoryAnchor): number {
  if (!anchor) return Math.max(0, lines.length - height);
  const start = lines.findIndex(line => line.turnId === anchor.turnId);
  if (start < 0) return 0;
  const end = lines.findIndex((line, i) => i > start && line.turnId !== anchor.turnId);
  return Math.min(start + anchor.line, (end < 0 ? lines.length : end) - 1);
}
export function anchorAt(lines: Line[], top: number): HistoryAnchor | undefined {
  const line = lines[top];
  return line?.turnId ? { turnId: line.turnId, line: line.turnLine ?? 0 } : undefined;
}
