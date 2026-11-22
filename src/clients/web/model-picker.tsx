import React, { useEffect, useState } from 'react';
import type { ModelDescriptor } from '../../core/domain.js';
import type { OrchestratorClient } from '../../transport/client.js';
import { Icon, Modal } from './components.js';

export function ModelPicker({ client, selected, onSelected, onClose }: {
  client: OrchestratorClient; selected?: string; onSelected(): Promise<void>; onClose(): void;
}) {
  const [models, setModels] = useState<ModelDescriptor[]>([]), [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [name, setName] = useState(''), [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [apiKey, setApiKey] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void client.models().then(value => { if (!controller.signal.aborted) setModels(value); }).catch(() => { if (!controller.signal.aborted) setError('Could not load models. Close and retry.'); });
    return () => controller.abort();
  }, [client]);
  const choose = async (id?: string) => {
    if (busy) return; setBusy(true); setError('');
    try {
      const value = id ?? (await client.addModel({ ...(name.trim() ? {name:name.trim()} : {}), baseUrl:baseUrl.trim(), model:model.trim(), apiKey })).id;
      setApiKey(''); await client.setModel(value); await onSelected(); onClose();
    } catch (reason) { setApiKey(''); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <Modal title={adding ? 'Add model' : 'Choose model'} onClose={onClose}>
    <p className="muted">New turns use the selected model. Running tasks keep their current model.</p>
    {error && <p className="failure" role="alert">{error}</p>}
    {adding ? <form autoComplete="off" onSubmit={event => { event.preventDefault(); void choose(); }}>
      <label>Display name<input className="field" aria-label="Display name" value={name} onChange={event=>setName(event.target.value)} placeholder="Optional label" maxLength={80}/></label>
      <label>API base URL<input className="field" aria-label="API base URL" required type="url" value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} placeholder="https://your-provider.example/v1" maxLength={4096}/></label>
      <label>Model ID<input className="field" aria-label="Model ID" required value={model} onChange={event=>setModel(event.target.value)} placeholder="Model ID from your provider" maxLength={256}/></label>
      <label>API key<input className="field" aria-label="API key" type="password" autoComplete="new-password" value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder="Leave empty for a service without authentication" maxLength={8192}/></label>
      <p className="muted">Compatible Chat Completions endpoints. Keys are stored in the runtime host's credentials file, separately from chat history.</p>
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={()=>{setApiKey('');setAdding(false);}}>Back</button><button className="primary" disabled={busy || !baseUrl.trim() || !model.trim()}>Save and use</button></div>
    </form> : <><div className="model-list">{models.map(item=><button key={item.id} className={selected===item.id?'chosen':''} disabled={busy} onClick={()=>void choose(item.id)}>
      <span><strong>{item.name}</strong><small>{item.model} · {item.provider}</small></span>{selected===item.id && <Icon name="check" size={16}/>}
    </button>)}</div><div className="dialog-actions"><button onClick={()=>setAdding(true)} disabled={busy}><Icon name="plus"/>Add model</button></div></>}
  </Modal>;
}
