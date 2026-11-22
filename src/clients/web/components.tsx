import React, { useEffect, useMemo, useRef, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Run, State, Task } from '../../core/domain.js';
import type { LiveMessage } from './runtime.js';

export function Icon({ name, size = 19 }: {name: string; size?: number}) {
  const paths: Record<string, ReactNode> = {
    new: <><path d="M12 5H5v14h14v-7"/><path d="m10 14 1-4L19 2l3 3-8 8-4 1Z"/></>,
    pin: <path d="m15 3 6 6-4 1-4 6-2-2-7 7 7-7-3-3 6-4Z"/>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>,
    folder: <path d="M3 7V5h7l2 3h9v12H3Z"/>, search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    plus: <path d="M12 4v16M4 12h16"/>, close: <path d="M6 6l12 12M6 18L18 6"/>,
    send: <path d="m5 11 7-7 7 7M12 4v16"/>, down: <path d="m6 9 6 6 6-6"/>, stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
    agent: <><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2M16 12v2M9 17h6"/></>,
    history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/><path d="M12 7v5l3 2"/></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/></>,
    file: <><path d="M5 3h9l5 5v13H5ZM14 3v6h5"/></>, check: <path d="m5 12 4 4L19 6"/>,
    bell: <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}
export function IconButton({ label, name, onClick, active = false }: {label: string; name: string; onClick: () => void; active?: boolean}) {
  return <button className={'icon-button' + (active ? ' active' : '')} aria-label={label} title={label} onClick={onClick}><Icon name={name}/></button>;
}
export function Modal({ title, children, onClose, className }: {title: string; children: ReactNode; onClose: () => void; className?:string}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!, previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={className} onCancel={e => { e.preventDefault(); onClose(); }} aria-label={title}><header><h2>{title}</h2><IconButton label="Close dialog" name="close" onClick={onClose}/></header>{children}</dialog>;
}
export const Markdown = React.memo(function Markdown({ source }: {source: string}) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: true, async: false }), {
    ALLOWED_TAGS: ['p','br','strong','em','del','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code','table','thead','tbody','tr','th','td','hr','a'],
    ALLOWED_ATTR: ['href','title','start','align']
  }).replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" '), [source]);
  return <div className="markdown" dangerouslySetInnerHTML={{__html:html}}/>;
});
export const parse = (value: string): Record<string, unknown> => { try { const data: unknown = JSON.parse(value); return data && typeof data === 'object' ? data as Record<string, unknown> : {}; } catch { return {}; } };
const pretty = (value: string) => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } };
export function Disclosure({ label, preview, failed, children }: {label: string; preview: string; failed?: boolean; children: ReactNode}) {
  return <details className={'disclosure' + (failed ? ' failed' : '')}><summary><span className="chevron">›</span><span className="disclosure-label">{label}</span><span className="preview">{preview.replace(/\s+/g, ' ')}</span></summary><div className="disclosure-body">{children}</div></details>;
}
export function RunMessages({ task, run, state, live }: {task: Task; run: Run; state: State; live?: LiveMessage}) {
  const start = run.messages.findLastIndex(m => m.role === 'user' && m.content === task.objective);
  return <>{run.model && <div className="run-model">{run.model.name}</div>}{run.attempt > 1 && <p className="muted">Attempt {run.attempt}</p>}{run.messages.slice(start + 1).map((message, i) => <React.Fragment key={i}>
    {message.source === 'agent_message' && <div className="user-message">{message.content}</div>}
    {message.reasoningContent && <Disclosure label="Thinking" preview={message.reasoningContent}><pre>{message.reasoningContent}</pre></Disclosure>}
    {message.role === 'assistant' && message.content && <Markdown source={message.content}/>}
    {message.toolCalls?.map(call => {
      const result = run.messages.find(m => m.role === 'tool' && m.toolCallId === call.id);
      const approval = Object.values(state.approvals).find(a => a.runId === run.id && a.toolCallId === call.id);
      const outcome = parse(result?.content ?? ''), args = parse(call.arguments);
      const failed = approval?.status === 'denied' || !!outcome.error || (typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) || outcome.timedOut === true || outcome.outputLimitReached === true;
      const status = approval?.status === 'denied' ? 'denied' : result ? failed ? 'failed' : 'completed' : approval?.status === 'pending' ? 'waiting approval' : 'running';
      const preview = ['command','path','pattern','question','objective','artifactId'].map(k => args[k]).find(v => typeof v === 'string') as string ?? call.arguments;
      return <Disclosure key={call.id} label={call.name} preview={preview} failed={failed}><p>Status: {status}</p><pre>{pretty(call.arguments)}</pre>{result && <pre>{pretty(result.content)}</pre>}</Disclosure>;
    })}
  </React.Fragment>)}{live?.reasoning && <Disclosure label="Thinking" preview={live.reasoning}><pre>{live.reasoning}</pre></Disclosure>}{live?.text && <Markdown source={live.text}/>}</>;
}
