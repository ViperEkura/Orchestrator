import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {StateStore} from '../src/storage/store.js';
import {OrchestratorService} from '../src/core/runtime.js';
import {createTools} from '../src/tools/index.js';
import {Scheduler} from '../src/core/execution/scheduler.js';
import {z} from 'zod';
import type {ModelProvider,Task,State} from '../src/core/domain.js';
import {startServer} from '../src/transport/server.js';
import {OrchestratorClient} from '../src/transport/client.js';
import {ModelGateway} from '../src/models/gateway.js';

async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error('Condition timeout');await delay(10);}}
async function fixture(provider:ModelProvider,options:Partial<ConstructorParameters<typeof OrchestratorService>[2]>={},persistent=false) {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-swarm-')),store=new StateStore(persistent?join(dir,'data'):':memory:');
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir,...options});
  return {dir,store,runtime,async close(){await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
const simple:ModelProvider={async *stream(){yield {type:'text',text:'done'};}};

test('50 delegated tasks complete with bounded execution and ordered dependencies',async()=>{
  let active=0,peak=0;
  const provider:ModelProvider={async *stream(_messages,_tools,signal){active++;peak=Math.max(peak,active);try{await delay(8,undefined,{signal});yield {type:'text',text:'done'};}finally{active--;}}};
  const f=await fixture(provider,{concurrency:8,maxActiveRuns:8,maxTasks:64,maxSteps:100},true);
  try{
    const root=f.runtime.submit({objective:'fifty tasks',delegations:Array.from({length:50},(_,i)=>({agentId:'researcher',objective:'Task '+i,...(i%5?{after:[i-1]}:{})}))});
    assert.equal((await f.runtime.waitUntilDone(root.id,30000)).status,'completed');
    const state=f.store.snapshot().state,children=Object.values(state.tasks).filter(task=>task.parentTaskId===root.id);
    assert.equal(children.length,50);assert.ok(children.every(task=>task.status==='completed'));assert.ok(peak>1&&peak<=8);
    const events=f.store.events(0,10000);
    for(const task of children)for(const dependency of task.dependsOn)assert.ok(events.find(e=>e.type==='run.completed'&&e.taskId===dependency)!.seq<events.find(e=>e.type==='run.started'&&e.taskId===task.id)!.seq);
    await f.runtime.close();const snapshot=f.store.snapshot();f.store.close();const reopened=new StateStore(join(f.dir,'data'));try{assert.deepEqual(reopened.snapshot(),snapshot);}finally{reopened.close();}
  }finally{await f.close();}
});

test('dispatch pause, DAG validation, messages and result review work through the API',async()=>{
  const received:string[]=[];
  const f=await fixture({async *stream(messages){received.push(...messages.map(message=>message.content));yield {type:'text',text:'evidence'};}});
  const server=await startServer(f.runtime,{port:0}),client=new OrchestratorClient(server.url);
  try{
    const root=f.runtime.submit({objective:'plan'});f.runtime.pause(root.id,true);
    const first=f.runtime.delegate(root.runIds[0]!,{agentId:'researcher',objective:'first',reviewRequired:true,acceptanceCriteria:['Evidence is present']});
    const second=f.runtime.delegate(root.runIds[0]!,{agentId:'reviewer',objective:'second'});
    await client.dependencies(second.id,[first.id],10);
    await assert.rejects(client.dependencies(first.id,[second.id]),/cycle/);
    await assert.rejects(client.dependencies(first.id,[root.id]),/ancestor/);
    const id=crypto.randomUUID();await client.message(first.id,'Use the revised contract',id);await client.message(first.id,'Use the revised contract',id);
    assert.equal(f.store.select(s=>s.runs[first.runIds[0]!]!.inbox!.length),1);
    await delay(30);assert.ok(f.store.select(s=>Object.values(s.tasks).every(task=>task.status==='queued')));
    await client.pause(root.id,false);await until(()=>f.store.select(s=>s.tasks[first.id]!.status==='waiting_review'));
    assert.equal(f.store.select(s=>s.tasks[second.id]!.status),'queued');
    assert.ok(received.some(text=>text.includes('revised contract')));
    await client.review(first.id,'accepted','Checked the evidence and acceptance criterion');
    assert.equal((await f.runtime.waitUntilDone(root.id)).status,'completed');
  }finally{await server.close();await f.close();}
});

async function seededCheckpoint(phase:'model'|'tools',operations:Record<string,{status:'running'|'completed';name:string;readOnly:boolean;content?:string}>={}) {
  const f=await fixture(simple);const task=f.runtime.submit({objective:'recover'});f.runtime.pause(task.id,true);
  const state=f.store.snapshot().state,run=state.runs[task.runIds[0]!]!;state.tasks[task.id]!.paused=false;state.tasks[task.id]!.status='running';run.status='running';run.checkpoint={phase,initialized:true};run.operations=operations;
  if(phase==='tools')run.messages.push({role:'assistant',content:'',toolCalls:[{id:'effect',name:'effect',arguments:'{}'}]});
  await f.close();return {state,task};
}

test('restart quarantines uncertain writes and verified results resume without replay',async()=>{
  const {state,task}=await seededCheckpoint('tools',{effect:{status:'running',name:'effect',readOnly:false}});
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-recovery-')),path=join(dir,'data');
  for(const session of Object.values(state.sessions))session.cwd=dir;
  let store=new StateStore(path);store.change('seed',{},draft=>Object.assign(draft,state));store.close();store=new StateStore(path);
  let executions=0;const tools=createTools();tools.register({name:'effect',description:'Effect fixture',schema:z.object({}),approval:true,async execute(){executions++;return {ok:true};}});
  state.runs[task.runIds[0]!]!.config.allowedTools.push('effect');
  // Permission list is persisted in the checkpoint, not taken from the live role registry.
  store.change('test.permission',{},draft=>{draft.runs[task.runIds[0]!]!.config.allowedTools.push('effect');});
  const runtime=new OrchestratorService(store,simple,{workspaceDir:dir,tools,approvalMode:'all'});
  try{
    assert.equal(store.select(s=>s.tasks[task.id]!.status),'needs_review');await delay(30);assert.equal(executions,0);
    runtime.resolveOperation(task.id,'effect','Verified file content on disk');
    assert.equal((await runtime.waitUntilDone(task.id)).status,'completed');assert.equal(executions,0);
    assert.ok(store.select(s=>s.runs[task.runIds[0]!]!.messages.some(message=>message.role==='tool'&&message.content.includes('Verified file'))));
  }finally{await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('completed tool receipts survive a crash before the transcript append',async()=>{
  const {state,task}=await seededCheckpoint('tools',{effect:{status:'completed',name:'effect',readOnly:false,content:'{"written":true}'}});
  const f=await fixture(simple);await f.runtime.close();f.store.change('seed',{},draft=>Object.assign(draft,state));
  for(const session of Object.values(state.sessions))session.cwd=f.dir;
  f.store.change('paths',{},draft=>{for(const session of Object.values(draft.sessions))session.cwd=f.dir;});
  const recovered=new OrchestratorService(f.store,simple,{workspaceDir:f.dir});
  try{assert.equal((await recovered.waitUntilDone(task.id)).status,'completed');assert.equal(f.store.select(s=>s.runs[task.runIds[0]!]!.messages.filter(message=>message.toolCallId==='effect').length),1);}
  finally{await recovered.close();await f.close();}
});

test('scheduler alternates roots and respects priority within each root',()=>{
  const make=(id:string,rootId:string,priority:number)=>({id,rootId,priority,status:'queued',dependsOn:[],createdAt:'2026-01-01'} as unknown as Task);
  const tasks=[make('a','a',0),make('a1','a',5),make('b','b',0),make('b1','b',3)];
  const scheduler=new Scheduler();assert.deepEqual(scheduler.select(tasks,new Set()).ready.map(t=>t.id),['a1','b1','a','b']);
  assert.equal(scheduler.select(tasks,new Set()).ready[0]!.rootId,'b');
});

test('scoped storage transactions roll back and never mutate other records',()=>{
  const store=new StateStore(':memory:');store.change('seed',{},s=>{s.budgets.a={stepsUsed:0,maxSteps:4,maxTasks:4,maxDepth:2};s.budgets.b={stepsUsed:0,maxSteps:4,maxTasks:4,maxDepth:2};});
  const before=store.snapshot();assert.throws(()=>store.transaction({budgets:['a']},'invalid',{},s=>{s.budgets.a!.stepsUsed=1;s.budgets.b={stepsUsed:9,maxSteps:4,maxTasks:4,maxDepth:2};}),/scope/);
  assert.deepEqual(store.snapshot(),before);store.transaction({budgets:['a']},'valid',{},s=>{s.budgets.a!.stepsUsed=2;});assert.equal(store.select(s=>s.budgets.b!.stepsUsed),0);store.close();
});

test('per-model concurrency and token budget stop unbounded loops',async()=>{
  let active=0,peak=0;
  const f=await fixture({async *stream(_messages,_tools,signal){active++;peak=Math.max(peak,active);try{await delay(15,undefined,{signal});yield {type:'usage',inputTokens:100,outputTokens:50};yield {type:'tool',call:{id:crypto.randomUUID(),name:'list_files',arguments:'{}'}};}finally{active--;}}},{concurrency:8,modelLimits:{default:{concurrency:2}},maxTokens:1});
  try{const tasks=Array.from({length:8},()=>f.runtime.submit({objective:'bounded'}));await Promise.all(tasks.map(task=>f.runtime.waitUntilDone(task.id)));assert.equal(peak,2);assert.ok(f.store.select(s=>Object.values(s.tasks).every(task=>task.error?.includes('token budget'))));}
  finally{await f.close();}
});

test('model rate waits are abortable and do not consume another profile slot',async()=>{
  const gateway=new ModelGateway({slow:{requestsPerMinute:1}},1),signal=new AbortController().signal;
  (await gateway.acquire('slow',signal))();
  const waiting=gateway.acquire('slow',AbortSignal.timeout(100));
  const rejected=assert.rejects(waiting);
  (await gateway.acquire('other',signal))();await rejected;
  assert.throws(()=>new ModelGateway({bad:{concurrency:0}}),/Invalid/);
});

test('recovered pending approvals keep their ID and do not execute before a decision',async()=>{
  const {state,task}=await seededCheckpoint('tools');
  const run=state.runs[task.runIds[0]!]!;run.config.allowedTools.push('effect');
  state.approvals.saved={id:'saved',taskId:task.id,runId:run.id,toolCallId:'effect',toolName:'effect',arguments:{},status:'pending',createdAt:new Date().toISOString()};
  const f=await fixture(simple);await f.runtime.close();f.store.change('seed',{},draft=>{Object.assign(draft,state);for(const session of Object.values(draft.sessions))session.cwd=f.dir;});
  let effects=0;const tools=createTools();tools.register({name:'effect',description:'effect',schema:z.object({}),approval:true,async execute(){effects++;return {ok:true};}});
  const recovered=new OrchestratorService(f.store,simple,{workspaceDir:f.dir,tools,approvalMode:'all',maxActiveRuns:1});
  try{
    await until(()=>f.store.select(s=>s.tasks[task.id]!.status)==='waiting_approval');assert.equal(effects,0);
    assert.deepEqual(f.store.select(s=>Object.keys(s.approvals)),['saved']);
    assert.equal((await recovered.waitUntilDone(recovered.submit({objective:'unblocked admission'}).id)).status,'completed');
    recovered.resolveApproval('saved','approved');assert.equal((await recovered.waitUntilDone(task.id)).status,'completed');assert.equal(effects,1);
  }finally{await recovered.close();await f.close();}
});

test('stale execution generations cannot commit model output',async()=>{
  let release!:()=>void,entered=false;
  const f=await fixture({async *stream(){entered=true;await new Promise<void>(done=>{release=done;});yield {type:'text',text:'stale output'};}});
  try{
    const task=f.runtime.submit({objective:'fenced'});await until(()=>entered);
    f.store.change('test.new_generation',{},state=>{state.runs[task.runIds[0]!]!.lease!.generation++;});
    release();await delay(30);
    assert.ok(!f.store.select(state=>state.runs[task.runIds[0]!]!.messages.some(message=>message.content==='stale output')));
  }finally{release?.();await f.close();}
});

test('a message arriving during the final model stream is handled before completion',async()=>{
  let entered=false,release!:()=>void,calls=0;
  const f=await fixture({async *stream(messages){calls++;if(calls===1){entered=true;await new Promise<void>(done=>{release=done;});yield {type:'text',text:'initial result'};}else{assert.ok(messages.some(message=>message.content.includes('late correction')));yield {type:'text',text:'corrected result'};}}});
  try{const task=f.runtime.submit({objective:'follow up'});await until(()=>entered);f.runtime.sendMessage(task.id,'late correction');release();assert.equal((await f.runtime.waitUntilDone(task.id)).result,'corrected result');assert.equal(calls,2);}
  finally{release?.();await f.close();}
});
