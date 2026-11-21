import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicJSON } from './files.js';
import { defaultAgents } from './runtime.js';

const settingsSchema = z.object({
  provider: z.enum(['demo', 'compatible']).default('demo'),
  baseUrl: z.string().url().optional(), model: z.string().optional(),
  defaultAgent: z.string().default('assistant'),
  credentials: z.object({ file: z.string(), provider: z.string() }).strict().optional(),
  thinking: z.enum(['enabled', 'disabled']).optional(), reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(4317),
  concurrency: z.number().int().min(1).max(32).default(3),
  maxSteps: z.number().int().positive().default(40), maxTasks: z.number().int().positive().default(16),
  maxDepth: z.number().int().min(0).max(16).default(3), runTimeoutMs: z.number().int().positive().default(300000)
}).strict();
const agentSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string(), systemPrompt: z.string(), allowedTools: z.array(z.string()) }).strict();
export function loadConfig(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  cwd = realpathSync(cwd);
  const home = resolve(env.ORCHESTRATOR_DATA_DIR ?? join(homedir(), '.orchestrator'));
  const globalFile = join(home, 'settings.json');
  if (!existsSync(globalFile)) atomicJSON(globalFile, settingsSchema.parse({}));
  const read = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as object : {};
  const projectFile = join(cwd, '.orchestrator', 'settings.json');
  const overrides = Object.fromEntries(Object.entries({
    provider: env.ORCHESTRATOR_PROVIDER, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL,
    host: env.ORCHESTRATOR_HOST, port: env.ORCHESTRATOR_PORT === undefined ? undefined : Number(env.ORCHESTRATOR_PORT)
  }).filter(([, value]) => value !== undefined));
  const settings = settingsSchema.parse({ ...read(globalFile), ...read(projectFile), ...overrides });
  const agentsDir = join(home, 'agents'); mkdirSync(agentsDir, { recursive: true });
  for (const agent of defaultAgents) { const path = join(agentsDir, `${agent.id}.json`); if (!existsSync(path)) atomicJSON(path, agent); }
  const agents = readdirSync(agentsDir).filter(name => name.endsWith('.json')).map(name => agentSchema.parse(read(join(agentsDir, name))));
  if (new Set(agents.map(agent => agent.id)).size !== agents.length) throw new Error('Duplicate agent IDs in agents/*.json');
  return { home, cwd, settings, agents };
}

export function resolveApiKey(settings: { credentials?: { file: string; provider: string } }, env: NodeJS.ProcessEnv = process.env): string {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  if (settings.credentials) {
    const { file, provider } = settings.credentials;
    const auth = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { type?: string; key?: string }>;
    const entry = auth[provider];
    if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key) return entry.key;
    throw new Error('Referenced credential does not contain an API key');
  }
  throw new Error('Set LLM_API_KEY or configure a credential file reference');
}
