import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Exclusive process ownership. A stale lock is removed only after proving its PID is gone. */
export function lockDirectory(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/runtime.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
      return () => { if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid lock: ${path}`);
      try { process.kill(pid, 0); }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check;
        // Only one contender may reclaim a stale lock; it cannot unlink a new owner's lock.
        const claim = `${path}.reclaim`;
        linkSync(path, claim);
        try {
          if (readFileSync(path, 'utf8') !== String(pid)) throw new Error('Runtime lock changed during recovery');
          unlinkSync(path);
          return lockDirectory(dir);
        } finally { unlinkSync(claim); }
      }
      throw new Error(`Runtime already active (PID ${pid}); connect with tui --url`);
    }
  }
  throw new Error(`Could not acquire runtime lock: ${path}`);
}
