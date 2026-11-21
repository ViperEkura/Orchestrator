import stringWidth from 'string-width';

/** Maximum UTF-16 length, matching the runtime input limit. */
export const MAX_INPUT = 16000;
/** The cursor is measured in grapheme clusters, keeping joined emoji whole. */
export type Draft = { value: string; cursor: number };
export type DraftLayout = { lines: string[]; row: number; column: number; index: number };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const chars = (value: string): string[] => Array.from(segmenter.segment(value), item => item.segment);
const truncate = (value: string, limit = MAX_INPUT) => {
  let result = '';
  for (const char of chars(value)) { if (result.length + char.length > limit) break; result += char; }
  return result;
};
const isWord = (char: string) => /[\p{L}\p{N}_]/u.test(char);

/** Keep pasted text on one origin: no carriage returns, tabs or terminal escapes. */
export function normalizeInput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function draftOf(value = '', cursor?: number): Draft {
  const parts = truncate(normalizeInput(value));
  return { value: parts, cursor: Math.max(0, Math.min(chars(parts).length, cursor ?? chars(parts).length)) };
}

const at = (value: string, cursor: number): Draft => draftOf(value, cursor);
const bounded = (draft: Draft) => Math.max(0, Math.min(chars(draft.value).length, draft.cursor));

function splice(draft: Draft, from: number, to: number, text = ''): Draft {
  const parts = chars(draft.value);
  const start = Math.max(0, Math.min(parts.length, from));
  const end = Math.max(start, Math.min(parts.length, to));
  const before = parts.slice(0, start).join(''), after = parts.slice(end).join('');
  const added = truncate(normalizeInput(text), MAX_INPUT - before.length - after.length);
  return at(before + added + after, start + chars(added).length);
}

export function insert(draft: Draft, text: string): Draft {
  const cursor = bounded(draft);
  return splice(draft, cursor, cursor, text);
}

export function backspace(draft: Draft): Draft {
  const cursor = bounded(draft);
  return cursor > 0 ? splice(draft, cursor - 1, cursor) : at(draft.value, 0);
}

export function deleteForward(draft: Draft): Draft {
  const cursor = bounded(draft);
  return cursor < chars(draft.value).length ? splice(draft, cursor, cursor + 1) : at(draft.value, cursor);
}

export function move(draft: Draft, delta: number): Draft {
  return at(draft.value, bounded(draft) + delta);
}

/** Index of the start of the word before (direction -1) or after (1) the cursor. */
export function wordEdge(draft: Draft, direction: -1 | 1): number {
  const parts = chars(draft.value);
  let index = bounded(draft);
  if (direction < 0) {
    while (index > 0 && !isWord(parts[index - 1]!)) index--;
    while (index > 0 && isWord(parts[index - 1]!)) index--;
  } else {
    while (index < parts.length && isWord(parts[index]!)) index++;
    while (index < parts.length && !isWord(parts[index]!)) index++;
  }
  return index;
}

export const moveWord = (draft: Draft, direction: -1 | 1): Draft => at(draft.value, wordEdge(draft, direction));

export function lineStartIndex(draft: Draft): number {
  const parts = chars(draft.value);
  let index = bounded(draft);
  while (index > 0 && parts[index - 1] !== '\n') index--;
  return index;
}

export function lineEndIndex(draft: Draft): number {
  const parts = chars(draft.value);
  let index = bounded(draft);
  while (index < parts.length && parts[index] !== '\n') index++;
  return index;
}

export const lineStart = (draft: Draft): Draft => at(draft.value, lineStartIndex(draft));
export const lineEnd = (draft: Draft): Draft => at(draft.value, lineEndIndex(draft));
export const deleteToLineStart = (draft: Draft): Draft => splice(draft, lineStartIndex(draft), bounded(draft));
export const deleteToLineEnd = (draft: Draft): Draft => splice(draft, bounded(draft), lineEndIndex(draft));
export const deleteWordBack = (draft: Draft): Draft => splice(draft, wordEdge(draft, -1), bounded(draft));

/**
 * Wrap the draft into visual lines and locate the cursor. `column` and `index` describe the
 * cursor cell: display width before it, and its grapheme offset in its own visual line.
 */
export function layout(draft: Draft, width: number): DraftLayout {
  const limit = Math.max(1, width);
  const parts = chars(draft.value);
  const cursor = bounded(draft);
  const lines = [''];
  let row = 0; let column = 0; let index = 0;
  let cursorRow = 0; let cursorColumn = 0; let cursorIndex = 0;
  for (let i = 0; i < parts.length; i++) {
    const char = parts[i]!;
    if (char === '\n') {
      if (i === cursor) { cursorRow = row; cursorColumn = column; cursorIndex = index; }
      lines.push(''); row++; column = 0; index = 0; continue;
    }
    const cell = stringWidth(char);
    if (column > 0 && column + cell > limit) { lines.push(''); row++; column = 0; index = 0; }
    if (i === cursor) { cursorRow = row; cursorColumn = column; cursorIndex = index; }
    lines[row] += char; column += cell; index++;
  }
  if (cursor >= parts.length && column >= limit) { lines.push(''); row++; column = 0; index = 0; }
  if (cursor >= parts.length) { cursorRow = row; cursorColumn = column; cursorIndex = index; }
  return { lines, row: cursorRow, column: cursorColumn, index: cursorIndex };
}

/** Move between logical lines using terminal columns instead of string length. */
export function moveVertical(draft: Draft, direction: -1 | 1): Draft {
  const parts = chars(draft.value), start = lineStartIndex(draft), end = lineEndIndex(draft);
  const column = stringWidth(parts.slice(start, draft.cursor).join(''));
  if (direction < 0 && start === 0 || direction > 0 && end === parts.length) return draft;
  const target = direction < 0 ? lineStartIndex(at(draft.value, start - 1)) : end + 1;
  let index = target, width = 0;
  while (index < parts.length && parts[index] !== '\n' && width + stringWidth(parts[index]!) <= column) {
    width += stringWidth(parts[index++]!);
  }
  return at(draft.value, index);
}
