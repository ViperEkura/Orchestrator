import { approvalOptions } from '../ui/options.js';
import { terminal, type State } from '../core/domain.js';

export interface Completion { value: string; label: string; description: string; kind: 'command' | 'argument' }
const commands = [
  ['/models', '', 'Choose or add a model with a custom URL and API key'],
  ['/model', '[id]', 'Choose a model profile'],
  ['/projects', '', 'Browse projects and their conversations'],
  ['/project', '<path>', 'Start a conversation in another project'],
  ['/settings', '', 'View settings and select approval mode'],
  ['/outputs', '', 'Browse saved responses and tool outputs'],
  ['/back', '', 'Return to the parent agent conversation'],
  ['/copy', '', 'Copy the latest response using terminal clipboard support'],
  ['/history', '', 'Jump to a user input in this conversation'],
  ['/chat', '', 'Open the conversation view'],
  ['/resume', '', 'Resume a saved conversation'],
  ['/sessions', '', 'Browse and switch conversations'],
  ['/agents', '', 'Inspect the current agent task tree'],
  ['/approval', '[mode]', 'Set approval mode: manual, agent, all'],
  ['/questions', '', 'Answer pending agent questions'],
  ['/approvals', '', 'Review pending tool approvals'],
  ['/new', '', 'Start a single-agent conversation'],
  ['/delegate', '<agent-id> <task>', 'Delegate a task to a sub-agent'],
  ['/team', '[agent1,agent2 task]', 'Run a team and synthesize its results'],
  ['/use', '<task-id>', 'Open a task and its conversation'],
  ['/approve', '<approval-id>', 'Approve a pending tool call'],
  ['/deny', '<approval-id>', 'Deny a pending tool call'],
  ['/cancel', '[task-id]', 'Cancel a task and its children'],
  ['/retry', '<task-id>', 'Retry an unsuccessful leaf task'],
  ['/quit', '', 'Exit the terminal'],
  ['/help', '', 'Browse commands'],
] as const;

export function completeInput(input: string, state?: State): Completion[] {
  if (!input.startsWith('/')) return [];
  if (!/\s/.test(input)) return commands.filter(([name]) => name.startsWith(input)).map(([name, args, description]) => ({
    value: name + (args && !args.startsWith('[') ? ' ' : ''), label: name + (args ? ` ${args}` : ''), description, kind: 'command'
  }));
  const match = /^(\/\w+)\s+(\S*)$/.exec(input);
  if (!match) return [];
  const [, command, prefix = ''] = match;
  if (command === '/approval') return approvalOptions.filter(option => option.value.startsWith(prefix)).map(option => ({ value: `/approval ${option.value}`, label: option.value, description: option.description, kind: 'argument' }));
  if (!state) return [];
  if (command === '/approve' || command === '/deny') return Object.values(state.approvals)
    .filter(a => a.status === 'pending' && a.id.startsWith(prefix))
    .map(a => ({ value: `${command} ${a.id}`, label: a.id.slice(0, 8), description: `${a.toolName} · task ${a.taskId.slice(0, 8)}`, kind: 'argument' }));
  if (!['/use', '/cancel', '/retry'].includes(command!)) return [];
  return Object.values(state.tasks).filter(task => {
    if (!task.id.startsWith(prefix)) return false;
    if (command === '/cancel') return !terminal(task.status) && task.status !== 'cancelling';
    if (command === '/retry') return ['failed', 'cancelled', 'interrupted'].includes(task.status)
      && !Object.values(state.tasks).some(child => child.parentTaskId === task.id)
      && (!task.parentTaskId || !terminal(state.tasks[task.parentTaskId]!.status));
    return true;
  }).reverse().map(task => ({ value: `${command} ${task.id}`, label: task.id.slice(0, 8), description: `${task.status} · ${task.objective}`, kind: 'argument' }));
}
