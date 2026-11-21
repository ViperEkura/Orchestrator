import { ModelRegistry } from '../../src/models/registry.js';
import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OrchestratorService } from '../../src/core/runtime.js';
import { StateStore } from '../../src/storage/store.js';
import { startServer } from '../../src/transport/server.js';
import type { Message, ModelChunk, ToolSpec } from '../../src/core/domain.js';

let directory: string, project: string, store: StateStore, runtime: OrchestratorService, server: Awaited<ReturnType<typeof startServer>>;
class PreviewProvider {
  async *stream(messages: Message[], _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ModelChunk> {
    const start = messages.findLastIndex(m=>m.role==='user');
    const user = messages[start]?.content ?? '', turn = messages.slice(start), calls = turn.flatMap(m=>m.toolCalls??[]);
    if (user.includes('Slow task')) await delay(20000, undefined, {signal});
    if (user.includes('Ask a question') && !calls.length) { yield {type:'tool',call:{id:'question',name:'ask_user',arguments:JSON.stringify({question:'Which client should we build first?',options:['Desktop','Web']})}};return; }
    if (user.includes('Approval') && !calls.length) { yield {type:'tool',call:{id:'write',name:'write_file',arguments:JSON.stringify({path:'approved.txt',content:'Approved test output'})}};return; }
    yield {type:'reasoning',text:'Inspecting the workspace and checking the implementation boundaries.'};
    if (!calls.length && !user.includes('Long history')) { yield {type:'tool',call:{id:'list',name:'list_files',arguments:'{}'}};return; }
    const answer = user.includes('Long history') ? Array.from({length:55},(_,i)=>`Paragraph ${i+1}. This is a readable history row for scrolling and user-turn navigation.\n\n`).join('') : '# A clear foundation for your agents\n\nThe workspace is ready. Each conversation shares the same runtime across the terminal, web, and desktop clients.\n\n| Component | Responsibility |\n| --- | --- |\n| Runtime | Tasks, tools, and agent coordination |\n| Workspace | Files and project instructions |\n| Clients | Conversations, approvals, and history |\n\n## Next steps\n\n1. Keep the conversation as the main workspace.\n2. Bring in specialist agents when a task benefits from them.\n3. Review tool activity in place, with details one click away.\n\n```ts\nconst task = await client.submit({ objective: "Review this project" });\n```\n\n**Ready when you are.**\n\n<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>';
    for (const text of answer.match(/.{1,100}/gs) ?? []) { signal.throwIfAborted(); yield {type:'text',text}; await delay(2,undefined,{signal}); }
  }
}
test.beforeAll(async()=>{
  directory=await mkdtemp(resolve('dist/web-test-')); project=join(directory,'Project'); await mkdir(project);
  const models=new ModelRegistry([{description:{id:'default',name:'Preview provider',model:'Preview provider',provider:'test'},create:()=>new PreviewProvider()}], 'default', undefined,
    (id,input)=>({description:{id,name:input.name??input.model,model:input.model,provider:'compatible'},create:()=>new PreviewProvider()}));
  store=new StateStore(join(directory,'data'));runtime=new OrchestratorService(store,new PreviewProvider(),{workspaceDir:project,model:'Preview provider',provider:'test',modelRegistry:models});
  server=await startServer(runtime,{port:0,token:'web-test-token',webRoot:resolve('dist/web')});
});
test.afterAll(async()=>{await server?.close();await runtime?.close();store?.close();if(directory?.startsWith(resolve('dist/web-test-')))await rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:500});});
async function visit(page: import('@playwright/test').Page) { await page.goto(server.url+'/#token=web-test-token');await expect(page.getByRole('heading',{name:'What would you like to build?'})).toBeVisible(); }

test('real streamed conversation, safe Markdown, tools, history, outputs and responsive layout',async({page})=>{
  await visit(page);
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Review the client architecture');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByText('Ready when you are.',{exact:true})).toBeVisible();
  await expect(page.locator('.markdown table')).toHaveCount(1);
  expect(await page.evaluate(()=>('pwned' in window))).toBe(false);
  await page.locator('.disclosure summary').filter({hasText:'list_files'}).click();
  await expect(page.getByText('Status: completed',{exact:true})).toBeVisible();
  await page.locator('.disclosure summary').filter({hasText:'list_files'}).click();
  await page.getByRole('button',{name:'Toggle details',exact:true}).click();
  await page.getByRole('button',{name:/Response 1/}).click();
  await expect(page.getByRole('dialog',{name:'Saved output'})).toBeVisible();
  await page.getByRole('button',{name:'Close dialog'}).click();
  const screenshot=process.env.ORCHESTRATOR_SCREENSHOT;
  if(screenshot)await page.screenshot({path:screenshot});
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Second turn');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'Stop task'})).toHaveCount(0);
  await page.getByRole('button',{name:'Conversation turns',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:/1 Review the client architecture/}).click();
  await page.getByRole('button',{name:'New chat',exact:true}).first().click();
  await page.locator('.session-row').filter({hasText:'Review the client architecture'}).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('heading',{name:'What would you like to build?'})).toBeVisible();
  await page.setViewportSize({width:820,height:650});
  await page.getByRole('button',{name:'Toggle sidebar'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('approval opens automatically, defers without losing draft, approves and denies',async({page})=>{
  await visit(page);
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Approval request');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Write this file?'})).toBeVisible();
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Draft preserved');
  await page.locator('.notification').click();
  await page.getByRole('button',{name:'Approve once'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await readFile(join(project,'approved.txt'),'utf8')).toBe('Approved test output');
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue('Draft preserved');
  await expect(page.getByRole('button',{name:'Stop task'})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Approval denied');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('button',{name:'Deny',exact:true}).click();
  await expect(page.locator('.disclosure.failed')).toHaveCount(1);
});

test('questions, team delegation, project selection and cancellation use the runtime',async({page})=>{
  await visit(page);
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Ask a question');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Your input is needed'})).toBeVisible();
  await page.getByRole('button',{name:'Desktop',exact:true}).click();await page.getByRole('button',{name:'Send answer',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Stop task'})).toHaveCount(0);
  expect(Object.values(store.snapshot().state.questions).some(q=>q.answer==='Desktop')).toBe(true);
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  await page.getByRole('checkbox',{name:/Researcher/}).check();await page.getByRole('checkbox',{name:/Reviewer/}).check();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Review as a team');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(()=>Object.values(store.snapshot().state.tasks).filter(t=>t.parentTaskId).length).toBe(2);
  await expect(page.getByRole('button',{name:'Stop task'})).toHaveCount(0);
  const other=join(directory,'AnotherProject');await mkdir(other);
  await page.getByRole('button',{name:'Add project'}).click();await page.getByRole('textbox',{name:'Project directory'}).fill(other);await page.getByRole('button',{name:'Open project',exact:true}).click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Slow task');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('button',{name:'Stop task'}).click();
  await expect.poll(()=>Object.values(store.snapshot().state.tasks).some(t=>t.objective==='Slow task'&&t.status==='cancelled')).toBe(true);
  expect(Object.values(store.snapshot().state.sessions).some(s=>s.cwd.toLowerCase()===other.toLowerCase())).toBe(true);
});

test('static assets expose no workspace files and APIs still require authentication',async({request})=>{
  const response=await request.get(server.url+'/');expect(response.status()).toBe(200);expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  expect((await request.get(server.url+'/v1/snapshot')).status()).toBe(401);
  expect((await request.get(server.url+'/.orchestrator/settings.json',{headers:{Authorization:'Bearer web-test-token'}})).status()).toBe(404);
  expect((await request.post(server.url+'/v1/tasks',{headers:{Authorization:'Bearer web-test-token',Origin:'https://evil.example'},data:{objective:'bad'}})).status()).toBe(403);
  const task=runtime.submit({objective:'Project immutability'});await runtime.waitUntilDone(task.id);
  expect(()=>runtime.submit({objective:'move',sessionId:task.sessionId,cwd:project})).toThrow(/keep their project/);
});

test('packaged exe starts its own runtime and closes cleanly',async()=>{
  const net = createServer(); await new Promise<void>(done=>net.listen(0,'127.0.0.1',done));
  const port = (net.address() as {port:number}).port; await new Promise<void>(done=>net.close(()=>done()));
  const child=spawn(resolve('dist/windows/Orchestrator/Orchestrator.exe'),['--cwd',project],{windowsHide:false,env:{...process.env,ORCHESTRATOR_DATA_DIR:join(directory,'desktop-data'),ORCHESTRATOR_PROVIDER:'demo',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  let closed=false;child.once('exit',()=>{closed=true;});
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await expect.poll(async()=>{try{return(await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},{timeout:20000}).toBe(true);
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
    await expect.poll(()=>browser!.contexts()[0]?.pages().length??0).toBeGreaterThan(0);
    const page=browser.contexts()[0]!.pages()[0]!;
    await expect(page.getByRole('heading',{name:'What would you like to build?'})).toBeVisible();
    expect(await page.evaluate(()=>typeof (window as unknown as {require?: unknown}).require)).toBe('undefined');
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('Hello from desktop');await page.getByRole('button',{name:'Send message',exact:true}).click();
    await expect(page.getByText('Demo mode: configure a model provider for real conversation.',{exact:true})).toBeVisible();
    if(process.env.ORCHESTRATOR_NATIVE_SCREENSHOT) await page.screenshot({path:process.env.ORCHESTRATOR_NATIVE_SCREENSHOT});
    await page.reload();await expect(page.getByRole('heading',{name:'What would you like to build?'})).toBeVisible();
    await page.evaluate(()=>window.close()).catch(()=>{});
    await expect.poll(()=>closed,{timeout:12000}).toBe(true);
  } finally { if(!closed)child.kill();await browser?.close().catch(()=>{}); }
});


test('compact navigation, search empty state and dialog focus preserve the composer', async ({page}) => {
  await page.setViewportSize({width:390,height:760});
  await visit(page);
  const editor = page.getByRole('textbox',{name:'Message',exact:true});
  await editor.fill('Keep this draft');
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.getByRole('button',{name:'Agents',exact:true})).toBeFocused();
  await expect(editor).toHaveValue('Keep this draft');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox',{name:'Search conversations'})).toBeFocused();
  await page.getByRole('textbox',{name:'Search conversations'}).fill('no-match-unique-123');
  await expect(page.getByText('No matching conversations.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close sidebar',exact:true}).click({position:{x:320,y:100}});
  await expect(editor).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const send = await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();
  expect(send!.x + send!.width).toBeLessThanOrEqual(390);
  if(process.env.ORCHESTRATOR_MOBILE_SCREENSHOT)await page.screenshot({path:process.env.ORCHESTRATOR_MOBILE_SCREENSHOT});
});


test('approval menu supports keyboard selection, dismissal and narrow windows', async ({page}) => {
  await visit(page);
  const trigger = page.getByRole('button',{name:'Approval mode',exact:true});
  const menu = page.getByRole('menu',{name:'Approval mode',exact:true});
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(page.getByRole('menuitemradio',{name:/Ask for approval/})).toBeFocused();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('Allow all');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(runtime.info().approvalMode).toBe('all');
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(page.getByRole('menuitemradio',{name:/Allow all/})).toBeFocused();
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('Ask for approval');
  await trigger.click();
  if(process.env.ORCHESTRATOR_MENU_SCREENSHOT) await page.screenshot({path:process.env.ORCHESTRATOR_MENU_SCREENSHOT});
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await trigger.click(); await page.getByRole('heading',{name:'What would you like to build?'}).click();
  await expect(menu).toBeHidden();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Approval mode'}).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.setViewportSize({width:390,height:760});
  await trigger.click();
  const bounds=await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(760);
  if(process.env.ORCHESTRATOR_MENU_MOBILE_SCREENSHOT) await page.screenshot({path:process.env.ORCHESTRATOR_MENU_MOBILE_SCREENSHOT});
});


test('projects contain their own conversations and collapse without losing selection', async ({page}) => {
  await visit(page);
  const other=join(directory,'GroupedProject');await mkdir(other,{recursive:true});
  const first=runtime.submit({objective:'Conversation in Project',cwd:project});await runtime.waitUntilDone(first.id);
  const second=runtime.submit({objective:'Conversation in GroupedProject',cwd:other});await runtime.waitUntilDone(second.id);
  await page.reload();
  const group=page.locator('.project-group').filter({has:page.getByRole('button',{name:'New chat in GroupedProject',exact:true})});
  await expect(group.locator('.session-row')).toHaveCount(1);
  await expect(group.locator('.session-row')).toHaveText('Conversation in GroupedProject');
  await group.locator('.session-row').click();
  await expect(page.locator('.chat-heading')).toContainText('GroupedProject');
  await group.getByRole('button',{name:'GroupedProject',exact:true}).click();
  await expect(group.locator('.session-row')).toHaveCount(0);
  await expect(page.locator('.chat-heading')).toContainText('Conversation in GroupedProject');
  await group.getByRole('button',{name:'New chat in GroupedProject',exact:true}).click();
  await expect(page.locator('.chat-heading')).toContainText('New conversation');
  await expect(page.locator('.chat-heading')).toContainText('GroupedProject');
  await expect(group.locator('.session-row')).toBeVisible();
  await page.getByRole('textbox',{name:'Search conversations'}).fill('Conversation in GroupedProject');
  await expect(page.locator('.project-group')).toHaveCount(1);
});


test('users add custom model endpoints and switch without exposing the API key',async({page})=>{
  await visit(page);
  await page.getByRole('button',{name:'Choose model',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Choose model',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add model',exact:true}).click();
  await page.getByLabel('Display name',{exact:true}).fill('My custom model');
  await page.getByLabel('API base URL',{exact:true}).fill('https://provider.example.test/v1');
  await page.getByLabel('Model ID',{exact:true}).fill('custom-model');
  await page.getByLabel('API key',{exact:true}).fill('private-ui-test-key');
  await expect(page.getByLabel('API key',{exact:true})).toHaveAttribute('type','password');
  await page.getByRole('button',{name:'Save and use',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Choose model',exact:true})).toContainText('custom-model');
  expect(JSON.stringify(store.events())).not.toContain('private-ui-test-key');
  await page.getByRole('button',{name:'Choose model',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('My custom model');
  expect(await page.locator('body').textContent()).not.toContain('private-ui-test-key');
  if(process.env.ORCHESTRATOR_MODELS_SCREENSHOT)await page.screenshot({path:process.env.ORCHESTRATOR_MODELS_SCREENSHOT});
  await page.getByRole('dialog').getByRole('button',{name:/Preview provider/}).click();
  await expect(page.getByRole('button',{name:'Choose model',exact:true})).toContainText('Preview provider');
});
