import { discoverGuidance, guidancePrompt, loadSkill } from './agents/guidance.js';
import { sessionHistory } from './agents/context.js';
import { agentSessions, isDescendantSession } from './agents/sessions.js';
import type { FollowupInput, AgentMessage } from './domain.js';
import { defaultAgents } from './agents/definitions.js';
import { taskResults } from './tasks/results.js';
import { ModelGateway } from '../models/gateway.js';
import { execFileSync } from 'node:child_process';
import { WorkerPool } from './execution/worker-pool.js';
import { IntegrationQueue } from './workspaces/integration.js';
import { taskPolicySchema } from './tasks/schema.js';
import { RunExecutor } from './execution/run-executor.js';
import { Scheduler } from './execution/scheduler.js';
import { TaskRepository } from './tasks/repository.js';
import { ModelRegistry } from '../models/registry.js';
import type { ModelInput, TaskPolicy, TaskMessage } from './domain.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { terminal, approvalModes, type QuestionInput, type TodoItem, type ApprovalMode, type AgentDefinition, type DelegationInput, type ModelProvider, type Run, type State, type SubmitInput, type Task, type ToolCall } from './domain.js';
import { judgeApproval } from './approval.js';
import { StateStore } from '../storage/store.js';
import { createTools, type ToolRegistry } from '../tools/index.js';
import { prepareWorkspace, projectDirectory } from './workspaces/workspace.js';

export { defaultAgents } from './agents/definitions.js';

/** Fair permits are held only during model/tool execution, never during approval/child waits. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit: number) { if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency'); }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    await new Promise<void>((resolvePermit, reject) => {
      const onAbort = () => { this.queue = this.queue.filter(item => item !== enter); reject(signal.reason); };
      const enter = () => { signal.removeEventListener('abort', onAbort); this.active++; resolvePermit(); };
      if (this.active < this.limit) enter();
      else { this.queue.push(enter); signal.addEventListener('abort', onAbort, { once: true }); }
    });
    let released = false;
    return () => { if (released) return; released = true; this.active--; this.queue.shift()?.(); };
  }
}

export interface RuntimeOptions {
  approvalMode?: ApprovalMode; workspaceDir: string; defaultAgent?: string; model?: string; provider?: string; concurrency?: number; maxSteps?: number; maxTasks?: number;
  modelRegistry?: ModelRegistry; maxActiveRuns?: number; maxActivePerRoot?: number; maxTokens?: number;
  modelLimits?: Record<string, import('../models/gateway.js').ModelLimit>;
  maxDepth?: number; runTimeoutMs?: number; agents?: AgentDefinition[]; tools?: ToolRegistry;
}

export class OrchestratorService {
  readonly agents: Map<string, AgentDefinition>;
  readonly tools: ToolRegistry;
  private catalog: ModelRegistry;
  private gateway: ModelGateway;
  private executions: Semaphore;
  private pool = new WorkerPool();
  private controllers = this.pool.controllers;
  private jobs = this.pool.jobs;
  readonly integrations: IntegrationQueue;
  private scheduler = new Scheduler();
  private executor: RunExecutor;
  private repo: TaskRepository;
  private scheduled = false;
  private closing = false;
  constructor(readonly store: StateStore, private provider: ModelProvider, private options: RuntimeOptions) {
    for(const key of ['maxActiveRuns','maxActivePerRoot','maxTasks','maxSteps','maxTokens'] as const){const value=options[key];if(value!==undefined&&(!Number.isSafeInteger(value)||value<1))throw new Error('Invalid '+key);}
    this.catalog = options.modelRegistry ?? new ModelRegistry([{ description: {id:'default', name:options.model ?? 'Custom', model:options.model ?? 'custom', provider:options.provider ?? 'custom'}, create: () => provider }]);
    this.agents = new Map((options.agents ?? defaultAgents).map(agent => [agent.id, agent]));
    this.tools = options.tools ?? createTools();
    this.executions = new Semaphore(options.concurrency ?? 3);
    this.options.workspaceDir = projectDirectory(options.workspaceDir);
    this.gateway = new ModelGateway(options.modelLimits,options.concurrency??3);
    this.repo = new TaskRepository(store);
    this.integrations = new IntegrationQueue(store);
    this.executor = new RunExecutor({ store, catalog:this.catalog, gateway:this.gateway, options, jobs:this.jobs, tools:this.tools,
      delegate:this.delegate.bind(this), waitChildren:this.waitChildren.bind(this), setStatus:this.setStatus.bind(this), fail:this.fail.bind(this),
      executeTool:this.executeTool.bind(this), deliverMessages:this.deliverMessages.bind(this) });
    this.recover(); this.kick();
  }
  private recover() {
    const state = this.store.snapshot().state;
    if (!Object.values(state.tasks).some(task => !terminal(task.status)||['running','applying'].includes(task.integration?.status??''))) return;
    this.store.change('runtime.recovered', {policy:'resume checkpoints; quarantine uncertain operations'}, s=>{
      for(const task of Object.values(s.tasks)) {
        if(task.integration&&['running','applying'].includes(task.integration.status))task.integration.status='interrupted';
        if(terminal(task.status) || task.status==='waiting_review')continue;
        const run=s.runs[task.runIds.at(-1)!]!;
        if(!run.checkpoint || run.checkpoint.phase==='done') {task.status='interrupted';run.status='interrupted';task.error='No resumable execution checkpoint';continue;}
        const uncertain=Object.values(run.operations??{}).some(op=>op.status==='running'&&!op.readOnly);
        task.status=uncertain?'needs_review':'queued';run.status=task.status;
        if(uncertain)task.error='A tool may have executed before interruption. Verify its effects before continuing.';
        if(run.lease)run.lease.generation++;
      }
      for(const approval of Object.values(s.approvals))if(approval.status==='pending'&&terminal(s.tasks[approval.taskId]!.status))approval.status='cancelled';
      for(const question of Object.values(s.questions))if(question.status==='pending'&&terminal(s.tasks[question.taskId]!.status))question.status='cancelled';
    });
  }

  info() { const model = this.catalog.describe(); return { cwd: this.options.workspaceDir, model: model.model, modelId: model.id, provider: model.provider, defaultAgent: this.options.defaultAgent ?? 'assistant', approvalMode: this.options.approvalMode ?? 'manual' }; }
  listModels() { return this.catalog.list(); }
  setModel(id: string) {
    this.catalog.select(id);
    this.store.change('model.selected', { model: this.catalog.describe() }, () => {});
    return this.info();
  }
  addModel(input: ModelInput) {
    const model = this.catalog.add(input);
    this.store.change('model.added', { model }, () => {});
    return model;
  }

  private validatePolicy(input: TaskPolicy): TaskPolicy {
    const policy=taskPolicySchema.parse(input); if(policy.modelId)this.catalog.describe(policy.modelId); return policy;
  }
  private validateArtifacts(ids: string[] | undefined, rootId: string, sessionId: string) {
    for(const id of ids??[]) {
      const owner=this.store.select(state=>{const artifact=state.artifacts[id];return artifact?state.tasks[artifact.taskId]:undefined;});
      if(!owner || owner.rootId!==rootId&&owner.sessionId!==sessionId&&!this.store.select(state=>isDescendantSession(state,owner.sessionId,sessionId)))throw new Error('Input artifact is outside this task tree');
    }
  }
  pause(rootId: string, paused: boolean) {
    const task=this.repo.task(rootId); if(task.parentTaskId)throw new Error('Pause requires a root task');
    this.store.change('scheduler.paused',{rootId,paused},state=>{state.tasks[rootId]!.paused=paused;},{taskId:rootId});this.kick();
  }
  updateDependencies(taskId: string, dependsOn: string[], priority?: number) {
    const task=this.repo.task(taskId);
    if(task.status!=='queued'||this.jobs.has(taskId))throw new Error('Only undispatched queued tasks can be replanned');
    const tasks=this.repo.tasks(), byId=new Map(tasks.map(item=>[item.id,item]));
    if(dependsOn.length>256 || dependsOn.some(id=>!byId.has(id)||byId.get(id)!.rootId!==task.rootId))throw new Error('Dependencies must belong to the same task tree');
    const ancestors=new Set<string>();let parent=task.parentTaskId;while(parent){ancestors.add(parent);parent=byId.get(parent)?.parentTaskId;}
    if(dependsOn.some(id=>ancestors.has(id)))throw new Error('A task cannot depend on its waiting ancestor');
    task.dependsOn=[...new Set(dependsOn)];byId.set(taskId,task);
    const visiting=new Set<string>(), visited=new Set<string>();
    const visit=(id:string)=>{if(visiting.has(id))throw new Error('Dependency cycle');if(visited.has(id))return;visiting.add(id);
      for(const dep of [...byId.get(id)!.dependsOn,...tasks.filter(item=>item.parentTaskId===id).map(item=>item.id)])visit(dep);
      visiting.delete(id);visited.add(id);};
    for(const item of tasks)visit(item.id);
    const policy=this.validatePolicy(priority===undefined?{}:{priority});
    this.store.change('task.replanned',{dependsOn},state=>{state.tasks[taskId]!.dependsOn=task.dependsOn;Object.assign(state.tasks[taskId]!,policy);},{taskId});this.kick();
  }
  sendMessage(toTaskId: string, content: string, fromTaskId?: string, id: string=randomUUID()): TaskMessage {
    if(!content.trim()||content.length>16000)throw new Error('Message must contain 1–16000 characters');
    const target=this.repo.task(toTaskId),runId=target.runIds.at(-1)!;
    const previous=this.repo.run(runId).inbox?.find(message=>message.id===id);
    if(previous) {if(previous.content!==content||previous.fromTaskId!==fromTaskId)throw new Error('Message ID already used');return previous;}
    if(terminal(target.status)||target.status==='waiting_review')throw new Error('Target is not accepting messages');
    if(fromTaskId&&this.repo.task(fromTaskId).rootId!==target.rootId)throw new Error('Messages must stay in the same task tree');
    if((this.repo.run(runId).inbox??[]).filter(message=>!message.deliveredAt).length>=100)throw new Error('Target inbox is full');
    const message:TaskMessage={id,toTaskId,content,...(fromTaskId?{fromTaskId}:{}),createdAt:new Date().toISOString()};
    this.repo.changeRun(runId,'message.sent',{id,toTaskId,fromTaskId:fromTaskId??null},state=>{(state.runs[runId]!.inbox??=[]).push(message);});
    return message;
  }
  listAgentSessions(parentSessionId?: string) { return this.store.select(state => agentSessions(state, parentSessionId)); }
  private ownedAgent(sessionId: string, fromTaskId?: string) {
    const state = this.store.snapshot().state, session = state.sessions[sessionId];
    if (!session?.parentSessionId) throw new Error('Unknown child agent session');
    if (fromTaskId && state.tasks[fromTaskId]?.sessionId !== session.parentSessionId) throw new Error('Only the parent session can control this agent');
    return session;
  }
  sendAgentMessage(sessionId: string, content: string, fromTaskId?: string, id: string = randomUUID()): AgentMessage {
    if (!content.trim() || content.length > 16000) throw new Error('Message must contain 1–16000 characters');
    const session = this.ownedAgent(sessionId, fromTaskId);
    const previous = session.mailbox?.find(message => message.id === id);
    if (previous) { if (previous.content !== content || previous.fromTaskId !== fromTaskId) throw new Error('Message ID already used'); return previous; }
    if (session.closedAt) throw new Error('Agent session is closed');
    if ((session.mailbox ?? []).filter(message => !message.deliveredRunId).length >= 100) throw new Error('Agent inbox is full');
    const message: AgentMessage = {id, sessionId, content, ...(fromTaskId?{fromTaskId}:{}), createdAt:new Date().toISOString()};
    this.store.change('agent.message_sent', {sessionId, id}, state => { (state.sessions[sessionId]!.mailbox ??= []).push(message); }, {sessionId});
    return message;
  }
  interruptAgent(taskId: string, fromTaskId: string) {
    const task = this.repo.task(taskId);
    this.ownedAgent(task.sessionId, fromTaskId);
    if (!terminal(task.status)) this.cancel(taskId);
    return {taskId, sessionId:task.sessionId};
  }
  closeAgent(sessionId: string, fromTaskId?: string) {
    this.ownedAgent(sessionId, fromTaskId);
    const state = this.store.snapshot().state;
    const ids = new Set(Object.keys(state.sessions).filter(id => isDescendantSession(state, id, sessionId)));
    this.store.change('agent.closed', {sessionIds:[...ids]}, current => { for (const id of ids) current.sessions[id]!.closedAt ??= new Date().toISOString(); }, {sessionId});
    for (const task of Object.values(state.tasks)) if (ids.has(task.sessionId) && !terminal(task.status)) this.cancel(task.id);
    return {ok:true};
  }
  followup(input: FollowupInput, parentRunId?: string, sourceCallId?: string): Task {
    if (this.closing) throw new Error('Runtime is shutting down');
    if (!input.objective.trim() || input.objective.length > 16000) throw new Error('Objective must contain 1–16000 characters');
    const state = this.store.snapshot().state;
    const parentRun = parentRunId ? state.runs[parentRunId] : undefined;
    if (parentRunId && (!parentRun || terminal(parentRun.status) || parentRun.status === 'cancelling')) throw new Error('Parent run is not active');
    const session = this.ownedAgent(input.sessionId, parentRun?.taskId);
    const previous = Object.values(state.tasks).filter(task => task.sessionId === session.id);
    const saved = sourceCallId ? previous.find(task => task.sourceCallId === sourceCallId && task.parentTaskId === parentRun?.taskId) : undefined;
    if (saved) { if (saved.objective !== input.objective) throw new Error('Follow-up ID already used'); return saved; }
    if (session.closedAt) throw new Error('Agent session is closed');
    if (previous.some(task => !terminal(task.status))) throw new Error('Agent is busy; send a message or wait before assigning another task');
    const last = previous.at(-1); if (!last) throw new Error('Agent has no prior task');
    const owner = parentRun ? state.tasks[parentRun.taskId] : Object.values(state.tasks).findLast(task => task.sessionId === session.parentSessionId && !terminal(task.status) && task.status !== 'cancelling');
    const task = this.makeTask(input.objective, last.agentId, session.id);
    Object.assign(task, this.validatePolicy(input), ...(sourceCallId ? [{sourceCallId}] : []));
    if (owner) {
      const budget = state.budgets[owner.rootId]!;
      if (owner.depth >= budget.maxDepth) throw new Error('Delegation depth budget exhausted');
      if (Object.values(state.tasks).filter(t => t.rootId === owner.rootId).length >= budget.maxTasks) throw new Error('Task budget exhausted');
      if (input.dependsOn?.some(id => state.tasks[id]?.parentTaskId !== owner.id)) throw new Error('Dependencies must reference sibling tasks');
      Object.assign(task, {rootId:owner.rootId, parentTaskId:owner.id, depth:owner.depth+1, dependsOn:[...new Set(input.dependsOn ?? [])]});
    } else if (input.dependsOn?.length) throw new Error('Dependencies require an active parent task');
    this.validateArtifacts(input.inputArtifactIds, task.rootId, task.sessionId);
    const oldRun = state.runs[last.runIds.at(-1)!]!;
    const ownerRun = owner ? state.runs[owner.runIds.at(-1)!] : undefined;
    const allowed = oldRun.config.allowedTools.filter(name => !ownerRun || ownerRun.config.allowedTools.includes(name));
    this.store.change('task.created', {objective:task.objective, followup:true}, current => {
      if (!owner) current.budgets[task.id] = {stepsUsed:0,tokensUsed:0,maxSteps:this.options.maxSteps ?? 400,maxTasks:this.options.maxTasks ?? 64,maxDepth:this.options.maxDepth ?? 3,...(this.options.maxTokens?{maxTokens:this.options.maxTokens}:{})};
      this.insertTask(current, task, allowed, input.modelId ?? oldRun.model?.id);
    }, {taskId:task.id, sessionId:session.id});
    this.kick(); return structuredClone(task);
  }
  private deliverMessages(runId: string) {
    const sessionId = this.repo.task(this.repo.run(runId).taskId).sessionId;
    const mailbox = this.store.select(state => state.sessions[sessionId]?.mailbox ?? []);
    if(!this.repo.run(runId).inbox?.some(message=>!message.deliveredAt) && !mailbox.some(message => !message.deliveredRunId))return;
    this.store.change('message.delivered',{},state=>{const run=state.runs[runId]!;
      for (const message of state.sessions[sessionId]?.mailbox ?? []) if (!message.deliveredRunId) {
        run.messages.push({role:'user',source:'agent_message',content:'Message from '+(message.fromTaskId ?? 'user')+': '+message.content}); message.deliveredRunId=runId;
      }
      for(const message of run.inbox??[])if(!message.deliveredAt){run.messages.push({role:'user',source:'agent_message',content:'Message from '+(message.fromTaskId??'user')+': '+message.content});message.deliveredAt=new Date().toISOString();}
    });
  }
  private publishArtifact(taskId:string,runId:string,callId:string,content:string,mediaType:string) {
    const id=runId+'-'+callId, existing=this.store.select(state=>state.artifacts[id]);
    if(existing)return {artifactId:id};
    const artifact=this.store.saveArtifact(taskId,runId,id,content,mediaType);
    this.store.change('artifact.created',{artifactId:id},state=>{state.artifacts[id]=artifact;},{taskId,runId});return {artifactId:id};
  }
  reviewTask(taskId:string,decision:'accepted'|'rejected',note:string) {
    const task=this.repo.task(taskId);if(task.status!=='waiting_review')throw new Error('Task is not awaiting review');
    if(!['accepted','rejected'].includes(decision)||!note.trim()||note.length>4000)throw new Error('A review decision and note are required');
    this.repo.changeRun(task.runIds.at(-1)!,'task.reviewed',{decision,note},state=>{
      const current=state.tasks[taskId]!;current.review={...current.review!,status:decision,note,at:new Date().toISOString()};
      current.status=decision==='accepted'?'completed':'failed';if(decision==='rejected')current.error='Review rejected: '+note;
      state.runs[current.runIds.at(-1)!]!.status=current.status;
    });this.kick();
  }
  resolveOperation(taskId:string,callId:string,content:string) {
    const task=this.repo.task(taskId),runId=task.runIds.at(-1)!;
    const operation=this.repo.run(runId).operations?.[callId];
    if(task.status!=='needs_review'||!operation||operation.status!=='running'||operation.readOnly)throw new Error('No uncertain operation to resolve');
    if(!content.trim()||content.length>24000)throw new Error('Provide the verified operation result');
    this.repo.changeRun(runId,'operation.verified',{callId},state=>{
      const run=state.runs[runId]!,current=state.tasks[taskId]!;
      run.operations![callId]={...operation,status:'completed',content:JSON.stringify({verifiedByUser:true,result:content})};
      if(!Object.values(run.operations!).some(op=>op.status==='running'&&!op.readOnly)){current.status='queued';run.status='queued';delete current.error;}
    });this.kick();
  }
  setApprovalMode(mode: ApprovalMode) {
    if (!approvalModes.includes(mode)) throw new Error('Invalid approval mode');
    this.options.approvalMode = mode;
    this.store.change('approval.mode_changed', { mode }, () => {});
    return this.info();
  }
  submit(input: SubmitInput): Task {
    if (this.closing) throw new Error('Runtime is shutting down');
    if (!input.objective.trim() || input.objective.length > 16000) throw new Error('Objective must contain 1–16000 characters');
    const agentId = input.agentId ?? this.options.defaultAgent ?? 'assistant'; this.requireAgent(agentId);
    const state = this.store.snapshot().state;
    if (input.sessionId && !state.sessions[input.sessionId]) throw new Error('Unknown session');
    if (input.sessionId && state.sessions[input.sessionId]?.parentSessionId) {
      if (input.cwd || input.delegations?.length) throw new Error('Follow-up keeps the agent workspace; delegate from its parent');
      const prior = Object.values(state.tasks).findLast(t => t.sessionId === input.sessionId);
      if (input.agentId && input.agentId !== prior?.agentId) throw new Error('Follow-up keeps the agent role');
      return this.followup(input as FollowupInput);
    }
    if (input.sessionId && Object.values(state.tasks).some(t => t.sessionId === input.sessionId && !terminal(t.status))) throw new Error('Session already has an active task');
    if (input.delegations?.length) {
      if (!this.requireAgent(agentId).allowedTools.includes('delegate_task')) throw new Error('Agent cannot delegate');
      if (input.delegations.length >= (this.options.maxTasks ?? 64)) throw new Error('Task budget exhausted');
      input.delegations.forEach((plan, i) => {
        this.requireAgent(plan.agentId);
        if (!plan.objective.trim() || plan.objective.length > 16000) throw new Error('Invalid delegated objective');
        if (plan.after?.some(index => !Number.isInteger(index) || index < 0 || index >= i)) throw new Error('Dependencies must reference earlier plan entries');
      });
    }
    if (input.sessionId && input.cwd) throw new Error('Existing sessions keep their project directory');
    const cwd = input.cwd ? realpathSync(resolve(input.cwd)) : this.options.workspaceDir;
    if (!statSync(cwd).isDirectory()) throw new Error('Project must be an existing directory');
    if(Object.values(state.tasks).some(task=>task.integration?.status==='applying'&&state.sessions[task.sessionId]?.sourceCwd===cwd))throw new Error('Project integration is being applied');
    const task = this.makeTask(input.objective, agentId, input.sessionId ?? randomUUID());
    Object.assign(task, this.validatePolicy(input));
    this.validateArtifacts(task.inputArtifactIds, task.rootId, task.sessionId);
    if (input.delegations?.length) task.delegations = structuredClone(input.delegations);
    this.store.change('task.created', { objective: task.objective }, s => {
      s.sessions[task.sessionId] ??= { id: task.sessionId, createdAt: task.createdAt, cwd, workspace: 'project' };
      s.budgets[task.id] = { ...(this.options.maxTokens?{maxTokens:this.options.maxTokens}:{}), tokensUsed:0, stepsUsed: 0, maxSteps: this.options.maxSteps ?? 400, maxTasks: this.options.maxTasks ?? 16, maxDepth: this.options.maxDepth ?? 3 };
      this.insertTask(s, task);
    }, { taskId: task.id });
    this.kick(); return structuredClone(task);
  }
  private requireAgent(id: string): AgentDefinition {
    const agent = this.agents.get(id); if (!agent) throw new Error(`Unknown agent: ${id}`); return agent;
  }
  private makeTask(objective: string, agentId: string, sessionId: string): Task {
    const id = randomUUID(); return { id, rootId: id, sessionId, objective, agentId, depth: 0, dependsOn: [], status: 'queued', runIds: [], createdAt: new Date().toISOString() };
  }
  private insertTask(state: State, task: Task, allowedTools?: string[], modelId = task.modelId ?? this.catalog.selectedId) {
    state.tasks[task.id] = task;
    const definition = structuredClone(this.requireAgent(task.agentId));
    if(task.requiredCapabilities?.some(name=>!definition.allowedTools.includes(name) || allowedTools && !allowedTools.includes(name)))throw new Error('Agent lacks required capabilities');
    if(task.acceptanceCriteria?.length)definition.systemPrompt += '\nAcceptance criteria: '+JSON.stringify(task.acceptanceCriteria);
    if(task.inputArtifactIds?.length)definition.systemPrompt += '\nInput artifacts (read_artifact): '+JSON.stringify(task.inputArtifactIds);
    definition.systemPrompt += '\nUse grep/glob to find files, read_file offset/limit to page, apply_patch for exact local edits, read_artifact to page large outputs, ask_user for missing decisions, and todo_write for multi-step plans. Independent read-only calls in the same response can run concurrently; submit dependent calls in separate responses.';
    if (task.parentTaskId) definition.systemPrompt += '\nYour conversation is independent. Work only on the delegated task. Start your final report with a concise conclusion, evidence, tests and blockers. Keep detailed output in artifacts; the parent receives a bounded result preview and can read the full report.';
    const session = state.sessions[task.sessionId]!;
    if (allowedTools) definition.allowedTools = definition.allowedTools.filter(t => allowedTools.includes(t));
    if (state.sessions[task.sessionId]!.workspace === 'read-only') definition.allowedTools = definition.allowedTools.filter(name => this.tools.resolve(name).readOnly);
    if(task.requiredCapabilities?.some(name=>!definition.allowedTools.includes(name)))throw new Error('Workspace lacks required capabilities');
    if (definition.allowedTools.includes('delegate_task')) {
      const roles = [...this.agents.values()].map(({id, name, description}) => ({id, name, description}));
      definition.systemPrompt += '\nRegistered roles for delegate_task: ' + JSON.stringify(roles);
    }
    const catalog = discoverGuidance(session.sourceCwd ?? session.cwd, this.store.root);
    definition.systemPrompt += guidancePrompt(catalog, task.objective, definition.allowedTools.includes('read_skill'));
    const history = sessionHistory(state, task.sessionId, task.id);
    const run: Run = { checkpoint: {phase:'model'}, operations:{}, inbox:[], model: this.catalog.describe(modelId), id: randomUUID(), taskId: task.id, attempt: task.runIds.length + 1, status: 'queued', steps: 0, config: definition,
      messages: [{ role: 'system', content: definition.systemPrompt }, ...history, { role: 'user', content: task.objective }] };
    task.runIds.push(run.id); state.runs[run.id] = run;
  }
  delegate(parentRunId: string, input: DelegationInput): Task {
    const state = this.store.snapshot().state; const parentRun = state.runs[parentRunId];
    if (!parentRun || terminal(parentRun.status) || parentRun.status === 'cancelling') throw new Error('Parent run is not active');
    const parent = state.tasks[parentRun.taskId]!; const budget = state.budgets[parent.rootId]!;
    const sourceCallId=(input as DelegationInput & {sourceCallId?:string}).sourceCallId;
    const existing=sourceCallId?Object.values(state.tasks).find(task=>task.parentTaskId===parent.id&&task.sourceCallId===sourceCallId):undefined;
    if(existing)return existing;
    if (parent.depth >= budget.maxDepth) throw new Error('Delegation depth budget exhausted');
    if (Object.values(state.tasks).filter(t => t.rootId === parent.rootId).length >= budget.maxTasks) throw new Error('Task budget exhausted');
    this.requireAgent(input.agentId);
    if (!input.objective.trim() || input.objective.length > 16000) throw new Error('Invalid child objective');
    // New tasks can depend only on already-existing siblings: no cycles can be introduced.
    for (const id of input.dependsOn ?? []) if (state.tasks[id]?.parentTaskId !== parent.id) throw new Error('Dependencies must reference existing sibling tasks');
    const task = this.makeTask(input.objective, input.agentId, randomUUID());
    const parentSession = state.sessions[parent.sessionId]!;
    if (parentSession.closedAt) throw new Error('Parent agent session is closed');
    const workspace = input.workspace ?? 'read-only';
    if (parentSession.workspace === 'read-only' && workspace === 'worktree') throw new Error('Read-only agents cannot create writable workspaces');
    if (workspace === 'worktree' && this.store.root === ':memory:') throw new Error('Worktrees require a persistent store directory');
    const baseCommit=workspace==='worktree'?execFileSync('git',['rev-parse','HEAD'],{cwd:parentSession.cwd,encoding:'utf8',windowsHide:true}).trim():undefined;
    const cwd = workspace === 'worktree' ? resolve(this.store.root, 'worktrees', task.sessionId) : parentSession.cwd;
    Object.assign(task, this.validatePolicy(input), ...(sourceCallId?[{sourceCallId}]:[]));
    this.validateArtifacts(input.inputArtifactIds, parent.rootId, parent.sessionId);
    Object.assign(task, { rootId: parent.rootId, parentTaskId: parent.id, depth: parent.depth + 1, dependsOn: [...new Set(input.dependsOn ?? [])] });
    this.store.change('task.created', { parentTaskId: parent.id, objective: task.objective }, s => {
      s.sessions[task.sessionId] = { id: task.sessionId, parentSessionId: parent.sessionId, createdAt: task.createdAt, cwd, workspace, ...(baseCommit?{baseCommit}:{}), ...(workspace === 'worktree' ? { sourceCwd: parentSession.cwd } : {}) };
      this.insertTask(s, task, parentRun.config.allowedTools, input.modelId ?? parentRun.model?.id);
    }, { taskId: task.id });
    this.kick(); return structuredClone(task);
  }
  retry(taskId: string): Run {
    const state = this.store.snapshot().state; const task = state.tasks[taskId];
    if (!task || !['failed', 'cancelled', 'interrupted'].includes(task.status)) throw new Error('Only stopped unsuccessful tasks can be retried');
    if (this.jobs.has(taskId)) throw new Error('Previous attempt is still cleaning up');
    if (Object.values(state.tasks).some(t => t.parentTaskId === taskId)) throw new Error('Retry of a task with children is not supported; submit a new root task');
    if (task.parentTaskId && terminal(state.tasks[task.parentTaskId]!.status)) throw new Error('Parent already finished; submit a new root task');
    if (Object.values(state.tasks).some(t => t.sessionId === task.sessionId && !terminal(t.status))) throw new Error('Session already active');
    if (state.sessions[task.sessionId]?.closedAt) throw new Error('Agent session is closed');
    const oldConfig = state.runs[task.runIds.at(-1)!]!.config;
    this.store.change('task.retried', {}, s => {
      const current = s.tasks[taskId]!; current.status = 'queued'; delete current.result; delete current.error;
      this.insertTask(s, current, oldConfig.allowedTools);
    }, { taskId });
    this.kick(); const after = this.store.snapshot().state; return after.runs[after.tasks[taskId]!.runIds.at(-1)!]!;
  }
  cancel(taskId: string): void {
    const state = this.store.snapshot().state; if (!state.tasks[taskId]) throw new Error('Unknown task');
    const ids = new Set([taskId]);
    let changed = true;
    while (changed) { changed = false; for (const task of Object.values(state.tasks)) if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) { ids.add(task.id); changed = true; } }
    this.store.change('task.cancel_requested', { taskIds: [...ids] }, s => {
      for (const id of ids) {
        const task = s.tasks[id]!; if (terminal(task.status)) continue;
        task.status = this.controllers.has(id) ? 'cancelling' : 'cancelled';
        const run = s.runs[task.runIds.at(-1)!]!; run.status = task.status;
        if (task.status === 'cancelled') run.finishedAt = new Date().toISOString();
      }
      for (const approval of Object.values(s.approvals)) if (ids.has(approval.taskId) && approval.status === 'pending') approval.status = 'cancelled';
      for (const question of Object.values(s.questions)) if (ids.has(question.taskId) && question.status === 'pending') question.status = 'cancelled';
    }, { taskId });
    for (const id of ids) this.controllers.get(id)?.abort(new Error('Task cancelled'));
    this.kick();
  }
  resolveApproval(id: string, decision: 'approved' | 'denied') {
    const approval = this.store.snapshot().state.approvals[id];
    if (!approval || approval.status !== 'pending') throw new Error('Approval is not pending');
    this.store.change('approval.resolved', { id, decision }, s => { s.approvals[id]!.status = decision; }, { taskId: approval.taskId, runId: approval.runId });
  }
  answerQuestion(id: string, answer: string) {
    const question = this.store.snapshot().state.questions[id];
    if (!question || question.status !== 'pending') throw new Error('Question is not pending');
    if (!answer.trim() || answer.length > 16000) throw new Error('Answer must contain 1–16000 characters');
    this.store.change('question.answered', { id }, s => { s.questions[id]!.answer = answer.trim(); s.questions[id]!.status = 'answered'; }, { taskId: question.taskId, runId: question.runId });
  }
  private async askUser(taskId: string, runId: string, toolCallId: string, input: QuestionInput, signal: AbortSignal) {
    const existing=this.store.select(s=>Object.values(s.questions).find(q=>q.runId===runId&&q.toolCallId===toolCallId));
    const id = existing?.id ?? randomUUID();
    if(!existing)this.store.change('question.requested', { id }, s => {
      s.questions[id] = { ...input, id, taskId, runId, toolCallId, status: 'pending', createdAt: new Date().toISOString() };
      s.tasks[taskId]!.status = 'waiting_user'; s.runs[runId]!.status = 'waiting_user';
    }, { taskId, runId });
    if(this.store.select(state=>state.questions[id]!.status)==='pending')this.setStatus(taskId,'waiting_user');
    await this.waitFor(s => s.questions[id]!.status !== 'pending', signal);
    signal.throwIfAborted(); this.setStatus(taskId, 'running');
    return { answer: this.store.snapshot().state.questions[id]!.answer };
  }
  private kick() {
    if (this.scheduled || this.closing) return; this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.schedule(); });
  }
  private schedule() {
    const {ready, failed} = this.scheduler.select(this.repo.tasks(), new Set(this.jobs.keys()));
    for (const task of failed) this.fail(task.id, 'A dependency did not complete successfully');
    let capacity=(this.options.maxActiveRuns??64)-this.repo.tasks().filter(task=>this.jobs.has(task.id)&&['queued','running'].includes(task.status)).length;
    for (const task of ready) {
      if(capacity<=0)break;
      const executing=this.repo.tasks().filter(item=>item.rootId===task.rootId&&this.jobs.has(item.id)&&['queued','running'].includes(item.status)).length;
      if(executing>=(this.options.maxActivePerRoot??8))continue;
      capacity--;
      this.pool.launch(task.id, controller=>this.executor.execute(task.id,controller), ()=>this.kick());
    }
  }
  private setStatus(taskId: string, status: Task['status']) {
    this.store.change(`run.${status}`, {}, state => {
      const task = state.tasks[taskId]!; if (terminal(task.status) || task.status === 'cancelling') return;
      task.status = status; state.runs[task.runIds.at(-1)!]!.status = status;
    }, { taskId });
    this.kick();
  }
  private fail(taskId: string, error: string) {
    const state = this.store.snapshot().state; if (terminal(state.tasks[taskId]!.status)) return;
    for (const child of Object.values(state.tasks)) if (child.parentTaskId === taskId && !terminal(child.status)) this.cancel(child.id);
    this.store.change('run.failed', { error }, s => {
      const task = s.tasks[taskId]!; task.status = 'failed'; task.error = error;
      const run = s.runs[task.runIds.at(-1)!]!; run.status = 'failed'; run.finishedAt = new Date().toISOString();
      for (const approval of Object.values(s.approvals)) if (approval.taskId === taskId && approval.status === 'pending') approval.status = 'cancelled';
      for (const question of Object.values(s.questions)) if (question.taskId === taskId && question.status === 'pending') question.status = 'cancelled';
    }, { taskId });
    this.kick();
  }
  private meterReview(runId:string):ModelProvider {
    const provider=this.catalog.resolve(this.repo.run(runId).model?.id),repo=this.repo;
    return {async *stream(messages,tools,signal){let usage=0,characters=JSON.stringify(messages).length;
      try{for await(const chunk of provider.stream(messages,tools,signal)){if(chunk.type==='usage')usage=chunk.inputTokens+chunk.outputTokens;else if(chunk.type==='text'||chunk.type==='reasoning')characters+=chunk.text.length;yield chunk;}}
      finally{repo.changeRun(runId,'approval.usage',{},state=>{const budget=state.budgets[state.tasks[state.runs[runId]!.taskId]!.rootId]!;budget.tokensUsed=(budget.tokensUsed??0)+(usage>0&&Number.isFinite(usage)?usage:Math.ceil(characters/3));});}
    }};
  }
  private async executeTool(taskId: string, runId: string, call: ToolCall, workspace: string, signal: AbortSignal): Promise<unknown> {
    const run = this.store.snapshot().state.runs[runId]!;
    if (!run.config.allowedTools.includes(call.name)) throw new Error(`Tool is not allowed: ${call.name}`);
    const tool = this.tools.resolve(call.name); const args: unknown = tool.schema.parse(JSON.parse(call.arguments));
    this.store.change('tool.started', { toolCallId: call.id, name: call.name, arguments: args }, () => {}, { taskId, runId });
    if (tool.approval) {
      const prior=this.store.select(s=>Object.values(s.approvals).find(a=>a.runId===runId&&a.toolCallId===call.id));
      const id = prior?.id ?? randomUUID(); const mode = this.info().approvalMode;
      let decision: { status: 'pending' | 'approved' | 'denied'; reason: string } = {
        status: prior?.status==='approved'?'approved':prior?.status==='denied'?'denied':mode === 'all' ? 'approved' : 'pending', reason: mode === 'all' ? 'Allow all mode' : 'Manual approval required'
      };
      if (mode === 'agent' && !prior) {
        const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        let releaseProfile: (()=>void)|undefined;
        try {
          releaseProfile = await this.gateway.acquire(run.model?.id??'default',reviewSignal);
          const state = this.store.snapshot().state; const task = state.tasks[taskId]!;
          this.store.change('approval.reviewing', { toolCallId: call.id }, s => {
            const budget = s.budgets[task.rootId]!;
            if (budget.stepsUsed >= budget.maxSteps || budget.maxTokens && (budget.tokensUsed??0)>=budget.maxTokens) throw new Error('Model budget exhausted');
            budget.stepsUsed++; s.runs[runId]!.steps++;
          }, { taskId, runId });
          decision = await judgeApproval(this.meterReview(runId), {
            userRequest: state.tasks[task.rootId]!.objective, agentObjective: task.objective,
            workspace, tool: call.name, arguments: args
          }, reviewSignal);
        } catch {
          signal.throwIfAborted();
          decision = { status: 'pending', reason: 'Agent review unavailable; manual approval required' };
        } finally { releaseProfile?.(); }
      }
      signal.throwIfAborted();
      if(prior)decision={status:prior.status==='approved'?'approved':prior.status==='denied'?'denied':'pending',reason:prior.reason??'Saved approval'};
      if(!prior)this.store.change(decision.status === 'pending' ? 'approval.requested' : 'approval.resolved', { approvalId: id, mode, ...decision }, s => {
        s.approvals[id] = { id, taskId, runId, toolCallId: call.id, toolName: call.name, arguments: args, mode, ...decision, createdAt: new Date().toISOString() };
        if (decision.status === 'pending') { s.tasks[taskId]!.status = 'waiting_approval'; s.runs[runId]!.status = 'waiting_approval'; }
      }, { taskId, runId });
      if (decision.status === 'pending') {
        this.setStatus(taskId,'waiting_approval');
        await this.waitFor(s => s.approvals[id]!.status !== 'pending', signal);
        signal.throwIfAborted(); this.setStatus(taskId, 'running');
      }
      if (this.store.snapshot().state.approvals[id]!.status !== 'approved') throw new Error(decision.status === 'denied' ? 'Agent denied this tool call: ' + decision.reason : 'User denied this exact tool call');
    }
    const context = { workspace, signal,
      readSkill: (name: string, resource?: string) => {
        const session = this.store.select(s => s.sessions[s.tasks[taskId]!.sessionId]!);
        return loadSkill(discoverGuidance(session.sourceCwd ?? session.cwd, this.store.root).skills, name, resource);
      },
      ask: (input: QuestionInput) => this.askUser(taskId, runId, call.id, input, signal),
      setTodos: (items: TodoItem[]) => { this.store.change('task.plan_updated', {}, s => { s.tasks[taskId]!.todos = items; }, { taskId, runId }); return { items }; },
      readArtifact: (id: string) => {
        const state = this.store.snapshot().state; const artifact = state.artifacts[id]; const task = state.tasks[taskId]!;
        const owner = artifact ? state.tasks[artifact.taskId] : undefined;
        if (!owner || (owner.sessionId !== task.sessionId && owner.rootId !== task.rootId && !isDescendantSession(state, owner.sessionId, task.sessionId))) throw new Error('Artifact is outside this session or task tree');
        return this.store.readArtifact(id);
      },
      delegate: (input: DelegationInput) => { const child=this.delegate(runId, { ...input, sourceCallId:call.id } as DelegationInput); return {taskId:child.id,sessionId:child.sessionId}; },
      followup: (input: FollowupInput) => {const child=this.followup(input,runId,call.id);return {taskId:child.id,sessionId:child.sessionId};},
      listAgents: () => this.listAgentSessions(this.repo.task(taskId).sessionId),
      interruptAgent: (id: string) => this.interruptAgent(id, taskId),
      closeAgent: (id: string) => this.closeAgent(id,taskId),
      sendAgentMessage: (id: string, content: string) => this.sendAgentMessage(id,content,taskId,runId+':'+call.id),
      sendMessage: (toTaskId: string, content: string) => this.sendMessage(toTaskId,content,taskId,runId+':'+call.id),
      publishArtifact: (content: string, mediaType: string) => this.publishArtifact(taskId,runId,call.id,content,mediaType),
      wait: (ids: string[]) => this.waitChildren(taskId, ids, signal) };
    // Coordination operations never acquire execution permits: they may await children.
    if (['wait_tasks', 'delegate_task', 'followup_task', 'list_agents', 'interrupt_agent', 'close_agent', 'ask_user', 'send_message', 'publish_artifact'].includes(call.name)) return tool.execute(args, context);
    const release = await this.executions.acquire(signal);
    try {
      signal.throwIfAborted();
      this.repo.changeRun(runId,'operation.started',{toolCallId:call.id},state=>{state.runs[runId]!.operations![call.id]={status:'running',name:call.name,readOnly:!!tool.readOnly};});
      return await tool.execute(args, context);
    } finally { release(); }
  }
  private async waitChildren(taskId: string, ids: string[], signal: AbortSignal): Promise<unknown> {
    const state = this.store.snapshot().state;
    if (!ids.length || ids.some(id => state.tasks[id]?.parentTaskId !== taskId)) throw new Error('Can wait only for direct child tasks');
    this.setStatus(taskId, 'waiting_children');
    await this.waitFor(s => ids.every(id => terminal(s.tasks[id]!.status)), signal);
    signal.throwIfAborted(); this.setStatus(taskId, 'running');
    const after = this.store.snapshot().state;
    return taskResults(after, ids);
  }
  private waitFor(predicate: (state: State) => boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolveWait, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      const check = () => { if (predicate(this.store.snapshot().state)) { cleanup(); resolveWait(); } };
      unsubscribe = this.store.subscribe(check); signal.addEventListener('abort', aborted, { once: true }); check();
    });
  }
  async waitUntilDone(taskId: string, timeoutMs = 30000): Promise<Task> {
    if (!this.store.snapshot().state.tasks[taskId]) throw new Error('Unknown task');
    await this.waitFor(s => terminal(s.tasks[taskId]!.status), AbortSignal.timeout(timeoutMs));
    return this.store.snapshot().state.tasks[taskId]!;
  }
  async close() {
    this.closing = true;
    for (const task of Object.values(this.store.snapshot().state.tasks)) if (!task.parentTaskId && !terminal(task.status)) this.cancel(task.id);
    await Promise.allSettled([...this.jobs.values()]);
    await this.integrations.close();
  }
}
