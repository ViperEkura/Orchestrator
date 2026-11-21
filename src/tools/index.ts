import { mkdir, writeFile } from 'node:fs/promises';
import { safePath } from './paths.js';
import { registerFileTools } from './filesystem.js';
export { safePath } from './paths.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { DelegationInput, QuestionInput, TodoItem, ToolSpec } from '../core/domain.js';

export interface ToolContext {
  workspace: string; signal: AbortSignal;
  ask?(input: QuestionInput): Promise<unknown>;
  setTodos?(items: TodoItem[]): unknown;
  readArtifact?(id: string): string;
  delegate(input: DelegationInput): { taskId: string };
  wait(taskIds: string[]): Promise<unknown>;
}
export interface Tool {
  name: string; description: string; schema: z.ZodType; approval: boolean; readOnly?: boolean; parallelSafe?: boolean;
  execute(args: unknown, context: ToolContext): Promise<unknown>;
}
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(tool: Tool) { if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`); this.tools.set(tool.name, tool); }
  resolve(name: string): Tool { const tool = this.tools.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`); return tool; }
  specs(allowed: string[]): ToolSpec[] {
    return allowed.map(name => { const t = this.resolve(name); return { name, description: t.description, parameters: z.toJSONSchema(t.schema) }; });
  }
}

export function createTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registerFileTools(registry);
  const add = <T extends z.ZodType>(name: string, description: string, schema: T, approval: boolean,
    execute: (args: z.infer<T>, ctx: ToolContext) => Promise<unknown>) => {
    registry.register({ name, description, schema, approval, readOnly: !approval, execute: (args, ctx) => execute(schema.parse(args), ctx) });
  };
  add('delegate_task', 'Delegate a subtask. Default: read-only access to the project. Choose worktree for an independent writable checkout of committed HEAD; Git repository required.',
    z.object({ agentId: z.string(), objective: z.string().min(1).max(16000), dependsOn: z.array(z.string()).max(16).optional(), workspace: z.enum(['read-only', 'worktree']).optional() }).strict(), false,
    async (args, ctx) => ctx.delegate(args));
  add('wait_tasks', 'Wait for delegated tasks and retrieve their results. No execution slot is held while waiting.',
    z.object({ taskIds: z.array(z.string()).min(1).max(16) }).strict(), false, (args, ctx) => ctx.wait(args.taskIds));
  add('write_file', 'Write a UTF-8 file in this task workspace. Subject to the configured approval mode.',
    z.object({ path: z.string().min(1).max(500), content: z.string().max(131072) }).strict(), true, async (args, ctx) => {
      const path = await safePath(ctx.workspace, args.path);
      const { dirname } = await import('node:path'); await mkdir(dirname(path), { recursive: true });
      await safePath(ctx.workspace, args.path); ctx.signal.throwIfAborted();
      await writeFile(path, args.content, { encoding: 'utf8', signal: ctx.signal }); return { written: args.path };
    });
  add('run_command', 'Run a shell command on the HOST in this workspace. NOT sandboxed. Requires approval.',
    z.object({ command: z.string().min(1).max(8000), timeoutMs: z.number().int().min(100).max(60000).default(30000) }).strict(), true,
    (args, ctx) => runCommand(args.command, ctx.workspace, args.timeoutMs, ctx.signal));
  add('ask_user', 'Ask the user one question and wait for their answer. Optional choices still allow a custom answer. Approval modes never auto-answer.',
    z.object({ question: z.string().trim().min(1).max(2000), options: z.array(z.string().trim().min(1).max(200)).min(2).max(6).optional() }).strict(), false,
    async (args, ctx) => { if (!ctx.ask) throw new Error('Questions unavailable'); return ctx.ask(args); });
  add('todo_write', 'Replace the current task plan with pending, in_progress or completed items. At most one item may be in progress.',
    z.object({ items: z.array(z.object({ text: z.string().trim().min(1).max(500), status: z.enum(['pending', 'in_progress', 'completed']) }).strict()).max(50).refine(items => items.filter(i => i.status === 'in_progress').length <= 1) }).strict(), false,
    async (args, ctx) => { if (!ctx.setTodos) throw new Error('Plans unavailable'); return ctx.setTodos(args.items); });
  registry.register({ name: 'read_artifact', description: 'Read a saved tool output in character pages. Limited to this session or task tree.', approval: false, readOnly: true, parallelSafe: true,
    schema: z.object({ artifactId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20000).default(12000) }).strict(),
    async execute(input, ctx) { const args = this.schema.parse(input) as { artifactId: string; offset: number; limit: number };
      if (!ctx.readArtifact) throw new Error('Artifacts unavailable'); const content = ctx.readArtifact(args.artifactId);
      return { content: content.slice(args.offset, args.offset + args.limit), totalCharacters: content.length, nextOffset: args.offset + args.limit < content.length ? args.offset + args.limit : null };
    } });
  return registry;
}

export function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const windows = process.platform === 'win32';
    // Do not pass model API credentials or API bearer tokens to child processes.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
      { cwd, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let outputLimitReached = false; let timedOut = false;
    const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
    const append = (data: Buffer, decoder: StringDecoder) => {
      if (outputLimitReached) return; output += decoder.write(data);
      if (output.length > 8 * 1024 * 1024) { output = output.slice(0, 8 * 1024 * 1024); outputLimitReached = true; stop(); }
    };
    child.stdout.on('data', data => append(data, stdoutDecoder)); child.stderr.on('data', data => append(data, stderrDecoder));
    const stop = () => {
      if (!child.pid) return;
      if (windows) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); if (signal.aborted) reject(signal.reason); else { if (!outputLimitReached) output += stdoutDecoder.end() + stderrDecoder.end(); resolveResult({ exitCode: code, timedOut, outputLimitReached, output }); } });
    if (signal.aborted) stop();
  });
}
