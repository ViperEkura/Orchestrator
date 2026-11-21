import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import stringWidth from 'string-width';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { App } from '../src/tui/app.js';
import { emptyState } from '../src/storage/store.js';
import { OrchestratorClient } from '../src/transport/client.js';
import { anchorAt, historyTop, conversations, transcript } from '../src/tui/view.js';
import type { ModelInput, ModelDescriptor, ApprovalMode, Snapshot, Task, RuntimeEvent, SubmitInput } from '../src/core/domain.js';

function fixture(): Snapshot {
  const state = emptyState();
  for (const [id, title] of [['one', 'First conversation'], ['two', 'Second conversation']]) {
    state.sessions[id!] = { id: id!, cwd: 'C:/Develop/example', workspace: 'project', createdAt: '2026-11-21' };
    state.tasks[id!] = { id: id!, sessionId: id!, rootId: id!, agentId: 'coordinator', objective: title!, depth: 0, dependsOn: [], status: 'completed', runIds: [id!], createdAt: '2026-11-21' };
    state.runs[id!] = { id: id!, taskId: id!, attempt: 1, status: 'completed', steps: 1, config: { id: 'coordinator', name: 'Coordinator', systemPrompt: '', allowedTools: [] }, messages: [{ role: 'user', content: title! }, { role: 'assistant', content: `Answer for ${id}\n` + Array.from({ length: 35 }, (_, n) => `History line ${n}`).join('\n') }] };
  }
  state.approvals.approval = { id: 'approval', taskId: 'two', runId: 'two', toolCallId: 'call', toolName: 'write_file', arguments: { path: 'report.txt', content: 'review me' }, status: 'pending', createdAt: '2026-11-21' };
  return { state, lastSeq: 1 };
}

test('conversation history shows each turn once and preserves long Unicode output', () => {
  const { state } = fixture();
  state.tasks.next = { ...state.tasks.one!, id: 'next', runIds: ['next'], objective: 'Next turn' };
  state.runs.next = { ...state.runs.one!, id: 'next', taskId: 'next', messages: [
    ...state.runs.one!.messages, { role: 'user', content: 'Next turn' }, { role: 'assistant', content: '你好，世界。'.repeat(100) }
  ] };
  const text = transcript(state, 'one', {}, 30).map(line => line.text).join('\n');
  assert.equal(text.split('First conversation').length - 1, 1);
  assert.equal(text.split('Answer for one').length - 1, 1);
  assert.equal(text.replace(/\n/g, '').split('你好，世界。').length - 1, 100);
  assert.equal(conversations(state).length, 2);
});

class FakeClient extends OrchestratorClient {
  answers: { id: string; answer: string }[] = [];
  override async answer(id: string, answer: string) { this.answers.push({ id, answer }); this.data.state.questions[id]!.status = 'answered'; this.data.state.questions[id]!.answer = answer; return { ok: true }; }
  data = fixture(); decisions: string[] = []; inputs: SubmitInput[] = [];
  private queued: RuntimeEvent[] = []; private wake?: () => void;
  emit(event: RuntimeEvent) { this.queued.push(event); this.wake?.(); }
  constructor() { super('http://localhost:4317'); }
  approvalMode: ApprovalMode = 'manual';
  modelId = 'default';
  profiles: ModelDescriptor[] = [{id:'default',name:'Test',model:'test-model',provider:'compatible'}];
  addedModels: ModelInput[] = [];
  override async models() { return this.profiles; }
  override async setModel(id: string) { this.modelId=id;return this.info(); }
  override async addModel(input: ModelInput) { this.addedModels.push(input);const item={id:'custom',name:input.name??input.model,model:input.model,provider:'compatible'};this.profiles.push(item);return item; }
  override async info() { return { cwd: 'C:/Develop/example', model: this.profiles.find(item=>item.id===this.modelId)!.model, modelId:this.modelId, provider: 'compatible', defaultAgent: 'assistant', approvalMode: this.approvalMode }; }
  override async setApprovalMode(mode: ApprovalMode) { this.approvalMode = mode; return this.info(); }
  override async agents() { return ['assistant', 'researcher', 'reviewer'].map(id => ({id, name: id, systemPrompt: '', allowedTools: []})); }
  artifactReads: number[] = [];
  override async artifact(_id: string, offset = 0) {
    this.artifactReads.push(offset);
    return { content: offset ? 'Second output page' : 'First output page\n', total: 35, nextOffset: offset ? null : 18 };
  }
  override async snapshot() { return structuredClone(this.data); }
  override async *events(_after: number, signal: AbortSignal): AsyncGenerator<RuntimeEvent> {
    const abort = () => this.wake?.(); signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        if (this.queued.length) yield this.queued.shift()!;
        else await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally { signal.removeEventListener('abort', abort); }
  }
  override async approve(id: string, decision: 'approved' | 'denied') {
    this.decisions.push(`${id}:${decision}`); this.data.state.approvals[id]!.status = decision; return { ok: true };
  }
  override async submit(input: SubmitInput): Promise<Task> {
    this.inputs.push(input);
    return { ...this.data.state.tasks.one!, id: 'submitted', sessionId: input.sessionId ?? 'new-session', objective: input.objective };
  }
}

const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

function terminalHarness(client: FakeClient, columns = 100, rows = 30) {
  let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = chunk.toString(); if (text.includes('ORCHESTRATOR')) frame = text; done(); } }), { columns, rows, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  return {
    frame: () => frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''),
    press: async (key: string) => { input.write(key); await pause(); },
    close: () => { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); },
  };
}

test('TUI project tree folds, filters and creates conversations in the selected project', async () => {
  const client = new FakeClient(); client.data.state.approvals = {};
  client.data.state.sessions.two!.cwd = 'C:/Develop/another project';
  const tui = terminalHarness(client);
  try {
    await pause(160); await tui.press('\x10');
    assert.match(tui.frame(), /PROJECTS · 2/); assert.match(tui.frame(), /First conversation/); assert.match(tui.frame(), /Second conversation/);
    await tui.press('\x1b[D'); assert.doesNotMatch(tui.frame(), /First conversation/);
    await tui.press('\x1b[C'); assert.match(tui.frame(), /First conversation/);
    await tui.press('Second'); assert.doesNotMatch(tui.frame(), /First conversation/);
    await tui.press('+'); assert.match(tui.frame(), /NEW CONVERSATION/); assert.match(tui.frame(), /C:\/Develop\/another project/);
    await tui.press('new project task'); await tui.press('\r');
    assert.equal(client.inputs.at(-1)?.cwd, 'C:/Develop/another project'); assert.equal(client.inputs.at(-1)?.sessionId, undefined);
    await tui.press('\x10'); await tui.press('\x01'); assert.match(tui.frame(), /OPEN PROJECT/);
    // Ctrl+A opens a directory editor without touching the conversation draft.
    for (let i = 0; i < 'C:/Develop/another project'.length; i++) await tui.press('\x7f');
    await tui.press('C:/Develop/third project'); await tui.press('\r');
    await tui.press('third task'); await tui.press('\r'); assert.equal(client.inputs.at(-1)?.cwd, 'C:/Develop/third project');
  } finally { tui.close(); }
});

test('TUI settings and agent selection preserve drafts and submit the same structured team as web', async () => {
  const client = new FakeClient(); client.data.state.approvals = {};
  const tui = terminalHarness(client, 70, 24);
  try {
    await pause(160); await tui.press('review my project'); await tui.press('\x13');
    assert.match(tui.frame(), /SETTINGS · Approval mode/); assert.match(tui.frame(), /Ask for approval/); assert.match(tui.frame(), /Agent decides/);
    await tui.press('\x1b[B'); await tui.press('\r'); assert.equal(client.approvalMode, 'agent'); assert.match(tui.frame(), /review my project/);
    await tui.press('\x0c'); assert.match(tui.frame(), /CHOOSE AGENTS/);
    await tui.press(' '); await tui.press('\x1b[B'); await tui.press(' '); await tui.press('\r');
    assert.match(tui.frame(), /2 agents selected/); assert.match(tui.frame(), /review my project/);
    await tui.press('\r');
    assert.deepEqual(client.inputs.at(-1)?.delegations, [{agentId:'researcher',objective:'review my project'}, {agentId:'reviewer',objective:'review my project'}]);
    assert.doesNotMatch(tui.frame(), /2 agents selected/);
    await tui.press('/team'); await tui.press('\r'); assert.match(tui.frame(), /CHOOSE AGENTS/);
    await tui.press('\x1b'); await tui.press('/approval'); await tui.press('\r'); assert.match(tui.frame(), /SETTINGS · Approval mode/);
  } finally { tui.close(); }
});

test('TUI output paging, parent navigation and narrow panels retain the current conversation', async () => {
  const client = new FakeClient(); client.data.state.approvals = {};
  const state = client.data.state;
  state.tasks.child = {...state.tasks.two!,id:'child',parentTaskId:'two',rootId:'two',sessionId:'child',depth:1,runIds:[]};
  state.sessions.child = {...state.sessions.two!,id:'child',parentSessionId:'two'};
  state.artifacts.file = { id:'file',runId:'two',taskId:'two',path:'test.txt',mediaType:'text/plain' };
  const tui = terminalHarness(client, 50, 18);
  try {
    await pause(160); await tui.press('\x10'); await tui.press('\r'); await tui.press('draft kept');
    await tui.press('\x15'); assert.match(tui.frame(), /OUTPUTS · 1/); await tui.press('\r');
    assert.match(tui.frame(), /First output page/); await tui.press('l'); assert.deepEqual(client.artifactReads, [0,18]);
    for (let i=0;i<8;i++) await tui.press('\x1b[6~'); assert.match(tui.frame(), /Second output page/);
    await tui.press('\x1b'); await tui.press('\x1b'); assert.match(tui.frame(), /draft kept/);
    await tui.press('\x14'); await tui.press('\x1b[B'); await tui.press('\r'); assert.match(tui.frame(), /CHAT · child/);
    await tui.press('\x02'); assert.match(tui.frame(), /CHAT · two/); assert.match(tui.frame(), /draft kept/);
    for (const key of ['\x10','\x0c','\x13','\x15']) {
      await tui.press(key); const lines=tui.frame().trimEnd().split('\n');
      assert.ok(lines.length<=17, `frame has ${lines.length} rows`);
      assert.ok(lines.every(line=>stringWidth(line)<=50));
    }
  } finally { tui.close(); }
});
test('TUI navigates sessions, history, agents and approvals; new chat clears the old target; narrow resize fits', async () => {
  const client = new FakeClient(); let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = chunk.toString(); if (text.includes('ORCHESTRATOR')) frame = text; done(); } }), { columns: 120, rows: 30, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { input.write(key); await pause(); };
  try {
    await pause(160); assert.match(frame, /Write file\?/); await press('\x1b'); assert.match(frame, /NEW CONVERSATION/); assert.match(frame, /Welcome to Orchestrator/); assert.doesNotMatch(frame, /History line 34|COORDINATOR/);
    await press('\x10'); await press('\r'); assert.match(frame, /CHAT · two/); assert.doesNotMatch(frame, /CONVERSATIONS · Ctrl/);
    assert.match(frame, /History line 34/);
    await press('\x1b[5~'); assert.match(frame, /above latest/); assert.doesNotMatch(frame, /History line 34/);
    await press('\x10'); assert.match(frame, /SESSIONS · 2/);
    await press('First'); assert.match(frame, /SESSIONS · 1/);
    await press('\r'); assert.match(frame, /CHAT · one/);
    await press('draft to keep'); await press('\x10'); await press('\x1b'); assert.match(frame, /draft to keep/);
    await press('\x14'); assert.match(frame, /AGENTS · 1/);
    await press('\x0f'); assert.doesNotMatch(frame, /draft to keep/); assert.match(frame, /Write file\?/); assert.match(frame, /report.txt/);
    await press('y'); assert.deepEqual(client.decisions, ['approval:approved']); assert.doesNotMatch(frame, /Write file\?/); assert.match(frame, /draft to keep/);
    await press('\x0f'); assert.match(frame, /No pending approvals/);
    await press('\r'); assert.doesNotMatch(frame, /Write file\?/);
    await press('\x0f'); await press('!'); assert.match(frame, /draft to keep!/); assert.doesNotMatch(frame, /Write file\?/);
    await press('\x0e'); assert.match(frame, /NEW CONVERSATION/);
    await press('fresh task'); await press('\r'); assert.equal(client.inputs[0]?.sessionId, undefined);
    await press('\x0e'); await press('/delegate reviewer review this'); await press('\r');
    assert.deepEqual(client.inputs.at(-1)?.delegations, [{ agentId: 'reviewer', objective: 'review this' }]);
    await press('\x0e'); await press('/team researcher,reviewer inspect this'); await press('\r');
    assert.deepEqual(client.inputs.at(-1)?.delegations?.map(plan => plan.agentId), ['researcher', 'reviewer']);
    await press('\x0e'); await press('/ses'); assert.match(frame, /Browse and switch conversations/);
    await press('\t'); assert.match(frame, /\/sessions/); await press('\r'); assert.match(frame, /SESSIONS · 2/);
    output.columns = 65; output.rows = 22; output.emit('resize'); await pause();
    assert.doesNotMatch(frame, /CONVERSATIONS · Ctrl/);
    const plain = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd();
    assert.ok(plain.split('\n').length <= 21, `frame has ${plain.split('\n').length} lines`);
    for (const columns of [50, 120]) {
      output.columns = columns; output.rows = 18; output.emit('resize'); await pause();
      await press('\x0e'); await press('/');
      const compact = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd();
      assert.ok(compact.split('\n').length <= 17, `compact frame has ${compact.split('\n').length} lines`);
    }
  } finally { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); }
});


test('history anchors remain on the selected user turn as new output arrives and widths change', () => {
  const { state } = fixture();
  const lines = transcript(state, 'one', {}, 70);
  const anchor = anchorAt(lines, 0);
  const growing = transcript(state, 'one', { one: 'new streaming output '.repeat(100) }, 70);
  assert.equal(historyTop(growing, 8, anchor), 0);
  assert.equal(historyTop(growing, 8), growing.length - 8);
  assert.equal(historyTop(transcript(state, 'one', {}, 20), 8, anchor), 0);
});

test('arrows and wheel scroll; user-input search and adjacent-turn jumps preserve drafts and reading position', async () => {
  const client = new FakeClient();
  const state = client.data.state;
  delete state.tasks.two; delete state.runs.two; state.approvals = {};
  for (const [id, title] of [['next', 'Second input'], ['last', '最后一轮中文问题']]) {
    state.tasks[id!] = { ...state.tasks.one!, id: id!, objective: title!, runIds: [id!] };
    state.runs[id!] = { ...state.runs.one!, id: id!, taskId: id!, messages: [{ role: 'user', content: title! }, { role: 'assistant', content: Array.from({length: 35}, (_, n) => id + ' response line ' + n).join('\n') }] };
  }
  let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = chunk.toString(); if (text.includes('ORCHESTRATOR')) frame = text; done(); } }), { columns: 100, rows: 30, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { input.write(key); await pause(); };
  try {
    await pause(160); assert.match(frame, /Welcome to Orchestrator/); await press('\x10'); await press('\r'); assert.match(frame, /last response line 34/);
    await press('\x1b[A'); assert.match(frame, /1 lines above latest/);
    await press('\x1b[<64;10;10M'); assert.match(frame, /4 lines above latest/);
    await press('\x1b[<65;10;10M'); assert.match(frame, /1 lines above latest/);
    await press('\x1b[B'); assert.doesNotMatch(frame, /above latest/);
    await press('\x1b[H'); assert.match(frame, /First conversation/);
    await press('\x1b[1;3B'); assert.match(frame, /Second input/); assert.match(frame, /Turn 2\/3/);
    await press('draft kept');
    await press('\x12'); assert.match(frame, /HISTORY · 3/);
    await press('中文'); assert.match(frame, /HISTORY · 1/); assert.match(frame, /#3/);
    await press('\r'); assert.match(frame, /最后一轮中文问题/); assert.match(frame, /draft kept/);
    await press('\x1b[1;3A'); assert.match(frame, /Second input/);
    client.emit({ seq: 1, type: 'message.delta', at: '', runId: 'last', data: { text: '\nNew output '.repeat(100) }, transient: true });
    await pause(); assert.match(frame, /Second input/); assert.match(frame, /Turn 2\/3/);
    await press('\x12'); await press('missing prompt'); assert.match(frame, /No matching user inputs/);
    await press('\x1b'); assert.match(frame, /Second input/); assert.match(frame, /draft kept/);
    output.columns = 65; output.emit('resize'); await pause(); assert.match(frame, /Second input/);
    assert.equal(client.inputs.length, 0);
    await press('\x1b[F'); assert.doesNotMatch(frame, /above latest/); assert.match(frame, /New output/);
    await press('\x0e'); await press('/history'); await press('\r'); assert.match(frame, /No turns in this conversation yet/);
  } finally { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); }
});

test('approval queue stays open for remaining requests and returns to the draft after external resolution', async () => {
  const client = new FakeClient();
  client.data.state.approvals.second = { ...client.data.state.approvals.approval!, id: 'second' };
  client.data.state.runs.two!.messages = [{ role: 'user', content: 'Second conversation' }, { role: 'assistant', content: '**Formatted answer**\n\n| Name | Value |\n| --- | --- |\n| Markdown | works |' }];
  let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = chunk.toString(); if (text.includes('ORCHESTRATOR')) frame = text; done(); } }), { columns: 100, rows: 30, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { input.write(key); await pause(); };
  try {
    await pause(160); await press('\x10'); await press('\r');
    assert.match(frame, /Formatted answer/); assert.doesNotMatch(frame, /\*\*Formatted answer\*\*/); assert.match(frame, /┌/);
    await press('\x1b[H'); await press('unsent draft'); await press('\x0f'); assert.match(frame, /Write file\?.*1\/2/);
    await press('y'); assert.match(frame, /Write file\?/);
    client.data.state.approvals.second!.status = 'denied';
    client.emit({ seq: 2, type: 'approval.resolved', at: '', data: {} });
    await pause(180); assert.doesNotMatch(frame, /Write file\?/); assert.match(frame, /unsent draft/);
    client.data.state.approvals.third = { ...client.data.state.approvals.second!, id: 'third', status: 'pending' };
    client.emit({ seq: 3, type: 'approval.requested', at: '', data: {} });
    await pause(180); assert.match(frame, /Write file\?/);
    await press('\x1b'); assert.match(frame, /unsent draft/);
    client.emit({ seq: 4, type: 'run.step', at: '', data: {} });
    await pause(180); assert.doesNotMatch(frame, /Write file\?/);
    // Replace a request while the queue count stays the same: ID, not count, triggers the popup.
    client.data.state.approvals.third!.status = 'cancelled';
    client.data.state.approvals.fourth = { ...client.data.state.approvals.third!, id: 'fourth', status: 'pending' };
    client.emit({ seq: 5, type: 'approval.requested', at: '', data: {} });
    await pause(180); assert.match(frame, /Write file\?/); await press('n');
    assert.deepEqual(client.decisions, ['approval:approved', 'fourth:denied']);
    assert.doesNotMatch(frame, /Write file\?/); assert.match(frame, /unsent draft/);
  } finally { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); }
});

test('compact approvals show commands directly and page complete details on narrow terminals', async () => {
  const client = new FakeClient();
  client.data.state.approvals.approval!.toolName = 'run_command';
  client.data.state.approvals.approval!.arguments = { command: Array.from({ length: 12 }, (_, i) => 'echo line-' + i).join('\n'), timeoutMs: 60000 };
  let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = chunk.toString(); if (text.includes('ORCHESTRATOR')) frame = text; done(); } }), { columns: 50, rows: 18, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { input.write(key); await pause(); };
  try {
    await pause(160);
    assert.match(frame, /Run command\?/); assert.match(frame, /echo line-0/);
    assert.match(frame, /Y allow/); assert.match(frame, /Esc later/);
    assert.doesNotMatch(frame, /APPROVALS|Ctrl\+O to review|timeoutMs|Manual approval required|╭|╰/);
    for (let i = 0; i < 8; i++) await press('\x1b[6~');
    assert.match(frame, /echo line-11/);
    await press('d'); assert.match(frame, /Task: two/); assert.match(frame, /D less/);
    for (let i = 0; i < 12; i++) await press('\x1b[6~');
    assert.match(frame, /timeoutMs/);
    const plain = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd();
    assert.ok(plain.split('\n').length <= 17);
    assert.equal(client.decisions.length, 0);
    await press('d'); assert.match(frame, /echo line-0/);
    await press('n'); assert.deepEqual(client.decisions, ['approval:denied']);
  } finally { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); }
});

function detailMessages() {
  return [
    { role: 'user' as const, content: 'First conversation' },
    { role: 'assistant' as const, content: 'Checking the project.', reasoningContent: 'Model-provided reasoning text', toolCalls: [{ id: 'inspect', name: 'run_command', arguments: '{"command":"echo inspect"}' }] },
    { role: 'tool' as const, toolCallId: 'inspect', content: '{"error":"Command failed"}' },
    { role: 'assistant' as const, content: 'Final response' }
  ];
}

test('thinking and tools are collapsed by default, preserve ordering and survive serialization', () => {
  const { state } = fixture(); state.approvals = {}; state.runs.one!.messages = detailMessages();
  const collapsed = transcript(state, 'one', {}, 70);
  const headers = collapsed.filter(l => l.disclosureId).map(l => l.text);
  assert.match(headers[0]!, /^▸ Thinking +Model-provided reasoning text$/);
  assert.match(headers[1]!, /^▸ run_command +echo inspect$/);
  assert.equal(headers[0]!.indexOf('Model-provided'), headers[1]!.indexOf('echo inspect'));
  assert.ok(!collapsed.some(l => /Arguments|Result|Command failed|Status:/.test(l.text)));
  assert.equal(collapsed.find(l => l.disclosureId?.includes(':tool:'))?.color, 'red');
  assert.equal(collapsed.find(l => l.disclosureId?.includes(':thinking:'))?.color, 'gray');
  state.runs.one!.messages[2]!.content = '{"exitCode":0}';
  assert.equal(transcript(state, 'one', {}, 70).find(l => l.disclosureId?.includes(':tool:'))?.color, 'gray');
  state.runs.one!.messages = detailMessages();
  state.runs.one!.messages[1]!.reasoningContent = '中文摘要\n\t' + '详细内容'.repeat(30);
  const narrow = transcript(state, 'one', {}, 32).find(l => l.disclosureId)!;
  assert.match(narrow.text, /中文摘要/); assert.match(narrow.text, /…$/); assert.doesNotMatch(narrow.text, /[\n\t]/);
  assert.ok(stringWidth(narrow.text) <= 32);
  state.runs.one!.messages = detailMessages();
  const expanded = new Set(collapsed.flatMap(l => l.disclosureId ? [l.disclosureId] : []));
  const text = transcript(JSON.parse(JSON.stringify(state)), 'one', {}, 70, expanded).map(l => l.text).join('\n');
  assert.match(text, /Status: failed/); assert.match(text, /Status: completed/);
  assert.match(text, /Model-provided reasoning text/); assert.match(text, /echo inspect/); assert.match(text, /Command failed/);
  assert.ok(text.indexOf('Thinking') < text.indexOf('Checking the project'));
  assert.ok(text.indexOf('Result') < text.indexOf('Final response'));
  state.tasks.next = { ...state.tasks.one!, id: 'next', objective: 'Next turn', runIds: ['next'] };
  state.runs.next = { ...state.runs.one!, id: 'next', messages: [...detailMessages(), { role: 'user', content: 'Next turn' }, { role: 'assistant', content: 'Next response' }] };
  assert.equal(transcript(state, 'one', {}, 70).filter(l => l.text.includes('▸ Thinking')).length, 1);
  const run = state.runs.one!; const key = 'one:thinking:' + run.messages.length;
  const live = transcript(state, 'one', {}, 70, new Set([key]), { one: 'Live model text' });
  assert.ok(live.some(l => l.disclosureId === key)); assert.ok(live.some(l => l.text === 'Live model text'));
  run.messages.push({ role: 'assistant', content: '', reasoningContent: 'Live model text' });
  assert.equal(transcript(state, 'one', {}, 70, new Set([key])).filter(l => l.text === 'Live model text').length, 1);
});

test('click and Ctrl+E toggle records without submitting drafts or repeating tool calls', async () => {
  const client = new FakeClient(); client.data.state.approvals = {};
  delete client.data.state.tasks.two; delete client.data.state.runs.two;
  client.data.state.runs.one!.messages = detailMessages();
  let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = chunk.toString(); if (text.includes('ORCHESTRATOR')) frame = text; done(); } }), { columns: 100, rows: 32, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { input.write(key); await pause(); };
  const click = async (label: string) => {
    const y = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').findIndex(line => line.includes(label)) + 1;
    assert.ok(y >= 5); await press('\x1b[<0;3;' + y + 'M'); await press('\x1b[<0;3;' + y + 'm');
  };
  try {
    await pause(160); await press('\x10'); await press('\r'); await press('draft kept');
    assert.match(frame, /▸ Thinking +Model-provided/); assert.equal(frame.split('Model-provided reasoning text').length - 1, 1);
    await click('▸ Thinking'); assert.equal(frame.split('Model-provided reasoning text').length - 1, 2);
    await press('\x05'); assert.equal(frame.split('Model-provided reasoning text').length - 1, 1);
    await click('▸ run_command'); assert.match(frame, /echo inspect/); assert.match(frame, /Command failed/);
    await click('▾ run_command'); assert.match(frame, /echo inspect/); assert.doesNotMatch(frame, /Command failed/);
    assert.match(frame, /draft kept/); assert.equal(client.inputs.length, 0); assert.equal(client.decisions.length, 0);
    client.emit({ seq: 2, type: 'message.thinking', at: '', runId: 'one', data: { text: 'Streaming reasoning' }, transient: true });
    await pause(); await click('Streaming reasoning'); assert.match(frame, /Streaming reasoning/);
    client.data.state.runs.one!.messages.push({ role: 'assistant', content: '', reasoningContent: 'Streaming reasoning' });
    client.emit({ seq: 3, type: 'message.completed', at: '', runId: 'one', data: {} });
    await pause(180); assert.equal(frame.split('Streaming reasoning').length - 1, 2);
    assert.match(frame, /draft kept/);
  } finally { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); }
});

test('questions automatically open, accept choices or custom text and preserve the chat draft', async () => {
  const client=new FakeClient(); client.data.state.approvals={};let frame='';
  const output=Object.assign(new Writable({write(chunk,_encoding,done){const text=chunk.toString();if(text.includes('ORCHESTRATOR'))frame=text;done();}}),{columns:80,rows:26,isTTY:true});
  const input=Object.assign(new PassThrough(),{isTTY:true,setRawMode(){},ref(){},unref(){}});
  const app=render(React.createElement(App,{client}),{stdout:output as unknown as NodeJS.WriteStream,stdin:input as unknown as NodeJS.ReadStream,debug:true,patchConsole:false,exitOnCtrlC:false});
  const press=async(key:string)=>{input.write(key);await pause();};
  try {
    await pause(160);await press('draft for chat');
    client.data.state.questions.q={id:'q',taskId:'one',runId:'one',toolCallId:'ask',question:'Which output format?',options:['JSON','Text'],status:'pending',createdAt:''};
    client.emit({seq:2,type:'question.requested',at:'',data:{}});await pause(180);
    assert.match(frame,/Which output format/);assert.doesNotMatch(frame,/draft for chat/);
    await press('\x1b');assert.match(frame,/draft for chat/);
    await press('\x11');assert.match(frame,/Which output format/);
    await press('CSV');await press('\r');assert.deepEqual(client.answers,[{id:'q',answer:'CSV'}]);assert.match(frame,/draft for chat/);
    client.data.state.questions.next={...client.data.state.questions.q!,id:'next',status:'pending'};
    client.emit({seq:3,type:'question.requested',at:'',data:{}});await pause(180);
    await press('\x1b[B');await press('\r');assert.deepEqual(client.answers[1],{id:'next',answer:'Text'});assert.match(frame,/draft for chat/);
    client.data.state.questions.last={...client.data.state.questions.q!,id:'last',status:'pending',question:'A question '.repeat(50)};
    client.emit({seq:4,type:'question.requested',at:'',data:{}});await pause(180);
    output.columns=50;output.rows=18;output.emit('resize');await pause();await press('\x1b[6~');
    const plain=frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trimEnd();assert.ok(plain.split('\n').length<=17);
    client.data.state.questions.last!.status='cancelled';client.emit({seq:5,type:'run.cancelled',at:'',data:{}});await pause(180);assert.match(frame,/draft for chat/);
    assert.equal(client.inputs.length,0);assert.equal(client.decisions.length,0);
  } finally {app.unmount();app.cleanup();input.destroy();output.destroy();}
});


test('composer edits at the cursor, retains multiline paste and restores per-session drafts', async () => {
  const client = new FakeClient(); client.data.state.approvals = {};
  let frame = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { frame = chunk.toString(); done(); } }), { columns: 80, rows: 24, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(React.createElement(App, { client }), { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { input.write(key); await pause(); };
  try {
    await pause(160);
    await press('acX'); await press('\x7f'); await press('\x1b[D'); await press('b'); await press('Z'); await press('\x1b[D'); await press('\x1b[3~'); await press('\r');
    assert.equal(client.inputs[0]?.objective, 'abc');
    await press('\x10'); await press('Second'); await press('\r');
    await press('draft two');
    await press('\x10'); await press('First'); await press('\r');
    await press('first line\nsecond line');
    await press('\x10'); await press('Second'); await press('\r');
    assert.match(frame, /draft two/); assert.doesNotMatch(frame, /first line/);
    await press('\x10'); await press('First'); await press('\r');
    assert.match(frame, /first line/); assert.match(frame, /second line/);
    await press('\r');
    assert.equal(client.inputs.at(-1)?.objective, 'first line\nsecond line');
    assert.equal(client.inputs.at(-1)?.sessionId, 'one');
  } finally { app.unmount(); app.cleanup(); input.destroy(); output.destroy(); }
});


test('TUI adds and selects custom models while masking keys and retaining the chat draft',async()=>{
  const client=new FakeClient();client.data.state.approvals={};const tui=terminalHarness(client,70,24);
  try {
    await pause(160);await tui.press('/models');await tui.press('\r');assert.match(tui.frame(),/CHOOSE MODEL/);
    assert.match(tui.frame(),/\+ Add model/);
    for(const shortcut of ['a','A']){await tui.press(shortcut);assert.match(tui.frame(),/ADD MODEL/);await tui.press('\x1b');}
    await tui.press('\x1b[B');await tui.press('\r');assert.match(tui.frame(),/ADD MODEL/);
    await tui.press('My endpoint');await tui.press('\t');await tui.press('https://provider.example.test/v1');
    await tui.press('\t');await tui.press('custom-model');await tui.press('\t');await tui.press('private-ui-key');
    assert.doesNotMatch(tui.frame(),/private-ui-key/);assert.match(tui.frame(),/•••/);
    await tui.press('\r');assert.equal(client.modelId,'custom');assert.match(tui.frame(),/custom-model/);
    assert.equal(client.addedModels[0]?.baseUrl,'https://provider.example.test/v1');assert.equal(client.addedModels[0]?.apiKey,'private-ui-key');
    await tui.press('draft kept');await tui.press('\x13');await tui.press('\t');await tui.press('\t');
    // Outputs then Models in the shared panel cycle.
    assert.match(tui.frame(),/CHOOSE MODEL/);await tui.press('\x1b[A');await tui.press('\r');
    assert.equal(client.modelId,'default');assert.match(tui.frame(),/draft kept/);assert.equal(client.inputs.length,0);
  } finally {tui.close();}
});
