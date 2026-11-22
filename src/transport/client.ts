import { readSSE, pause } from './sse.js';
import type { AgentSessionInfo, AgentMessage, FollowupInput, AgentDefinition, ModelDescriptor, ModelInput, ApprovalMode, Run, RuntimeEvent, Snapshot, SubmitInput, Task } from '../core/domain.js';

export class OrchestratorClient {
  constructor(readonly url: string, private token?: string) {}
  private headers() { return { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }; }
  private async request<T>(path: string, body?: unknown, timeoutMs=15000): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
    return data as T;
  }
  info(): Promise<{ cwd: string; model: string; modelId?: string; provider: string; defaultAgent: string; approvalMode: ApprovalMode }> { return this.request('/v1/info'); }
  setApprovalMode(mode: ApprovalMode): ReturnType<OrchestratorClient['info']> { return this.request('/v1/approval-mode', { mode }); }
  models(): Promise<ModelDescriptor[]> { return this.request('/v1/models'); }
  setModel(id: string): ReturnType<OrchestratorClient['info']> { return this.request('/v1/model', {id}); }
  addModel(profile: ModelInput): Promise<ModelDescriptor> { return this.request('/v1/models', profile); }
  agents(): Promise<AgentDefinition[]> { return this.request('/v1/agents'); }
  manageConversation(id:string, action:import('../core/domain.js').ConversationAction):Promise<{ok:boolean}> {
    return this.request('/v1/conversations/'+encodeURIComponent(id),action);
  }
  agentSessions(parentSessionId?:string):Promise<AgentSessionInfo[]> {return this.request('/v1/agent-sessions'+(parentSessionId?'?parentSessionId='+encodeURIComponent(parentSessionId):''));}
  followup(input:FollowupInput):Promise<Task> {const {sessionId,...body}=input;return this.request('/v1/agent-sessions/'+encodeURIComponent(sessionId)+'/followup',body);}
  agentMessage(sessionId:string,content:string,id?:string):Promise<AgentMessage> {return this.request('/v1/agent-sessions/'+encodeURIComponent(sessionId)+'/message',{content,...(id?{id}:{})});}
  closeAgent(sessionId:string):Promise<{ok:boolean}> {return this.request('/v1/agent-sessions/'+encodeURIComponent(sessionId)+'/close',{});}
  artifact(id: string, offset = 0): Promise<{ content: string; total: number; nextOffset: number | null }> { return this.request(`/v1/artifacts/${encodeURIComponent(id)}?offset=${offset}`); }
  snapshot(): Promise<Snapshot> { return this.request('/v1/snapshot'); }
  submit(input: SubmitInput): Promise<Task> { return this.request('/v1/tasks', input); }
  cancel(taskId: string): Promise<{ ok: boolean }> { return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {}); }
  integrate(taskId:string,testCommand:string):Promise<NonNullable<Task['integration']>>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/integrate',{testCommand},300000);}
  applyIntegration(taskId:string):Promise<NonNullable<Task['integration']>>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/apply',{},90000);}
  pause(taskId:string,paused:boolean):Promise<{ok:boolean}>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/pause',{paused});}
  message(taskId:string,content:string,id?:string):Promise<import('../core/domain.js').TaskMessage>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/message',{content,...(id?{id}:{})});}
  dependencies(taskId:string,dependsOn:string[],priority?:number):Promise<{ok:boolean}>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/dependencies',{dependsOn,...(priority===undefined?{}:{priority})});}
  review(taskId:string,decision:'accepted'|'rejected',note:string):Promise<{ok:boolean}>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/review',{decision,note});}
  verify(taskId:string,callId:string,content:string):Promise<{ok:boolean}>{return this.request('/v1/tasks/'+encodeURIComponent(taskId)+'/verify',{callId,content});}
  retry(taskId: string): Promise<Run> { return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/retry`, {}); }
  answer(id: string, answer: string): Promise<{ ok: boolean }> { return this.request('/v1/questions/' + encodeURIComponent(id), { answer }); }
  approve(id: string, decision: 'approved' | 'denied'): Promise<{ ok: boolean }> { return this.request(`/v1/approvals/${encodeURIComponent(id)}`, { decision }); }
  async *events(after: number, signal: AbortSignal): AsyncGenerator<RuntimeEvent, void, unknown> {
    let cursor = after;
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.url.replace(/\/$/, '')}/v1/events?after=${cursor}`, { headers: this.headers(), signal });
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new AuthError('Event subscription unauthorized'); }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Event HTTP ${response.status}`); }
        for await (const data of readSSE(response.body)) {
          const event = JSON.parse(data) as RuntimeEvent;
          if (event.transient) yield event;
          else if (event.seq > cursor) { cursor = event.seq; yield event; }
        }
      } catch (error) { if (signal.aborted) return; if (error instanceof AuthError) throw error; }
      try { await pause(500, signal); } catch { return; }
    }
  }
}
class AuthError extends Error {}
