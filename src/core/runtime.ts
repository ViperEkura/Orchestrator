import { ModelRegistry } from '../models/registry.js';
import type { ModelInput } from './domain.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { terminal, approvalModes, type QuestionInput, type TodoItem, type ApprovalMode, type AgentDefinition, type DelegationInput, type Message, type ModelProvider, type Run, type State, type SubmitInput, type Task, type ToolCall } from './domain.js';
import { judgeApproval } from './approval.js';
import { StateStore } from '../storage/store.js';
import { createTools, type ToolRegistry } from '../tools/index.js';
import { prepareWorkspace, projectDirectory } from './workspace.js';

export const defaultAgents: AgentDefinition[] = [
  { id: 'coordinator', name: 'Coordinator', systemPrompt: '[coordinator] Respond in English unless the user explicitly requests another language. You coordinate tasks. Delegate independent work to researcher and reviewer with delegate_task, then wait_tasks and synthesize results. Children share the project read-only by default; request workspace=worktree for code changes in a separate committed-HEAD checkout. Do not claim unperformed actions. Tool errors must be acknowledged.', allowedTools: ['delegate_task', 'wait_tasks', 'list_files', 'read_file', 'write_file', 'run_command', 'grep', 'glob', 'apply_patch', 'ask_user', 'todo_write', 'read_artifact'] },
  { id: 'researcher', name: 'Researcher', systemPrompt: '[researcher] Respond in English unless the user explicitly requests another language. Analyze the assigned task. Produce concrete findings and assumptions. Your session specifies the workspace; only use the tools actually available to you. Do not pretend that a plan was executed.', allowedTools: ['list_files', 'read_file', 'write_file', 'run_command', 'grep', 'glob', 'apply_patch', 'ask_user', 'todo_write', 'read_artifact'] },
  { id: 'reviewer', name: 'Reviewer', systemPrompt: '[reviewer] Respond in English unless the user explicitly requests another language. Review the assigned objective, identify risks and propose verifiable checks. Your session specifies the workspace; only use the tools actually available to you. Distinguish actual tests from suggestions.', allowedTools: ['list_files', 'read_file', 'write_file', 'run_command', 'grep', 'glob', 'apply_patch', 'ask_user', 'todo_write', 'read_artifact'] },
  { id: 'assistant', name: 'Assistant', systemPrompt: '[assistant] You are a helpful coding assistant. Respond directly to the user in English unless they request another language. Maintain conversational context. Use tools only when the request needs them. Do not invent tool results. Answer simple messages yourself. Only delegate when the user requests sub-agents or collaboration, or explicitly authorizes independent parallel work. When child results are supplied, synthesize them without repeating the delegation.', allowedTools: ['list_files', 'read_file', 'write_file', 'run_command', 'grep', 'glob', 'apply_patch', 'ask_user', 'todo_write', 'read_artifact', 'delegate_task', 'wait_tasks'] }
];

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
  modelRegistry?: ModelRegistry;
  maxDepth?: number; runTimeoutMs?: number; agents?: AgentDefinition[]; tools?: ToolRegistry;
}

export class OrchestratorService {
  readonly agents: Map<string, AgentDefinition>;
  readonly tools: ToolRegistry;
  private catalog: ModelRegistry;
  private models: Semaphore;
  private executions: Semaphore;
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();
  private scheduled = false;
  private closing = false;
  constructor(readonly store: StateStore, private provider: ModelProvider, private options: RuntimeOptions) {
    this.catalog = options.modelRegistry ?? new ModelRegistry([{ description: {id:'default', name:options.model ?? 'Custom', model:options.model ?? 'custom', provider:options.provider ?? 'custom'}, create: () => provider }]);
    this.agents = new Map((options.agents ?? defaultAgents).map(agent => [agent.id, agent]));
    this.tools = options.tools ?? createTools();
    this.models = new Semaphore(options.concurrency ?? 3); this.executions = new Semaphore(options.concurrency ?? 3);
    this.options.workspaceDir = projectDirectory(options.workspaceDir);
    this.recover();
  }
  private recover() {
    const state = this.store.snapshot().state;
    if (!Object.values(state.tasks).some(task => !terminal(task.status))) return;
    this.store.change('runtime.recovered', { policy: 'mark interrupted; never replay unknown side effects' }, s => {
      for (const task of Object.values(s.tasks)) if (!terminal(task.status)) { task.status = 'interrupted'; task.error = 'Runtime stopped before task completion'; }
      for (const run of Object.values(s.runs)) if (!terminal(run.status)) { run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); }
      for (const approval of Object.values(s.approvals)) if (approval.status === 'pending') approval.status = 'cancelled';
      for (const question of Object.values(s.questions)) if (question.status === 'pending') question.status = 'cancelled';
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
    if (input.sessionId && Object.values(state.tasks).some(t => t.sessionId === input.sessionId && !terminal(t.status))) throw new Error('Session already has an active task');
    if (input.delegations?.length) {
      if (!this.requireAgent(agentId).allowedTools.includes('delegate_task')) throw new Error('Agent cannot delegate');
      if (input.delegations.length >= (this.options.maxTasks ?? 16)) throw new Error('Task budget exhausted');
      input.delegations.forEach((plan, i) => {
        this.requireAgent(plan.agentId);
        if (!plan.objective.trim() || plan.objective.length > 16000) throw new Error('Invalid delegated objective');
        if (plan.after?.some(index => !Number.isInteger(index) || index < 0 || index >= i)) throw new Error('Dependencies must reference earlier plan entries');
      });
    }
    if (input.sessionId && input.cwd) throw new Error('Existing sessions keep their project directory');
    const cwd = input.cwd ? realpathSync(resolve(input.cwd)) : this.options.workspaceDir;
    if (!statSync(cwd).isDirectory()) throw new Error('Project must be an existing directory');
    const task = this.makeTask(input.objective, agentId, input.sessionId ?? randomUUID());
    if (input.delegations?.length) task.delegations = structuredClone(input.delegations);
    this.store.change('task.created', { objective: task.objective }, s => {
      s.sessions[task.sessionId] ??= { id: task.sessionId, createdAt: task.createdAt, cwd, workspace: 'project' };
      s.budgets[task.id] = { stepsUsed: 0, maxSteps: this.options.maxSteps ?? 40, maxTasks: this.options.maxTasks ?? 16, maxDepth: this.options.maxDepth ?? 3 };
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
  private insertTask(state: State, task: Task, allowedTools?: string[], modelId = this.catalog.selectedId) {
    state.tasks[task.id] = task;
    const definition = structuredClone(this.requireAgent(task.agentId));
    definition.systemPrompt += '\nUse grep/glob to find files, read_file offset/limit to page, apply_patch for exact local edits, read_artifact to page large outputs, ask_user for missing decisions, and todo_write for multi-step plans. Independent read-only calls in the same response can run concurrently; submit dependent calls in separate responses.';
    const session = state.sessions[task.sessionId]!;
    const instructions = resolve(session.sourceCwd ?? session.cwd, 'AGENTS.md');
    if (existsSync(instructions)) definition.systemPrompt += `\n\nProject instructions (AGENTS.md):\n${readFileSync(instructions, 'utf8').slice(0, 64000)}`;
    if (allowedTools) definition.allowedTools = definition.allowedTools.filter(t => allowedTools.includes(t));
    if (state.sessions[task.sessionId]!.workspace === 'read-only') definition.allowedTools = definition.allowedTools.filter(name => this.tools.resolve(name).readOnly);
    const previous = Object.values(state.tasks).filter(t => t.sessionId === task.sessionId && t.id !== task.id && t.status === 'completed');
    const history: Message[] = previous.slice(-8).flatMap(t => {
      const run = state.runs[t.runIds.at(-1)!];
      // Select this turn, excluding the context copied from previous turns.
      const lastUser = run?.messages.findLastIndex(message => message.role === 'user' && message.content === t.objective) ?? -1;
      return run && lastUser >= 0 ? run.messages.slice(lastUser) : [{ role: 'user' as const, content: t.objective }, { role: 'assistant' as const, content: t.result ?? '' }];
    });
    const run: Run = { model: this.catalog.describe(modelId), id: randomUUID(), taskId: task.id, attempt: task.runIds.length + 1, status: 'queued', steps: 0, config: definition,
      messages: [{ role: 'system', content: definition.systemPrompt }, ...history, { role: 'user', content: task.objective }] };
    task.runIds.push(run.id); state.runs[run.id] = run;
  }
  delegate(parentRunId: string, input: DelegationInput): Task {
    const state = this.store.snapshot().state; const parentRun = state.runs[parentRunId];
    if (!parentRun || terminal(parentRun.status)) throw new Error('Parent run is not active');
    const parent = state.tasks[parentRun.taskId]!; const budget = state.budgets[parent.rootId]!;
    if (parent.depth >= budget.maxDepth) throw new Error('Delegation depth budget exhausted');
    if (Object.values(state.tasks).filter(t => t.rootId === parent.rootId).length >= budget.maxTasks) throw new Error('Task budget exhausted');
    this.requireAgent(input.agentId);
    if (!input.objective.trim() || input.objective.length > 16000) throw new Error('Invalid child objective');
    // New tasks can depend only on already-existing siblings: no cycles can be introduced.
    for (const id of input.dependsOn ?? []) if (state.tasks[id]?.parentTaskId !== parent.id) throw new Error('Dependencies must reference existing sibling tasks');
    const task = this.makeTask(input.objective, input.agentId, randomUUID());
    const parentSession = state.sessions[parent.sessionId]!;
    const workspace = input.workspace ?? 'read-only';
    if (parentSession.workspace === 'read-only' && workspace === 'worktree') throw new Error('Read-only agents cannot create writable workspaces');
    if (workspace === 'worktree' && this.store.root === ':memory:') throw new Error('Worktrees require a persistent store directory');
    const cwd = workspace === 'worktree' ? resolve(this.store.root, 'worktrees', task.sessionId) : parentSession.cwd;
    Object.assign(task, { rootId: parent.rootId, parentTaskId: parent.id, depth: parent.depth + 1, dependsOn: [...new Set(input.dependsOn ?? [])] });
    this.store.change('task.created', { parentTaskId: parent.id, objective: task.objective }, s => {
      s.sessions[task.sessionId] = { id: task.sessionId, parentSessionId: parent.sessionId, createdAt: task.createdAt, cwd, workspace, ...(workspace === 'worktree' ? { sourceCwd: parentSession.cwd } : {}) };
      this.insertTask(s, task, parentRun.config.allowedTools, parentRun.model?.id);
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
    const id = randomUUID();
    this.store.change('question.requested', { id }, s => {
      s.questions[id] = { ...input, id, taskId, runId, toolCallId, status: 'pending', createdAt: new Date().toISOString() };
      s.tasks[taskId]!.status = 'waiting_user'; s.runs[runId]!.status = 'waiting_user';
    }, { taskId, runId });
    await this.waitFor(s => s.questions[id]!.status !== 'pending', signal);
    signal.throwIfAborted(); this.setStatus(taskId, 'running');
    return { answer: this.store.snapshot().state.questions[id]!.answer };
  }
  private kick() {
    if (this.scheduled || this.closing) return; this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.schedule(); });
  }
  private schedule() {
    const state = this.store.snapshot().state;
    for (const task of Object.values(state.tasks)) {
      if (task.status !== 'queued' || this.jobs.has(task.id)) continue;
      const dependencies = task.dependsOn.map(id => state.tasks[id]!);
      if (dependencies.some(t => terminal(t.status) && t.status !== 'completed')) { this.fail(task.id, 'A dependency did not complete successfully'); continue; }
      if (!dependencies.every(t => t.status === 'completed')) continue;
      const controller = new AbortController(); this.controllers.set(task.id, controller);
      const job = this.execute(task.id, controller).finally(() => { this.jobs.delete(task.id); this.controllers.delete(task.id); this.kick(); });
      this.jobs.set(task.id, job);
    }
  }
  private setStatus(taskId: string, status: Task['status']) {
    this.store.change(`run.${status}`, {}, state => {
      const task = state.tasks[taskId]!; if (terminal(task.status) || task.status === 'cancelling') return;
      task.status = status; state.runs[task.runIds.at(-1)!]!.status = status;
    }, { taskId });
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
  private async execute(taskId: string, controller: AbortController): Promise<void> {
    const signal = controller.signal; const initial = this.store.snapshot().state;
    const task = initial.tasks[taskId]!; const runId = task.runIds.at(-1)!;
    const session = initial.sessions[task.sessionId]!;
    const workspace = session.cwd;
    const timer = setTimeout(() => controller.abort(new Error('Run deadline exceeded')), this.options.runTimeoutMs ?? 300000);
    try {
      this.store.change('run.started', {}, s => { s.tasks[taskId]!.status = 'running'; s.runs[runId]!.status = 'running'; s.runs[runId]!.startedAt = new Date().toISOString(); }, { taskId, runId });
      await prepareWorkspace(session, signal);
      if (task.dependsOn.length) this.append(runId, { role: 'user', content: `Dependency results: ${JSON.stringify(task.dependsOn.map(id => ({ taskId: id, result: initial.tasks[id]!.result })))}` });
      if (task.delegations?.length) {
        const children: Task[] = [];
        for (const { after, ...plan } of task.delegations) children.push(this.delegate(runId, { ...plan, dependsOn: after?.map(index => children[index]!.id) }));
        const results = await this.waitChildren(taskId, children.map(child => child.id), signal);
        this.append(runId, { role: 'user', content: 'The requested child tasks have finished. Synthesize their results; do not launch the same tasks again.\n' + JSON.stringify(results) });
      }
      while (true) {
        signal.throwIfAborted();
        const release = await this.models.acquire(signal);
        let text = ''; let reasoningContent = ''; const calls: ToolCall[] = [];
        try {
          signal.throwIfAborted();
          this.store.change('run.step', {}, s => {
            const budget = s.budgets[task.rootId]!;
            if (budget.stepsUsed >= budget.maxSteps) throw new Error('Shared model-step budget exhausted');
            budget.stepsUsed++; s.runs[runId]!.steps++;
          }, { taskId, runId });
          const run = this.store.snapshot().state.runs[runId]!;
          if (JSON.stringify(run.messages).length > 240000) throw new Error('Context size limit exceeded; start a new session or reduce tool output');
          for await (const chunk of this.catalog.resolve(run.model?.id).stream(run.messages, this.tools.specs(run.config.allowedTools), signal)) {
            signal.throwIfAborted();
            if (chunk.type === 'reasoning') {
              reasoningContent += chunk.text;
              if (reasoningContent.length > 128000) throw new Error('Reasoning size limit exceeded');
              this.store.emit('message.thinking', { text: chunk.text }, { taskId, runId });
            } else if (chunk.type === 'text') {
              text += chunk.text;
              if (text.length > 128000) throw new Error('Model output size limit exceeded');
              this.store.emit('message.delta', { text: chunk.text }, { taskId, runId });
            } else { calls.push(chunk.call); if (calls.length > 32 || calls.reduce((n, c) => n + c.arguments.length, 0) > 256000) throw new Error('Tool call size limit exceeded'); }
          }
        } finally { release(); }
        this.append(runId, { role: 'assistant', content: text, ...(reasoningContent ? { reasoningContent } : {}), ...(calls.length ? { toolCalls: calls } : {}) });
        if (!calls.length) {
          const children = Object.values(this.store.snapshot().state.tasks).filter(t => t.parentTaskId === taskId);
          if (children.some(t => !terminal(t.status))) await this.waitChildren(taskId, children.map(t => t.id), signal);
          const after = this.store.snapshot().state;
          if (children.some(t => after.tasks[t.id]!.status !== 'completed')) throw new Error('One or more child tasks failed or were cancelled');
          signal.throwIfAborted();
          const artifactId = randomUUID();
          const artifact = this.store.saveArtifact(taskId, runId, artifactId, text, 'text/markdown');
          this.store.change('run.completed', { artifactId, result: text }, s => {
            s.tasks[taskId]!.status = 'completed'; s.tasks[taskId]!.result = text;
            s.runs[runId]!.status = 'completed'; s.runs[runId]!.finishedAt = new Date().toISOString();
            s.artifacts[artifactId] = artifact;
          }, { taskId, runId });
          return;
        }
        await this.executeCalls(taskId, runId, calls, workspace, signal);
      }
    } catch (error) {
      if (this.store.snapshot().state.tasks[taskId]!.status === 'cancelling') {
        // Finish cancellation only after in-flight execution and descendant jobs have settled.
        const children = Object.values(this.store.snapshot().state.tasks).filter(t => t.parentTaskId === taskId);
        await Promise.allSettled(children.flatMap(t => { const job = this.jobs.get(t.id); return job ? [job] : []; }));
        this.store.change('run.cancelled', {}, s => {
          s.tasks[taskId]!.status = 'cancelled'; s.runs[runId]!.status = 'cancelled'; s.runs[runId]!.finishedAt = new Date().toISOString();
        }, { taskId, runId });
      } else this.fail(taskId, error instanceof Error ? error.message : String(error));
    }
    finally { clearTimeout(timer); }
  }
  private append(runId: string, message: Message) {
    const taskId = this.store.snapshot().state.runs[runId]!.taskId;
    this.store.change('message.completed', { message }, s => { s.runs[runId]!.messages.push(message); }, { taskId, runId });
  }
  private async executeCalls(taskId: string, runId: string, calls: ToolCall[], workspace: string, signal: AbortSignal) {
    const parallel = (call: ToolCall) => { try { const tool = this.tools.resolve(call.name); return tool.parallelSafe && tool.readOnly && !tool.approval; } catch { return false; } };
    for (let index = 0; index < calls.length;) {
      const batch = [calls[index++]!];
      if (parallel(batch[0]!)) while (index < calls.length && parallel(calls[index]!)) batch.push(calls[index++]!);
      const results = await Promise.allSettled(batch.map(call => this.executeTool(taskId, runId, call, workspace, signal)));
      signal.throwIfAborted();
      for (let i = 0; i < batch.length; i++) {
        const call = batch[i]!; const outcome = results[i]!;
        const result = outcome.status === 'fulfilled' ? outcome.value : { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
        const full = JSON.stringify(result) ?? 'null'; let content = full;
        if (full.length > 24000) {
          const artifactId = randomUUID(); const artifact = this.store.saveArtifact(taskId, runId, artifactId, full, 'application/json');
          this.store.change('artifact.created', { artifactId }, s => { s.artifacts[artifactId] = artifact; }, { taskId, runId });
          const metadata = result && typeof result === 'object' ? Object.fromEntries(Object.entries(result).filter(([key]) => ['error', 'exitCode', 'timedOut', 'outputLimitReached'].includes(key))) : {};
          content = JSON.stringify({ ...metadata, truncated: true, artifactId, preview: full.slice(0, 16000) });
        }
        this.append(runId, { role: 'tool', toolCallId: call.id, content });
        this.store.change('tool.completed', { toolCallId: call.id, name: call.name, result: JSON.parse(content) }, () => {}, { taskId, runId });
      }
    }
  }
  private async executeTool(taskId: string, runId: string, call: ToolCall, workspace: string, signal: AbortSignal): Promise<unknown> {
    const run = this.store.snapshot().state.runs[runId]!;
    if (!run.config.allowedTools.includes(call.name)) throw new Error(`Tool is not allowed: ${call.name}`);
    const tool = this.tools.resolve(call.name); const args: unknown = tool.schema.parse(JSON.parse(call.arguments));
    this.store.change('tool.started', { toolCallId: call.id, name: call.name, arguments: args }, () => {}, { taskId, runId });
    if (tool.approval) {
      const id = randomUUID(); const mode = this.info().approvalMode;
      let decision: { status: 'pending' | 'approved' | 'denied'; reason: string } = {
        status: mode === 'all' ? 'approved' : 'pending', reason: mode === 'all' ? 'Allow all mode' : 'Manual approval required'
      };
      if (mode === 'agent') {
        const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        let release: (() => void) | undefined;
        try {
          release = await this.models.acquire(reviewSignal);
          const state = this.store.snapshot().state; const task = state.tasks[taskId]!;
          this.store.change('approval.reviewing', { toolCallId: call.id }, s => {
            const budget = s.budgets[task.rootId]!;
            if (budget.stepsUsed >= budget.maxSteps) throw new Error('Model-step budget exhausted');
            budget.stepsUsed++; s.runs[runId]!.steps++;
          }, { taskId, runId });
          decision = await judgeApproval(this.catalog.resolve(run.model?.id), {
            userRequest: state.tasks[task.rootId]!.objective, agentObjective: task.objective,
            workspace, tool: call.name, arguments: args
          }, reviewSignal);
        } catch {
          signal.throwIfAborted();
          decision = { status: 'pending', reason: 'Agent review unavailable; manual approval required' };
        } finally { release?.(); }
      }
      signal.throwIfAborted();
      this.store.change(decision.status === 'pending' ? 'approval.requested' : 'approval.resolved', { approvalId: id, mode, ...decision }, s => {
        s.approvals[id] = { id, taskId, runId, toolCallId: call.id, toolName: call.name, arguments: args, mode, ...decision, createdAt: new Date().toISOString() };
        if (decision.status === 'pending') { s.tasks[taskId]!.status = 'waiting_approval'; s.runs[runId]!.status = 'waiting_approval'; }
      }, { taskId, runId });
      if (decision.status === 'pending') {
        await this.waitFor(s => s.approvals[id]!.status !== 'pending', signal);
        signal.throwIfAborted(); this.setStatus(taskId, 'running');
      }
      if (this.store.snapshot().state.approvals[id]!.status !== 'approved') throw new Error(decision.status === 'denied' ? 'Agent denied this tool call: ' + decision.reason : 'User denied this exact tool call');
    }
    const context = { workspace, signal,
      ask: (input: QuestionInput) => this.askUser(taskId, runId, call.id, input, signal),
      setTodos: (items: TodoItem[]) => { this.store.change('task.plan_updated', {}, s => { s.tasks[taskId]!.todos = items; }, { taskId, runId }); return { items }; },
      readArtifact: (id: string) => {
        const state = this.store.snapshot().state; const artifact = state.artifacts[id]; const task = state.tasks[taskId]!;
        const owner = artifact ? state.tasks[artifact.taskId] : undefined;
        if (!owner || (owner.sessionId !== task.sessionId && owner.rootId !== task.rootId)) throw new Error('Artifact is outside this session or task tree');
        return this.store.readArtifact(id);
      },
      delegate: (input: DelegationInput) => ({ taskId: this.delegate(runId, input).id }),
      wait: (ids: string[]) => this.waitChildren(taskId, ids, signal) };
    // Coordination operations never acquire execution permits: they may await children.
    if (['wait_tasks', 'delegate_task', 'ask_user'].includes(call.name)) return tool.execute(args, context);
    const release = await this.executions.acquire(signal);
    try { signal.throwIfAborted(); return await tool.execute(args, context); } finally { release(); }
  }
  private async waitChildren(taskId: string, ids: string[], signal: AbortSignal): Promise<unknown> {
    const state = this.store.snapshot().state;
    if (!ids.length || ids.some(id => state.tasks[id]?.parentTaskId !== taskId)) throw new Error('Can wait only for direct child tasks');
    this.setStatus(taskId, 'waiting_children');
    await this.waitFor(s => ids.every(id => terminal(s.tasks[id]!.status)), signal);
    signal.throwIfAborted(); this.setStatus(taskId, 'running');
    const after = this.store.snapshot().state;
    return ids.map(id => ({ taskId: id, status: after.tasks[id]!.status, result: after.tasks[id]!.result, error: after.tasks[id]!.error }));
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
  }
}
