import React from 'react';
import { Text } from 'ink';
import { chars, layout, type Draft } from './editor.js';

/** Keep the cursor visible without letting a long paste displace the conversation. */
export function Composer({ draft, width, rows, busy, placeholder = 'Ask anything, or / for commands' }: { draft: Draft; width: number; rows: number; busy: boolean; placeholder?: string }) {
  const value = layout(draft, width);
  const top = Math.max(0, Math.min(value.row - rows + 1, value.lines.length - rows));
  return <>{value.lines.slice(top, top + rows).map((line, index) => {
    const active = top + index === value.row;
    const parts = chars(line);
    return <Text key={index} color="#dedede" wrap="truncate-end">
      <Text color={active ? 'cyan' : 'gray'}>{index === 0 ? top ? '↑ ' : '› ' : '  '}</Text>
      {active && !busy ? <>{parts.slice(0, value.index).join('')}<Text inverse>{parts[value.index] || ' '}</Text>{parts.slice(value.index + 1).join('')}</> : line || ' '}
      {!draft.value && !busy ? <Text color="#909090"> {' '+placeholder}</Text> : null}
    </Text>;
  })}</>;
}
