import { legacyAgentPrompts } from '../src/core/agents/definitions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { createTools, ToolRegistry, type ToolContext } from '../src/tools/index.js';
import { OrchestratorService, defaultAgents } from '../src/core/runtime.js';
import { StateStore } from '../src/storage/store.js';
import { startServer } from '../src/transport/server.js';
import { OrchestratorClient } from '../src/transport/client.js';
import { loadConfig } from '../src/core/config.js';
import { atomicJSON } from '../src/storage/files.js';
import type { ModelProvider, ToolCall } from '../src/core/domain.js';

async function until(check: () => boolean) { for (let i=0;i<300;i++) { if(check()) return; await pause(10); } throw Error('Timed out'); }
function toolContext(workspace: string): ToolContext { return { workspace, signal: new AbortController().signal, delegate: () => { throw Error('Unexpected delegation'); }, wait: async () => [] }; }

test('glob, recursive listing and grep respect exclusions, context, limits and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-files-')); const tools = createTools(); const ctx=toolContext(dir);
  const call = async (name: string, args: unknown) => { const tool=tools.resolve(name); return await tool.execute(tool.schema.parse(args),ctx) as any; };
  try {
    for (const path of ['src/nested','node_modules','src/node_modules','.git','outside']) await mkdir(join(dir,path),{recursive:true});
    await writeFile(join(dir,'src/a.ts'),'before\nHello world\nafter\n'); await writeFile(join(dir,'src/nested/b.ts'),'HELLO\n');
    for (const path of ['node_modules/x.ts','src/node_modules/x.ts','.git/x.ts']) await writeFile(join(dir,path),'Hello ignored');
    await writeFile(join(dir,'outside/secret.ts'),'secret');
    await symlink(join(dir,'outside'),join(dir,'linked'),process.platform==='win32'?'junction':'dir');
    assert.deepEqual((await call('glob',{pattern:'src/**/*.ts'})).files,['src/a.ts','src/nested/b.ts']);
    assert.ok(!(await call('list_files',{depth:5})).files.some((p:string)=>p.includes('node_modules')||p.startsWith('linked')));
    assert.ok(!(await call('list_files',{})).files.includes('src/a.ts'));
    assert.ok((await call('list_files',{depth:2})).files.includes('src/a.ts'));
    assert.equal((await call('glob',{pattern:'**/*.ts',limit:1})).truncated,true);
    const found=await call('grep',{pattern:'hello',ignoreCase:true,glob:'**/*.ts',context:1});
    assert.ok(found.matches.some((m:any)=>m.path==='src/a.ts'&&m.line===2&&m.text==='Hello world'),JSON.stringify(found));
    assert.ok(found.matches.some((m:any)=>m.context)); assert.ok(!found.matches.some((m:any)=>m.path.includes('node_modules')));
    assert.equal((await call('grep',{pattern:'never-present'})).matches.length,0);
    await assert.rejects(call('grep',{pattern:'['}),/Search failed/);
    await assert.rejects(call('read_file',{path:'linked/secret.ts'}),/Symlinks/);
    await assert.rejects(call('glob',{pattern:'**/*',path:'..'}),/escapes/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('paged reads exceed the old file cap and exact edits validate before any write', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-edit-')); const tools=createTools(); const ctx=toolContext(dir);
  const call=async(name:string,args:unknown)=>{const t=tools.resolve(name);return await t.execute(t.schema.parse(args),ctx) as any;};
  try {
    const body=Array.from({length:3000},(_,i)=>'line '+(i+1)+' '+'.'.repeat(60)).join('\n'); await writeFile(join(dir,'large.txt'),body);
    const page=await call('read_file',{path:'large.txt',offset:2000,limit:2});
    assert.equal(page.totalLines,3000); assert.equal(page.lines[0].line,2000); assert.equal(page.nextOffset,2002);
    await call('apply_patch',{path:'large.txt',edits:[{oldText:'line 2000 ',newText:'changed 2000 '}]});
    assert.match(await readFile(join(dir,'large.txt'),'utf8'),/changed 2000/);
    const before=await readFile(join(dir,'large.txt'),'utf8');
    await assert.rejects(call('apply_patch',{path:'large.txt',edits:[{oldText:'changed 2000 ',newText:'lost '},{oldText:'missing',newText:'x'}]}),/exactly once/);
    assert.equal(await readFile(join(dir,'large.txt'),'utf8'),before);
    await writeFile(join(dir,'windows.txt'),'one\r\ntwo\r\n');
    await call('apply_patch',{path:'windows.txt',edits:[{oldText:'one\ntwo',newText:'first\nsecond'}]});
    assert.equal(await readFile(join(dir,'windows.txt'),'utf8'),'first\r\nsecond\r\n');
    await assert.rejects(call('apply_patch',{path:'../escape.txt',edits:[{oldText:'a',newText:'b'}]}),/escapes/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('parallel reads overlap within limits; write barriers and message ordering are preserved', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-parallel-')); const store=new StateStore(':memory:'); const tools=new ToolRegistry();
  let active=0,max=0,written=false; const order:string[]=[];
  tools.register({name:'read',description:'Read',schema:z.object({id:z.string()}),approval:false,readOnly:true,parallelSafe:true,
    async execute(args) { const id=(args as {id:string}).id; if(id==='c')assert.equal(written,true); active++;max=Math.max(max,active); await pause(id==='a'?40:15);active--;order.push(id);if(id==='b')throw Error('Read failed');return id; }});
  tools.register({name:'write',description:'Write',schema:z.object({}),approval:false,async execute(){assert.equal(active,0);written=true;order.push('write');return 'written';}});
  const calls:ToolCall[]=[{id:'a',name:'read',arguments:'{"id":"a"}'},{id:'b',name:'read',arguments:'{"id":"b"}'},{id:'w',name:'write',arguments:'{}'},{id:'c',name:'read',arguments:'{"id":"c"}'}];
  const provider:ModelProvider={async *stream(messages){if(messages.some(m=>m.role==='tool'))yield {type:'text',text:'done'};else for(const call of calls)yield {type:'tool',call};}};
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir,tools,concurrency:2,agents:[{id:'assistant',name:'Test',systemPrompt:'',allowedTools:['read','write']}]});
  try {const task=runtime.submit({objective:'test'}); assert.equal((await runtime.waitUntilDone(task.id)).status,'completed');assert.equal(max,2);assert.ok(order.indexOf('write')>order.indexOf('a'));assert.ok(order.indexOf('c')>order.indexOf('write'));
    assert.deepEqual(store.snapshot().state.runs[task.runIds[0]!]!.messages.filter(m=>m.role==='tool').map(m=>m.toolCallId),['a','b','w','c']);
  } finally {await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('ask_user waits even in allow-all mode, leaves slots free, persists answers and updates plans', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-question-')); const store=new StateStore(join(dir,'data'));
  const provider:ModelProvider={async *stream(messages){
    if(messages.some(m=>m.role==='tool')||messages.at(-1)?.content==='background')yield {type:'text',text:'done'};
    else {yield {type:'tool',call:{id:'ask',name:'ask_user',arguments:'{"question":"Choose a format","options":["JSON","Text"]}'}};yield {type:'tool',call:{id:'plan',name:'todo_write',arguments:'{"items":[{"text":"Export","status":"completed"}]}'}};}
  }};
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir,approvalMode:'all',concurrency:1});const server=await startServer(runtime,{port:0});const client=new OrchestratorClient(server.url);
  try {
    const task=runtime.submit({objective:'export'});await until(()=>Object.values(store.snapshot().state.questions).some(q=>q.status==='pending'));
    const q=Object.values(store.snapshot().state.questions)[0]!;assert.equal(store.snapshot().state.tasks[task.id]!.status,'waiting_user');
    assert.equal((await runtime.waitUntilDone(runtime.submit({objective:'background'}).id)).status,'completed');
    await assert.rejects(client.answer(q.id,' '));await client.answer(q.id,'CSV');await runtime.waitUntilDone(task.id);
    assert.equal(store.snapshot().state.questions[q.id]!.answer,'CSV');assert.deepEqual(store.snapshot().state.tasks[task.id]!.todos,[{text:'Export',status:'completed'}]);
    await assert.rejects(client.answer(q.id,'again'),/not pending/);
    const snapshot=store.snapshot();await runtime.close();store.close();const restored=new StateStore(join(dir,'data'));try {assert.deepEqual(restored.snapshot(),snapshot);} finally {restored.close();}
  } finally {await server.close();await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('restart preserves checkpointed questions while cancellation invalidates them', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-cancel-question-'));const store=new StateStore(':memory:');
  const provider:ModelProvider={async *stream(){yield {type:'tool',call:{id:'ask',name:'ask_user',arguments:'{"question":"Continue?"}'}};}};
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir});
  try {
    const task=runtime.submit({objective:'question'});await until(()=>Object.keys(store.snapshot().state.questions).length>0);const id=Object.keys(store.snapshot().state.questions)[0]!;
    const crash=new StateStore(':memory:');crash.change('seed',{},s=>Object.assign(s,store.snapshot().state));const recovered=new OrchestratorService(crash,provider,{workspaceDir:dir});
    try { assert.equal(crash.snapshot().state.questions[id]!.status,'pending'); } finally { await recovered.close();crash.close(); }
    runtime.cancel(task.id);assert.equal((await runtime.waitUntilDone(task.id)).status,'cancelled');assert.equal(store.snapshot().state.questions[id]!.status,'cancelled');assert.throws(()=>runtime.answerQuestion(id,'yes'),/not pending/);
  } finally {await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('long command output is retained as an artifact and can be read back', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-output-'));const store=new StateStore(join(dir,'data'));let artifactId='';
  const provider:ModelProvider={async *stream(messages){const results=messages.filter(m=>m.role==='tool');
    if (messages.some(m=>m.role==='user'&&m.content==='foreign')) {
      if (!results.length) yield {type:'tool',call:{id:'foreign',name:'read_artifact',arguments:JSON.stringify({artifactId})}};
      else { assert.match(results[0]!.content,/outside this session/); yield {type:'text',text:'blocked'}; }
      return;
    }
    if(!results.length)yield {type:'tool',call:{id:'cmd',name:'run_command',arguments:JSON.stringify({command:`node -e "process.stdout.write('A'.repeat(40000)+'TAIL')"`})}};
    else if(results.length===1){const result=JSON.parse(results[0]!.content);artifactId=result.artifactId;assert.ok(artifactId);yield {type:'tool',call:{id:'read',name:'read_artifact',arguments:JSON.stringify({artifactId,offset:39000,limit:12000})}};}
    else {assert.match(results[1]!.content,/TAIL/);yield {type:'text',text:'done'};}
  }};
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir,approvalMode:'all'});
  try {assert.equal((await runtime.waitUntilDone(runtime.submit({objective:'output'}).id)).status,'completed');assert.ok(store.readArtifact(artifactId).includes('A'.repeat(40000)+'TAIL'));
    assert.ok(!JSON.stringify(store.events()).includes('A'.repeat(30000)));
    assert.equal((await runtime.waitUntilDone(runtime.submit({objective:'foreign'}).id)).result,'blocked');
  } finally {await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('pristine built-in role files upgrade while customized allowlists stay unchanged', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-role-upgrade-'));const home=join(dir,'data');
  try {loadConfig(dir,{ORCHESTRATOR_DATA_DIR:home});const assistant=defaultAgents.find(a=>a.id==='assistant')!;
    atomicJSON(join(home,'agents/assistant.json'),{...assistant,systemPrompt:legacyAgentPrompts.assistant!,allowedTools:['list_files','read_file','write_file','run_command','delegate_task','wait_tasks']});
    atomicJSON(join(home,'agents/reviewer.json'),{...defaultAgents.find(a=>a.id==='reviewer')!,systemPrompt:'Custom',allowedTools:['read_file']});
    atomicJSON(join(home,'agents/coordinator.json'),{...defaultAgents.find(a=>a.id==='coordinator')!,systemPrompt:legacyAgentPrompts.coordinator!,allowedTools:['read_file']});
    const paths = ['assistant','researcher','coordinator','reviewer'].map(id => join(home,'agents',id+'.json'));
    const timestamp = new Date('2024-01-01T00:00:00Z');
    for (const path of paths) await utimes(path, timestamp, timestamp);
    const config=loadConfig(dir,{ORCHESTRATOR_DATA_DIR:home});assert.equal(config.agents.find(a=>a.id==='coordinator')!.systemPrompt,legacyAgentPrompts.coordinator);assert.deepEqual(config.agents.find(a=>a.id==='coordinator')!.allowedTools,['read_file']);assert.ok(config.agents.find(a=>a.id==='assistant')!.allowedTools.includes('ask_user'));assert.equal(config.agents.find(a=>a.id==='assistant')!.systemPrompt,assistant.systemPrompt);assert.deepEqual(config.agents.find(a=>a.id==='reviewer')!.allowedTools,['read_file']);
    for (const path of paths) assert.equal((await stat(path)).mtimeMs,timestamp.getTime());
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('run deadlines cancel pending questions instead of leaving stale prompts', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-question-timeout-'));const store=new StateStore(':memory:');
  const provider:ModelProvider={async *stream(){yield {type:'tool',call:{id:'ask',name:'ask_user',arguments:'{"question":"Wait?"}'}};}};
  const runtime=new OrchestratorService(store,provider,{workspaceDir:dir,runTimeoutMs:150});
  try {const task=runtime.submit({objective:'wait'});const done=await runtime.waitUntilDone(task.id);assert.equal(done.status,'failed');assert.match(done.error!,/deadline/);assert.equal(Object.values(store.snapshot().state.questions)[0]!.status,'cancelled');}
  finally {await runtime.close();store.close();await rm(dir,{recursive:true,force:true});}
});
