import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig, resolveApiKey } from '../core/config.js';
import { OrchestratorService } from '../core/runtime.js';
import { StateStore } from '../storage/store.js';
import { CompatibleProvider, DemoProvider } from '../models/providers.js';
import { startServer } from '../transport/server.js';

async function main() {
  const cwd = resolve(process.argv[2] ?? process.cwd());
  const webRoot = resolve(process.argv[3] ?? 'dist/web');
  const {home, settings, agents} = loadConfig(cwd);
  const provider = settings.provider === 'demo' ? new DemoProvider() : new CompatibleProvider({...settings,baseUrl:settings.baseUrl??'',model:settings.model??'',apiKey:resolveApiKey(settings)});
  const store = new StateStore(home);
  let runtime: OrchestratorService | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    runtime = new OrchestratorService(store,provider,{...settings,agents,workspaceDir:cwd});
    const token = randomBytes(32).toString('hex');
    server = await startServer(runtime,{host:'127.0.0.1',port:0,token,webRoot});
    process.stdout.write(JSON.stringify({url:server.url,token})+'\n');
    const input = createInterface({input:process.stdin});
    await new Promise<void>(done=>{input.once('line',()=>done());input.once('close',done);process.once('SIGINT',done);process.once('SIGTERM',done);});
    input.close();
  } finally { await server?.close();await runtime?.close();store.close(); }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
