import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry } from '../src/models/registry.js';
import { configuredModels } from '../src/models/configured.js';
import { loadConfig } from '../src/core/config.js';
import { OrchestratorService } from '../src/core/runtime.js';
import { StateStore } from '../src/storage/store.js';
import { startServer } from '../src/transport/server.js';
import { OrchestratorClient } from '../src/transport/client.js';
import type { ModelProvider } from '../src/core/domain.js';

test('model selection pins running and queued tasks, child models, and later turns', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a: ModelProvider = { async *stream(messages) { if (messages.some(item => item.content === 'wait')) await gate; yield {type:'text',text:'model-a'}; } };
  const b: ModelProvider = { async *stream() { yield {type:'text',text:'model-b'}; } };
  const catalog = new ModelRegistry([{description:{id:'a',name:'A',model:'a',provider:'test'},create:()=>a},{description:{id:'b',name:'B',model:'b',provider:'test'},create:()=>b}], 'a');
  const store = new StateStore(':memory:');
  const runtime = new OrchestratorService(store,a,{workspaceDir:process.cwd(),modelRegistry:catalog});
  try {
    const task = runtime.submit({objective:'wait'});
    runtime.setModel('b');
    const other = runtime.submit({objective:'other'});
    assert.equal((await runtime.waitUntilDone(other.id)).result, 'model-b');
    release(); assert.equal((await runtime.waitUntilDone(task.id)).result, 'model-a');
    const next = runtime.submit({objective:'next',sessionId:task.sessionId});
    assert.equal((await runtime.waitUntilDone(next.id)).result, 'model-b');
    runtime.setModel('a');
    const team = runtime.submit({objective:'team',delegations:[{agentId:'reviewer',objective:'child'}]});
    runtime.setModel('b');
    assert.equal((await runtime.waitUntilDone(team.id)).result, 'model-a');
    const snapshot=store.snapshot();
    const child=Object.values(snapshot.state.tasks).find(item=>item.parentTaskId===team.id)!;
    assert.equal(snapshot.state.runs[child.runIds[0]!]!.model?.id,'a');
    assert.throws(()=>runtime.setModel('missing'),/Unknown model/);
    assert.equal(runtime.info().modelId,'b');
  } finally { release();await runtime.close();store.close(); }
});

test('custom URL and key persist separately and never enter metadata or journal', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-models-'));const home=join(dir,'data');
  const config=loadConfig(dir,{ORCHESTRATOR_DATA_DIR:home});
  const models=configuredModels(config,{}), store=new StateStore(home);
  const runtime=new OrchestratorService(store,models.resolve(),{workspaceDir:dir,modelRegistry:models});
  const server=await startServer(runtime,{port:0});const client=new OrchestratorClient(server.url);
  try {
    const profile=await client.addModel({name:'My endpoint',baseUrl:'https://models.example.test/v1',model:'custom-model',apiKey:'private-test-key'});
    assert.equal(profile.model,'custom-model');
    await client.setModel(profile.id);
    assert.equal((await client.info()).modelId,profile.id);
    const global=await readFile(join(home,'settings.json'),'utf8'), credentials=await readFile(join(home,'credentials.json'),'utf8');
    assert.ok(!global.includes('private-test-key'));assert.ok(credentials.includes('private-test-key'));
    assert.ok(!JSON.stringify(await client.models()).includes('private-test-key'));
    assert.ok(!JSON.stringify(store.events()).includes('private-test-key'));
    for(const file of await readdir(join(home,'sessions','_system'))) assert.ok(!(await readFile(join(home,'sessions','_system',file),'utf8')).includes('private-test-key'));
    const restored=configuredModels(loadConfig(dir,{ORCHESTRATOR_DATA_DIR:home}),{});
    assert.equal(restored.selectedId,profile.id);assert.doesNotThrow(()=>restored.resolve());
    await assert.rejects(client.addModel({baseUrl:'file:///tmp/models',model:'x',apiKey:'secret'}));
    await assert.rejects(client.setModel('unknown'));
    assert.equal((await client.info()).modelId,profile.id);
  } finally { await server.close();await runtime.close();store.close();await rm(dir,{recursive:true,force:true}); }
});

test('project profile selection stays project-scoped and credential environment names work', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-profile-'));const home=join(dir,'data');
  try {
    await mkdir(join(dir,'.orchestrator'));
    await writeFile(join(dir,'.orchestrator','settings.json'),JSON.stringify({models:{local:{provider:'compatible',baseUrl:'http://localhost:9999/v1',model:'local',apiKeyEnv:'LOCAL_KEY'}}}));
    const env={ORCHESTRATOR_DATA_DIR:home,LOCAL_KEY:'test-local-key'};
    const catalog=configuredModels(loadConfig(dir,env),env);catalog.select('local');
    assert.equal(JSON.parse(await readFile(join(dir,'.orchestrator','settings.json'),'utf8')).activeModel,'local');
    assert.equal(JSON.parse(await readFile(join(home,'settings.json'),'utf8')).activeModel,'default');
    assert.throws(()=>configuredModels(loadConfig(dir,env),{}).resolve(),/environment variable/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
