import { taskPolicyShape } from '../core/tasks/schema.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { safePath } from './paths.js';
import { registerFileTools } from './filesystem.js';
export { safePath } from './paths.js';
import { runCommand } from './command.js';
import { ToolRegistry, type ToolContext } from './registry.js';
import { z } from 'zod';
export { ToolRegistry, type Tool, type ToolContext } from './registry.js';
export { runCommand } from './command.js';

export function createTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registerFileTools(registry);
  const add = <T extends z.ZodType>(name: string, description: string, schema: T, approval: boolean,
    execute: (args: z.infer<T>, ctx: ToolContext) => Promise<unknown>) => {
    registry.register({ name, description, schema, approval, readOnly: !approval, execute: (args, ctx) => execute(schema.parse(args), ctx) });
  };
  add('read_skill', 'Load the SKILL.md instructions for a named skill from the available catalog, or a Markdown/text resource relative to its bundle.', z.object({name:z.string().min(1).max(64), resource:z.string().min(1).max(500).optional()}).strict(), false,
    async ({name,resource}, ctx) => { if (!ctx.readSkill) throw new Error('Skills unavailable'); return ctx.readSkill(name, resource); });
  add('delegate_task', 'Delegate a bounded task to an independent agent session. Include necessary context in objective; parent history is not inherited. Use acceptanceCriteria and dependsOn as needed. Default: read-only access to the project. Choose worktree for an independent writable checkout of committed HEAD; Git repository required.',
    z.object({ ...taskPolicyShape, agentId: z.string(), objective: z.string().min(1).max(16000), dependsOn: z.array(z.string()).max(256).optional(), workspace: z.enum(['read-only', 'worktree']).optional() }).strict(), false,
    async (args, ctx) => ctx.delegate(args));
  add('followup_task', 'Assign new work to an idle child agent session. Retains its own context and workspace; creates a new task. Busy agents accept messages instead. Returns taskId for wait_tasks and sessionId for future reuse.',
    z.object({...taskPolicyShape,sessionId:z.string().min(1),objective:z.string().trim().min(1).max(16000),dependsOn:z.array(z.string()).max(256).optional()}).strict(),false,async(args,ctx)=>{if(!ctx.followup)throw new Error('Follow-up unavailable');return ctx.followup(args);});
  add('list_agents', 'List child agent sessions owned by this conversation, including idle or closed agents and their latest task IDs.',z.object({}).strict(),false,async(_args,ctx)=>ctx.listAgents?.() ?? []);
  add('interrupt_agent', 'Cancel the specified task of a child agent and its dependent child tasks. Its session stays available for followup_task.', z.object({taskId:z.string().min(1)}).strict(), false,
    async ({taskId}, ctx) => { if (!ctx.interruptAgent) throw new Error('Agent interruption unavailable'); return ctx.interruptAgent(taskId); });
  add('close_agent', 'Explicitly close a child agent session and its descendants, cancel active tasks and retain history. Closed agents cannot receive new tasks.',z.object({sessionId:z.string().min(1)}).strict(),false,async(args,ctx)=>{if(!ctx.closeAgent)throw new Error('Agent close unavailable');return ctx.closeAgent(args.sessionId);});
  add('wait_tasks', 'Wait for delegated tasks and retrieve bounded result previews, status and resultArtifactId. Use read_artifact for complete reports. No execution slot is held while waiting.',
    z.object({ taskIds: z.array(z.string()).min(1).max(256) }).strict(), false, (args, ctx) => ctx.wait(args.taskIds));
  add('send_message', 'Send a message to an active taskId, or to a child sessionId (including idle agents). Session messages persist until the next model step. Sending a message does not start a task; use followup_task to wake idle agents.',
    z.object({taskId:z.string().min(1).optional(),sessionId:z.string().min(1).optional(),content:z.string().trim().min(1).max(16000)}).strict().refine(value=>!!value.taskId!==!!value.sessionId,'Provide taskId or sessionId'),false,
    async(args,ctx)=>{if(args.sessionId){if(!ctx.sendAgentMessage)throw new Error('Agent messaging unavailable');return ctx.sendAgentMessage(args.sessionId,args.content);}if(!ctx.sendMessage)throw new Error('Messaging unavailable');return ctx.sendMessage(args.taskId!,args.content);});
  add('publish_artifact', 'Publish a result, patch or evidence for this task. Returns an artifact ID; does not approve or merge changes.',
    z.object({content:z.string().max(131072),mediaType:z.enum(['text/plain','text/markdown','text/x-diff','application/json']).default('text/plain')}).strict(),false,
    async(args,ctx)=>{if(!ctx.publishArtifact)throw new Error('Artifacts unavailable');return ctx.publishArtifact(args.content,args.mediaType);});
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
