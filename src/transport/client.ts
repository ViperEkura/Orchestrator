import { readSSE, pause } from './sse.js';
import type { AgentDefinition, ModelDescriptor, ModelInput, ApprovalMode, Run, RuntimeEvent, Snapshot, SubmitInput, Task } from '../core/domain.js';

export class OrchestratorClient {
  constructor(readonly url: string, private token?: string) {}
  private headers() { return { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }; }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
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
  artifact(id: string, offset = 0): Promise<{ content: string; total: number; nextOffset: number | null }> { return this.request(`/v1/artifacts/${encodeURIComponent(id)}?offset=${offset}`); }
  snapshot(): Promise<Snapshot> { return this.request('/v1/snapshot'); }
  submit(input: SubmitInput): Promise<Task> { return this.request('/v1/tasks', input); }
  cancel(taskId: string): Promise<{ ok: boolean }> { return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {}); }
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
