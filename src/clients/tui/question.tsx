import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UserQuestion } from '../../core/domain.js';
import { clean, wrap } from './view.js';

export function QuestionCard({ question, count, width, height, draft, busy, onDraft, onAnswer, onClose }: {
  question?: UserQuestion; count: number; width: number; height: number; draft: string; busy: boolean;
  onDraft(value: string): void; onAnswer(value: string): void; onClose(): void;
}) {
  const options = question?.options ?? [];
  const [selected, setSelected] = useState(draft ? options.length : 0);
  const [scroll, setScroll] = useState(0);
  const rows = question ? [
    ...wrap(question.question, width - 4).map(text => ({ text, option: -1 })),
    ...[...options, draft ? 'Custom: ' + draft + '▌' : 'Custom answer: type here'].flatMap((option, i) => wrap((i === selected ? '› ' : '  ') + option, width - 4).map(text => ({ text, option: i })))
  ] : [{ text: 'No unanswered questions.', option: -1 }];
  const capacity = Math.max(1, height - 4); const maxScroll = Math.max(0, rows.length - capacity);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const row = selected === options.length && draft ? rows.findLastIndex(row => row.option === selected) : rows.findIndex(row => row.option === selected);
    if (row >= 0) setScroll(current => row < current ? row : row >= current + capacity ? row - capacity + 1 : current);
  }, [selected, draft]);
  useInput((text, key) => {
    if (key.escape || (key.ctrl && text === 'q')) { onClose(); return; }
    if (busy || key.ctrl || key.meta) return;
    if (key.pageUp || key.pageDown) { setScroll(current => Math.max(0, Math.min(maxScroll, current + (key.pageDown ? 1 : -1) * capacity))); return; }
    if (key.upArrow || key.downArrow) { setSelected(current => Math.max(0, Math.min(options.length, current + (key.downArrow ? 1 : -1)))); return; }
    if (key.return) {
      if (!question) { onClose(); return; }
      const answer = selected < options.length ? options[selected]! : draft;
      if (answer.trim()) onAnswer(answer); return;
    }
    if (key.backspace || key.delete) { setSelected(options.length); onDraft(Array.from(draft).slice(0, -1).join('')); }
    else if (text && !key.tab && !key.leftArrow && !key.rightArrow) { setSelected(options.length); onDraft((draft + clean(text).replace(/\n/g,' ')).slice(0,16000)); }
  });
  return <Box height={height} flexDirection="column" backgroundColor="#181818" paddingX={2} paddingY={1}>
    <Text color="cyan" bold>Question{count ? ` · ${count} pending` : ''}</Text>
    {rows.slice(Math.min(scroll,maxScroll), Math.min(scroll,maxScroll) + capacity).map((row,i) => <Text key={i} color={row.option === selected ? 'cyan' : undefined} wrap="truncate-end">{row.text}</Text>)}
    <Box flexGrow={1} />
    <Text dimColor wrap="truncate-end">↑↓ choose · Enter send · Esc later{maxScroll ? ' · PgUp/PgDn' : ''}</Text>
  </Box>;
}
