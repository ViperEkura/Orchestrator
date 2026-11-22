import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message, ModelChunk, ModelProvider, ToolCall, ToolSpec } from '../core/domain.js';
import { readSSE } from '../transport/sse.js';
export { readSSE } from '../transport/sse.js';

/** Deterministic provider exercises real delegation, scheduling, tools and approvals. */
export class DemoProvider implements ModelProvider {
  async *stream(messages: Message[], _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ModelChunk> {
    await delay(30, undefined, { signal });
    const role = messages[0]?.content ?? '';
    const user = messages.findLast(m => m.role === 'user')?.content ?? '';
    if (role.includes('[assistant]')) {
      for (const text of ['Demo mode: ', 'configure a model provider for real conversation.']) {
        await delay(35, undefined, { signal }); yield { type: 'text', text };
      }
      return;
    }
    const turn = messages.slice(messages.findLastIndex(m => m.role === 'user'));
    const calls = turn.flatMap(m => m.toolCalls ?? []);
    const call = (name: string, args: unknown): ModelChunk => ({ type: 'tool', call: { id: randomUUID(), name, arguments: JSON.stringify(args) } });
    if (role.includes('[coordinator]')) {
      if (!calls.some(c => c.name === 'delegate_task')) {
        const workspace = /审批|approval/i.test(user) ? 'worktree' : 'read-only';
        yield { type: 'text', text: 'Delegating to two independent agents: implementation research and risk review.\n' };
        yield call('delegate_task', { agentId: 'researcher', workspace, objective: `Research the implementation: ${user}` });
        yield call('delegate_task', { agentId: 'reviewer', workspace, objective: `Review constraints and risks: ${user}` });
        return;
      }
      if (!calls.some(c => c.name === 'wait_tasks')) {
        const ids = turn.filter(m => m.role === 'tool').flatMap(m => {
          try { const v = JSON.parse(m.content) as { taskId?: string }; return v.taskId ? [v.taskId] : []; } catch { return []; }
        });
        yield call('wait_tasks', { taskIds: ids }); return;
      }
      const finalTool = turn.filter(m => m.role === 'tool').at(-1);
      let summary = finalTool?.content ?? '';
      try {
        const results = JSON.parse(summary) as { taskId: string; status: string; result?: string; error?: string }[];
        if (Array.isArray(results)) summary = results.map((r, i) => `${i + 1}. Subtask ${r.taskId.slice(0, 8)} [${r.status}]\n${r.result ?? r.error ?? ''}`).join('\n\n');
      } catch { /* Preserve raw tool errors in the demo output. */ }
      yield { type: 'text', text: `Demo collaboration completed. These are deterministic examples, not real model reasoning.\n\n${summary}` };
    } else {
      if (/审批|approval/i.test(user) && !calls.some(c => c.name === 'write_file')) {
        yield call('write_file', { path: 'report.txt', content: `Demo agent artifact\n${user}\n` }); return;
      }
      if (!calls.some(c => c.name === 'list_files')) { yield call('list_files', {}); return; }
      const text = role.includes('[reviewer]')
        ? 'Risk review: verify cancellation propagation, approval denial, reconnection, task failures, and workspace isolation.'
        : 'Implementation plan: build an independent runtime, durable tasks, and a shared protocol, then add TUI, web, and desktop clients.';
      for (const part of [text.slice(0, 20), text.slice(20)]) {
        await delay(35, undefined, { signal }); yield { type: 'text', text: part };
      }
    }
  }
}

export interface CompatibleOptions { baseUrl: string; apiKey: string; model: string; thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'low' | 'high' | 'max'; maxOutputTokens?: number }

/** OpenAI-compatible Chat Completions transport, with fragmented SSE/tool-call handling. */
export class CompatibleProvider implements ModelProvider {
  constructor(private options: CompatibleOptions) {
    const url = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('LLM_BASE_URL must use HTTP(S)');
  }
  async *stream(messages: Message[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ModelChunk> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.options.model, stream: true,
        ...(this.options.thinking ? { thinking: { type: this.options.thinking } } : {}),
        ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
        ...(this.options.maxOutputTokens ? { max_tokens: this.options.maxOutputTokens } : {}),
        messages: messages.map(m => ({ role: m.role, content: m.content,
          ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) })),
        ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {})
      })
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Model HTTP ${response.status}; check provider configuration`); }
    if (!response.body) throw new Error('Model returned no stream');
    const calls = new Map<number, ToolCall>();
    let finished = false;
    for await (const payload of readSSE(response.body)) {
      signal.throwIfAborted();
      if (payload === '[DONE]') { finished = true; break; }
      const packet = JSON.parse(payload) as { error?: unknown; usage?: {prompt_tokens?: number;completion_tokens?: number}; choices?: { finish_reason?: string | null; delta?: {
        content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
      } }[] };
      if (packet.error) throw new Error('Provider reported a streaming error');
      if(packet.usage)yield {type:'usage',inputTokens:packet.usage.prompt_tokens??0,outputTokens:packet.usage.completion_tokens??0};
      const choice = packet.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('Model output truncated by token limit');
      if (choice?.finish_reason === 'content_filter') throw new Error('Model output blocked by provider');
      if (choice?.finish_reason) finished = true;
      if (choice?.delta?.reasoning_content) yield { type: 'reasoning', text: choice.delta.reasoning_content };
      if (choice?.delta?.content) yield { type: 'text', text: choice.delta.content };
      for (const fragment of choice?.delta?.tool_calls ?? []) {
        const current = calls.get(fragment.index) ?? { id: '', name: '', arguments: '' };
        if (fragment.id) current.id += fragment.id;
        current.name += fragment.function?.name ?? '';
        current.arguments += fragment.function?.arguments ?? '';
        calls.set(fragment.index, current);
      }
    }
    if (!finished) throw new Error('Model stream ended before completion');
    for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) throw new Error('Invalid streamed tool call');
      yield { type: 'tool', call };
    }
  }
}
