/** Bound JSON structural complexity before validators allocate one issue per item.
 * String payload sizes remain governed by each route's bodyLimit and schema. */
export function isBoundedRequestShape(value: unknown): boolean {
  const maxNodes = 50_000;
  const maxDepth = 64;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++visited > maxNodes || item.depth > maxDepth) return false;
    if (item.value === null || typeof item.value !== "object") continue;
    const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
    if (children.length > maxNodes - visited - pending.length) return false;
    for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
