import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { loadConfig } from '../core/config.js';
import { resolveApiKey } from '../core/config.js';
import { atomicJSON } from '../storage/files.js';
import { CompatibleProvider, DemoProvider } from './providers.js';
import { ModelRegistry, type ModelEntry } from './registry.js';

/** Both entry points share profile loading, credential storage and selection persistence. */
export function configuredModels(config: ReturnType<typeof loadConfig>, env: NodeJS.ProcessEnv = process.env) {
  const { settings, home, cwd } = config;
  const read = (path: string): Record<string, unknown> & { models?: Record<string, unknown> } => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const globalFile = join(home, 'settings.json'), projectFile = join(cwd, '.orchestrator', 'settings.json');
  const entry = (id: string, profile: typeof settings.models[string] | typeof settings): ModelEntry => {
    const options = id === 'default' ? settings : { baseUrl: settings.baseUrl, credentials: settings.credentials, provider: 'compatible' as const, ...profile };
    const provider = options.provider ?? 'compatible';
    return {
      description: { id, name: ('name' in profile ? profile.name : undefined) ?? options.model ?? 'Demo', model: options.model ?? 'demo', provider },
      create: () => provider === 'demo' ? new DemoProvider() : new CompatibleProvider({
        ...options, baseUrl: options.baseUrl ?? '', model: options.model ?? '',
        apiKey: resolveApiKey(options, id !== 'default' && ('credentials' in profile && profile.credentials || 'apiKeyEnv' in profile && profile.apiKeyEnv) ? { ...env, LLM_API_KEY: undefined } : env),
      }),
    };
  };
  return new ModelRegistry([entry('default', settings), ...Object.entries(settings.models).map(([id, profile]) => entry(id, profile))], settings.activeModel,
    id => {
      // Respect an existing project-level choice; otherwise save the user's global default.
      const project = read(projectFile);
      const file = Object.hasOwn(project, 'activeModel') || Object.hasOwn(project.models ?? {}, id) ? projectFile : globalFile;
      atomicJSON(file, { ...read(file), activeModel: id });
    },
    (id, input) => {
      const credentialsFile = join(home, 'credentials.json');
      atomicJSON(credentialsFile, { ...read(credentialsFile), [id]: { type: 'api', key: input.apiKey } });
      const profile = { provider: 'compatible' as const, name: input.name ?? input.model, baseUrl: input.baseUrl, model: input.model, credentials: { file: credentialsFile, provider: id } };
      // A project-level models map overrides the global map, so write into that scope when present.
      const file = Object.hasOwn(read(projectFile), 'models') ? projectFile : globalFile;
      const current = read(file);
      atomicJSON(file, { ...current, models: { ...current.models, [id]: profile } });
      return entry(id, profile);
    });
}
