import test from 'node:test';
import assert from 'node:assert/strict';
import { backspace, deleteForward, draftOf, insert, layout, move, moveVertical, MAX_INPUT } from '../src/tui/editor.js';

test('editing preserves Chinese, combining characters and joined emoji', () => {
  const original = draftOf('你好👩‍💻é');
  assert.equal(backspace(original).value, '你好👩‍💻');
  assert.equal(backspace(backspace(original)).value, '你好');
  const middle = insert(move(draftOf('你好世界'), -2), '，');
  assert.equal(middle.value, '你好，世界');
  assert.equal(deleteForward(middle).value, '你好，界');
});

test('pasted lines retain structure, strip terminal controls and respect the input limit', () => {
  assert.equal(insert(draftOf(), 'a\r\nb\t\x1b[31mc').value, 'a\nb  c');
  const full = draftOf('a'.repeat(MAX_INPUT - 2) + '😀');
  assert.equal(insert(move(full, -1), 'extra').value, full.value);
  assert.equal(draftOf('a'.repeat(MAX_INPUT - 1) + '😀').value.length, MAX_INPUT - 1);
});

test('cursor wraps at cell boundaries and vertical movement respects wide characters', () => {
  assert.deepEqual(layout(draftOf('你好a', 2), 4), { lines: ['你好', 'a'], row: 1, column: 0, index: 0 });
  assert.equal(layout(draftOf('abcd'), 4).row, 1);
  assert.equal(moveVertical(draftOf('你好\nabc', 1), 1).cursor, 5);
  assert.equal(moveVertical(draftOf('你好\nabc', 5), -1).cursor, 1);
});
