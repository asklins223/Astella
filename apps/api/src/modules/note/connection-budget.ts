/** Process-wide WebSocket budget; failed handshakes consume a slot as well. */
export function createNoteConnectionBudget(maxConnections: number) {
  let active = 0;
  return {
    acquire(): (() => void) | null {
      if (active >= maxConnections) return null;
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
  };
}

/** Bound sustained message processing while permitting one full-size document. */
export function createNoteMessageBudget(now = Date.now) {
  let windowStart = now();
  let messages = 0;
  let bytes = 0;
  return (size: number): boolean => {
    const time = now();
    if (time - windowStart >= 10_000 || time < windowStart) {
      windowStart = time;
      messages = 0;
      bytes = 0;
    }
    messages++;
    bytes += size;
    return messages <= 600 && bytes <= 256 * 1024 * 1024;
  };
}
