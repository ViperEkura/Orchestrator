import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Session } from '../domain.js';

const exec = promisify(execFile);
export function projectDirectory(path: string): string { mkdirSync(path, { recursive: true }); return realpathSync(path); }
export async function prepareWorkspace(session: Session, signal: AbortSignal) {
  if (session.workspace !== 'worktree') { projectDirectory(session.cwd); return; }
  if (existsSync(session.cwd)) {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: session.cwd, windowsHide: true, signal });
    if (realpathSync(stdout.trim()) !== realpathSync(session.cwd)) throw new Error('Workspace is not an independent Git worktree');
    return;
  }
  mkdirSync(dirname(session.cwd), { recursive: true });
  await exec('git', ['worktree', 'add', '--detach', resolve(session.cwd), session.baseCommit ?? 'HEAD'], { cwd: session.sourceCwd, windowsHide: true, signal });
}
