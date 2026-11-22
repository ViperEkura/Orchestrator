import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { rgPath } from '@vscode/ripgrep';
import { safePath } from './paths.js';
import type { ToolRegistry } from './registry.js';

const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', '.orchestrator']);
const filePath = z.string().min(1).max(500);
const page = { offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(2000).default(200) };

export function textPage(text: string, offset: number, limit: number) {
  const lines = text.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  const selected: string[] = []; let size = 0;
  for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
    if (size + line.length > 128000) { if (!selected.length) throw new Error('A line exceeds 128000 characters'); break; }
    selected.push(line); size += line.length + 1;
  }
  const nextOffset = offset + selected.length;
  return { content: selected.join('\n'), lines: selected.map((text, i) => ({ line: offset + i, text })), totalLines: lines.length,
    offset, nextOffset: nextOffset <= lines.length ? nextOffset : null };
}
async function readText(workspace: string, input: string, signal: AbortSignal) {
  const path = await safePath(workspace, input);
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('File exceeds 16 MiB');
  const content = await readFile(path, { encoding: 'utf8', signal });
  if (content.includes('\0')) throw new Error('Binary files are not supported');
  return content;
}
async function walk(workspace: string, input: string, depth: number, signal: AbortSignal, visit: (path: string, directory: boolean) => boolean) {
  let visited = 0;
  async function scan(path: string, level: number): Promise<boolean> {
    signal.throwIfAborted();
    const entries = (await readdir(await safePath(workspace, path), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal.throwIfAborted(); if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      if (++visited > 50000) return false;
      const child = posix.join(path, entry.name);
      if (!visit(child, entry.isDirectory())) return false;
      if (entry.isDirectory() && level < depth && !await scan(child, level + 1)) return false;
    }
    return true;
  }
  return scan(input.replaceAll('\\', '/'), 1);
}
export function registerFileTools(registry: ToolRegistry) {
  registry.register({ name: 'list_files', description: 'List workspace paths recursively up to depth (default 1). Ignores .git, node_modules, .orchestrator and symlinks.', approval: false, readOnly: true, parallelSafe: true,
    schema: z.object({ path: z.string().max(500).default('.'), depth: z.number().int().min(1).max(20).default(1), limit: z.number().int().min(1).max(5000).default(1000) }).strict(),
    async execute(input, ctx) { const args = this.schema.parse(input) as { path: string; depth: number; limit: number }; const files: string[] = [];
      const complete = await walk(ctx.workspace, args.path, args.depth, ctx.signal, (path, dir) => { if (files.length >= args.limit) return false; files.push(path + (dir ? '/' : '')); return true; });
      return { files, truncated: !complete };
    } });
  registry.register({ name: 'glob', description: 'Find workspace files with a glob such as **/*.ts. Skips ignored folders and symlinks.', approval: false, readOnly: true, parallelSafe: true,
    schema: z.object({ pattern: z.string().min(1).max(500), path: z.string().max(500).default('.'), limit: z.number().int().min(1).max(5000).default(1000) }).strict(),
    async execute(input, ctx) { const args = this.schema.parse(input) as { pattern: string; path: string; limit: number }; const files: string[] = [];
      const complete = await walk(ctx.workspace, args.path, Number.MAX_SAFE_INTEGER, ctx.signal, (path, dir) => {
        if (!dir && posix.matchesGlob(path, args.pattern)) { if (files.length >= args.limit) return false; files.push(path); } return true;
      }); return { files, truncated: !complete };
    } });
  registry.register({ name: 'grep', description: 'Search text using ripgrep regex or literal mode with glob, line numbers and context. Uses bundled ripgrep; no shell is invoked.', approval: false, readOnly: true, parallelSafe: true,
    schema: z.object({ pattern: z.string().min(1).max(2000), path: z.string().max(500).default('.'), glob: z.string().max(500).default('**/*'), literal: z.boolean().default(false), ignoreCase: z.boolean().default(false), context: z.number().int().min(0).max(10).default(0), limit: z.number().int().min(1).max(500).default(100) }).strict(),
    async execute(input, ctx) {
      const args = this.schema.parse(input) as { pattern: string; path: string; glob: string; literal: boolean; ignoreCase: boolean; context: number; limit: number };
      const root = await realpath(ctx.workspace); const path = await safePath(root, args.path);
      const flags = ['--no-config', '--json', '--line-number', '--hidden', '--max-filesize', '16M', '--glob', args.glob, '--glob', '!**/.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.orchestrator/**', '--context', String(args.context), '--max-count', String(args.limit + 1)];
      if (args.literal) flags.push('--fixed-strings'); if (args.ignoreCase) flags.push('--ignore-case');
      let stdout: string;
      try { ({ stdout } = await exec(rgPath, [...flags, '-e', args.pattern, '--', path], { cwd: root, signal: ctx.signal, windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })); }
      catch (error) { if ((error as { code?: number }).code === 1) return { matches: [], truncated: false }; throw new Error(ctx.signal.aborted ? 'Search cancelled' : 'Search failed. Check the regex, narrow the path/glob, or reinstall dependencies.'); }
      const matches = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => ['match', 'context'].includes(event.type));
      const { relative } = await import('node:path');
      return { matches: matches.slice(0, args.limit).map(event => ({ path: relative(root, event.data.path.text).replaceAll('\\','/'), line: event.data.line_number, text: event.data.lines.text.replace(/\r?\n$/, ''), context: event.type === 'context' })), truncated: matches.length > args.limit };
    } });
  registry.register({ name: 'read_file', description: 'Read a UTF-8 file by 1-based line offset and limit. Returns totalLines and nextOffset; supports files up to 16 MiB.', approval: false, readOnly: true, parallelSafe: true,
    schema: z.object({ path: filePath, ...page }).strict(),
    async execute(input, ctx) { const args = this.schema.parse(input) as { path: string; offset: number; limit: number }; return textPage(await readText(ctx.workspace, args.path, ctx.signal), args.offset, args.limit); } });
  registry.register({ name: 'apply_patch', description: 'Apply exact text replacements to one UTF-8 file. Each oldText must match exactly once; all edits are validated before writing. Requires approval.', approval: true,
    schema: z.object({ path: filePath, edits: z.array(z.object({ oldText: z.string().min(1).max(128000), newText: z.string().max(128000) }).strict()).min(1).max(20) }).strict(),
    async execute(input, ctx) {
      const args = this.schema.parse(input) as { path: string; edits: { oldText: string; newText: string }[] };
      let content = await readText(ctx.workspace, args.path, ctx.signal);
      const eol = content.includes('\r\n') ? '\r\n' : '\n';
      for (const edit of args.edits) {
        const oldText = edit.oldText.replace(/\r?\n/g, eol); const newText = edit.newText.replace(/\r?\n/g, eol);
        const at = content.indexOf(oldText);
        if (at < 0 || content.indexOf(oldText, at + 1) >= 0) throw new Error('oldText must match exactly once; read the file again');
        content = content.slice(0, at) + newText + content.slice(at + oldText.length);
      }
      if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error('Edited file exceeds 16 MiB');
      ctx.signal.throwIfAborted(); await writeFile(await safePath(ctx.workspace, args.path), content, { encoding: 'utf8', signal: ctx.signal });
      return { written: args.path, edits: args.edits.length };
    } });
}
