import { useEffect, useRef } from 'react';
import { useInput, useStdin, type Key } from 'ink';

/** Ink 6 labels both terminal DEL/backspace and CSI Delete as `delete`.
 * Keep that compatibility workaround here so editors can distinguish them.
 */
export function useTerminalInput(handler: (text: string, key: Key) => void) {
  const { internal_eventEmitter: events } = useStdin();
  const sequence = useRef('');
  useEffect(() => {
    const capture = (value: string) => { sequence.current = value; };
    events?.prependListener('input', capture);
    return () => { events?.removeListener('input', capture); };
  }, [events]);
  useInput((text, key) => {
    if (key.delete && /^(?:\x1b)?\x7f$|^\x1b\[127(?:;[\d:]+)?u$/.test(sequence.current)) {
      handler(text, { ...key, backspace: true, delete: false });
    } else if (sequence.current === '\n') handler('j', { ...key, ctrl: true, return: false });
    else handler(text, key);
  });
}
