import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StateStore} from '../src/storage/store.js';
import {OrchestratorService} from '../src/core/runtime.js';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();

test('integration tests isolated worktrees, rejects stale targets, and applies only verified commits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orchestrator-integration-'));git(dir,'init','-q');git(dir,'config','user.email','tests@example.invalid');git(dir,'config','user.name','Integration Test');
  await writeFile(join(dir,'base.txt'),'base');git(dir,'add','base.txt');git(dir,'commit','-qm','base');
  const store=new StateStore(join(dir,'.orchestrator'));
  // Keep runtime data out of Git status checks without changing user repositories.
  await writeFile(join(dir,'.git','info','exclude'),'.orchestrator/\n');
  const runtime=new OrchestratorService(store,{async *stream(){yield {type:'text',text:'done'};}},{workspaceDir:dir});
  try{
    const parent=runtime.submit({objective:'integrate'});runtime.pause(parent.id,true);
    const child=runtime.delegate(parent.runIds[0]!,{agentId:'researcher',objective:'change',workspace:'worktree',reviewRequired:true});
    runtime.pause(parent.id,false);
    const deadline=Date.now()+10000;
    while(store.select(state=>state.tasks[child.id]!.status)!=='waiting_review'){assert.ok(Date.now()<deadline,JSON.stringify(store.select(state=>state.tasks[child.id])));await new Promise(resolve=>setTimeout(resolve,10));}
    const workspace=store.select(state=>state.sessions[child.sessionId]!.cwd);
    await writeFile(join(workspace,'feature.txt'),'verified');git(workspace,'add','feature.txt');git(workspace,'commit','-qm','feature');
    runtime.reviewTask(child.id,'accepted','Reviewed feature commit');await runtime.waitUntilDone(parent.id);
    const base=git(dir,'rev-parse','HEAD');
    const failed=await runtime.integrations.prepare(child.id,'node -e "process.exit(1)"');assert.equal(failed.status,'failed');await assert.rejects(runtime.integrations.apply(child.id),/No verified/);
    const ready=await runtime.integrations.prepare(child.id,'node -e "process.exit(0)"');assert.equal(ready.status,'ready');assert.equal(git(dir,'rev-parse','HEAD'),base);
    await writeFile(join(dir,'other.txt'),'other');git(dir,'add','other.txt');git(dir,'commit','-qm','other');
    await assert.rejects(runtime.integrations.apply(child.id),/HEAD changed/);
    assert.equal((await runtime.integrations.prepare(child.id,'node -e "process.exit(0)"')).status,'ready');
    assert.equal((await runtime.integrations.apply(child.id)).status,'applied');assert.equal(await readFile(join(dir,'feature.txt'),'utf8'),'verified');
  }finally{await runtime.close();store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
