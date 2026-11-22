import type { ApprovalMode } from '../../core/domain.js';

/** Shared copy and values for every client. */
export const approvalOptions: { value: ApprovalMode; label: string; description: string }[] = [
  { value: 'manual', label: 'Ask for approval', description: 'Review protected tool calls yourself.' },
  { value: 'agent', label: 'Agent decides', description: 'Let an agent review; ask when uncertain.' },
  { value: 'all', label: 'Allow all', description: 'Run permitted tools without approval.' },
];
export const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
