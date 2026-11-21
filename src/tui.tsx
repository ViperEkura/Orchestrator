import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { approvalModes, type ApprovalMode, type Snapshot, type Task } from './domain.js';
import { OrchestratorClient } from './client.js';
import { completeInput } from './completions.js';
import { anchorAt, historyTop, clean, conversations, short, statusColor, transcript, views, wrap, type HistoryAnchor, type Line, type View } from './tui-view.js';

export function App({ client }: { client: OrchestratorClient }) {
  const { exit } = useApp(); const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [info, setInfo] = useState<Awaited<ReturnType<OrchestratorClient['info']>>>();
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>('Chat'); const [index, setIndex] = useState(0);
  const [historyAnchor, setHistoryAnchor] = useState<HistoryAnchor>();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string>(); const [sessionId, setSessionId] = useState<string>();
  const [input, setInput] = useState(''); const [notice, setNotice] = useState('Connecting…');
  const [busy, setBusy] = useState(false); const [offset, setOffset] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0); const [dismissed, setDismissed] = useState(false);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', resize);
    stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => { stdout.off('resize', resize); stdout.write('\x1b[?1006l\x1b[?1000l'); };
  }, [stdout]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = Promise.resolve();
    const refresh = async () => {
      refreshing = refreshing.catch(() => {}).then(async () => {
        if (controller.signal.aborted) return;
        const value = await client.snapshot(); if (!controller.signal.aborted) setSnapshot(value);
      });
      return refreshing;
    };
    void (async () => {
      const [initial, details] = await Promise.all([client.snapshot(), client.info()]); if (controller.signal.aborted) return;
      setInfo(details);
      setSnapshot(initial); setNotice('Ready');
      for await (const event of client.events(initial.lastSeq, controller.signal)) {
        if (event.type === 'approval.mode_changed') setInfo(await client.info());
        if (event.runId && event.type === 'message.thinking') {
          const id = event.runId; setThinking(current => current[id] ? current : { ...current, [id]: true }); continue;
        }
        if (event.runId && event.type === 'message.delta') {
          const id = event.runId; setThinking(current => ({ ...current, [id]: false })); const text = (event.data as { text: string }).text;
          setStreaming(current => ({ ...current, [id]: (current[id] ?? '') + text }));
        } else {
          if (event.runId && ['run.step', 'message.completed', 'run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
            const id = event.runId; setThinking(current => ({ ...current, [id]: false })); setStreaming(current => { const next = { ...current }; delete next[id]; return next; });
          }
          if (!timer) timer = setTimeout(() => { timer = undefined; void refresh().catch(error => setNotice(String(error))); }, 80);
        }
      }
    })().catch(error => { if (!controller.signal.aborted) setNotice(String(error)); });
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [client]);
  const state = snapshot?.state;
  const sessions = conversations(state).filter(task => `${task.objective} ${task.id}`.toLowerCase().includes(filter.toLowerCase()));
  const focus = selected ? state?.tasks[selected] : undefined;
  const tasks = Object.values(state?.tasks ?? {}).filter(task => focus && task.rootId === focus.rootId);
  const approvals = Object.values(state?.approvals ?? {}).filter(approval => approval.status === 'pending');
  const seenApprovals = useRef(new Set<string>());
  const previousPending = useRef(0);
  useEffect(() => {
    if (busy) return;
    const fresh = approvals.findIndex(approval => !seenApprovals.current.has(approval.id));
    for (const approval of approvals) seenApprovals.current.add(approval.id);
    if (fresh >= 0 && view !== 'Approvals') {
      setView('Approvals'); setIndex(fresh); setOffset(0); setFilter(''); setDismissed(true);
    } else if (view === 'Approvals' && previousPending.current > 0 && approvals.length === 0) {
      setView('Chat'); setIndex(0); setOffset(0); setFilter(''); setDismissed(true);
    }
    previousPending.current = approvals.length;
  }, [view, snapshot, busy]);
  const allTurns = Object.values(state?.tasks ?? {}).filter(task => task.sessionId === sessionId);
  const turns = allTurns.filter(task => task.objective.toLowerCase().includes(filter.toLowerCase()));
  const list = view === 'History' ? turns : view === 'Sessions' ? sessions : view === 'Agents' ? tasks : approvals;
  const row = Math.min(index, Math.max(0, list.length - 1));
  const approval = approvals[row];
  const switchView = (next: View) => { setView(next); setIndex(0); setOffset(0); setFilter(''); setDismissed(true); };
  const openTask = (task: Task) => { setHistoryAnchor(undefined); setSelected(task.id); setSessionId(task.sessionId); switchView('Chat'); };
  const newChat = () => { setHistoryAnchor(undefined); setSelected(undefined); setSessionId(undefined); setInput(''); switchView('Chat'); setNotice('New conversation'); };
  const match = (ids: string[], prefix?: string) => {
    const matches = prefix ? ids.filter(id => id.startsWith(prefix)) : [];
    if (matches.length !== 1) throw new Error('Provide a unique ID or prefix'); return matches[0]!;
  };
  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setBusy(true);
    try { await client.approve(id, decision); setSnapshot(await client.snapshot()); setNotice(`Tool call ${decision}`); setOffset(0); }
    catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  const submit = async (line: string) => {
    if (!line.trim()) return; setBusy(true);
    try {
      const [command, argument] = line.trim().split(/\s+/);
      const navigation: Record<string, View> = { '/chat': 'Chat', '/history': 'History', '/sessions': 'Sessions', '/resume': 'Sessions', '/agents': 'Agents', '/approvals': 'Approvals' };
      if (command === '/quit') { exit(); return; }
      if (navigation[command!]) switchView(navigation[command!]!);
      else if (command === '/help') { setInput('/'); setCompletionIndex(0); setDismissed(false); }
      else if (command === '/new') newChat();
      else if (command === '/approval') {
        if (!approvalModes.includes(argument as ApprovalMode)) throw new Error('Usage: /approval manual|agent|all');
        setInfo(await client.setApprovalMode(argument as ApprovalMode));
        setNotice('Approval: ' + argument + ' · applies to new requests');
      }
      else if (command === '/team' || command === '/delegate') {
        const request = /^\/(?:team|delegate)\s+(\S+)\s+([\s\S]+)$/.exec(line);
        if (!request) throw new Error(command === '/team' ? 'Usage: /team agent1,agent2 task' : 'Usage: /delegate agent-id task');
        const ids = request[1]!.split(',');
        if (command === '/delegate' && ids.length !== 1) throw new Error('Use /team for multiple agents');
        const task = await client.submit({ objective: request[2]!, sessionId, agentId: info?.defaultAgent ?? 'assistant', delegations: ids.map(agentId => ({ agentId, objective: request[2]! })) });
        openTask(task); setNotice('Delegated tasks started');
      }
      else if (command === '/use') openTask(state!.tasks[match(Object.keys(state?.tasks ?? {}), argument)]!);
      else if (command === '/approve' || command === '/deny') {
        await client.approve(match(approvals.map(a => a.id), argument), command === '/approve' ? 'approved' : 'denied'); setNotice('Approval decision submitted');
      } else if (command === '/cancel') {
        await client.cancel(match(Object.keys(state?.tasks ?? {}), argument ?? selected)); setNotice('Cancellation requested');
      } else if (command === '/retry') {
        const id = match(Object.keys(state?.tasks ?? {}), argument); await client.retry(id); openTask(state!.tasks[id]!); setNotice('New run attempt');
      } else if (command?.startsWith('/')) throw new Error('Unknown command. Type / to browse.');
      else {
        const task = await client.submit({ objective: line, sessionId, agentId: focus?.parentTaskId ? focus.agentId : info?.defaultAgent ?? 'assistant' });
        openTask(task); setNotice(`Submitted ${short(task.id)}`);
      }
      setSnapshot(await client.snapshot());
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const completions = busy || dismissed || view !== 'Chat' ? [] : completeInput(input, state);
  const activeIndex = Math.min(completionIndex, Math.max(0, completions.length - 1));
  const completion = completions[activeIndex];
  const menuCount = Math.min(4, completions.length);
  const menuHeight = menuCount ? menuCount + 1 : 0;
  const panelHeight = Math.max(7, Math.min(size.rows - 9, view === 'Approvals' ? approvals.length ? 18 : 7 : 13));
  const bodyHeight = Math.max(2, size.rows - 6 - (view === 'Chat' ? 3 + menuHeight : panelHeight));
  const contentWidth = Math.max(10, size.columns - 4);
  const transcriptHeight = Math.max(1, bodyHeight - 1);
  const contentHeight = view === 'Chat' ? transcriptHeight : panelHeight - 4 - (['Sessions', 'History'].includes(view) ? 1 : 0);
  const chat = transcript(state, sessionId, streaming, contentWidth);
  const top = historyTop(chat, transcriptHeight, historyAnchor);
  const aboveLatest = Math.max(0, chat.length - top - transcriptHeight);
  const currentTurn = allTurns.findIndex(task => task.id === chat[top]?.turnId) + 1;
  const moveHistory = (delta: number) => setHistoryAnchor(current => {
    const bottom = Math.max(0, chat.length - transcriptHeight);
    const next = Math.max(0, historyTop(chat, transcriptHeight, current) + delta);
    return delta > 0 && next >= bottom ? undefined : anchorAt(chat, Math.min(next, Math.max(0, chat.length - 1)));
  });
  const jumpTurn = (task: Task) => { switchView('Chat'); setHistoryAnchor({ turnId: task.id, line: 0 }); };
  const adjacentTurn = (direction: number) => {
    const starts = chat.map((line, i) => line.turnLine === 0 ? i : -1).filter(i => i >= 0);
    const target = direction < 0 ? starts.findLast(i => i < top) ?? starts[0] : starts.find(i => i > top);
    if (target !== undefined) setHistoryAnchor(anchorAt(chat, target));
  };
  const approvalLines: Line[] = approval ? [
    { text: `${approval.toolName} · task ${short(approval.taskId)}`, color: 'yellow', bold: true },
    ...wrap(`Workspace: ${state?.sessions[state.tasks[approval.taskId]!.sessionId]?.cwd ?? ''}`, contentWidth).map(text => ({ text, color: 'gray' })),
    ...wrap(approval.reason ?? 'Manual approval required', contentWidth).map(text => ({ text, color: 'gray' })),
    ...wrap(JSON.stringify(approval.arguments, null, 2), contentWidth).map(text => ({ text })),
    { text: 'Y approve this call · N deny', color: 'yellow' }
  ] : [];
  const detailHeight = Math.max(1, contentHeight - Math.min(3, approvals.length) - 1);
  const maxOffset = view === 'Approvals' ? Math.max(0, approvalLines.length - detailHeight) : Math.max(0, chat.length - contentHeight);
  const scroll = Math.min(offset, maxOffset);
  const editInput = (value: string) => { setInput(value); setCompletionIndex(0); setDismissed(false); };
  useInput((text, key) => {
    const mouse = /^\[<(\d+);\d+;\d+([mM])$/.exec(text);
    if (mouse) {
      const button = Number(mouse[1]);
      if (mouse[2] === 'M' && (button & 64) && (button & 3) < 2) {
        const direction = button & 1 ? 1 : -1;
        if (view === 'Chat') moveHistory(direction * 3);
        else setIndex(current => Math.max(0, Math.min(list.length - 1, current + direction)));
      }
      return;
    }
    if (key.ctrl && text === 'c') { exit(); return; }
    if (key.escape) { if (completions.length) setDismissed(true); else if (view !== 'Chat') switchView('Chat'); else setInput(''); return; }
    if (busy) return;
    if (key.ctrl) {
      if (text === 'n') newChat();
      const shortcuts: Record<string, View> = { g: 'Chat', r: 'History', p: 'Sessions', t: 'Agents', o: 'Approvals' };
      if (shortcuts[text]) switchView(shortcuts[text]!);
      return;
    }
    if (key.tab) {
      if (completion && !key.shift) editInput(completion.value);
      else switchView(views[(views.indexOf(view) + (key.shift ? views.length - 1 : 1)) % views.length]!);
      return;
    }
    if (view === 'Chat' && key.meta && (key.upArrow || key.downArrow)) { adjacentTurn(key.upArrow ? -1 : 1); return; }
    if (view === 'Chat' && (key.home || key.end)) {
      setHistoryAnchor(key.end ? undefined : anchorAt(chat, 0)); return;
    }
    if (key.pageUp || key.pageDown) {
      if (view === 'Chat') { moveHistory((key.pageDown ? 1 : -1) * Math.max(1, transcriptHeight - 2)); return; }
      if (view !== 'Approvals') { setIndex(Math.max(0, Math.min(list.length - 1, row + (key.pageDown ? 1 : -1) * contentHeight))); return; }
      const direction = view === 'Approvals' ? 1 : -1;
      setOffset(Math.max(0, Math.min(maxOffset, scroll + (key.pageDown ? direction : -direction) * Math.max(1, contentHeight - 2)))); return;
    }
    if ((key.upArrow || key.downArrow) && completions.length) {
      setCompletionIndex((activeIndex + (key.upArrow ? -1 : 1) + completions.length) % completions.length); return;
    }
    if ((key.upArrow || key.downArrow) && view === 'Chat') { moveHistory(key.upArrow ? -1 : 1); return; }
    if ((key.upArrow || key.downArrow) && view !== 'Chat') {
      setIndex(Math.max(0, Math.min(list.length - 1, row + (key.upArrow ? -1 : 1)))); setOffset(0); return;
    }
    if (view === 'Approvals' && approval && ['y', 'n'].includes(text.toLowerCase())) {
      void decide(approval.id, text.toLowerCase() === 'y' ? 'approved' : 'denied'); return;
    }
    if (key.return) {
      if (view === 'Approvals' && !approvals.length) { switchView('Chat'); return; }
      if (view === 'History' && turns[row]) { jumpTurn(turns[row]!); return; }
      if (view === 'Sessions' && sessions[row]) { openTask(sessions[row]!); return; }
      if (view === 'Agents' && tasks[row]) { openTask(tasks[row]!); return; }
      if (view !== 'Chat') return;
      if (completion && input !== completion.value.trimEnd()) { editInput(completion.value); return; }
      if (completion?.kind === 'command' && completion.value.endsWith(' ') && input !== '/cancel') { editInput(completion.value); return; }
      const value = input; editInput(''); void submit(value); return;
    }
    if (view === 'Approvals' && !approvals.length && text && !key.ctrl && !key.meta) {
      switchView('Chat'); editInput((input + clean(text).replace(/\n/g, ' ')).slice(0, 16000)); return;
    }
    if (view !== 'Chat') {
      if (view === 'Sessions' || view === 'History') {
        if (key.backspace || key.delete) setFilter(Array.from(filter).slice(0, -1).join(''));
        else if (!key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) setFilter(filter + clean(text).replace(/\n/g, ' '));
        setIndex(0);
      }
      return;
    }
    if (key.backspace || key.delete) editInput(Array.from(input).slice(0, -1).join(''));
    else if (!key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      if (view !== 'Chat' && !input && text !== '/') switchView('Chat');
      editInput((input + clean(text).replace(/\n/g, ' ')).slice(0, 16000));
    }
  });
  const taskLines = (items: Task[], active: number, tree = false): Line[] => items.map((task, i) => ({
    text: `${tree ? '  '.repeat(task.depth) : ''}${short(task.id)}  ${task.status}  ${tree ? `[${task.agentId}] ` : ''}${clean(task.objective).replace(/\n/g, ' ')}`,
    color: i === active ? 'cyan' : statusColor(task.status), selected: i === active
  }));
  let lines: Line[];
  if (view === 'Chat') lines = chat.length ? chat.slice(top, top + transcriptHeight) : [
    { text: '' }, { text: 'Welcome to Orchestrator', color: 'cyan', bold: true }, { text: '' },
    { text: 'Type a message to start. Enter sends it.' },
    { text: '/resume       Continue a saved conversation', color: 'gray' },
    { text: '/delegate     Ask a sub-agent to work on a task', color: 'gray' },
    { text: '/team         Run a team of agents', color: 'gray' },
    { text: 'Ctrl+R        Find a user turn in this conversation', color: 'gray' },
    { text: 'Ctrl+T agents · Ctrl+O approvals · / all commands', color: 'gray' }
  ];
  else if (view === 'History') lines = turns.length ? turns.map((task, i) => ({
    text: `#${allTurns.indexOf(task) + 1}  ${clean(task.objective).replace(/\n/g, ' ')}`, color: i === row ? 'cyan' : 'gray', selected: i === row
  })).slice(Math.max(0, row - contentHeight + 1), Math.max(contentHeight, row + 1)) : [{ text: allTurns.length ? 'No matching user inputs.' : 'No turns in this conversation yet.', color: 'gray' }];
  else if (view === 'Sessions') lines = sessions.length ? taskLines(sessions, row).slice(Math.max(0, row - contentHeight + 1), Math.max(contentHeight, row + 1)) : [{ text: 'No conversations yet. Ctrl+N starts one.', color: 'gray' }];
  else if (view === 'Agents') lines = tasks.length ? taskLines(tasks, row, true).slice(Math.max(0, row - contentHeight + 1), Math.max(contentHeight, row + 1)) : [{ text: 'Open a conversation to inspect its agents.', color: 'gray' }];
  else lines = approvals.length ? [
    ...approvals.slice(Math.max(0, row - 2), Math.max(0, row - 2) + 3).map(a => ({ text: `${short(a.id)}  ${a.toolName}  · task ${short(a.taskId)}`, color: 'yellow', selected: a.id === approval?.id })),
    { text: '─'.repeat(contentWidth), color: 'gray' }, ...approvalLines.slice(scroll, scroll + detailHeight)
  ] : [{ text: 'No pending approvals.', color: 'green' }, { text: 'Press Enter or Esc to return to chat.', color: 'gray' }];
  const renderLines = (items: Line[], limit: number) => items.slice(0, limit).map((line, i) => <Text key={i} color={line.color} bold={line.bold} inverse={line.selected} wrap="truncate-end">{line.text || ' '}</Text>);
  if (size.rows < 18 || size.columns < 50) return <Text>Resize terminal to at least 50 × 18. Ctrl+C exits.</Text>;
  const preview = view === 'Chat' ? lines : chat.slice(top, top + transcriptHeight);
  const running = tasks.filter(task => ['running', 'queued', 'waiting_children'].includes(task.status)).length;
  const model = info?.provider === 'demo' ? 'Demo · no live model' : info?.model ?? 'Connecting…';
  const isThinking = focus?.runIds.some(id => thinking[id]);
  return <Box flexDirection="column" width={size.columns} height={size.rows - 1}>
    <Box height={3} flexDirection="column" paddingX={1}>
      <Text><Text bold color="cyan">ORCHESTRATOR</Text><Text dimColor>  v0.1  ·  {model}  ·  Approval: {info?.approvalMode ?? 'manual'}</Text></Text>
      <Text dimColor wrap="truncate-middle">{clean(sessionId ? state?.sessions[sessionId]?.cwd ?? info?.cwd ?? '' : info?.cwd ?? 'Local workspace')}</Text>
      <Text> </Text>
    </Box>
    <Box height={bodyHeight} flexDirection="column" paddingX={1}>
      <Text dimColor wrap="truncate-end">{focus ? `CHAT · ${short(focus.sessionId)} · ${focus.agentId}` : 'NEW CONVERSATION'}{allTurns.length ? ` · Turn ${currentTurn}/${allTurns.length}` : ''}{view === 'Chat' && historyAnchor ? ` · ${aboveLatest} lines above latest · End to follow` : ''}</Text>
      {renderLines(preview, transcriptHeight)}
    </Box>
    <Text color={approvals.length ? 'yellow' : 'gray'} wrap="truncate-end"> {approvals.length ? `${approvals.length} approval(s) waiting · Ctrl+O to review` : isThinking ? 'Thinking…' : running ? `${running} agent(s) working · Ctrl+T to inspect` : busy ? 'Working…' : clean(notice)}</Text>
    {view === 'Chat' ? <Box height={3 + menuHeight} flexDirection="column" backgroundColor="#181818" paddingX={2} paddingY={1}>
      <Text color="#dedede" wrap="truncate-end"><Text color="cyan">› </Text>{wrap(input, Math.max(1, size.columns - 7)).at(-1)}{!busy ? <Text color="cyan">▌</Text> : null}{!input && !busy ? <Text color="#808080">  Type a task, or / for commands</Text> : null}</Text>
      {menuCount ? <>
        {completions.slice(Math.max(0, activeIndex - menuCount + 1), Math.max(menuCount, activeIndex + 1)).map(item => <Text key={item.value} color={item === completion ? 'cyan' : 'gray'} bold={item === completion} wrap="truncate-end">{item.label.padEnd(24)} {clean(item.description)}</Text>)}
        <Text dimColor wrap="truncate-end">↑↓ select · Tab complete · Enter select/run · Esc close</Text>
      </> : null}
    </Box> : <Box height={panelHeight} flexDirection="column" borderStyle="round" borderColor={view === 'Approvals' ? 'yellow' : 'cyan'} paddingX={1}>
      <Text bold color={view === 'Approvals' ? 'yellow' : 'cyan'}>{view.toUpperCase()} · {list.length}</Text>
      {view === 'Sessions' || view === 'History' ? <Text dimColor wrap="truncate-end">Filter: {filter || (view === 'History' ? 'search user inputs' : 'type to search conversations')}▌</Text> : null}
      {renderLines(lines, contentHeight)}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">{view === 'Approvals' ? !approvals.length ? 'Enter returns to chat' : `↑↓ select · Y approve · N deny · PgUp/PgDn details ${scroll + 1}/${Math.max(1, approvalLines.length)}` : '↑↓ select · Enter open'} · Esc back</Text>
    </Box>}
    <Text dimColor wrap="truncate-end"> ↑↓/wheel scroll · Ctrl+R turns · Alt+↑↓ jump · Home/End · / commands</Text>
  </Box>;
}

export async function startTui(client: OrchestratorClient) {
  if (!process.stdin.isTTY) throw new Error('TUI requires an interactive terminal; use npm run demo');
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
  try { const app = render(<App client={client} />); await app.waitUntilExit(); }
  finally { process.stdout.write('\x1b[?1049l'); }
}
