import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Serve only built application files; never serve the project directory or its configuration. */
export async function serveWeb(req: IncomingMessage, res: ServerResponse, path: string, root: string): Promise<boolean> {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
    '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css']
  };
  const file = files[path];
  if (!file || !['GET', 'HEAD'].includes(req.method ?? '')) return false;
  try {
    const content = await readFile(join(root, file[0]));
    res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Web client is not built. Run npm run build.');
  }
  return true;
}
