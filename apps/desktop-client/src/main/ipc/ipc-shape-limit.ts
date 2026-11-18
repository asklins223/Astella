/** Bound structural work before validating a structured-clone IPC payload. */
export function isBoundedIpcShape(value: unknown): boolean {
  const maxNodes = 50_000;
  const pending = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > maxNodes || item.depth > 64) return false;
    if (item.value === null || typeof item.value !== 'object') continue;
    if (ArrayBuffer.isView(item.value) || item.value instanceof ArrayBuffer) continue;
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
    if (children.length > maxNodes - count - pending.length) return false;
    for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
