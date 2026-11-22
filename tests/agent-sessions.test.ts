import { sessionHistory } from '../src/core/agents/context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/storage/store.js';
import { OrchestratorService } from '../src/core/runtime.js';
import { startServer } from '../src/transport/server.js';
import { OrchestratorClient } from '../src/transport/client.js';
import type { Message, ModelProvider, ModelChunk } from '../src/core/domain.js';

const tool = (id:string,name:string,args:unknown):ModelChunk => ({type:'tool',call:{id,name,arguments:JSON.stringify(args)}});
const simple:ModelProvider={async *stream(){yield {type:'text',text:'Saved findings'};}};
async function fixture(provider:ModelProvider=simple) {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-agent-session-')),store=new StateStore(join(dir,'data'));
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir,concurrency:1});
  return {dir,store,runtime,async close(){await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}};
}

test('idle agent and queued instructions survive restart, then follow-up retains only its own context',async()=>{
  const requests:Message[][]=[];
  const provider:ModelProvider={async *stream(messages){requests.push(structuredClone(messages));yield {type:'text',text:'Saved findings'};}};
  const f=await fixture(provider);let reopened:StateStore|undefined, resumed:OrchestratorService|undefined;
  try{
    const parent=f.runtime.submit({objective:'Private parent objective',delegations:[{agentId:'researcher',objective:'Inspect module'}]});
    await f.runtime.waitUntilDone(parent.id);
    const agent=f.runtime.listAgentSessions(parent.sessionId)[0]!;
    assert.equal(agent.status,'idle');assert.equal(agent.taskStatus,'completed');
    const count=requests.length;await delay(40);assert.equal(requests.length,count);
    const message=f.runtime.sendAgentMessage(agent.sessionId,'Check the edge case',undefined,'stable-message');
    assert.deepEqual(f.runtime.sendAgentMessage(agent.sessionId,'Check the edge case',undefined,'stable-message'),message);
    assert.equal(f.runtime.listAgentSessions()[0]!.pendingMessages,1);assert.equal(requests.length,count);
    await f.runtime.close();f.store.close();
    reopened=new StateStore(join(f.dir,'data'));resumed=new OrchestratorService(reopened,provider,{workspaceDir:f.dir,concurrency:1});
    assert.equal(resumed.listAgentSessions()[0]!.status,'idle');assert.equal(resumed.listAgentSessions()[0]!.pendingMessages,1);
    const next=resumed.followup({sessionId:agent.sessionId,objective:'Verify the findings'});
    assert.notEqual(next.id,agent.taskId);assert.equal(next.sessionId,agent.sessionId);assert.equal(next.agentId,'researcher');
    const done=await resumed.waitUntilDone(next.id);assert.equal(done.status,'completed',done.error);
    const messages=requests.at(-1)!;
    assert.ok(messages.some(m=>m.content==='Inspect module'));assert.ok(messages.some(m=>m.content==='Saved findings'));
    assert.ok(messages.some(m=>m.content.includes('Check the edge case')));assert.ok(!messages.some(m=>m.content==='Private parent objective'));
    assert.equal(resumed.listAgentSessions()[0]!.pendingMessages,0);assert.equal(resumed.listAgentSessions()[0]!.status,'idle');
    resumed.closeAgent(agent.sessionId);
    assert.equal(resumed.listAgentSessions()[0]!.status,'closed');assert.throws(()=>resumed!.followup({sessionId:agent.sessionId,objective:'again'}),/closed/);
    assert.throws(()=>resumed!.sendAgentMessage(agent.sessionId,'new'),/closed/);
    assert.equal(reopened.snapshot().state.sessions[agent.sessionId]!.parentSessionId,parent.sessionId);
  }finally{await resumed?.close();reopened?.close();await f.close();}
});

test('main agent discovers and reuses the same child through model tools, with no wait-slot deadlock',async()=>{
  let sessionId='',childTasks=0;
  const provider:ModelProvider={async *stream(messages,tools){
    if(messages[0]!.content.includes('[researcher]')){childTasks++;yield {type:'text',text:'Worker result '+childTasks};return;}
    assert.ok(tools.some(t=>t.name==='followup_task'));
    const calls=messages.flatMap(m=>m.toolCalls??[]),results=messages.filter(m=>m.role==='tool');
    if(!calls.length){yield tool('spawn','delegate_task',{agentId:'researcher',objective:'First job'});return;}
    const spawned=JSON.parse(results.find(m=>m.toolCallId==='spawn')!.content);sessionId=spawned.sessionId;
    if(!calls.some(c=>c.id==='wait-first')){yield tool('wait-first','wait_tasks',{taskIds:[spawned.taskId]});return;}
    if(!calls.some(c=>c.id==='list')){yield tool('list','list_agents',{});return;}
    const agents=JSON.parse(results.find(m=>m.toolCallId==='list')!.content);assert.equal(agents[0].status,'idle');
    if(!calls.some(c=>c.id==='next')){yield tool('next','followup_task',{sessionId,objective:'Second job'});return;}
    const next=JSON.parse(results.find(m=>m.toolCallId==='next')!.content);assert.equal(next.sessionId,sessionId);
    if(!calls.some(c=>c.id==='wait-next')){yield tool('wait-next','wait_tasks',{taskIds:[next.taskId]});return;}
    yield {type:'text',text:'Combined result'};
  }};
  const f=await fixture(provider);
  try{const root=f.runtime.submit({objective:'Coordinate two jobs'});const done=await f.runtime.waitUntilDone(root.id);assert.equal(done.status,'completed',done.error);assert.equal(childTasks,2);
    assert.equal(f.runtime.listAgentSessions().length,1);assert.equal(f.runtime.listAgentSessions()[0]!.status,'idle');
    assert.equal(Object.values(f.store.snapshot().state.tasks).filter(t=>t.sessionId===sessionId).length,2);
  }finally{await f.close();}
});

test('API follows up idle agents, queues messages, closes active work and preserves role restrictions',async()=>{
  const f=await fixture({async *stream(){await delay(40);yield {type:'text',text:'Saved findings'};}}),server=await startServer(f.runtime,{port:0}),client=new OrchestratorClient(server.url);
  try{
    const root=f.runtime.submit({objective:'Owner',delegations:[{agentId:'researcher',objective:'Read only'}]});await f.runtime.waitUntilDone(root.id);
    const agent=(await client.agentSessions(root.sessionId))[0]!;
    await client.agentMessage(agent.sessionId,'Next instructions');
    const next=await client.followup({sessionId:agent.sessionId,objective:'Continue'});
    assert.equal(next.agentId,'researcher');assert.ok(!f.store.snapshot().state.runs[next.runIds[0]!]!.config.allowedTools.includes('write_file'));
    assert.throws(()=>f.runtime.followup({sessionId:agent.sessionId,objective:'Concurrent'}),/busy/);
    await f.runtime.waitUntilDone(next.id);
    assert.throws(()=>f.runtime.submit({sessionId:agent.sessionId,agentId:'assistant',objective:'Change role'}),/role/);
    const foreign=f.runtime.submit({objective:'Another owner'});f.runtime.pause(foreign.id,true);
    assert.throws(()=>f.runtime.followup({sessionId:agent.sessionId,objective:'Foreign'},foreign.runIds[0]),/parent session/);
    assert.throws(()=>f.runtime.sendAgentMessage(agent.sessionId,'Foreign',foreign.id),/parent session/);
    const pending=await client.followup({sessionId:agent.sessionId,objective:'Interrupt before dispatch'});
    assert.throws(()=>f.runtime.interruptAgent(pending.id,foreign.id),/parent session/);
    f.runtime.interruptAgent(pending.id,root.id);
    assert.equal((await f.runtime.waitUntilDone(pending.id)).status,'cancelled');
    assert.equal((await client.agentSessions(root.sessionId))[0]!.status,'idle');
    const paused=await client.followup({sessionId:agent.sessionId,objective:'Close before dispatch'});f.runtime.pause(paused.rootId,true);
    await client.closeAgent(agent.sessionId);
    assert.equal((await f.runtime.waitUntilDone(paused.id)).status,'cancelled');
    assert.equal((await client.agentSessions(root.sessionId))[0]!.status,'closed');
    await assert.rejects(client.followup({sessionId:agent.sessionId,objective:'Closed'}),/closed/);
    assert.throws(()=>f.runtime.retry(paused.id),/closed/);
  }finally{await server.close();await f.close();}
});


test('a session message arriving during final output schedules another step before completion',async()=>{
  let release!:()=>void,entered!:()=>void,count=0;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const provider:ModelProvider={async *stream(messages){
    if(messages[0]!.content.includes('[researcher]')){count++;if(count===1){entered();await gate;}else assert.ok(messages.some(m=>m.source==='agent_message'&&m.content.includes('Late instruction')));}
    yield {type:'text',text:'Handled'};
  }};
  const f=await fixture(provider);
  try{const root=f.runtime.submit({objective:'Main',delegations:[{agentId:'researcher',objective:'Worker'}]});await ready;
    const session=f.runtime.listAgentSessions()[0]!;f.runtime.sendAgentMessage(session.sessionId,'Late instruction');release();
    assert.equal((await f.runtime.waitUntilDone(root.id)).status,'completed');assert.equal(count,2);assert.equal(f.runtime.listAgentSessions()[0]!.pendingMessages,0);
  }finally{release?.();await f.close();}
});

test('cancelled tool exchanges are excluded from the next task context',async()=>{
  const f=await fixture();try{
    const root=f.runtime.submit({objective:'Main',delegations:[{agentId:'researcher',objective:'Worker'}]});await f.runtime.waitUntilDone(root.id);
    const agent=f.runtime.listAgentSessions()[0]!;
    f.store.change('test.cancelled',{},state=>{const task=state.tasks[agent.taskId]!,run=state.runs[task.runIds[0]!]!;task.status='cancelled';run.status='cancelled';run.messages.push({role:'assistant',content:'Inspecting',toolCalls:[{id:'unfinished',name:'read_file',arguments:'{}'}]});});
    const history=sessionHistory(f.store.snapshot().state,agent.sessionId,'new');
    assert.ok(history.some(m=>m.content==='Worker'));assert.ok(!history.some(m=>m.toolCalls?.some(c=>c.id==='unfinished')));
  }finally{await f.close();}
});


test('a later parent turn reuses its idle child under the new task budget',async()=>{
  const f=await fixture();try{
    const root=f.runtime.submit({objective:'First parent turn',delegations:[{agentId:'researcher',objective:'Research'},{agentId:'reviewer',objective:'Review'}]});await f.runtime.waitUntilDone(root.id);
    const agents=f.runtime.listAgentSessions(root.sessionId);
    const nextParent=f.runtime.submit({sessionId:root.sessionId,objective:'Second parent turn'});f.runtime.pause(nextParent.id,true);
    f.store.change('test.budget',{},state=>{state.budgets[nextParent.id]!.maxTasks=2;});
    const child=f.runtime.followup({sessionId:agents[0]!.sessionId,objective:'Continue research'},nextParent.runIds[0],'followup-call');
    assert.equal(child.rootId,nextParent.id);assert.equal(child.parentTaskId,nextParent.id);
    assert.equal(f.runtime.followup({sessionId:agents[0]!.sessionId,objective:'Continue research'},nextParent.runIds[0],'followup-call').id,child.id);
    assert.throws(()=>f.runtime.followup({sessionId:agents[1]!.sessionId,objective:'Continue review'},nextParent.runIds[0],'second-call'),/budget/);
    f.runtime.pause(nextParent.id,false);assert.equal((await f.runtime.waitUntilDone(nextParent.id)).status,'completed');
    assert.equal(f.runtime.listAgentSessions(root.sessionId).length,2);
  }finally{await f.close();}
});

test('closing a session closes descendant sessions and cancels their queued work',async()=>{
  const f=await fixture();try{
    const root=f.runtime.submit({objective:'Parent'});f.runtime.pause(root.id,true);
    const child=f.runtime.delegate(root.runIds[0]!,{agentId:'coordinator',objective:'Child'});
    const grandchild=f.runtime.delegate(child.runIds[0]!,{agentId:'researcher',objective:'Grandchild'});
    f.runtime.closeAgent(child.sessionId,root.id);
    const state=f.store.snapshot().state;
    assert.ok(state.sessions[child.sessionId]!.closedAt);assert.ok(state.sessions[grandchild.sessionId]!.closedAt);
    assert.equal(state.tasks[child.id]!.status,'cancelled');assert.equal(state.tasks[grandchild.id]!.status,'cancelled');
    assert.ok(!state.sessions[root.sessionId]!.closedAt);
    assert.throws(()=>f.runtime.delegate(child.runIds[0]!,{agentId:'researcher',objective:'Late child'}),/not active|closed/);
  }finally{await f.close();}
});
