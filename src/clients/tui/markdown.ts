import { marked, type Token, type Tokens } from 'marked';
import { Chalk } from 'chalk';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'node:util';

const emphasis = new Chalk({ level: 1 });
const style = new Chalk({ level: process.env.NO_COLOR === undefined ? 1 : 0 });
const safe = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
const entities = (text: string) => safe(text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (original, name: string) => {
  const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (names[name]) return names[name]!;
  const point = name[0] === '#' ? parseInt(name.slice(name[1]?.toLowerCase() === 'x' ? 2 : 1), name[1]?.toLowerCase() === 'x' ? 16 : 10) : NaN;
  return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
}));
const wrap = (text: string, width: number) => wrapAnsi(text, Math.max(2, width), { hard: true, trim: false }).split('\n');

function inline(tokens: Token[]): string {
  return tokens.map(token => {
    const nested = () => inline('tokens' in token ? token.tokens ?? [] : []);
    switch (token.type) {
      case 'strong': return emphasis.bold(nested());
      case 'em': return emphasis.italic(nested());
      case 'del': return emphasis.strikethrough(nested());
      case 'codespan': return style.cyan(entities(token.text));
      case 'link': return emphasis.underline(nested()) + (token.text === token.href ? '' : style.gray(` (${safe(token.href)})`));
      case 'image': return `[Image: ${entities(token.text)}] (${safe(token.href)})`;
      case 'br': return '\n';
      default: return 'tokens' in token && token.tokens ? nested() : entities(('text' in token ? token.text : token.raw) ?? '');
    }
  }).join('');
}

function table(token: Tokens.Table, width: number): string[] {
  const rows = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens)));
  const count = token.header.length;
  // Very wide tables become labelled records; no columns or cell text are discarded.
  if (count * 6 + 1 > width) return token.rows.length ? rows.slice(1).flatMap((row, i) => [
    style.gray(`Row ${i + 1}`), ...row.flatMap((cell, col) => wrap(`${emphasis.bold(rows[0]![col])}: ${cell}`, width)), ''
  ]) : rows[0]!.flatMap(cell => wrap(emphasis.bold(cell), width));
  const budget = width - count * 3 - 1;
  const widths = Array.from({ length: count }, (_, col) => Math.min(budget, Math.max(3, ...rows.map(row => Math.max(...row[col]!.split('\n').map(value => stringWidth(value)))))));
  while (widths.reduce((sum, n) => sum + n, 0) > budget) {
    const widest = widths.indexOf(Math.max(...widths)); widths[widest]!--;
  }
  const border = (left: string, middle: string, right: string) => style.gray(left + widths.map(n => '─'.repeat(n + 2)).join(middle) + right);
  const output = [border('┌', '┬', '┐')];
  rows.forEach((row, rowIndex) => {
    const cells = row.map((cell, col) => wrap(rowIndex === 0 ? emphasis.bold(style.cyan(cell)) : cell, widths[col]!));
    for (let line = 0; line < Math.max(...cells.map(cell => cell.length)); line++) {
      const padded = cells.map((cell, col) => {
        const value = cell[line] ?? ''; const spaces = Math.max(0, widths[col]! - stringWidth(value));
        const left = token.align[col] === 'right' ? spaces : token.align[col] === 'center' ? Math.floor(spaces / 2) : 0;
        return ' '.repeat(left) + value + ' '.repeat(spaces - left);
      });
      output.push(style.gray('│ ') + padded.join(style.gray(' │ ')) + style.gray(' │'));
    }
    if (rowIndex < rows.length - 1) output.push(border('├', '┼', '┤'));
  });
  output.push(border('└', '┴', '┘')); return output;
}

function blocks(tokens: Token[], width: number): string[] {
  const output: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space': if (output.length && output.at(-1) !== '') output.push(''); break;
      case 'heading': output.push(...wrap(emphasis.bold(style.cyan(inline(token.tokens ?? []))), width), ''); break;
      case 'paragraph': case 'text': output.push(...wrap(token.tokens ? inline(token.tokens) : entities(token.text), width)); break;
      case 'table': output.push(...table(token as Tokens.Table, width), ''); break;
      case 'hr': output.push(style.gray('─'.repeat(width))); break;
      case 'code': {
        output.push(style.gray(`code${token.lang ? ` · ${safe(token.lang)}` : ''}`));
        output.push(...wrap(safe(token.text), width - 2).map(line => style.gray('│ ') + style.cyan(line)), ''); break;
      }
      case 'blockquote': output.push(...blocks(token.tokens ?? [], Math.max(2, width - 2)).map(line => style.gray('│ ') + line), ''); break;
      case 'list': {
        const list = token as Tokens.List;
        list.items.forEach((item, i) => {
          const marker = item.task ? `${item.checked ? '☑' : '☐'} ` : list.ordered ? `${Number(list.start) + i}. ` : '• ';
          const indent = stringWidth(marker);
          const content = blocks(item.tokens, Math.max(2, width - indent));
          output.push(...content.map((line, n) => (n ? ' '.repeat(indent) : marker) + line));
        });
        output.push(''); break;
      }
      default: output.push(...wrap(safe(token.raw ?? ''), width));
    }
  }
  return output;
}

const cache = new Map<string, string[]>();
/** Format untrusted Markdown into individually wrapped terminal lines; persist only the source text. */
export function renderMarkdown(source: string, width: number, cached = true): string[] {
  width = Math.max(10, Math.floor(width));
  const key = `${width}\0${source}`;
  if (cached && cache.has(key)) return cache.get(key)!;
  let lines: string[];
  try { lines = blocks(marked.lexer(safe(source), { gfm: true, breaks: true }), width); }
  catch { lines = wrap(safe(source), width); } // Incomplete streaming Markdown remains readable.
  while (lines.at(-1) === '') lines.pop();
  if (cached) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, lines);
  }
  return lines;
}
