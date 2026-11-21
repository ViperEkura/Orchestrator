import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { renderMarkdown } from '../src/tui/markdown.js';
import { transcript, historyTop } from '../src/tui/view.js';
import { emptyState } from '../src/storage/store.js';

const plain = (lines: string[]) => lines.map(stripVTControlCharacters);
test('Markdown renders emphasis and block formatting while code remains literal', () => {
  const lines = renderMarkdown('# Heading\n\nNormal **bold** and *italic* plus `code`.\n\n- item\n- **important**\n\n> quotation\n\n```ts\nconst x = "**literal**";\n```', 50);
  const text = plain(lines).join('\n');
  assert.match(lines.join('\n'), /\x1b\[1mbold\x1b\[22m/);
  assert.match(lines.join('\n'), /\x1b\[3mitalic\x1b\[23m/);
  assert.match(text, /Normal bold and italic plus code\./);
  assert.match(text, /• important/); assert.match(text, /│ quotation/);
  assert.match(text, /const x = "\*\*literal\*\*";/);
  assert.doesNotMatch(text, /```|# Heading/);
});

test('tables align Chinese and emoji by display width, wrap cells and retain every column', () => {
  const source = '| 项目 | 内容 | 数量 |\n| :--- | :---: | ---: |\n| **模型** | 中文和 emoji 👩‍💻 | 12 |\n| 配置 | 很长的描述内容，不能被裁掉，全部显示。 | 100 |';
  const rendered = renderMarkdown(source, 45);
  const lines = plain(rendered);
  assert.ok(lines.some(line => line.startsWith('┌')));
  assert.ok(lines.every(line => stringWidth(line) <= 45));
  const bordered = lines.filter(line => /^[┌├└│]/.test(line));
  assert.equal(new Set(bordered.map(line => stringWidth(line))).size, 1);
  assert.match(lines.join('\n'), /👩‍💻/);
  assert.match(lines.filter(line => line.startsWith('│')).map(line => line.split('│')[2] ?? '').join('').replace(/\s/g, ''), /很长的描述内容，不能被裁掉，全部显示。/);
  const narrow = plain(renderMarkdown(source, 16)).join('\n');
  assert.match(narrow, /Row 1/); assert.match(narrow, /数量: 12/);
  assert.ok(plain(renderMarkdown(source, 16)).every(line => stringWidth(line) <= 16));
});

test('escaped pipes, links, partial streaming and terminal controls are handled safely', () => {
  const table = plain(renderMarkdown('| A | B |\n| --- | --- |\n| x\\|y | **yes** |', 32)).join('\n');
  assert.match(table, /x\|y/); assert.match(table, /yes/);
  const link = plain(renderMarkdown('[docs](https://example.com) &amp; text', 80)).join('\n');
  assert.match(link, /docs \(https:\/\/example.com\) & text/);
  for (const text of ['**unfinished', '```ts\nconst n = 1', '| A | B |\n| --', '**complete**']) {
    assert.ok(renderMarkdown(text, 25, false).length);
  }
  const hostile = renderMarkdown('\x1b[2J**safe**\x1b]52;c;YQ==\x07\n&#27;[2J', 40).join('\n');
  assert.doesNotMatch(hostile, /\x1b\[2J|\x1b\]52/); assert.match(stripVTControlCharacters(hostile), /safe/);
});

test('formatted live and persisted messages share layout and user-turn anchors', () => {
  const state = emptyState();
  state.tasks.t = { id: 't', rootId: 't', sessionId: 's', objective: '**literal user input**', agentId: 'assistant', depth: 0, dependsOn: [], status: 'running', runIds: ['r'], createdAt: '' };
  state.runs.r = { id: 'r', taskId: 't', attempt: 1, status: 'running', steps: 1, config: { id: 'assistant', name: 'Assistant', systemPrompt: '', allowedTools: [] }, messages: [{ role: 'user', content: '**literal user input**' }] };
  const answer = '**Summary**\n\n| 项目 | 值 |\n| --- | --- |\n| 测试 | passed |';
  const live = transcript(state, 's', { r: answer }, 45);
  state.runs.r.messages.push({ role: 'assistant', content: answer });
  const stored = transcript(state, 's', {}, 45);
  assert.deepEqual(live, stored);
  assert.equal(historyTop(stored, 8, { turnId: 't', line: 0 }), 0);
  assert.ok(stored.some(line => line.text === '**literal user input**'));
  assert.equal(state.runs.r.messages.at(-1)!.content, answer);
});

test('tables separate every logical row, including wrapped cells', () => {
  const rows=renderMarkdown('| Name | Details |\n| --- | --- |\n| First | A long description that wraps across several terminal lines |\n| Second | Another entry |\n| Third | Final entry |',40).map(stripVTControlCharacters);
  const separators=rows.map((line,i)=>line.startsWith('├')?i:-1).filter(i=>i>=0);
  assert.equal(separators.length,3);
  const second=rows.findIndex(line=>line.includes('Second')); const third=rows.findIndex(line=>line.includes('Third'));
  assert.ok(separators[1]!<second);assert.ok(separators[2]!>second&&separators[2]!<third);
  assert.ok(rows.every(line=>stringWidth(line)<=40));
});
