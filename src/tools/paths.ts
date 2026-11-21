import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Reject traversal and all existing symlink/junction components. Not an OS sandbox. */
export async function safePath(workspace: string, input: string): Promise<string> {
  if (isAbsolute(input) || input.includes(':')) throw new Error('Only relative workspace paths are allowed');
  const root = await realpath(workspace); const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes workspace');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks and junctions are not permitted'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
