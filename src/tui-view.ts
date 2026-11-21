import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { renderMarkdown } from './markdown.js';
import type { Approval, State, Task } from './domain.js';

export type View = 'Chat' | 'History' | 'Sessions' | 'Agents' | 'Approvals';
export const views: View[] = ['Chat', 'History', 'Sessions', 'Agents', 'Approvals'];
export type Line = { text: string; color?: string; bold?: boolean; selected?: boolean; turnId?: string; turnLine?: number; disclosureId?: string };
export const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const short = (id: string) => id.slice(0, 8);
export const statusColor = (status: string) => status === 'completed' ? 'green' : ['failed', 'interrupted'].includes(status) ? 'red' : 'yellow';
export const wrap = (text: string, width: number) => wrapAnsi(clean(text).replace(/\t/g, '  '), Math.max(1, width), { hard: true, trim: false }).split('\n');
export function conversations(state?: State): Task[] {
  const latest = new Map<string, Task>();
  for (const task of Object.values(state?.tasks ?? {})) if (!task.parentTaskId) { latest.delete(task.sessionId); latest.set(task.sessionId, task); }
  return [...latest.values()].reverse();
}
export function transcript(state: State | undefined, sessionId: string | undefined, streaming: Record<string, string>, width: number, expanded: ReadonlySet<string> = new Set(), reasoning: Record<string, string> = {}): Line[] {
  if (!state || !sessionId) return [];
  const lines: Line[] = [];
  const add = (text: string, color?: string, bold = false) => lines.push(...wrap(text, width).map(text => ({ text, color, bold })));
  for (const task of Object.values(state.tasks).filter(task => task.sessionId === sessionId)) {
    const turnStart = lines.length;
    add('YOU', 'cyan', true); add(task.objective); add('');
    for (const runId of task.runIds) {
      const run = state.runs[runId]; if (!run) continue;
      add(`${run.config.name.toUpperCase()} · ${run.status}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`, statusColor(run.status), true);
      // Match the actual user turn, excluding context copied from older turns.
      const start = run.messages.findLastIndex(message => message.role === 'user' && message.content === task.objective);
      const disclosure = (id: string, name: string, status: string, summary: string, body: () => string, color = 'gray') => {
        lines.push({ text: disclosureRow(expanded.has(id), name, status, summary, width), color, disclosureId: id });
        if (expanded.has(id)) add(body(), 'gray');
      };
      for (let i = Math.max(0, start + 1); i < run.messages.length; i++) {
        const message = run.messages[i]!;
        if (message.reasoningContent) disclosure(runId + ':thinking:' + i, 'Thinking', 'completed', message.reasoningContent, () => message.reasoningContent!);
        if (message.role === 'assistant' && message.content) lines.push(...renderMarkdown(message.content, width).map(text => ({ text })));
        for (const call of message.toolCalls ?? []) {
          const result = run.messages.slice(i + 1).find(m => m.role === 'tool' && m.toolCallId === call.id);
          const approval = Object.values(state.approvals).find(a => a.runId === runId && a.toolCallId === call.id);
          const outcome = parseJSON(result?.content ?? 'null');
          const failed = outcome && typeof outcome === 'object' && ('error' in outcome || ('exitCode' in outcome && outcome.exitCode !== 0));
          const status = approval?.status === 'denied' ? 'denied' : result ? failed ? 'failed' : 'completed' : approval?.status === 'pending' ? 'waiting approval' : ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? 'not executed' : 'pending';
          disclosure(runId + ':tool:' + i + ':' + call.id, call.name, status, toolSummary(call.name, call.arguments),
            () => 'Arguments\n' + prettyJSON(call.arguments) + '\n\nResult\n' + (result ? prettyJSON(result.content) : 'No result yet.'),
            status === 'failed' || status === 'denied' ? 'red' : 'gray');
        }
      }
      if (reasoning[runId]) disclosure(runId + ':thinking:' + run.messages.length, 'Thinking', 'streaming', reasoning[runId]!, () => reasoning[runId]!);
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

/** Show the operation first; keep identifiers and raw parameters in details. */
export function approvalPreview(approval: Approval | undefined, state: State | undefined, width: number, details: boolean): { title: string; lines: Line[] } {
  if (!approval) return { title: 'No pending approvals', lines: [] };
  const task = state?.tasks[approval.taskId];
  const cwd = task ? state?.sessions[task.sessionId]?.cwd : undefined;
  const args = approval.arguments && typeof approval.arguments === 'object' ? approval.arguments as Record<string, unknown> : {};
  const command = approval.toolName === 'run_command' && typeof args.command === 'string';
  const write = approval.toolName === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string';
  const title = command ? 'Run command?' : write ? 'Write file?' : 'Allow ' + clean(approval.toolName) + '?';
  const lines: Line[] = [];
  const add = (text: string, color?: string) => lines.push(...wrap(text, width).map(text => ({ text, color })));
  if (cwd) add(cwd, 'gray');
  if (details) {
    add('Task: ' + approval.taskId, 'gray');
    if (approval.reason) add(approval.reason, 'gray');
    add(JSON.stringify(approval.arguments, null, 2));
  } else if (command) add(args.command as string);
  else if (write) { add(args.path as string, 'cyan'); add(args.content as string); }
  else add(JSON.stringify(approval.arguments, null, 2));
  return { title, lines };
}

function parseJSON(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }
function prettyJSON(text: string): string {
  const value = parseJSON(text);
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function singleLine(text: string, width: number): string {
  const plain = clean(text).replace(/\s+/g, ' ').trim();
  return stringWidth(plain) <= width ? plain : wrap(plain, Math.max(1, width - 1))[0]!.trimEnd() + '…';
}
function toolSummary(name: string, argumentsText: string): string {
  const args = parseJSON(argumentsText);
  if (!args || typeof args !== 'object') return argumentsText;
  if ('objective' in args && typeof args.objective === 'string') return ('agentId' in args ? String(args.agentId) + ': ' : '') + args.objective;
  for (const field of ['command', 'path', 'query', 'url']) {
    const value = (args as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  if ('taskIds' in args && Array.isArray(args.taskIds)) return 'Wait for ' + args.taskIds.length + ' task(s)';
  if (name === 'list_files') return 'List workspace files';
  return Object.keys(args).length ? JSON.stringify(args) : 'No arguments';
}

function disclosureRow(open: boolean, name: string, status: string, summary: string, width: number): string {
  const nameWidth = Math.min(16, Math.max(8, Math.floor(width * 0.25)));
  const statusWidth = Math.min(16, Math.max(7, Math.floor(width * 0.23)));
  const column = (text: string, size: number) => {
    const value = singleLine(text, size);
    return value + ' '.repeat(Math.max(0, size - stringWidth(value)));
  };
  const prefix = (open ? '▾ ' : '▸ ') + column(name, nameWidth) + '  ' + column(status, statusWidth) + '  ';
  return prefix + singleLine(summary, Math.max(1, width - stringWidth(prefix)));
}
