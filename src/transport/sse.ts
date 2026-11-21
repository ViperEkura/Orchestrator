/** Browser-compatible SSE decoder shared by the model adapter and client SDK. */
export async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let data: string[] = []; let frameSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line) { if (data.length) yield data.join('\n'); data = []; frameSize = 0; }
        else if (line.startsWith('data:')) { frameSize += line.length; if (frameSize > 2_000_000) throw new Error('SSE frame too large'); data.push(line.slice(5).replace(/^ /, '')); }
      }
      if (buffer.length > 2_000_000) throw new Error('SSE frame too large');
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
