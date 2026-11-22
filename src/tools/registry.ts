import { z } from 'zod';
import type { FollowupInput, DelegationInput, QuestionInput, TodoItem, ToolSpec } from '../core/domain.js';

export interface ToolContext {
  workspace: string; signal: AbortSignal;
  followup?(input: FollowupInput): unknown; listAgents?(): unknown; closeAgent?(sessionId: string): unknown; sendAgentMessage?(sessionId: string, content: string): unknown;
  sendMessage?(taskId: string, content: string): unknown;
  publishArtifact?(content: string, mediaType: string): unknown;
  ask?(input: QuestionInput): Promise<unknown>;
  setTodos?(items: TodoItem[]): unknown;
  interruptAgent?(taskId: string): unknown;
  readSkill?(name: string, resource?: string): unknown;
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
