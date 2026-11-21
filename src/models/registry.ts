import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelDescriptor, ModelInput, ModelProvider } from '../core/domain.js';

export const modelInputSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(), model: z.string().trim().min(1).max(256),
  baseUrl: z.string().url().max(4096).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, 'Use an HTTP(S) API base URL without credentials or query parameters'),
  apiKey: z.string().max(8192),
}).strict();
export interface ModelEntry { description: ModelDescriptor; create(): ModelProvider }

/** Profiles are immutable once registered. Runs retain an ID while selection changes. */
export class ModelRegistry {
  private entries = new Map<string, ModelEntry>();
  private instances = new Map<string, ModelProvider>();
  constructor(entries: ModelEntry[], public selectedId = 'default', private saveSelection?: (id: string) => void,
    private saveProfile?: (id: string, input: ModelInput) => ModelEntry) {
    for (const entry of entries) {
      if (this.entries.has(entry.description.id)) throw new Error('Duplicate model profile');
      this.entries.set(entry.description.id, entry);
    }
    this.describe(selectedId);
  }
  list(): ModelDescriptor[] { return [...this.entries.values()].map(entry => ({ ...entry.description })); }
  describe(id = this.selectedId): ModelDescriptor {
    const entry = this.entries.get(id); if (!entry) throw new Error('Unknown model profile');
    return { ...entry.description };
  }
  resolve(id = this.selectedId): ModelProvider {
    this.describe(id);
    if (!this.instances.has(id)) this.instances.set(id, this.entries.get(id)!.create());
    return this.instances.get(id)!;
  }
  select(id: string): void {
    this.resolve(id); // Validate local configuration before persisting selection.
    this.saveSelection?.(id); this.selectedId = id;
  }
  add(value: ModelInput): ModelDescriptor {
    const input = modelInputSchema.parse(value);
    if (!this.saveProfile) throw new Error('Model configuration is not writable in this runtime');
    const id = randomUUID(), entry = this.saveProfile(id, input);
    this.entries.set(id, entry); return this.describe(id);
  }
}
