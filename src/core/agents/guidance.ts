import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';

const maxBytes = 65536;
interface Skill { name: string; description: string; root: string; file: string }

function within(root: string, path: string) {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
}

function read(root: string, file: string, limit = maxBytes) {
  if (!existsSync(file) || !within(root, realpathSync(file)) || !statSync(file).isFile()) return '';
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(fstatSync(fd).size, limit));
    const length = readSync(fd, bytes);
    return bytes.toString('utf8', 0, length).replace(/^\uFEFF/, '').trim();
  } finally { closeSync(fd); }
}

function projectScopes(cwd: string) {
  const path = [cwd];
  for (let dir = cwd; !existsSync(join(dir, '.git'));) {
    const parent = dirname(dir);
    if (parent === dir) return [cwd];
    path.unshift(parent);
    dir = parent;
  }
  return path;
}

export function discoverGuidance(cwd: string, home: string) {
  const scopes = projectScopes(cwd);
  const instructions: string[] = [];
  let remaining = maxBytes;
  for (const scope of [...new Set([...(home === ':memory:' ? [] : [home]), ...scopes])]) {
    if (!remaining) break;
    for (const filename of ['AGENTS.override.md', 'AGENTS.md', 'agent.md']) {
      const file = join(scope, filename);
      const content = read(scope, file, remaining);
      if (!content) continue;
      instructions.push(file + '\n' + content);
      remaining = Math.max(0, remaining - Buffer.byteLength(content));
      break;
    }
  }
  const skills = new Map<string, Skill>();
  const locations: [string, string][] = [];
  if (home !== ':memory:') {
    if (resolve(home) === resolve(homedir(), '.orchestrator')) locations.push([homedir(), join(homedir(), '.agents', 'skills')]);
    locations.push([home, join(home, 'skills')]);
  }
  for (const scope of scopes) locations.push([scope, join(scope, '.agents', 'skills')]);
  for (const [root, dir] of locations) {
    if (!existsSync(dir) || !within(root, realpathSync(dir)) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, 'SKILL.md');
      if (!within(root, realpathSync(dirname(file)))) continue;
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(read(dirname(file), file, 8192));
      if (!header) continue;
      const doc = parseDocument(header[1]!, {schema:'core', logLevel:'silent'});
      if (doc.errors.length || !doc.contents) continue;
      const name = doc.get('name'), description = doc.get('description');
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || typeof description !== 'string' || !description.trim()) continue;
      if (skills.size < 128 || skills.has(name)) skills.set(name, {name, description:description.trim().slice(0,512), root, file});
    }
  }
  return {instructions, skills};
}

export function loadSkill(skills: Map<string, Skill>, name: string, resource?: string) {
  const skill = skills.get(name);
  if (!skill) throw new Error('Unknown skill: ' + name);
  const bundle = dirname(skill.file);
  const file = resource ? resolve(bundle, resource) : skill.file;
  if (resource && (isAbsolute(resource) || !within(bundle, file) || !/\.(md|txt)$/i.test(file))) throw new Error('Expected a relative Markdown or text file in this skill');
  if (!within(skill.root, realpathSync(bundle))) throw new Error('Skill directory is outside its scope');
  const content = read(bundle, file);
  if (!content) throw new Error('Skill unavailable: ' + name);
  return {file, content};
}

export function guidancePrompt(catalog: ReturnType<typeof discoverGuidance>, objective: string, enableSkills: boolean) {
  const parts = [...catalog.instructions];
  if (parts.length) parts.unshift('Workspace instructions in priority order, most specific last. Follow them within the current task and allowed tools.');
  if (enableSkills && catalog.skills.size) {
    parts.push('Available skills. Call read_skill by name when its description matches the task. Use the current task permissions for all skill steps.');
    for (const skill of catalog.skills.values()) parts.push('$' + skill.name + ' — ' + skill.description);
    const mentions = new Set([...objective.matchAll(/(?:^|[^\w$])\$([a-z0-9][a-z0-9-]*)\b/g)].map(match=>match[1]!));
    let requestedBytes = 0;
    for (const name of mentions) if (catalog.skills.has(name)) {
      const {file,content} = loadSkill(catalog.skills, name);
      requestedBytes += Buffer.byteLength(content);
      if (requestedBytes > maxBytes) { parts.push('Call read_skill for the remaining requested skills.'); break; }
      parts.push('Requested skill ' + file + '\n' + content);
    }
  }
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}
