import { taskResults } from '../tasks/results.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelGateway } from '../../models/gateway.js';
import { randomUUID } from 'node:crypto';
import { terminal, type Message, type Task, type ToolCall, type DelegationInput } from '../domain.js';
import type { StateStore } from '../../storage/store.js';
import type { ModelRegistry } from '../../models/registry.js';
import type { RuntimeOptions } from '../runtime.js';
import type { ToolRegistry } from '../../tools/index.js';
import { prepareWorkspace } from '../workspaces/workspace.js';
import { TaskRepository } from '../tasks/repository.js';

export interface ExecutorHost {
  store: StateStore; catalog: ModelRegistry; gateway: ModelGateway; options: RuntimeOptions;
  jobs: Map<string, Promise<void>>; tools: ToolRegistry;
  delegate(runId: string, input: DelegationInput): Task;
  waitChildren(taskId: string, ids: string[], signal: AbortSignal): Promise<unknown>;
  setStatus(taskId: string, status: Task['status']): void;
  fail(taskId: string, error: string): void;
  executeTool(taskId: string, runId: string, call: ToolCall, workspace: string, signal: AbortSignal): Promise<unknown>;
  deliverMessages(runId: string): void;
}
export class RunExecutor {
  private repo: TaskRepository;
  private gateway: ModelGateway;
  constructor(private host: ExecutorHost) { this.repo = new TaskRepository(host.store); this.gateway = host.gateway; }
  async execute(taskId: string, controller: AbortController): Promise<void> {
    const signal = controller.signal; const initial = this.host.store.snapshot().state;
    const task = initial.tasks[taskId]!; const runId = task.runIds.at(-1)!;
    if(terminal(task.status))return;
    if(task.status==='cancelling'){this.repo.changeRun(runId,'run.cancelled',{},state=>{state.tasks[taskId]!.status='cancelled';state.runs[runId]!.status='cancelled';});return;}
    const session = initial.sessions[task.sessionId]!;
    const workspace = session.cwd;
    const generation = (this.repo.run(runId).lease?.generation ?? 0) + 1;
    const check = () => { signal.throwIfAborted(); if (this.repo.run(runId).lease?.generation !== generation) throw new Error('Stale execution lease'); };
    const renew = () => this.repo.changeRun(runId, 'run.lease', {}, state => { state.runs[runId]!.lease = {workerId:'local', generation, expiresAt:new Date(Date.now()+30000).toISOString()}; });
    renew(); const heartbeat = setInterval(() => { try { check(); renew(); } catch(error) { controller.abort(error); } }, 10000);
    const timer = setTimeout(() => controller.abort(new Error('Run deadline exceeded')), this.host.options.runTimeoutMs ?? 300000);
    try {
      this.host.store.change('run.started', {}, s => { s.tasks[taskId]!.status = 'running'; s.runs[runId]!.status = 'running'; s.runs[runId]!.startedAt = new Date().toISOString(); }, { taskId, runId });
      await prepareWorkspace(session, signal);
      if (task.dependsOn.length && !this.repo.run(runId).checkpoint?.dependenciesAdded) this.append(runId, { role: 'user', content: `Dependency results: ${JSON.stringify(taskResults(initial, task.dependsOn))}` });
      this.repo.changeRun(runId, 'run.checkpoint', {}, state => { state.runs[runId]!.checkpoint!.dependenciesAdded = true; });
      if (task.delegations?.length && !this.repo.run(runId).checkpoint?.initialized) {
        const children: Task[] = [];
        for (const [index, { after, ...plan }] of task.delegations.entries()) {
          const saved = this.repo.tasks().find(item => item.parentTaskId === taskId && item.sourceCallId === 'plan:'+index);
          children.push(saved ?? this.host.delegate(runId, { ...plan, sourceCallId:'plan:'+index, dependsOn:after?.map(i=>children[i]!.id) } as DelegationInput));
        }
        const results = await this.host.waitChildren(taskId, children.map(child => child.id), signal);
        this.append(runId, { role: 'user', content: 'The requested child tasks have finished. Synthesize their results; do not launch the same tasks again.\n' + JSON.stringify(results) }, children.map(child => child.id));
      }
      this.repo.changeRun(runId, 'run.checkpoint', {}, state => { state.runs[runId]!.checkpoint!.initialized = true; });
      while (true) {
        check();
        const checkpoint = this.repo.run(runId).checkpoint!;
        if (checkpoint.phase === 'tools') {
          const run = this.repo.run(runId), index=run.messages.findLastIndex(message=>message.role==='assistant'),assistant=run.messages[index];
          const pending = (assistant?.toolCalls ?? []).filter(call=>!run.messages.slice(index+1).some(message=>message.role==='tool' && message.toolCallId===call.id));
          await this.executeCalls(taskId, runId, pending, workspace, signal, check); check();
          this.repo.changeRun(runId, 'run.checkpoint', {}, state=>{state.runs[runId]!.checkpoint!.phase='model';});
          continue;
        }
        if (checkpoint.phase === 'finalize') { if(await this.complete(taskId,runId,signal))return;continue; }
        this.host.deliverMessages(runId);
        let text = ''; let reasoningContent = ''; let usage = 0; const calls: ToolCall[] = [];
        {
          signal.throwIfAborted();
          this.repo.changeRun(runId, 'run.step', {}, s => {
            const budget = s.budgets[task.rootId]!;
            if (budget.stepsUsed >= budget.maxSteps) throw new Error('Shared model-step budget exhausted');
            if (budget.maxTokens && (budget.tokensUsed ?? 0) >= budget.maxTokens) throw new Error('Shared token budget exhausted');
            budget.stepsUsed++; s.runs[runId]!.steps++;
          });
          const run = this.repo.run(runId);
          if (JSON.stringify(run.messages).length > 240000) throw new Error('Context size limit exceeded; start a new session or reduce tool output');
          for await (const chunk of this.stream(run.model?.id, run.messages, run.config.allowedTools, signal)) {
            signal.throwIfAborted();
            if (chunk.type === 'reasoning') {
              reasoningContent += chunk.text;
              if (reasoningContent.length > 128000) throw new Error('Reasoning size limit exceeded');
              this.host.store.emit('message.thinking', { text: chunk.text }, { taskId, runId });
            } else if (chunk.type === 'text') {
              text += chunk.text;
              if (text.length > 128000) throw new Error('Model output size limit exceeded');
              this.host.store.emit('message.delta', { text: chunk.text }, { taskId, runId });
            } else if (chunk.type === 'usage') { const total=chunk.inputTokens+chunk.outputTokens;if(Number.isFinite(total)&&total>=0)usage=total; } else { calls.push(chunk.call); if (calls.length > 32 || calls.reduce((n, c) => n + c.arguments.length, 0) > 256000) throw new Error('Tool call size limit exceeded'); }
          }
          check();
          this.repo.changeRun(runId, 'run.usage', {}, state=>{ const budget=state.budgets[task.rootId]!; budget.tokensUsed=(budget.tokensUsed??0)+(usage || Math.ceil((JSON.stringify(run.messages).length+text.length+reasoningContent.length+JSON.stringify(calls).length)/3)); });
        }
        check();
        if(new Set(calls.map(call=>call.id)).size!==calls.length || calls.some(call=>Object.hasOwn(this.repo.run(runId).operations??{},call.id)))throw new Error('Duplicate tool call IDs');
        const message: Message = {role:'assistant',content:text,...(reasoningContent?{reasoningContent}:{}),...(calls.length?{toolCalls:calls}:{})};
        this.repo.changeRun(runId, 'message.completed', {message}, state=>{
          state.runs[runId]!.messages.push(message); state.runs[runId]!.checkpoint!.phase=calls.length?'tools':'finalize';
        });
      }
    } catch (error) {
      if(this.repo.run(runId).lease?.generation!==generation)return;
      if (this.host.store.snapshot().state.tasks[taskId]!.status === 'cancelling') {
        // Finish cancellation only after in-flight execution and descendant jobs have settled.
        const children = Object.values(this.host.store.snapshot().state.tasks).filter(t => t.parentTaskId === taskId);
        await Promise.allSettled(children.flatMap(t => { const job = this.host.jobs.get(t.id); return job ? [job] : []; }));
        this.host.store.change('run.cancelled', {}, s => {
          s.tasks[taskId]!.status = 'cancelled'; s.runs[runId]!.status = 'cancelled'; s.runs[runId]!.finishedAt = new Date().toISOString();
        }, { taskId, runId });
      } else this.host.fail(taskId, error instanceof Error ? error.message : String(error));
    }
    finally { clearTimeout(timer); clearInterval(heartbeat); }
  }
  private append(runId: string, message: Message, receivedChildIds: string[] = [], resumeModel = false) {
    this.repo.changeRun(runId, 'message.completed', { message }, s => { s.runs[runId]!.messages.push(message);
      const checkpoint = s.runs[runId]!.checkpoint!;
      if (resumeModel) checkpoint.phase = 'model';
      if (receivedChildIds.length) checkpoint.receivedChildIds = [...new Set([...(checkpoint.receivedChildIds ?? []), ...receivedChildIds])];
    });
  }
  private async executeCalls(taskId: string, runId: string, calls: ToolCall[], workspace: string, signal: AbortSignal, check:()=>void) {
    const parallel = (call: ToolCall) => { try { const tool = this.host.tools.resolve(call.name); return tool.parallelSafe && tool.readOnly && !tool.approval; } catch { return false; } };
    for (let index = 0; index < calls.length;) {
      const batch = [calls[index++]!];
      if (parallel(batch[0]!)) while (index < calls.length && parallel(calls[index]!)) batch.push(calls[index++]!);
      check();
      const results = await Promise.allSettled(batch.map(async call => {
        check();
        const saved = this.repo.run(runId).operations?.[call.id];
        if(saved?.status==='completed') return JSON.parse(saved.content!);
        let result: unknown;
        try { result=await this.host.executeTool(taskId,runId,call,workspace,signal); }
        catch(error) { signal.throwIfAborted(); result={error:error instanceof Error?error.message:String(error)}; }
        check();
        result=this.compactResult(taskId,runId,result);
        this.repo.changeRun(runId,'operation.completed',{toolCallId:call.id},state=>{state.runs[runId]!.operations![call.id]={status:'completed',name:call.name,readOnly:true,content:JSON.stringify(result)??'null'};});
        return result;
      }));
      signal.throwIfAborted();
      for (let i = 0; i < batch.length; i++) {
        const call = batch[i]!; const outcome = results[i]!;
        const result = outcome.status === 'fulfilled' ? outcome.value : { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
        const full = JSON.stringify(result) ?? 'null'; let content = full;
        if (full.length > 24000) {
          const artifactId = randomUUID(); const artifact = this.host.store.saveArtifact(taskId, runId, artifactId, full, 'application/json');
          this.host.store.change('artifact.created', { artifactId }, s => { s.artifacts[artifactId] = artifact; }, { taskId, runId });
          const metadata = result && typeof result === 'object' ? Object.fromEntries(Object.entries(result).filter(([key]) => ['error', 'exitCode', 'timedOut', 'outputLimitReached'].includes(key))) : {};
          content = JSON.stringify({ ...metadata, truncated: true, artifactId, preview: full.slice(0, 16000) });
        }
        this.append(runId, { role: 'tool', toolCallId: call.id, content }, call.name === 'wait_tasks' && Array.isArray(result) ? result.map(item => (item as {taskId: string}).taskId) : []);
        this.host.store.change('tool.completed', { toolCallId: call.id, name: call.name, result: JSON.parse(content) }, () => {}, { taskId, runId });
      }
    }
  }
  private compactResult(taskId:string,runId:string,result:unknown):unknown {
    const full=JSON.stringify(result)??'null';if(full.length<=24000)return result;
    const artifactId=randomUUID(),artifact=this.host.store.saveArtifact(taskId,runId,artifactId,full,'application/json');
    this.host.store.change('artifact.created',{artifactId},state=>{state.artifacts[artifactId]=artifact;},{taskId,runId});
    const metadata=result&&typeof result==='object'?Object.fromEntries(Object.entries(result).filter(([key])=>['error','exitCode','timedOut','outputLimitReached'].includes(key))):{};
    return {...metadata,truncated:true,artifactId,preview:full.slice(0,16000)};
  }
  private async *stream(modelId: string | undefined, messages: Message[], allowed: string[], signal: AbortSignal) {
    for (let attempt=0;;attempt++) {
      let emitted=false;
      const release=await this.gateway.acquire(modelId??'default',signal);
      try { for await(const chunk of this.host.catalog.resolve(modelId).stream(messages,this.host.tools.specs(allowed),signal)){emitted=true;yield chunk;} return; }
      catch(error) { if(emitted || attempt>=2 || !/Model HTTP (429|502|503|504)/.test(String(error)))throw error; }
      finally { release(); }
      await delay(500*2**attempt,undefined,{signal});
    }
  }
  private async complete(taskId: string,runId: string,signal: AbortSignal) {
    const children=this.repo.tasks().filter(task=>task.parentTaskId===taskId);
    if(children.some(task=>!terminal(task.status))) { await this.host.waitChildren(taskId,children.map(task=>task.id),signal); return false; }
    const received = new Set(this.repo.run(runId).checkpoint?.receivedChildIds ?? []);
    const unseen = children.filter(child => !received.has(child.id));
    if (unseen.length) {
      const ids = unseen.map(child => child.id);
      this.append(runId, {role:'user', content:'Child tasks have finished. Review these result previews, read full artifacts if needed, and synthesize the answer. Do not repeat completed tasks.\n' + JSON.stringify(taskResults(this.host.store.snapshot().state, ids))}, ids, true);
      return false;
    }
    if(children.some(task=>this.repo.task(task.id).status!=='completed'))throw new Error('One or more child tasks failed or were cancelled');
    signal.throwIfAborted();
    if(this.repo.run(runId).inbox?.some(message=>!message.deliveredAt) || this.host.store.select(state=>state.sessions[this.repo.task(taskId).sessionId]?.mailbox?.some(message=>!message.deliveredRunId))){this.repo.changeRun(runId,'run.checkpoint',{},state=>{state.runs[runId]!.checkpoint!.phase='model';});return false;}
    const task=this.repo.task(taskId), text=this.repo.run(runId).messages.findLast(message=>message.role==='assistant')?.content??'';
    const artifactId=randomUUID(), artifact=this.host.store.saveArtifact(taskId,runId,artifactId,text,'text/markdown');
    this.host.store.change(task.reviewRequired?'task.review_requested':'run.completed',{artifactId,result:text},state=>{
      const current=state.tasks[taskId]!, run=state.runs[runId]!;
      current.result=text; current.status=task.reviewRequired?'waiting_review':'completed'; run.status=current.status;
      run.checkpoint!.phase='done'; run.finishedAt=new Date().toISOString();state.artifacts[artifactId]=artifact;
      if(task.reviewRequired)current.review={status:'pending',artifactIds:Object.values(state.artifacts).filter(a=>a.taskId===taskId).map(a=>a.id),at:new Date().toISOString()};
    },{taskId,runId});
    return true;
  }

}
