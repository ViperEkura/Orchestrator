import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { StateStore } from './store.js';
import { CompatibleProvider, DemoProvider } from './models.js';
import { OrchestratorService } from './runtime.js';
import { OrchestratorClient } from './client.js';
import { startServer } from './server.js';
import { startTui } from './tui.js';
import { loadConfig, resolveApiKey } from './config.js';

async function main() {
  const args = process.argv.slice(2); const command = args.shift();
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`); args.splice(index, 2); return value; };
  if (!command || command === '--help') {
    console.log('Orchestrator\nCommands: init | server | tui [--url URL] | demo [objective] | migrate <sqlite-file> [--output directory]\nOptions: --cwd <project-directory>\nConfiguration: ~/.orchestrator/settings.json + <project>/.orchestrator/settings.json'); return;
  }
  const cwd = resolve(option('--cwd') ?? process.cwd());
  const home = resolve(process.env.ORCHESTRATOR_DATA_DIR ?? join(homedir(), '.orchestrator'));
  if (command === 'migrate') {
    const output = resolve(option('--output') ?? home); const source = args[0];
    if (!source) throw new Error('Usage: migrate <sqlite-file> [--output new-directory]');
    const { migrateLegacy } = await import('./migrate.js'); console.log(await migrateLegacy(source, output)); return;
  }
  if (!['init', 'server', 'tui', 'demo'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const url = option('--url');
  if (command === 'tui' && url) { await startTui(new OrchestratorClient(url, process.env.ORCHESTRATOR_TOKEN)); return; }
  if (command === 'tui' && !process.stdin.isTTY) throw new Error('TUI requires a terminal; use npm run demo');
  const legacy = join(cwd, '.orchestrator', 'state.sqlite');
  if (!existsSync(home) && existsSync(legacy)) {
    const { migrateLegacy } = await import('./migrate.js');
    console.log('Importing legacy history; the SQLite source and project files will remain unchanged.');
    console.log(await migrateLegacy(legacy, home));
  }
  const { settings, agents } = loadConfig(cwd);
  if (command === 'init') { console.log(`Configuration: ${home}\nProject: ${cwd}`); return; }
  const providerName = command === 'demo' ? 'demo' : settings.provider;
  const provider = providerName === 'demo' ? new DemoProvider() : new CompatibleProvider({
    ...settings, baseUrl: required('LLM_BASE_URL / baseUrl', settings.baseUrl), apiKey: resolveApiKey(settings), model: required('LLM_MODEL / model', settings.model)
  });
  const store = new StateStore(home);
  let runtime: OrchestratorService | undefined; let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    runtime = new OrchestratorService(store, provider, { ...settings, workspaceDir: cwd, agents });
    if (command === 'demo') {
      const off = store.subscribe(event => { if (event.type !== 'message.delta' && event.type !== 'message.completed') console.log(`#${event.seq} ${event.type} ${event.taskId?.slice(0, 8) ?? ''}`); });
      const task = runtime.submit({ agentId: 'coordinator', objective: args.join(' ') || 'Design a multi-agent framework for terminal, web, and desktop clients' });
      const done = await runtime.waitUntilDone(task.id);
      console.log(`\nStatus: ${done.status}\n${done.result ?? done.error ?? ''}`); off(); if (done.status !== 'completed') process.exitCode = 1;
    } else {
      server = await startServer(runtime, { host: settings.host, port: command === 'tui' ? 0 : settings.port, token: process.env.ORCHESTRATOR_TOKEN });
      if (command === 'tui') await startTui(new OrchestratorClient(server.url, process.env.ORCHESTRATOR_TOKEN));
      else {
        console.log(`Orchestrator (${providerName}) listening on ${server.url}\nData: ${home}\nProject: ${cwd}\nCtrl+C to shut down.`);
        await new Promise<void>(resolveStop => { process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop); });
      }
    }
  } finally { await server?.close(); await runtime?.close(); store.close(); }
}
function required(name: string, value: string | undefined) { if (!value) throw new Error(`Missing ${name}`); return value; }
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
