import { mkdir, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { DelegationInput, ToolSpec } from './domain.js';

export interface ToolContext {
  workspace: string; signal: AbortSignal;
  delegate(input: DelegationInput): { taskId: string };
  wait(taskIds: string[]): Promise<unknown>;
}
export interface Tool {
  name: string; description: string; schema: z.ZodType; approval: boolean; readOnly?: boolean;
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

/** Reject traversal and all existing symlink/junction components. Not an OS sandbox. */
export async function safePath(workspace: string, input: string): Promise<string> {
  if (isAbsolute(input) || input.includes(':')) throw new Error('Only relative workspace paths are allowed');
  const root = await realpath(workspace); const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes workspace');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks and junctions are not permitted'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}

export function createTools(): ToolRegistry {
  const registry = new ToolRegistry();
  const add = <T extends z.ZodType>(name: string, description: string, schema: T, approval: boolean,
    execute: (args: z.infer<T>, ctx: ToolContext) => Promise<unknown>) => {
    registry.register({ name, description, schema, approval, readOnly: !approval, execute: (args, ctx) => execute(schema.parse(args), ctx) });
  };
  add('delegate_task', 'Delegate a subtask. Default: read-only access to the project. Choose worktree for an independent writable checkout of committed HEAD; Git repository required.',
    z.object({ agentId: z.string(), objective: z.string().min(1).max(16000), dependsOn: z.array(z.string()).max(16).optional(), workspace: z.enum(['read-only', 'worktree']).optional() }).strict(), false,
    async (args, ctx) => ctx.delegate(args));
  add('wait_tasks', 'Wait for delegated tasks and retrieve their results. No execution slot is held while waiting.',
    z.object({ taskIds: z.array(z.string()).min(1).max(16) }).strict(), false, (args, ctx) => ctx.wait(args.taskIds));
  add('list_files', 'List files in this task workspace.', z.object({}).strict(), false,
    async (_args, ctx) => ({ files: await readdir(ctx.workspace) }));
  add('read_file', 'Read a UTF-8 file in this task workspace, up to 128 KiB.',
    z.object({ path: z.string().min(1).max(500) }).strict(), false, async (args, ctx) => {
      const path = await safePath(ctx.workspace, args.path);
      if ((await lstat(path)).size > 131072) throw new Error('File exceeds 128 KiB');
      return { content: await readFile(path, { encoding: 'utf8', signal: ctx.signal }) };
    });
  add('write_file', 'Write a UTF-8 file in this task workspace. Requires human approval.',
    z.object({ path: z.string().min(1).max(500), content: z.string().max(131072) }).strict(), true, async (args, ctx) => {
      const path = await safePath(ctx.workspace, args.path);
      const { dirname } = await import('node:path'); await mkdir(dirname(path), { recursive: true });
      await safePath(ctx.workspace, args.path); ctx.signal.throwIfAborted();
      await writeFile(path, args.content, { encoding: 'utf8', signal: ctx.signal }); return { written: args.path };
    });
  add('run_command', 'Run a shell command on the HOST in this workspace. NOT sandboxed. Requires approval.',
    z.object({ command: z.string().min(1).max(8000), timeoutMs: z.number().int().min(100).max(60000).default(30000) }).strict(), true,
    (args, ctx) => runCommand(args.command, ctx.workspace, args.timeoutMs, ctx.signal));
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
    let output = ''; let stopped = false;
    const append = (data: Buffer) => { output = (output + data.toString('utf8')).slice(-32000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const stop = () => {
      stopped = true;
      if (!child.pid) return;
      if (windows) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(stop, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); if (signal.aborted) reject(signal.reason); else resolveResult({ exitCode: code, timedOut: stopped, output }); });
    if (signal.aborted) stop();
  });
}
