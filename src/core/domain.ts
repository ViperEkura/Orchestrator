export type Status = 'queued' | 'running' | 'waiting_approval' | 'waiting_user' | 'waiting_children' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export const terminal = (status: Status) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export interface AgentDefinition {
  id: string; name: string; systemPrompt: string; allowedTools: string[];
}
export interface Session {
  id: string; parentSessionId?: string; createdAt: string; cwd: string;
  workspace: 'project' | 'read-only' | 'worktree'; sourceCwd?: string;
}
export interface DelegationInput { agentId: string; objective: string; dependsOn?: string[]; workspace?: 'read-only' | 'worktree' }
export type DelegationPlan = Omit<DelegationInput, 'dependsOn'> & { after?: number[] };
export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  reasoningContent?: string; toolCalls?: ToolCall[]; toolCallId?: string;
}
export interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface QuestionInput { question: string; options?: string[] }
export interface UserQuestion extends QuestionInput { id: string; taskId: string; runId: string; toolCallId: string; status: 'pending' | 'answered' | 'cancelled'; answer?: string; createdAt: string }
export interface Task {
  todos?: TodoItem[];
  id: string; rootId: string; parentTaskId?: string; sessionId: string;
  objective: string; delegations?: DelegationPlan[]; agentId: string; depth: number; dependsOn: string[];
  status: Status; runIds: string[]; result?: string; error?: string; createdAt: string;
}
export interface Run {
  id: string; taskId: string; attempt: number; status: Status; steps: number;
  messages: Message[]; config: AgentDefinition; startedAt?: string; finishedAt?: string;
}
export const approvalModes = ['manual', 'agent', 'all'] as const;
export type ApprovalMode = typeof approvalModes[number];
export interface Approval {
  id: string; taskId: string; runId: string; toolCallId: string;
  toolName: string; arguments: unknown; status: 'pending' | 'approved' | 'denied' | 'cancelled';
  mode?: ApprovalMode; reason?: string;
  createdAt: string;
}
export interface Artifact { id: string; runId: string; taskId: string; path: string; mediaType: string }
export interface Budget { stepsUsed: number; maxSteps: number; maxTasks: number; maxDepth: number }
export interface State {
  questions: Record<string, UserQuestion>; sessions: Record<string, Session>; tasks: Record<string, Task>; runs: Record<string, Run>;
  approvals: Record<string, Approval>; artifacts: Record<string, Artifact>; budgets: Record<string, Budget>;
}
export interface RuntimeEvent {
  seq: number; type: string; at: string; taskId?: string; runId?: string; sessionId?: string; data: unknown; transient?: true;
}
export interface Snapshot { state: State; lastSeq: number }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export type ModelChunk = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool'; call: ToolCall };
export interface ModelProvider {
  stream(messages: Message[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ModelChunk>;
}
export interface SubmitInput { cwd?: string; delegations?: DelegationPlan[]; objective: string; agentId?: string; sessionId?: string }
