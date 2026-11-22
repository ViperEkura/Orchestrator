import { useTerminalInput } from './input.js';
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentDefinition, State, Task } from '../../core/domain.js';
import type { OrchestratorClient } from '../../transport/client.js';
import { approvalOptions, projectName } from '../shared/options.js';
import { clean, conversations, wrap } from './view.js';
import { Composer } from './composer.js';
import { backspace, deleteForward, draftOf, insert, move } from './editor.js';

export type WorkspaceView = 'Sessions' | 'Team' | 'Settings' | 'Outputs';
export const isWorkspaceView = (view: string): view is WorkspaceView => ['Sessions', 'Team', 'Settings', 'Outputs'].includes(view);
type Info = Awaited<ReturnType<OrchestratorClient['info']>>;
type Entry = { text: string; key: string; cwd?: string; task?: Task };

export function WorkspacePanel({ view, state, info, cwd, sessionId, client, width, height, team, onTeam, collapsed, onCollapsed, onOpen, onProject, onInfo, onClose, onCopy }: {
  view: WorkspaceView; state?: State; info?: Info; cwd: string; sessionId?: string; client: OrchestratorClient;
  width: number; height: number; team: string[]; onTeam(ids: string[]): void; onOpen(task: Task): void;
  collapsed: string[]; onCollapsed(projects: string[]): void;
  onProject(cwd: string): void; onInfo(info: Info): void; onClose(): void; onCopy(text: string): void;
}) {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(view === 'Settings' ? approvalOptions.findIndex(option => option.value === info?.approvalMode) : -1);
  const [path, setPath] = useState<ReturnType<typeof draftOf>>();
  const [roles, setRoles] = useState<AgentDefinition[]>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(view === 'Team'), [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<{ id: string; content: string; nextOffset: number | null }>();
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (view !== 'Team') return;
    const controller = new AbortController();
    void client.agents().then(value => { if (!controller.signal.aborted) setRoles(value.filter(role => role.id !== (info?.defaultAgent ?? 'assistant'))); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, view, info?.defaultAgent]);
  const roots = conversations(state);
  const sessions = roots.filter(task => {
    const first = Object.values(state?.tasks ?? {}).find(item => item.sessionId === task.sessionId);
    return `${first?.objective} ${task.objective} ${task.id}`.toLowerCase().includes(filter.toLowerCase());
  });
  const projects = [...new Set([cwd, info?.cwd, ...Object.values(state?.sessions ?? {}).filter(item => !item.parentSessionId).map(item => item.cwd)].filter((item): item is string => !!item))];
  const entries: Entry[] = projects.flatMap(project => {
    const children = sessions.filter(task => state?.sessions[task.sessionId]?.cwd === project);
    if (filter && !children.length) return [];
    const expanded = !!filter || !collapsed.includes(project);
    return [{ text: `${expanded ? '▾' : '▸'} ${projectName(project)}`, key: project, cwd: project },
      ...(expanded ? children.map(task => ({ text: '    ' + (Object.values(state?.tasks ?? {}).find(item => item.sessionId === task.sessionId)?.objective ?? task.objective), key: task.sessionId, task, cwd: project })) : [])];
  });
  const rootIds = new Set(Object.values(state?.tasks ?? {}).filter(task => task.sessionId === sessionId).map(task => task.rootId));
  const outputs = Object.values(state?.artifacts ?? {}).filter(item => rootIds.has(state?.tasks[item.taskId]?.rootId ?? ''));
  const total = view === 'Sessions' ? entries.length : view === 'Team' ? roles.length : view === 'Settings' ? approvalOptions.length : outputs.length;
  const defaultRow = view === 'Sessions' ? Math.max(0, entries.findIndex(entry => entry.task)) : 0;
  const row = Math.max(0, Math.min(index < 0 ? defaultRow : index, total - 1));
  const capacity = Math.max(1, height - 6);
  const outputLines = output ? wrap(output.content, width - 4) : [];
  const scroll = Math.min(offset, Math.max(0, outputLines.length - capacity));
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const toggle = (project: string) => onCollapsed(collapsed.includes(project) ? collapsed.filter(item => item !== project) : [...collapsed, project]);
  useTerminalInput((text, key) => {
    if (key.ctrl && text === 'c') return; // The app owns exit and global navigation.
    if (key.escape) { if (path) setPath(undefined); else if (output) { setOutput(undefined); setOffset(0); } else onClose(); return; }
    if (busy) return;
    const mouse = /^\[<(\d+);(\d+);(\d+)([mM])$/.exec(text);
    if (mouse) {
      const button = Number(mouse[1]);
      if (mouse[4] === 'M' && (button & 64) && (button & 3) < 2 && !path) {
        const delta = button & 1 ? 3 : -3;
        if (output) setOffset(Math.max(0, scroll + delta));
        else setIndex(Math.max(0, Math.min(total - 1, row + delta)));
      }
      return;
    }
    if (path) {
      if (key.return) { if (path.value.trim()) onProject(path.value.trim()); return; }
      if (key.leftArrow || key.rightArrow) setPath(move(path, key.leftArrow ? -1 : 1));
      else if (key.backspace || key.delete) setPath(key.delete ? deleteForward(path) : backspace(path));
      else if (!key.ctrl && !key.meta && !key.tab) setPath(insert(path, text.replace(/[\r\n]/g, '')));
      return;
    }
    if (view === 'Sessions' && key.ctrl && text === 'a') { setPath(draftOf(cwd)); return; }
    if (key.ctrl || key.meta || key.tab) return;
    if (output) {
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) setOffset(Math.max(0, scroll + (key.upArrow || key.pageUp ? -1 : 1) * (key.pageUp || key.pageDown ? capacity : 1)));
      else if (text === 'l' && output.nextOffset !== null) void perform(async () => {
        const next = await client.artifact(output.id, output.nextOffset!);
        setOutput({ ...output, content: output.content + next.content, nextOffset: next.nextOffset });
      });
      else if (text === 'c') onCopy(output.content);
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = (key.upArrow || key.pageUp ? -1 : 1) * (key.pageUp || key.pageDown ? capacity : 1);
      setIndex(Math.max(0, Math.min(total - 1, row + delta))); return;
    }
    if (view === 'Sessions') {
      const entry = entries[row];
      if (text === '+' && entry?.cwd) { onProject(entry.cwd); return; }
      if (entry?.cwd && (key.leftArrow || key.rightArrow)) {
        const project = entry.cwd;
        onCollapsed(key.leftArrow ? [...new Set([...collapsed, project])] : collapsed.filter(item => item !== project));
        setIndex(entries.findIndex(item => item.key === project)); return;
      }
      if (key.return && entry) { if (entry.task) onOpen(entry.task); else toggle(entry.cwd!); return; }
      if (key.backspace || key.delete) setFilter(Array.from(filter).slice(0, -1).join(''));
      else if (!key.leftArrow && !key.rightArrow) setFilter(filter + clean(text).replace(/\n/g, ' '));
      setIndex(-1);
    } else if (view === 'Team') {
      if (text === ' ' && roles[row]) onTeam(team.includes(roles[row]!.id) ? team.filter(id => id !== roles[row]!.id) : [...team, roles[row]!.id]);
      else if (text === 'c') onTeam([]);
      else if (key.return) onClose();
    } else if (view === 'Settings' && key.return) {
      void perform(async () => { onInfo(await client.setApprovalMode(approvalOptions[row]!.value)); onClose(); });
    } else if (view === 'Outputs' && key.return && outputs[row]) {
      const id = outputs[row]!.id;
      void perform(async () => { setOutput({ id, ...await client.artifact(id) }); setOffset(0); });
    }
  });
  const title = path ? 'OPEN PROJECT' : view === 'Sessions' ? `PROJECTS · ${projects.length} · SESSIONS · ${sessions.length}` : view === 'Team' ? `CHOOSE AGENTS · ${team.length} selected` : view === 'Settings' ? 'SETTINGS · Approval mode' : output ? 'SAVED OUTPUT' : `OUTPUTS · ${outputs.length}`;
  const subtitle = path ? 'Existing folder on the runtime host' : view === 'Sessions' ? `Filter: ${filter || 'search conversations'}▌` : view === 'Team' ? 'Selected agents join your next message with read-only access.' : view === 'Settings' ? `${info?.provider ?? 'Connecting'} · ${info?.model ?? ''}` : output ? `Lines ${scroll + 1}–${Math.min(scroll + capacity, outputLines.length)}/${outputLines.length}` : 'Saved responses and tool output for this conversation.';
  const rows = view === 'Sessions' ? entries.map(entry => entry.text) : view === 'Team' ? roles.map(role => `${team.includes(role.id) ? '[x]' : '[ ]'} ${role.name} · ${role.id}`) : view === 'Settings' ? approvalOptions.map(option => `${info?.approvalMode === option.value ? '✓' : ' '} ${option.label}`) : outputs.map((item, i) => `${item.mediaType === 'text/markdown' ? 'Response' : 'Tool output'} ${i + 1} · ${item.id.slice(0, 8)}`);
  const start = Math.max(0, row - capacity + 1);
  const hint = path ? 'Enter open · Esc back' : view === 'Sessions' ? '←→ fold · + new chat · Ctrl+A add project · Enter open' : view === 'Team' ? 'Space select · C clear · Enter done · Esc back' : view === 'Settings' ? '↑↓ select · Enter apply · Esc back' : output ? 'PgUp/PgDn scroll · L load more · C copy · Esc back' : '↑↓ select · Enter open · Esc back';
  return <Box height={height} flexDirection="column" paddingX={2} paddingY={1} backgroundColor="#202020">
    <Text color="cyan" bold wrap="truncate-end">{title}</Text>
    <Text color="gray" wrap="truncate-end">{subtitle}</Text>
    {path ? <Composer draft={path} width={width - 7} rows={1} busy={busy}/> : output ? outputLines.slice(scroll, scroll + capacity).map((line, i) => <Text key={i} wrap="truncate-end">{line || ' '}</Text>) : rows.length ? rows.slice(start, start + capacity).map((line, i) => <Text key={i} color={start + i === row ? 'cyan' : 'gray'} inverse={start + i === row} wrap="truncate-end">{clean(line).replace(/\n/g, ' ')}</Text>) : <Text color="gray">{loading ? 'Loading agents…' : view === 'Sessions' ? 'No matching conversations.' : view === 'Team' ? 'No additional agents configured.' : 'No saved outputs yet.'}</Text>}
    <Box flexGrow={1}/>
    <Text color={error ? 'red' : 'gray'} wrap="truncate-end">{error || (busy ? 'Working…' : view === 'Settings' ? approvalOptions[row]?.description : ' ')}</Text>
    <Text color="gray" wrap="truncate-end">{hint}</Text>
  </Box>;
}
