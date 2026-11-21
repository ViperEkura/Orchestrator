import { useCallback, useEffect, useState } from 'react';
import { OrchestratorClient } from '../transport/client.js';
import { terminal, type AgentDefinition, type Message, type Snapshot } from '../core/domain.js';

export type RuntimeInfo = Awaited<ReturnType<OrchestratorClient['info']>>;
export interface LiveMessage { text: string; reasoning: string }
export function useRuntime(client: OrchestratorClient) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [info, setInfo] = useState<RuntimeInfo>();
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [live, setLive] = useState<Record<string, LiveMessage>>({});
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const refresh = useCallback(async () => {
    const [value, details] = await Promise.all([client.snapshot(), client.info()]);
    setSnapshot(old => !old || value.lastSeq >= old.lastSeq ? value : old);
    setInfo(details); setConnected(true);
    setLive(old => Object.fromEntries(Object.entries(old).filter(([id]) => value.state.runs[id] && !terminal(value.state.runs[id]!.status))));
  }, [client]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let polling = false;
    setSnapshot(undefined); setLive({}); setError(''); setConnected(false);
    const update = async () => { if (polling || controller.signal.aborted) return; polling = true; try { await refresh(); } catch (e) { setConnected(false); setError(String(e)); } finally { polling = false; } };
    const poll = setInterval(() => void update(), 5000);
    void (async () => {
      const [initial, details, roles] = await Promise.all([client.snapshot(), client.info(), client.agents()]);
      if (controller.signal.aborted) return;
      setSnapshot(initial); setInfo(details); setAgents(roles); setConnected(true);
      for await (const event of client.events(initial.lastSeq, controller.signal)) {
        if (controller.signal.aborted) break;
        if (event.runId && ['message.delta', 'message.thinking'].includes(event.type)) {
          const id = event.runId, text = (event.data as {text?: string}).text ?? '';
          setLive(old => { const current = old[id] ?? { text: '', reasoning: '' }; return { ...old, [id]: { text: current.text + (event.type === 'message.delta' ? text : ''), reasoning: current.reasoning + (event.type === 'message.thinking' ? text : '') } }; });
        } else {
          if (event.runId && ['message.completed', 'run.step', 'run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
            const id = event.runId;
            if (event.type === 'message.completed') setSnapshot(old => {
              if (!old || old.lastSeq >= event.seq || !old.state.runs[id]) return old;
              const run = old.state.runs[id]!;
              return { ...old, state: { ...old.state, runs: { ...old.state.runs, [id]: { ...run, messages: [...run.messages, (event.data as { message: Message }).message] } } } };
            });
            setLive(old => { const next = {...old}; delete next[id]; return next; });
          }
          if (!timer) timer = setTimeout(() => { timer = undefined; void update(); }, 60);
        }
      }
    })().catch(e => { if (!controller.signal.aborted) { setConnected(false); setError(String(e)); } });
    return () => { controller.abort(); clearInterval(poll); if (timer) clearTimeout(timer); };
  }, [client, refresh]);
  return { snapshot, info, agents, live, connected, error, setError, refresh };
}
