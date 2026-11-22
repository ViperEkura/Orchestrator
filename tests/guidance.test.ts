import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverGuidance, loadSkill } from '../src/core/agents/guidance.js';
import { OrchestratorService } from '../src/core/runtime.js';
import { StateStore } from '../src/storage/store.js';
import type { ModelProvider } from '../src/core/domain.js';

test('project scopes, role discovery and skill activation reach independent child runs', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'guidance-'));
  const root = join(tmp,'repo'), cwd = join(root,'service'), home = join(tmp,'home');
  const put = (path: string, value: string) => { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,value); };
  mkdirSync(join(root,'.git'),{recursive:true});
  put(join(home,'AGENTS.md'),'global convention');
  put(join(root,'agent.md'),'root convention');
  put(join(cwd,'AGENTS.md'),'superseded convention');
  put(join(cwd,'AGENTS.override.md'),'local convention');
  const manifest = '---\nname: review\ndescription: >\n  Review the\n  changed files.\n---\n';
  put(join(home,'skills','review','SKILL.md'),manifest+'Global workflow.');
  const bundle = join(root,'.agents','skills','review');
  put(join(bundle,'SKILL.md'),manifest+'Project workflow.');
  put(join(bundle,'references','notes.md'),'Review notes.');
  const catalog = discoverGuidance(cwd,home);
  assert.throws(()=>loadSkill(catalog.skills,'review','../secret.md'));
  assert.equal(loadSkill(catalog.skills,'review','references/notes.md').content,'Review notes.');
  const provider: ModelProvider = {async *stream(messages){
    if (messages[0]!.content.startsWith('[researcher]') && !messages.some(m=>m.role==='tool')) {
      yield {type:'tool',call:{id:'skill',name:'read_skill',arguments:'{"name":"review"}'}}; return;
    }
    yield {type:'text',text:'Done'};
  }};
  const store = new StateStore(home);
  const service = new OrchestratorService(store,provider,{workspaceDir:cwd});
  try {
    const task = service.submit({objective:'Use $review',delegations:[{agentId:'researcher',objective:'Check changes'}]});
    const done = await service.waitUntilDone(task.id);
    assert.equal(done.status,'completed',done.error);
    const runs = Object.values(store.snapshot().state.runs);
    const parent = runs.find(r=>r.taskId===task.id)!, child = runs.find(r=>r.taskId!==task.id)!;
    assert.match(parent.messages[0]!.content,/Registered roles for delegate_task/);
    assert.match(parent.messages[0]!.content,/Project workflow/);
    assert.match(child.messages[0]!.content,/global convention[\s\S]*root convention[\s\S]*local convention/);
    assert.match(child.messages[0]!.content,/Review the changed files/);
    assert.doesNotMatch(child.messages[0]!.content,/superseded convention|Project workflow|Global workflow/);
    assert.ok(child.messages.some(m=>m.role==='tool' && m.content.includes('Project workflow')));
  } finally { await service.close(); store.close(); rmSync(tmp,{recursive:true,force:true}); }
});
