import type { MindMapContentV1, MindMapNodeV1 } from "@astella/shared/note-mind-map-contracts";

/**
 * 脑图的结构整理：两步都是**确定性**的，不额外调用模型。
 *
 * 为什么要有这一步：长笔记是分段生成再合并的，而合并那一步被要求"保留每一个
 * concept、只许改 parentId"（`reconcileMergedMindMap` 会核对概念集合，少一个就整发失败）。
 * 那条纪律保住了"不编造、不丢依据"，但留下两件事没人管：
 *
 *  1. **同一件事在两个段里各立了一个节点**——各挂半份依据，读者看到的是重复而不是更全；
 *  2. **同层节点的次序基本是随机的**——各段并发生成、合并只改父子关系，而读者是从上往下看的。
 *
 * 放在最终校验之前，所以整理过的图仍要过同一道逐字引用核对。
 */

/** 折叠同名概念用的键：忽略空白与大小写，"固定电压"与"固定 电压"是同一件事。 */
function conceptKey(label: string): string | null {
  const normalized = label.trim().replace(/\s+/gu, "").toLowerCase();
  // 太短的名字（"a"、"1"）不足以判断是同一件事，宁可不折。
  return normalized.length >= 2 ? normalized : null;
}

function dedupeReferences(references: readonly { blockOrdinal: number; quote: string }[]) {
  return references.filter((reference, index, all) => all.findIndex(
    (item) => item.blockOrdinal === reference.blockOrdinal && item.quote === reference.quote,
  ) === index);
}

/**
 * 跨段重复概念折叠成一条。
 *
 * 保留**先出现**的那一条（节点数组顺序就是生成顺序），把后来那些的依据取并集挂上去，
 * 被折掉节点的子节点重挂到留下的那一条上；因此空掉的分组剪掉——合同不许空枝条。
 * 名字与解释只动"原先没有、折进来的有"这一种情况，不改写已有内容。
 */
export function foldDuplicateConcepts(map: MindMapContentV1): MindMapContentV1 {
  const canonical = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const node of map.nodes) {
    if (node.kind !== "concept") continue;
    const key = conceptKey(node.label);
    if (!key) continue;
    const keeper = seen.get(key);
    if (keeper === undefined) { seen.set(key, node.id); continue; }
    canonical.set(node.id, keeper);
  }
  if (canonical.size === 0) return map;

  const resolve = (id: string): string => {
    let current = id;
    const guard = new Set<string>();
    while (canonical.has(current) && !guard.has(current)) {
      guard.add(current);
      current = canonical.get(current)!;
    }
    return current;
  };

  const kept = new Map<string, MindMapNodeV1>();
  for (const node of map.nodes) {
    if (resolve(node.id) !== node.id) {
      const keeper = kept.get(resolve(node.id));
      if (!keeper) continue;
      keeper.references = dedupeReferences([...keeper.references, ...node.references]);
      if (keeper.explanation === null && node.explanation !== null) keeper.explanation = node.explanation;
      continue;
    }
    kept.set(node.id, { ...node, references: dedupeReferences(node.references) });
  }

  let nodes = map.nodes
    .filter((node) => resolve(node.id) === node.id)
    .map((node) => ({
      ...kept.get(node.id)!,
      parentId: node.parentId === null ? null : resolve(node.parentId),
    }));
  // 折掉某个 concept 之后，它所在的分组可能就没有孩子了；剪到不再变化为止
  // （剪掉一层分组可能让上一层也空掉）。
  for (;;) {
    const parents = new Set(nodes.map((node) => node.parentId).filter((id): id is string => id !== null));
    const pruned = nodes.filter((node) => node.kind !== "group" || parents.has(node.id));
    if (pruned.length === nodes.length) break;
    nodes = pruned;
  }
  return { ...map, nodes };
}

/**
 * 同层节点按原文顺序排。
 *
 * 每个节点的位置取它**子树里最小的原文段号**：分组自己没有依据，位置由它归拢的那些
 * 知识点决定。没有依据也没有子节点的节点排在同层最后。数组顺序就是渲染顺序，
 * 所以这一改，图读起来跟笔记同序。
 */
export function orderMindMapBySource(map: MindMapContentV1): MindMapContentV1 {
  const children = new Map<string, MindMapNodeV1[]>();
  for (const node of map.nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }
  const position = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (node: MindMapNodeV1): number => {
    const memo = position.get(node.id);
    if (memo !== undefined) return memo;
    // 契约已挡掉成环，这里只是不让未校验的输入把这一趟挂死。
    if (visiting.has(node.id)) return Number.POSITIVE_INFINITY;
    visiting.add(node.id);
    let best = Number.POSITIVE_INFINITY;
    for (const reference of node.references) best = Math.min(best, reference.blockOrdinal);
    for (const child of children.get(node.id) ?? []) best = Math.min(best, compute(child));
    visiting.delete(node.id);
    position.set(node.id, best);
    return best;
  };
  for (const node of map.nodes) compute(node);

  const root = map.nodes.find((node) => node.id === map.rootId);
  if (!root) return map;
  const ordered: MindMapNodeV1[] = [];
  const walk = (node: MindMapNodeV1) => {
    ordered.push(node);
    const kids = [...(children.get(node.id) ?? [])].sort((left, right) =>
      (position.get(left.id) ?? Number.POSITIVE_INFINITY) - (position.get(right.id) ?? Number.POSITIVE_INFINITY));
    for (const kid of kids) walk(kid);
  };
  walk(root);
  // 契约保证每个非根节点都有父节点且无环，正常不会有遗漏；真出现也不能悄悄丢掉。
  const placed = new Set(ordered.map((node) => node.id));
  for (const node of map.nodes) if (!placed.has(node.id)) ordered.push(node);
  return { ...map, nodes: ordered };
}
