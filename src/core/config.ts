import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicJSON } from '../storage/files.js';
import { approvalModes } from './domain.js';
import { defaultAgents, legacyAgentPrompts, taskAgentPrompts } from './agents/definitions.js';

const profileSchema = z.object({
  name: z.string().optional(), provider: z.enum(['demo', 'compatible']).optional(),
  baseUrl: z.string().url().optional(), model: z.string().min(1), apiKeyEnv: z.string().optional(),
  credentials: z.object({file:z.string(),provider:z.string()}).strict().optional(),
  thinking: z.enum(['enabled','disabled']).optional(), reasoningEffort: z.enum(['low','high','max']).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();
export const settingsSchema = z.object({
  provider: z.enum(['demo', 'compatible']).default('demo'),
  baseUrl: z.string().url().optional(), model: z.string().optional(),
  activeModel: z.string().default('default'),
  models: z.record(z.string().min(1), profileSchema).default({}).refine(models => !Object.hasOwn(models, 'default'), 'default is reserved for the legacy model'),
  defaultAgent: z.string().default('assistant'),
  approvalMode: z.enum(approvalModes).default('manual'),
  credentials: z.object({ file: z.string(), provider: z.string() }).strict().optional(),
  thinking: z.enum(['enabled', 'disabled']).optional(), reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(4317),
  maxActivePerRoot:z.number().int().min(1).max(256).default(8),
  maxActiveRuns:z.number().int().min(1).max(256).default(64),
  maxTokens:z.number().int().positive().optional(),
  modelLimits:z.record(z.string(),z.object({concurrency:z.number().int().min(1).max(64).optional(),requestsPerMinute:z.number().int().positive().optional()}).strict()).default({}),
  concurrency: z.number().int().min(1).max(32).default(3),
  maxSteps: z.number().int().positive().default(400), maxTasks: z.number().int().min(1).max(256).default(64),
  maxDepth: z.number().int().min(0).max(16).default(3), runTimeoutMs: z.number().int().positive().default(300000)
}).strict();
const agentSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string(), description: z.string().max(512).optional(), systemPrompt: z.string(), allowedTools: z.array(z.string()) }).strict();
export function loadConfig(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  cwd = realpathSync(cwd);
  const home = resolve(env.ORCHESTRATOR_DATA_DIR ?? join(homedir(), '.orchestrator'));
  const globalFile = join(home, 'settings.json');
  if (!existsSync(globalFile)) atomicJSON(globalFile, settingsSchema.parse({}));
  const read = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as object : {};
  const projectFile = join(cwd, '.orchestrator', 'settings.json');
  const overrides = Object.fromEntries(Object.entries({
    activeModel: env.ORCHESTRATOR_MODEL ?? (env.ORCHESTRATOR_PROVIDER || env.LLM_MODEL || env.LLM_BASE_URL ? 'default' : undefined), approvalMode: env.ORCHESTRATOR_APPROVAL_MODE, provider: env.ORCHESTRATOR_PROVIDER, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL,
    host: env.ORCHESTRATOR_HOST, port: env.ORCHESTRATOR_PORT === undefined ? undefined : Number(env.ORCHESTRATOR_PORT)
  }).filter(([, value]) => value !== undefined));
  const settings = settingsSchema.parse({ ...read(globalFile), ...read(projectFile), ...overrides });
  const agentsDir = join(home, 'agents');
  const names = existsSync(agentsDir) ? readdirSync(agentsDir).filter(name => name.endsWith('.json')) : [];
  const agents = names.map(name => {
    const current = agentSchema.parse(JSON.parse(readFileSync(join(agentsDir, name), 'utf8')));
    const builtin = defaultAgents.find(agent => name === agent.id + '.json' && current.id === agent.id);
    if (!builtin || current.name !== builtin.name || current.systemPrompt === builtin.systemPrompt && isDeepStrictEqual(current.allowedTools, builtin.allowedTools)) return current;
    if (![builtin.systemPrompt, legacyAgentPrompts[builtin.id], taskAgentPrompts[builtin.id]].includes(current.systemPrompt)) return current;
    const added = new Set(['grep', 'glob', 'apply_patch', 'ask_user', 'todo_write', 'read_artifact', 'list_agents', 'followup_task', 'close_agent']);
    const previous = builtin.allowedTools.filter(name => !added.has(name)&&!['send_message','publish_artifact'].includes(name));
    const recent=builtin.allowedTools.filter(name=>!['send_message','publish_artifact','list_agents','followup_task','close_agent'].includes(name));
    const taskEra=builtin.allowedTools.filter(name=>!['list_agents','followup_task','close_agent'].includes(name));
    const knownTools = [previous, recent, taskEra, builtin.allowedTools].flatMap(tools => [tools, tools.filter(name => name !== 'read_skill' && name !== 'interrupt_agent')]);
    return knownTools.some(tools => isDeepStrictEqual(tools, current.allowedTools)) ? {...current, systemPrompt:builtin.systemPrompt, allowedTools:[...builtin.allowedTools]} : current;
  });
  for (const builtin of defaultAgents) {
    if (names.includes(builtin.id + '.json')) continue;
    // Keep editable templates on first startup when the role directory is writable.
    try { atomicJSON(join(agentsDir, builtin.id + '.json'), builtin); }
    catch (error) { if (!['EPERM','EACCES','EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    agents.push(structuredClone(builtin));
  }
  if (new Set(agents.map(agent => agent.id)).size !== agents.length) throw new Error('Duplicate agent IDs in agents/*.json');
  return { home, cwd, settings, agents };
}

export function resolveApiKey(settings: { apiKeyEnv?: string; credentials?: { file: string; provider: string } }, env: NodeJS.ProcessEnv = process.env): string {
  if (settings.apiKeyEnv) { const key = env[settings.apiKeyEnv]; if (!key) throw new Error('Configured API key environment variable is empty'); return key; }
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  if (settings.credentials) {
    const { file, provider } = settings.credentials;
    const auth = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { type?: string; key?: string }>;
    const entry = auth[provider];
    if (entry?.type === 'api' && typeof entry.key === 'string') return entry.key;
    throw new Error('Referenced credential does not contain an API key');
  }
  throw new Error('Set LLM_API_KEY or configure a credential file reference');
}
