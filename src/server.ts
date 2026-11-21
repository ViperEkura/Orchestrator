import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { OrchestratorService } from './runtime.js';

const delegationSchema = z.object({ agentId: z.string(), objective: z.string().trim().min(1).max(16000), workspace: z.enum(['read-only', 'worktree']).optional(), after: z.array(z.number().int().nonnegative()).max(16).optional() }).strict();
const submitSchema = z.object({ delegations: z.array(delegationSchema).min(1).max(16).optional(), objective: z.string().trim().min(1).max(16000), agentId: z.string().optional(), sessionId: z.string().uuid().optional() }).strict();
const decisionSchema = z.object({ decision: z.enum(['approved', 'denied']) }).strict();
const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);

export async function startServer(runtime: OrchestratorService, options: { host?: string; port?: number; token?: string } = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!loopback(host) && (!options.token || options.token.length < 24)) throw new Error('Non-loopback binding requires a bearer token of at least 24 characters');
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => { void route(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    send(res, error instanceof z.ZodError ? 400 : 409, { error: error instanceof Error ? error.message : 'Request failed' });
  }); });
  async function route(req: IncomingMessage, res: ServerResponse) {
    const requestHost = req.headers.host ?? '';
    if (loopback(host) && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(requestHost)) { send(res, 403, { error: 'Invalid host' }); return; }
    if (req.headers.origin && req.headers.origin !== `http://${requestHost}`) { send(res, 403, { error: 'Cross-origin access denied' }); return; }
    if (options.token) {
      const expected = Buffer.from(`Bearer ${options.token}`); const received = Buffer.from(req.headers.authorization ?? '');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) { send(res, 401, { error: 'Unauthorized' }); return; }
    }
    const url = new URL(req.url ?? '/', `http://${requestHost || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { status: 'ok', version: '0.1.0' }); return; }
    if (req.method === 'GET' && url.pathname === '/v1/snapshot') { send(res, 200, runtime.store.snapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/v1/info') { send(res, 200, runtime.info()); return; }
    if (req.method === 'GET' && url.pathname === '/v1/agents') { send(res, 200, [...runtime.agents.values()]); return; }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const cursor = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) { send(res, 400, { error: 'Invalid event cursor' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      streams.add(res);
      let last = cursor; let blocked = false;
      const write = (event: { seq: number; transient?: true }) => {
        if ((!event.transient && event.seq <= last) || blocked) return;
        if (!event.transient) last = event.seq;
        if (!res.write(`${event.transient ? '' : `id: ${event.seq}\n`}data: ${JSON.stringify(event)}\n\n`)) { blocked = true; res.end(); }
      };
      // No await between replay and subscription; mutations cannot interleave on this process.
      while (!blocked) { const events = runtime.store.events(last); for (const event of events) write(event); if (events.length < 500) break; }
      const unsubscribe = runtime.store.subscribe(write);
      const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.end(); }, 15000);
      const cleanup = () => { clearInterval(heartbeat); unsubscribe(); streams.delete(res); };
      res.once('close', cleanup); if (res.writableEnded) cleanup();
      return;
    }
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) { send(res, 415, { error: 'JSON content type required' }); return; }
      const body = await readBody(req);
      if (url.pathname === '/v1/tasks') { send(res, 201, runtime.submit(submitSchema.parse(body))); return; }
      const action = /^\/v1\/tasks\/([^/]+)\/(cancel|retry)$/.exec(url.pathname);
      if (action) {
        z.object({}).strict().parse(body);
        if (action[2] === 'cancel') { runtime.cancel(action[1]!); send(res, 200, { ok: true }); }
        else send(res, 201, runtime.retry(action[1]!));
        return;
      }
      const approval = /^\/v1\/approvals\/([^/]+)$/.exec(url.pathname);
      if (approval) { runtime.resolveApproval(approval[1]!, decisionSchema.parse(body).decision); send(res, 200, { ok: true }); return; }
    }
    send(res, 404, { error: 'Not found' });
  }
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, host, () => { server.off('error', reject); resolveListen(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    close: async () => {
      for (const stream of streams) stream.end();
      await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections(); });
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0; const buffers: Buffer[] = [];
  for await (const chunk of req) { const buffer = Buffer.from(chunk as Uint8Array); size += buffer.length; if (size > 65536) throw new Error('Request exceeds 64 KiB'); buffers.push(buffer); }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new Error('Invalid JSON'); }
}
