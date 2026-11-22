import { terminal, type State, type Task } from '../../core/domain.js';
export function projectTasks(state: State | undefined, cwd: string): Task[] {
  if(!state)return [];
  return Object.values(state.tasks).filter(task=>state.sessions[state.tasks[task.rootId]?.sessionId??'']?.cwd===cwd)
    .sort((a,b)=>Number(terminal(a.status))-Number(terminal(b.status)) || b.createdAt.localeCompare(a.createdAt));
}
export function waitingFor(task:Task,state:State):string {
  if(state.tasks[task.rootId]?.paused&&task.status==='queued')return 'Dispatch paused';
  if(task.status==='needs_review')return 'Verify interrupted tool effects';
  if(task.status==='waiting_review')return 'Result acceptance';
  const dependencies=task.dependsOn.filter(id=>state.tasks[id]?.status!=='completed');
  if(dependencies.length)return dependencies.map(id=>id.slice(0,8)).join(', ');
  return task.status.startsWith('waiting_')?task.status.slice(8).replaceAll('_',' '):'—';
}
