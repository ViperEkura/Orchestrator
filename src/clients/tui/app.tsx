import { agentSessions, isDescendantSession } from '../../core/agents/sessions.js';
import { TaskPanel } from './task-panel.js';
import { ModelPanel } from './model-panel.js';
import { useTerminalInput } from './input.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useStdout } from 'ink';
import { approvalModes, type ApprovalMode, type Snapshot, type Task } from '../../core/domain.js';
import { WorkspacePanel, isWorkspaceView } from './workspace-panel.js';
import { Composer } from './composer.js';
import { draftOf, insert, backspace, deleteForward, move, moveVertical, lineStart, lineEnd, deleteWordBack, layout, type Draft } from './editor.js';
import { QuestionCard } from './question.js';
import { OrchestratorClient } from '../../transport/client.js';
import { completeInput } from './completions.js';
import { agentProgress, approvalPreview, anchorAt, historyTop, clean, short, statusColor, transcript, views, wrap, type HistoryAnchor, type Line, type View } from './view.js';

export function App({ client }: { client: OrchestratorClient }) {
  const { exit } = useApp(); const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [info, setInfo] = useState<Awaited<ReturnType<OrchestratorClient['info']>>>();
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [expandedApproval, setExpandedApproval] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reasoning, setReasoning] = useState<Record<string, string>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>('Chat'); const [index, setIndex] = useState(0);
  const [historyAnchor, setHistoryAnchor] = useState<HistoryAnchor>();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string>(); const [sessionId, setSessionId] = useState<string>();
  const [project, setProject] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const currentProject = snapshot?.state.sessions[sessionId ?? '']?.cwd ?? (project || info?.cwd || '');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftKey = sessionId ?? 'new:' + currentProject;
  const draft = drafts[draftKey] ?? draftOf();
  const input = draft.value;
  const setDraft = (next: Draft) => setDrafts(old => ({ ...old, [draftKey]: next }));
  const setInput = (value: string) => setDraft(draftOf(value));
  const [notice, setNotice] = useState('Connecting…');
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
        if (['approval.mode_changed', 'model.selected'].includes(event.type)) setInfo(await client.info());
        if (event.runId && event.type === 'message.thinking') {
          const id = event.runId; setThinking(current => current[id] ? current : { ...current, [id]: true });
          const text = (event.data as { text?: string }).text;
          if (text) setReasoning(current => ({ ...current, [id]: (current[id] ?? '') + text }));
          continue;
        }
        if (event.runId && event.type === 'message.delta') {
          const id = event.runId; setThinking(current => ({ ...current, [id]: false })); const text = (event.data as { text: string }).text;
          setStreaming(current => ({ ...current, [id]: (current[id] ?? '') + text }));
        } else {
          if (event.runId && ['run.step', 'message.completed', 'run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
            const id = event.runId; setThinking(current => ({ ...current, [id]: false })); setStreaming(current => { const next = { ...current }; delete next[id]; return next; });
            setReasoning(current => { const next = { ...current }; delete next[id]; return next; });
          }
          if (!timer) timer = setTimeout(() => { timer = undefined; void refresh().catch(error => setNotice(String(error))); }, 80);
        }
      }
    })().catch(error => { if (!controller.signal.aborted) setNotice(String(error)); });
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [client]);
  const state = snapshot?.state;
  const focus = selected ? state?.tasks[selected] : undefined;
  const parentSessionId = state?.sessions[sessionId ?? '']?.parentSessionId;
  const parentTask = focus?.parentTaskId ? state?.tasks[focus.parentTaskId] : Object.values(state?.tasks ?? {}).findLast(task => task.sessionId === parentSessionId);
  const lifecycle = state ? agentSessions(state).find(agent => agent.sessionId === sessionId) : undefined;
  const rootSession = (() => {let id=sessionId;const seen=new Set<string>();while(id&&state?.sessions[id]?.parentSessionId&&!seen.has(id)){seen.add(id);id=state.sessions[id]!.parentSessionId;}return id;})();
  const taskMap = new Map<string,Task>();
  for (const task of Object.values(state?.tasks ?? {})) if (state && rootSession && isDescendantSession(state,task.sessionId,rootSession)) taskMap.set(task.sessionId,task);
  const tasks = [...taskMap.values()];
  const approvals = Object.values(state?.approvals ?? {}).filter(approval => approval.status === 'pending');
  const seenApprovals = useRef(new Set<string>());
  const previousPending = useRef(0);
  useEffect(() => {
    if (busy || view === 'Questions') return;
    const fresh = approvals.findIndex(approval => !seenApprovals.current.has(approval.id));
    for (const approval of approvals) seenApprovals.current.add(approval.id);
    if (fresh >= 0 && view !== 'Approvals') {
      setView('Approvals'); setIndex(fresh); setOffset(0); setFilter(''); setDismissed(true);
    } else if (view === 'Approvals' && previousPending.current > 0 && approvals.length === 0) {
      setView('Chat'); setIndex(0); setOffset(0); setFilter(''); setDismissed(true);
    }
    previousPending.current = approvals.length;
  }, [view, snapshot, busy]);
  const questions = Object.values(state?.questions ?? {}).filter(question => question.status === 'pending');
  const question = questions[0]; const seenQuestions = useRef(new Set<string>());
  useEffect(() => {
    if (busy || !info) return;
    if (!question && view === 'Questions') { setView('Chat'); return; }
    if (approvals.length) return;
    if (question && !seenQuestions.current.has(question.id)) {
      seenQuestions.current.add(question.id); setView('Questions'); setDismissed(true);
    }
  }, [question?.id, view, busy, approvals.length]);
  const answerQuestion = async (answer: string) => {
    if (!question) return; setBusy(true);
    try { await client.answer(question.id, answer); setSnapshot(await client.snapshot()); setNotice('Answer sent'); }
    catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  const allTurns = Object.values(state?.tasks ?? {}).filter(task => task.sessionId === sessionId);
  const turns = allTurns.filter(task => task.objective.toLowerCase().includes(filter.toLowerCase()));
  const list = view === 'History' ? turns : view === 'Agents' ? tasks : approvals;
  const row = Math.min(index, Math.max(0, list.length - 1));
  const approval = approvals[row];
  useEffect(() => { setOffset(0); setExpandedApproval(undefined); }, [approval?.id, view]);
  const switchView = (next: View) => { setView(next); setIndex(0); setOffset(0); setFilter(''); setDismissed(true); };
  const openTask = (task: Task) => { setHistoryAnchor(undefined); setSelected(task.id); setSessionId(task.sessionId); setNotice(''); switchView('Chat'); };
  const newChat = (cwd = currentProject) => { setHistoryAnchor(undefined); setSelected(undefined); setSessionId(undefined); setProject(cwd); setDrafts(old => ({ ...old, ['new:' + cwd]: draftOf() })); switchView('Chat'); setNotice('New conversation'); };
  const copy = (text: string) => { stdout.write('\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07'); setNotice('Copy requested · requires terminal clipboard support'); };
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
      const navigation: Record<string, View> = { '/chat': 'Chat', '/history': 'History', '/sessions': 'Sessions', '/resume': 'Sessions', '/agents': 'Agents', '/approvals': 'Approvals', '/questions': 'Questions', '/projects': 'Sessions', '/settings': 'Settings', '/outputs': 'Outputs', '/models': 'Models', '/tasks': 'Tasks' };
      if (command === '/quit') { exit(); return; }
      if (navigation[command!]) switchView(navigation[command!]!);
      else if (command === '/help') { setInput('/'); setCompletionIndex(0); setDismissed(false); }
      else if (command === '/model') { if (argument) setInfo(await client.setModel(argument)); else switchView('Models'); }
      else if (command === '/close-agent') { if (!parentSessionId || !sessionId) throw new Error('Open a child agent first'); await client.closeAgent(sessionId); setNotice('Agent closed; history retained'); }
      else if (command === '/new') newChat();
      else if (command === '/project') { const cwd = line.trim().slice('/project'.length).trim().replace(/^"|"$/g, ''); if (!cwd) throw new Error('Usage: /project <existing path>'); newChat(cwd); }
      else if (command === '/copy') copy(allTurns.at(-1)?.result ?? allTurns.at(-1)?.error ?? '');
      else if (command === '/back') { const parent = parentTask; if (parent) openTask(parent); else setNotice('Already in the main conversation'); }
      else if (command === '/approval' && !argument) switchView('Settings');
      else if (command === '/team' && !argument) switchView('Team');
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
        const task = await client.submit({ objective: request[2]!, ...(sessionId ? { sessionId } : { cwd: currentProject }), agentId: info?.defaultAgent ?? 'assistant', delegations: ids.map(agentId => ({ agentId, objective: request[2]! })) });
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
        if (parentSessionId && sessionId && lifecycle && lifecycle.status !== 'idle' && lifecycle.status !== 'closed') {
          await client.agentMessage(sessionId,line);setNotice('Message queued for this agent');setSnapshot(await client.snapshot());return;
        }
        const task = parentSessionId && sessionId ? await client.followup({sessionId,objective:line}) : await client.submit({ objective: line, ...(sessionId ? { sessionId } : { cwd: currentProject }), agentId: focus?.parentTaskId ? focus.agentId : info?.defaultAgent ?? 'assistant', ...(team.length ? { delegations: team.map(agentId => ({ agentId, objective: line })) } : {}) });
        setTeam([]);
        openTask(task); setNotice(`Submitted ${short(task.id)}`);
      }
      setSnapshot(await client.snapshot());
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); setDrafts(old => old[draftKey]?.value ? old : { ...old, [draftKey]: draftOf(line) }); }
    finally { setBusy(false); }
  };
  const completions = busy || dismissed || view !== 'Chat' ? [] : completeInput(input, state);
  const activeIndex = Math.min(completionIndex, Math.max(0, completions.length - 1));
  const completion = completions[activeIndex];
  const menuCount = Math.min(4, completions.length);
  const menuHeight = menuCount ? menuCount + 1 : 0;
  const contentWidth = Math.max(10, size.columns - 4);
  const details = !!approval && expandedApproval === approval.id;
  const approvalCard = approvalPreview(approval, state, contentWidth, details);
  const detailHeight = Math.min(approvalCard.lines.length, details ? 12 : 6, Math.max(1, size.rows - 13));
  const panelHeight = view === 'Questions' ? Math.max(7, Math.min(13, size.rows - 9)) : view === 'Approvals' ? detailHeight + 4 : Math.max(7, Math.min(size.rows - 9, 13));
  const inputLayout = layout(draft, Math.max(1, size.columns - 7));
  const inputRows = Math.min(inputLayout.lines.length, Math.max(1, Math.min(5, size.rows - 15 - menuHeight)));
  const bodyHeight = Math.max(2, size.rows - 6 - (view === 'Chat' ? inputRows + 2 + menuHeight : panelHeight));
  const transcriptHeight = Math.max(1, bodyHeight - 1);
  const contentHeight = view === 'Chat' ? transcriptHeight : panelHeight - 4 - (['Sessions', 'History'].includes(view) ? 1 : 0);
  const chat = useMemo(() => transcript(state, sessionId, streaming, contentWidth, expanded, reasoning), [state, sessionId, streaming, contentWidth, expanded, reasoning]);
  const top = historyTop(chat, transcriptHeight, historyAnchor);
  const aboveLatest = Math.max(0, chat.length - top - transcriptHeight);
  const currentTurn = allTurns.findIndex(task => task.id === chat[top]?.turnId) + 1;
  const toggleDisclosure = (line: Line | undefined) => {
    if(line?.openTaskId&&state?.tasks[line.openTaskId]){openTask(state.tasks[line.openTaskId]!);return;}
    if (!line?.disclosureId) return;
    const id = line.disclosureId;
    setHistoryAnchor(anchorAt(chat, top));
    setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
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
  const maxOffset = view === 'Approvals' ? Math.max(0, approvalCard.lines.length - detailHeight) : Math.max(0, chat.length - contentHeight);
  const scroll = Math.min(offset, maxOffset);
  const editInput = (value: string) => { setInput(value); setCompletionIndex(0); setDismissed(false); };
  useTerminalInput((text, key) => {
    if (isWorkspaceView(view) || view === 'Models' || view === 'Tasks') {
      if (key.ctrl && text === 'c') exit();
      else if (key.ctrl && text === 'n') newChat();
      else if (key.ctrl) {
        const navigation: Record<string, View> = { g: 'Chat', p: 'Sessions', t: 'Agents', r: 'History', o: 'Approvals', q: 'Questions', s: 'Settings', l: 'Team', u: 'Outputs' };
        if (navigation[text]) switchView(navigation[text]!);
      }
      else if (key.tab && view !== 'Models' && view !== 'Tasks') switchView(views[(views.indexOf(view) + (key.shift ? views.length - 1 : 1)) % views.length]!);
      return;
    }
    const mouse = /^\[<(\d+);(\d+);(\d+)([mM])$/.exec(text);
    if (mouse) {
      const button = Number(mouse[1]);
      const y = Number(mouse[3]);
      if (mouse[4] === 'M' && button === 0 && view === 'Chat' && y >= 5 && y < 5 + transcriptHeight) {
        toggleDisclosure(chat[top + y - 5]); return;
      }
      if (mouse[4] === 'M' && (button & 64) && (button & 3) < 2) {
        const direction = button & 1 ? 1 : -1;
        if (view === 'Chat') moveHistory(direction * 3);
        else setIndex(current => Math.max(0, Math.min(list.length - 1, current + direction)));
      }
      return;
    }
    if (key.ctrl && text === 'c') { exit(); return; }
    if (view === 'Questions') return;
    if (key.escape) { if (view === 'Chat' && parentTask) openTask(parentTask); else if (completions.length) setDismissed(true); else if (view !== 'Chat') switchView('Chat'); else setInput(''); return; }
    if (busy) return;
    if (view === 'Chat' && ((key.return && (key.meta || key.shift)) || (key.ctrl && text === 'j'))) { setDraft(insert(draft, '\n')); return; }
    if (view === 'Chat' && key.ctrl && ['a', 'f', 'w'].includes(text)) {
      setDraft(text === 'a' ? lineStart(draft) : text === 'f' ? lineEnd(draft) : deleteWordBack(draft)); return;
    }
    if (key.ctrl) {
      if (text === 'b') { const parent = focus?.parentTaskId ? state?.tasks[focus.parentTaskId] : undefined; if (parent) openTask(parent); return; }
      if (text === 'e' && view === 'Chat') { toggleDisclosure(chat.slice(top, top + transcriptHeight).find(line => line.disclosureId)); return; }
      if (text === 'n') newChat();
      const shortcuts: Record<string, View> = { g: 'Chat', r: 'History', p: 'Sessions', t: 'Agents', o: 'Approvals', q: 'Questions', s: 'Settings', l: 'Team', u: 'Outputs' };
      if (shortcuts[text]) switchView(shortcuts[text]!);
      return;
    }
    if (view === 'Approvals' && approval && text.toLowerCase() === 'd' && !key.meta) {
      setExpandedApproval(details ? undefined : approval.id); setOffset(0); return;
    }
    if (key.tab) {
      if (completion && !key.shift) editInput(completion.value);
      else switchView(views[(views.indexOf(view) + (key.shift ? views.length - 1 : 1)) % views.length]!);
      return;
    }
    if (view === 'Chat' && key.meta && (key.upArrow || key.downArrow)) { adjacentTurn(key.upArrow ? -1 : 1); return; }
    if (view === 'Chat' && (key.leftArrow || key.rightArrow)) { setDraft(move(draft, key.leftArrow ? -1 : 1)); return; }
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
    if ((key.upArrow || key.downArrow) && view === 'Chat') {
      if (input) setDraft(moveVertical(draft, key.upArrow ? -1 : 1));
      else moveHistory(key.upArrow ? -1 : 1);
      return;
    }
    if ((key.upArrow || key.downArrow) && view !== 'Chat') {
      setIndex(Math.max(0, Math.min(list.length - 1, row + (key.upArrow ? -1 : 1)))); setOffset(0); return;
    }
    if (view === 'Approvals' && approval && ['y', 'n'].includes(text.toLowerCase())) {
      void decide(approval.id, text.toLowerCase() === 'y' ? 'approved' : 'denied'); return;
    }
    if (key.return) {
      if (view === 'Approvals' && !approvals.length) { switchView('Chat'); return; }
      if (view === 'History' && turns[row]) { jumpTurn(turns[row]!); return; }
      if (view === 'Agents' && tasks[row]) { openTask(tasks[row]!); return; }
      if (view !== 'Chat') return;
      if (completion && input !== completion.value.trimEnd()) { editInput(completion.value); return; }
      if (completion?.kind === 'command' && completion.value.endsWith(' ') && input !== '/cancel') { editInput(completion.value); return; }
      const value = input; editInput(''); void submit(value); return;
    }
    if (view === 'Approvals' && !approvals.length && text && !key.ctrl && !key.meta) {
      switchView('Chat'); setDraft(insert(draft, text)); return;
    }
    if (view !== 'Chat') {
      if (view === 'History') {
        if (key.backspace || key.delete) setFilter(Array.from(filter).slice(0, -1).join(''));
        else if (!key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) setFilter(filter + clean(text).replace(/\n/g, ' '));
        setIndex(0);
      }
      return;
    }
    if (key.backspace || key.delete) { setDraft(key.delete ? deleteForward(draft) : backspace(draft)); setDismissed(false); }
    else if (!key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      if (view !== 'Chat' && !input && text !== '/') switchView('Chat');
      setDraft(insert(draft, text)); setCompletionIndex(0); setDismissed(false);
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
    { text: '/team         Choose agents for your next message', color: 'gray' },
    { text: '/settings     Approval mode · /outputs saved results', color: 'gray' },
    { text: 'Ctrl+R        Find a user turn in this conversation', color: 'gray' },
    { text: 'Ctrl+T agents · Ctrl+O approvals · / all commands', color: 'gray' }
  ];
  else if (view === 'History') lines = turns.length ? turns.map((task, i) => ({
    text: `#${allTurns.indexOf(task) + 1}  ${clean(task.objective).replace(/\n/g, ' ')}`, color: i === row ? 'cyan' : 'gray', selected: i === row
  })).slice(Math.max(0, row - contentHeight + 1), Math.max(contentHeight, row + 1)) : [{ text: allTurns.length ? 'No matching user inputs.' : 'No turns in this conversation yet.', color: 'gray' }];
  else if (view === 'Agents') lines = tasks.length ? tasks.map((task,i)=>{const activity=agentProgress(task,state!,streaming,reasoning,contentWidth);const agent=agentSessions(state!).find(a=>a.sessionId===task.sessionId);return {...activity,text:agent?activity.text.replace(/(↗ .{1,18}  )/,'$1'+agent.status+' · '):activity.text,selected:i===row};}).slice(Math.max(0, row - contentHeight + 1), Math.max(contentHeight, row + 1)) : [{ text: 'Open a conversation to inspect its agents.', color: 'gray' }];
  else lines = [];
  const renderLines = (items: Line[], limit: number) => items.slice(0, limit).map((line, i) => <Text key={i} color={line.color} bold={line.bold} inverse={line.selected} wrap="truncate-end">{line.text || ' '}</Text>);
  if (size.rows < 18 || size.columns < 50) return <Text>Resize terminal to at least 50 × 18. Ctrl+C exits.</Text>;
  const preview = view === 'Chat' ? lines : chat.slice(top, top + transcriptHeight);
  const running = tasks.filter(task => ['running', 'queued', 'waiting_children'].includes(task.status)).length;
  const model = info?.provider === 'demo' ? 'Demo · no live model' : info?.model ?? 'Connecting…';
  const reviews = tasks.filter(task=>task.status==='waiting_review'||task.status==='needs_review').length;
  const isThinking = focus?.runIds.some(id => thinking[id]);
  return <Box flexDirection="column" width={size.columns} height={size.rows - 1}>
    <Box height={3} flexDirection="column" paddingX={1}>
      <Text><Text bold color="cyan">ORCHESTRATOR</Text><Text dimColor>  ·  {model}  ·  Approval: {info?.approvalMode ?? 'manual'}</Text></Text>
      <Text dimColor wrap="truncate-middle">{clean(currentProject || 'Local workspace')}</Text>
      <Text> </Text>
    </Box>
    <Box height={bodyHeight} flexDirection="column" paddingX={1}>
      <Text dimColor wrap="truncate-end">{focus ? `${state?.sessions[focus.sessionId]?.parentSessionId ? 'AGENT CHAT' : 'CHAT'} · ${short(focus.sessionId)} · ${focus.agentId}` : 'NEW CONVERSATION'}{parentTask ? ' · Esc / Ctrl+B parent' : ''}{lifecycle ? ' · '+lifecycle.status : ''}{allTurns.length ? ` · Turn ${currentTurn}/${allTurns.length}` : ''}{view === 'Chat' && historyAnchor ? ` · ${aboveLatest} lines above latest · End to follow` : ''}</Text>
      {renderLines(preview, transcriptHeight)}
    </Box>
    <Text color={approvals.length ? 'yellow' : 'gray'} wrap="truncate-end"> {view === 'Approvals' ? ' ' : view !== 'Questions' && questions.length ? questions.length + ' question(s) waiting · Ctrl+Q to answer' : approvals.length ? `${approvals.length} approval(s) waiting · Ctrl+O to review` : reviews ? `${reviews} task(s) need review · /tasks` : isThinking ? 'Thinking…' : running ? `${running} agent(s) working · Ctrl+T to inspect` : busy ? 'Working…' : team.length ? `${team.length} agents selected for next message · Ctrl+L to edit` : clean(notice)}</Text>
    {view === 'Chat' ? <Box height={inputRows + 2 + menuHeight} flexDirection="column" backgroundColor="#202020" paddingX={2} paddingY={1}>
      <Composer draft={draft} width={Math.max(1, size.columns - 7)} rows={inputRows} busy={busy} placeholder={lifecycle?.status==='closed'?'Agent closed · Esc returns':lifecycle?.status==='idle'?'Assign next task, or / for commands':parentSessionId?'Message this agent, or / for commands':undefined}/>
      {menuCount ? <>
        {completions.slice(Math.max(0, activeIndex - menuCount + 1), Math.max(menuCount, activeIndex + 1)).map(item => <Text key={item.value} color={item === completion ? 'cyan' : 'gray'} bold={item === completion} wrap="truncate-end">{item.label.padEnd(24)} {clean(item.description)}</Text>)}
        <Text dimColor wrap="truncate-end">↑↓ select · Tab complete · Enter select/run · Esc {parentTask ? 'parent' : 'close'}</Text>
      </> : null}
    </Box> : view === 'Tasks' ? <TaskPanel streaming={streaming} reasoning={reasoning} state={state} cwd={currentProject} client={client} width={size.columns} height={panelHeight} onOpen={openTask} onClose={()=>switchView('Chat')}/> : view === 'Models' ? <ModelPanel client={client} selected={info?.modelId ?? 'default'} width={size.columns} height={panelHeight} onInfo={setInfo} onClose={() => switchView('Chat')}/> : isWorkspaceView(view) ? <WorkspacePanel key={view} view={view} state={state} info={info} cwd={currentProject} sessionId={sessionId} client={client} width={size.columns} height={panelHeight} team={team} onTeam={setTeam} collapsed={collapsedProjects} onCollapsed={setCollapsedProjects} onOpen={openTask} onProject={newChat} onInfo={setInfo} onClose={() => switchView('Chat')} onCopy={copy}/> : view === 'Questions' ? <QuestionCard key={question?.id ?? 'empty'} question={question} count={questions.length} width={size.columns} height={panelHeight} busy={busy}
      draft={question ? questionDrafts[question.id] ?? '' : ''}
      onDraft={value => { if (question) setQuestionDrafts(current => ({ ...current, [question.id]: value })); }}
      onAnswer={answer => { void answerQuestion(answer); }} onClose={() => switchView('Chat')} /> : view === 'Approvals' ? <Box height={panelHeight} flexDirection="column" backgroundColor="#181818" paddingX={2} paddingY={1}>
      <Text wrap="truncate-end"><Text color="yellow" bold>{approvalCard.title}</Text>{approval ? <Text dimColor> · {clean(state?.tasks[approval.taskId]?.agentId ?? 'agent')}{approvals.length > 1 ? ` · ${row + 1}/${approvals.length}` : ''}</Text> : null}</Text>
      {renderLines(approvalCard.lines.slice(scroll, scroll + detailHeight), detailHeight)}
      <Text wrap="truncate-end">{approval ? <><Text color="cyan">Y allow</Text><Text dimColor> · N deny · D {details ? 'less' : 'details'} · Esc later</Text></> : <Text dimColor>Enter or Esc returns to chat</Text>}</Text>
    </Box> : <Box height={panelHeight} flexDirection="column" backgroundColor="#202020" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{view.toUpperCase()} · {list.length}</Text>
      {view === 'History' ? <Text dimColor wrap="truncate-end">Filter: {filter || (view === 'History' ? 'search user inputs' : 'type to search conversations')}▌</Text> : null}
      {renderLines(lines, contentHeight)}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">↑↓ select · Enter open · Esc back</Text>
    </Box>}
    <Text dimColor wrap="truncate-end">{view === 'Questions' ? ' ' : view === 'Approvals' ? [approvals.length > 1 ? ' ↑↓ requests' : '', maxOffset ? ` PgUp/PgDn · lines ${scroll + 1}–${Math.min(scroll + detailHeight, approvalCard.lines.length)}/${approvalCard.lines.length}` : ''].filter(Boolean).join(' ·') || ' ' : view !== 'Chat' ? ' Esc back · Tab switch panel' : completions.length ? (parentTask ? ' / commands · Esc parent' : ' / commands · Esc dismiss') : input ? ' Enter send · Alt+Enter newline · ←→ edit · PgUp/PgDn history' : ' / commands · Ctrl+P sessions · Ctrl+R turns · ↑↓ scroll'}</Text>
  </Box>;
}

export async function startTui(client: OrchestratorClient) {
  if (!process.stdin.isTTY) throw new Error('TUI requires an interactive terminal; use npm run demo');
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
  try { const app = render(<App client={client} />); await app.waitUntilExit(); }
  finally { process.stdout.write('\x1b[?1049l'); }
}
