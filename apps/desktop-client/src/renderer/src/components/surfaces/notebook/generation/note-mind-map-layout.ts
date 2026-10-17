import type { MindMapContentV1, MindMapNodeV1 } from "@astella/shared/note-mind-map-contracts";
export type MindMapPosition = { node: MindMapNodeV1; x: number; y: number; width: number; height: number; branch: number; side: -1 | 0 | 1 };
export function layoutMindMap(map: MindMapContentV1, collapsed: ReadonlySet<string>) {
  const children = new Map<string, MindMapNodeV1[]>();
  for (const node of map.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const height = (node: MindMapNodeV1) => Math.max(56, Math.ceil(Array.from(node.label).length / 9) * 22 + 22);
  const span = (node: MindMapNodeV1): number => Math.max(height(node), collapsed.has(node.id) ? 0 : (children.get(node.id) ?? []).reduce((sum, child, i) => sum + span(child) + (i ? 24 : 0), 0));
  const fullSpan = (node: MindMapNodeV1): number => Math.max(height(node), (children.get(node.id) ?? []).reduce((sum, child, i) => sum + fullSpan(child) + (i ? 24 : 0), 0));
  const positions: MindMapPosition[] = [];
  const root = map.nodes.find(n => n.id === map.rootId)!;
  positions.push({ node: root, x: 0, y: 0, width: 196, height: height(root), branch: -1, side: 0 });
  const branches = collapsed.has(root.id) ? [] : children.get(root.id) ?? [];
  const sides: { node: MindMapNodeV1; branch: number }[][] = [[], []];
  const weights = [0, 0], fullWeights = [0, 0];
  branches.forEach((node, branch) => { const side = fullWeights[0]! <= fullWeights[1]! ? 0 : 1; sides[side]!.push({ node, branch }); weights[side]! += span(node) + 24; fullWeights[side]! += fullSpan(node) + 24; });
  const place = (node: MindMapNodeV1, depth: number, top: number, side: -1 | 1, branch: number) => {
    const size = span(node), y = top + size / 2;
    positions.push({ node, x: side * (depth * 228), y, width: 176, height: height(node), branch, side });
    if (collapsed.has(node.id)) return;
    const nested = children.get(node.id) ?? [];
    const total = nested.reduce((sum, child, i) => sum + span(child) + (i ? 24 : 0), 0);
    let cursor = y - total / 2;
    for (const child of nested) { place(child, depth + 1, cursor, side, branch); cursor += span(child) + 24; }
  };
  sides.forEach((nodes, index) => { let top = -(weights[index]! - (nodes.length ? 24 : 0)) / 2; for (const { node, branch } of nodes) { place(node, 1, top, index === 0 ? 1 : -1, branch); top += span(node) + 24; } });
  const bounds = { left: Math.min(...positions.map(p => p.x - p.width / 2)), right: Math.max(...positions.map(p => p.x + p.width / 2)), top: Math.min(...positions.map(p => p.y - p.height / 2)), bottom: Math.max(...positions.map(p => p.y + p.height / 2)) };
  return { positions, children, bounds };
}
