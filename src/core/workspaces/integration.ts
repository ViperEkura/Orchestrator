import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {StateStore} from '../../storage/store.js';
import {runCommand} from '../../tools/index.js';

const exec=promisify(execFile);
const git=async(cwd:string,...args:string[]) => (await exec('git',args,{cwd,windowsHide:true,maxBuffer:2*1024*1024,timeout:60000})).stdout.trim();
/** Serial integration is isolated from the user's working tree; applying is a separate action. */
export class IntegrationQueue {
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private store:StateStore){}
  private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.tail.then(work);this.tail=next.catch(()=>{});return next;}
  async close(){await this.tail;}
  prepare(taskId:string,testCommand:string) {
    if(!testCommand.trim()||testCommand.length>8000)throw new Error('A verification command is required');
    return this.serial(async()=>{
      const {task,session}=this.store.select(state=>{const task=state.tasks[taskId];return {task,session:task?state.sessions[task.sessionId]:undefined};});
      if(!task||task.status!=='completed'||!session||session.workspace!=='worktree'||!session.sourceCwd)throw new Error('Integration requires a completed writable child');
      if(task.reviewRequired&&task.review?.status!=='accepted')throw new Error('Result must be accepted before integration');
      if(this.store.root===':memory:')throw new Error('Integration requires persistent storage');
      if(await git(session.cwd,'status','--porcelain'))throw new Error('Commit the child worktree changes before integration');
      const commit=await git(session.cwd,'rev-parse','HEAD'),base=await git(session.sourceCwd,'rev-parse','HEAD');
      if(commit===session.baseCommit)throw new Error('Child worktree has no new commit');
      const path=join(this.store.root,'integrations',randomUUID());
      this.store.change('integration.started',{taskId},state=>{state.tasks[taskId]!.integration={status:'running',commit,base,path,testCommand};},{taskId});
      try {
        await mkdir(join(this.store.root,'integrations'),{recursive:true});
        await git(session.sourceCwd,'worktree','add','--detach',path,base);
        try { await git(path,'merge','--no-ff','--no-edit',commit); }
        catch { this.update(taskId,'conflict','Merge did not complete. Inspect the integration worktree.');return this.store.select(s=>s.tasks[taskId]!.integration!); }
        const result=await runCommand(testCommand,path,60000,AbortSignal.timeout(65000)) as {exitCode:number|null;timedOut:boolean;outputLimitReached:boolean;output:string};
        const artifactId=randomUUID(),artifact=this.store.saveArtifact(taskId,task.runIds.at(-1)!,artifactId,JSON.stringify(result),'application/json');
        const head=await git(path,'rev-parse','HEAD'),dirty=await git(path,'status','--porcelain');
        this.store.change('integration.verified',{artifactId},state=>{
          state.artifacts[artifactId]=artifact;const integration=state.tasks[taskId]!.integration!;
          integration.status=result.exitCode===0&&!result.timedOut&&!result.outputLimitReached&&!dirty?'ready':'failed';integration.head=head;integration.artifactId=artifactId;
          if(dirty)integration.error='Verification modified tracked or untracked files; inspect and prepare a clean result.';
        },{taskId});
      }catch(error){this.update(taskId,'failed',String(error));}
      return this.store.select(s=>s.tasks[taskId]!.integration!);
    });
  }
  apply(taskId:string){return this.serial(async()=>{
    const state=this.store.snapshot().state,task=state.tasks[taskId],integration=task?.integration;
    const cwd=task?state.sessions[task.sessionId]?.sourceCwd:undefined;
    if(!cwd||integration?.status!=='ready'||!integration.head)throw new Error('No verified integration ready to apply');
    if(await git(cwd,'status','--porcelain'))throw new Error('Target project must have a clean working tree');
    if(await git(cwd,'rev-parse','HEAD')!==integration.base)throw new Error('Target HEAD changed; prepare and verify integration again');
    if(await git(integration.path,'rev-parse','HEAD')!==integration.head||await git(integration.path,'status','--porcelain'))throw new Error('Verified worktree changed; prepare integration again');
    if(this.store.select(state=>Object.values(state.tasks).some(task=>!['completed','failed','cancelled','interrupted'].includes(task.status)&&state.sessions[task.sessionId]?.cwd===cwd)))throw new Error('Wait for active tasks in the target project before applying');
    this.update(taskId,'applying');
    try{await git(cwd,'merge','--ff-only',integration.head);this.update(taskId,'applied');}
    catch(error){this.update(taskId,'interrupted',String(error));throw error;}
    return this.store.select(s=>s.tasks[taskId]!.integration!);
  });}
  private update(taskId:string,status:NonNullable<import('../domain.js').Task['integration']>['status'],error?:string){
    this.store.change('integration.'+status,{taskId},state=>{const integration=state.tasks[taskId]!.integration!;integration.status=status;if(error)integration.error=error;},{taskId});
  }
}
