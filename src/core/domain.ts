export type Status = 'queued' | 'running' | 'waiting_approval' | 'waiting_user' | 'waiting_children' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review' | 'waiting_review';
export const terminal = (status: Status) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export interface AgentDefinition {
  id: string; name: string; description?: string; systemPrompt: string; allowedTools: string[];
}
export type ConversationFolder = 'inbox' | 'archive' | 'trash';
export type ConversationAction = {action:'rename'; title:string} | {action:'pin'; value:boolean} | {action:'move'; folder:ConversationFolder};
export interface Session {
  title?: string; pinned?: boolean; folder?: ConversationFolder;
  id: string; parentSessionId?: string; createdAt: string; cwd: string;
  baseCommit?: string; closedAt?: string; mailbox?: AgentMessage[];
  workspace: 'project' | 'read-only' | 'worktree'; sourceCwd?: string;
}
export interface AgentMessage { id: string; fromTaskId?: string; sessionId: string; content: string; createdAt: string; deliveredRunId?: string }
export interface AgentSessionInfo { sessionId: string; parentSessionId: string; agentId: string; status: 'idle' | 'running' | 'waiting' | 'closed'; taskId: string; taskStatus: Status; pendingMessages: number }
export interface FollowupInput extends TaskPolicy { sessionId: string; objective: string; dependsOn?: string[] }
export interface TaskPolicy { priority?: number; acceptanceCriteria?: string[]; requiredCapabilities?: string[]; inputArtifactIds?: string[]; modelId?: string; reviewRequired?: boolean }
export interface TaskMessage { id: string; fromTaskId?: string; toTaskId: string; content: string; createdAt: string; deliveredAt?: string }
export interface Operation { status: 'running' | 'completed'; name: string; readOnly: boolean; content?: string }
export interface Checkpoint { phase: 'model' | 'tools' | 'finalize' | 'done'; initialized?: boolean; dependenciesAdded?: boolean; receivedChildIds?: string[]; children?: string[] }
export interface Lease { workerId: string; generation: number; expiresAt: string }
export interface Review { status: 'pending' | 'accepted' | 'rejected'; note?: string; artifactIds: string[]; at: string }
export interface DelegationInput extends TaskPolicy { agentId: string; objective: string; dependsOn?: string[]; workspace?: 'read-only' | 'worktree' }
export type DelegationPlan = Omit<DelegationInput, 'dependsOn'> & { after?: number[] };
export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  source?: 'agent_message'; reasoningContent?: string; toolCalls?: ToolCall[]; toolCallId?: string;
}
export interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface QuestionInput { question: string; options?: string[] }
export interface UserQuestion extends QuestionInput { id: string; taskId: string; runId: string; toolCallId: string; status: 'pending' | 'answered' | 'cancelled'; answer?: string; createdAt: string }
export interface Task extends TaskPolicy {
  integration?: {status:'running'|'ready'|'failed'|'conflict'|'applying'|'applied'|'interrupted';commit:string;base:string;path:string;testCommand:string;head?:string;artifactId?:string;error?:string};
  sourceCallId?: string; paused?: boolean; review?: Review;
  todos?: TodoItem[];
  id: string; rootId: string; parentTaskId?: string; sessionId: string;
  objective: string; delegations?: DelegationPlan[]; agentId: string; depth: number; dependsOn: string[];
  status: Status; runIds: string[]; result?: string; error?: string; createdAt: string;
}
export interface Run {
  checkpoint?: Checkpoint; operations?: Record<string, Operation>; lease?: Lease; inbox?: TaskMessage[];
  model?: ModelDescriptor;
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
export interface Budget { tokensUsed?: number; maxTokens?: number; stepsUsed: number; maxSteps: number; maxTasks: number; maxDepth: number }
export interface State {
  questions: Record<string, UserQuestion>; sessions: Record<string, Session>; tasks: Record<string, Task>; runs: Record<string, Run>;
  approvals: Record<string, Approval>; artifacts: Record<string, Artifact>; budgets: Record<string, Budget>;
}
export interface RuntimeEvent {
  seq: number; type: string; at: string; taskId?: string; runId?: string; sessionId?: string; data: unknown; transient?: true;
}
export interface Snapshot { state: State; lastSeq: number }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export type ModelChunk = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool'; call: ToolCall } | { type: 'usage'; inputTokens: number; outputTokens: number };
export interface ModelProvider {
  stream(messages: Message[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ModelChunk>;
}
export interface ModelDescriptor { id: string; name: string; model: string; provider: string }
export interface ModelInput { name?: string; baseUrl: string; model: string; apiKey: string }
export interface SubmitInput extends TaskPolicy { cwd?: string; delegations?: DelegationPlan[]; objective: string; agentId?: string; sessionId?: string }
