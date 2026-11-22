import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OrchestratorClient } from '../../transport/client.js';
import { App } from './app.js';
import './style.css';

function Root() {
  const [token, setToken] = useState(() => {
    const incoming = new URLSearchParams(location.hash.slice(1)).get('token');
    if (incoming) { sessionStorage.setItem('orchestrator.token', incoming); history.replaceState(null, '', location.pathname); }
    return incoming ?? sessionStorage.getItem('orchestrator.token') ?? '';
  });
  const [entry, setEntry] = useState(''), [status, setStatus] = useState('Connecting…');
  const [ready, setReady] = useState(false), [needsToken, setNeedsToken] = useState(false);
  const client = useMemo(() => new OrchestratorClient(location.origin, token || undefined), [token]);
  useEffect(() => { let active=true; setReady(false); void client.info().then(()=>{if(active){setReady(true);setNeedsToken(false);}}).catch(error=>{if(active){setNeedsToken(true);setStatus(error instanceof Error?error.message:String(error));}});return()=>{active=false;}; }, [client]);
  if (ready) return <App client={client}/>;
  return <div className="connect-screen"><div className="connect-card"><div className="brand-word">Orchestrator</div><h1>{needsToken?'Connect to your runtime':'Opening your workspace'}</h1><p className="muted" role="status">{status}</p>{needsToken&&<form onSubmit={event=>{event.preventDefault();sessionStorage.setItem('orchestrator.token',entry);if(entry===token)location.reload();else setToken(entry);}}><input className="field" type="password" autoComplete="off" aria-label="Runtime token" value={entry} onChange={e=>setEntry(e.target.value)} placeholder="Runtime bearer token (if configured)"/><button className="primary">Connect</button></form>}</div></div>;
}
createRoot(document.getElementById('root')!).render(<Root/>);
