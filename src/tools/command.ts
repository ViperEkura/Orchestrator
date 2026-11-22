import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const windows = process.platform === 'win32';
    // Do not pass model API credentials or API bearer tokens to child processes.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
      { cwd, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let outputLimitReached = false; let timedOut = false;
    const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
    const append = (data: Buffer, decoder: StringDecoder) => {
      if (outputLimitReached) return; output += decoder.write(data);
      if (output.length > 8 * 1024 * 1024) { output = output.slice(0, 8 * 1024 * 1024); outputLimitReached = true; stop(); }
    };
    child.stdout.on('data', data => append(data, stdoutDecoder)); child.stderr.on('data', data => append(data, stderrDecoder));
    const stop = () => {
      if (!child.pid) return;
      if (windows) { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); if (signal.aborted) reject(signal.reason); else { if (!outputLimitReached) output += stdoutDecoder.end() + stderrDecoder.end(); resolveResult({ exitCode: code, timedOut, outputLimitReached, output }); } });
    if (signal.aborted) stop();
  });
}
