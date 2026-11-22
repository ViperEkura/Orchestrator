import { taskResults } from '../src/core/tasks/results.js';
import { emptyState } from '../src/storage/store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/storage/store.js';
import { OrchestratorService } from '../src/core/runtime.js';
import { resolveApiKey } from '../src/core/config.js';
import type { Message, ModelProvider, ToolSpec } from '../src/core/domain.js';

test('default agent streams a direct two-turn conversation and retains reasoning context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-chat-'));
  const store = new StateStore(join(dir, 'data')); const requests: Message[][] = [];
  const provider: ModelProvider = { async *stream(messages) {
    requests.push(structuredClone(messages));
    yield { type: 'reasoning', text: 'Provider reasoning metadata' };
    yield { type: 'text', text: 'Hello ' }; yield { type: 'text', text: 'there' };
  } };
  const runtime = new OrchestratorService(store, provider, { workspaceDir: dir });
  const events: string[] = []; const liveReasoning: unknown[] = [];
  store.subscribe(event => { events.push(event.type); if (event.type === 'message.thinking') liveReasoning.push(event.data); });
  try {
    const first = runtime.submit({ objective: 'Hello' }); await runtime.waitUntilDone(first.id);
    assert.equal(first.agentId, 'assistant');
    const second = runtime.submit({ objective: 'Continue', sessionId: first.sessionId }); await runtime.waitUntilDone(second.id);
    assert.equal(Object.keys(store.snapshot().state.tasks).length, 2);
    assert.equal(store.snapshot().state.tasks[second.id]!.result, 'Hello there');
    assert.equal(requests[1]!.filter(message => message.content === 'Hello').length, 1);
    assert.ok(requests[1]!.some(message => message.reasoningContent === 'Provider reasoning metadata'));
    assert.ok(events.indexOf('message.delta') < events.indexOf('message.completed'));
    assert.deepEqual(liveReasoning, [{ text: 'Provider reasoning metadata' }, { text: 'Provider reasoning metadata' }]);
    const restored = store.snapshot(); await runtime.close(); store.close();
    const reopened = new StateStore(join(dir, 'data'));
    try { assert.deepEqual(reopened.snapshot(), restored); }
    finally { reopened.close(); }
  } finally { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('structured sub-agent and team plans schedule dependencies and return results to the parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-team-')); const store = new StateStore(':memory:');
  const roles: string[] = []; const specs: ToolSpec[][] = []; const requests: Message[][] = [];
  const provider: ModelProvider = { async *stream(messages, tools) {
    roles.push(messages[0]!.content.match(/\[(\w+)\]/)![1]!); specs.push(tools); requests.push(structuredClone(messages));
    yield { type: 'text', text: `${roles.at(-1)} findings` };
  } };
  const runtime = new OrchestratorService(store, provider, { workspaceDir: dir, concurrency: 1 });
  try {
    const task = runtime.submit({ objective: 'Review project', delegations: [
      { agentId: 'researcher', objective: 'Inspect code' },
      { agentId: 'reviewer', objective: 'Review findings', after: [0] }
    ] });
    assert.equal((await runtime.waitUntilDone(task.id)).status, 'completed');
    assert.deepEqual(roles, ['researcher', 'reviewer', 'assistant']);
    assert.ok(requests[1]!.some(message => message.content.includes('researcher findings')));
    assert.ok(requests[2]!.some(message => message.content.includes('reviewer findings')));
    assert.ok(!specs[0]!.some(tool => tool.name === 'write_file'));
    assert.equal(Object.values(store.snapshot().state.tasks).filter(child => child.parentTaskId === task.id).length, 2);
    const sub = runtime.submit({ objective: 'One specialist', delegations: [{ agentId: 'reviewer', objective: 'Review this' }] });
    await runtime.waitUntilDone(sub.id);
    assert.equal(Object.values(store.snapshot().state.tasks).filter(child => child.parentTaskId === sub.id).length, 1);
    assert.throws(() => runtime.submit({ objective: 'cycle', delegations: [{ agentId: 'reviewer', objective: 'invalid', after: [0] }] }), /earlier plan/);
  } finally { await runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('credential references reuse API keys without putting secrets into settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-auth-')); const file = join(dir, 'auth.json');
  try {
    await writeFile(file, JSON.stringify({ deepseek: { type: 'api', key: 'fixture-key' } }));
    const settings = { credentials: { file, provider: 'deepseek' } };
    assert.equal(resolveApiKey(settings, {}), 'fixture-key');
    assert.equal(resolveApiKey(settings, { LLM_API_KEY: 'override' }), 'override');
    assert.ok(!JSON.stringify(settings).includes('fixture-key'));
    assert.throws(() => resolveApiKey({ credentials: { file, provider: 'missing' } }, {}), /API key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


for (const explicitWait of [true, false]) test('task-driven delegation returns compact reports and synthesizes ' + (explicitWait ? 'after wait_tasks' : 'when the model forgets to wait'), async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-dispatch-'));
  const store = new StateStore(':memory:');
  let syntheses = 0;
  const provider: ModelProvider = { async *stream(messages, tools) {
    if (!messages[0]!.content.includes('[assistant]')) {
      assert.ok(!messages.some(m => m.content === 'Main request with private history'));
      yield {type:'reasoning', text:'Private child reasoning'};
      yield {type:'text', text:'Conclusion and evidence. ' + 'Detailed child report. '.repeat(400)};
      return;
    }
    assert.ok(tools.some(tool => tool.name === 'delegate_task'));
    assert.match(messages[0]!.content, /without requiring the user to request agents/);
    const calls = messages.flatMap(m => m.toolCalls ?? []);
    if (!calls.some(call => call.name === 'delegate_task')) {
      for (const [id, agentId] of [['research','researcher'], ['review','reviewer']]) yield {type:'tool', call:{id:id!,name:'delegate_task',arguments:JSON.stringify({agentId,objective:'Bounded task '+id,acceptanceCriteria:['Provide evidence']})}};
      return;
    }
    const ids = messages.filter(m=>m.role==='tool').flatMap(m=>{const value=JSON.parse(m.content);return value.taskId?[value.taskId]:[];});
    if (explicitWait && !calls.some(call=>call.name==='wait_tasks')) {
      yield {type:'tool',call:{id:'wait',name:'wait_tasks',arguments:JSON.stringify({taskIds:ids})}};return;
    }
    const resultMessage=messages.find(m=>m.content.includes('resultArtifactId'));
    if (!resultMessage) { yield {type:'text',text:'Premature answer'};return; }
    assert.ok(resultMessage.content.length < 4000);
    assert.ok(!messages.some(m=>m.reasoningContent==='Private child reasoning'));
    syntheses++;
    yield {type:'text',text:'Verified combined conclusion'};
  }};
  const runtime = new OrchestratorService(store, provider, {workspaceDir:dir,concurrency:1});
  try {
    const root=runtime.submit({objective:'Main request with private history'});
    const done=await runtime.waitUntilDone(root.id);
    assert.equal(done.status,'completed',done.error);assert.equal(done.result,'Verified combined conclusion');assert.equal(syntheses,1);
    const state=store.snapshot().state, children=Object.values(state.tasks).filter(t=>t.parentTaskId===root.id);
    assert.equal(children.length,2);
    assert.equal(state.runs[root.runIds[0]!]!.checkpoint!.receivedChildIds!.length,2);
    for(const child of children){const artifact=Object.values(state.artifacts).find(a=>a.taskId===child.id)!;assert.equal(store.readArtifact(artifact.id),child.result);assert.ok(child.result!.length>8000);}
  } finally {await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});


test('dozens of child reports keep every reference within the shared preview budget', () => {
  const state=emptyState(),ids=Array.from({length:50},(_,i)=>'child-'+i);
  for(const id of ids){
    state.tasks[id]={id,rootId:'root',parentTaskId:'root',sessionId:id,agentId:'researcher',objective:id,depth:1,dependsOn:[],status:'completed',runIds:[id],createdAt:'',result:'Long report '.repeat(2000)};
    state.artifacts[id]={id,taskId:id,runId:id,path:id,mediaType:'text/markdown'};
  }
  const results=taskResults(state,ids);
  assert.equal(results.length,50);
  assert.ok(results.reduce((n,item)=>n+(item.result?.length??0),0)<=8000);
  assert.ok(JSON.stringify(results).length<24000);
  for(const result of results){assert.equal(result.resultArtifactId,result.taskId);assert.equal(result.truncated,true);}
});
