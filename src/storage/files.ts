import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temp, path); } finally { if (existsSync(temp)) unlinkSync(temp); }
}

/** Keep a single writer even when several processes find the same abandoned PID. */
export function lockDirectory(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  return acquirePidFile(dir + '/runtime.lock');
}

function acquirePidFile(path: string): () => void {
  const owner = String(process.pid);
  for (;;) {
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = readOwner(path);
      if (observed === undefined) continue;
      const pid = Number(observed);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock: ' + path);
      try { process.kill(pid, 0); }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check;
        // Use ordinary exclusive creation, including when recovering an abandoned claim.
        const releaseClaim = acquirePidFile(path + '.reclaim');
        try { if (readOwner(path) === observed) unlinkSync(path); }
        finally { releaseClaim(); }
        continue;
      }
      throw new Error('Runtime already active (PID ' + pid + '); connect with tui --url');
    }
    try { writeFileSync(fd, owner); fsyncSync(fd); } finally { closeSync(fd); }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (readOwner(path) === owner) unlinkSync(path);
    };
  }
}

function readOwner(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
