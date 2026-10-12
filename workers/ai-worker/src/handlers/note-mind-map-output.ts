import { mindMapContentV1Schema, type MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { NoteMindMapOutputError } from "../lib/non-retryable-errors.ts";
import { exactQuote, imageSafeText, type SourceBlock } from "./note-mind-map-source.ts";
/** 报错里带一小段原文，够模型认出是哪一条，又不至于把消息撑爆。 */
function brief(value: string, limit = 40): string {
  const chars = Array.from(value.trim());
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
}

/** Validation belongs inside the model step, so an invalid response never becomes a checkpoint. */
export function parseMindMap(raw: string, sources: readonly SourceBlock[]): MindMapContentV1 {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["schemaVersion", "rootId", "nodes"]); }
  catch { throw new NoteMindMapOutputError("脑图不是有效 JSON"); }
  const parsed = mindMapContentV1Schema.safeParse(value);
  if (!parsed.success) {
    // 带上第一条问题与它的路径：重试提示要靠它指出该改哪一处，
    // 只说"结构不完整"模型只能把同一张图原样再交一遍。
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `（${issue.path.join(".")}）` : "";
    throw new NoteMindMapOutputError(`脑图结构不完整或缺少原文依据：${issue?.message ?? "未通过校验"}${where}`);
  }
  const byOrdinal = new Map(sources.filter(b => b.type !== "image").map(b => [b.ordinal, b.content]));
  return { ...parsed.data, nodes: parsed.data.nodes.map(node => ({ ...node,
    references: node.references.map(ref => {
      const source = byOrdinal.get(ref.blockOrdinal);
      const quote = source === undefined || !exactQuote(imageSafeText(source).text, ref.quote) ? null : exactQuote(source, ref.quote);
      if (!quote) throw new NoteMindMapOutputError(`脑图引用无法在读取的段落中核对：节点 ${node.id} 引用第 ${ref.blockOrdinal} 段的「${brief(ref.quote)}」在原文里找不到`);
      return { blockOrdinal: ref.blockOrdinal, quote };
    }),
  })) };
}

export function reconcileMergedMindMap(map: MindMapContentV1, parts: readonly MindMapContentV1[]): MindMapContentV1 {
  const concepts = new Map(parts.flatMap(p => p.nodes.filter(n => n.kind === "concept")).map(n => [n.id, n]));
  const actual = map.nodes.filter(n => n.kind === "concept");
  const missing = [...concepts.keys()].filter(id => !actual.some(n => n.id === id));
  if (actual.length !== concepts.size || missing.length > 0) {
    throw new NoteMindMapOutputError(`合并脑图遗漏了已读取的知识节点：${missing.slice(0, 5).join("、") || "数量对不上"}。每个 concept 都必须原样保留，只能改 parentId`);
  }
  const checked = mindMapContentV1Schema.safeParse({ ...map, nodes: map.nodes.map(n => {
    if (n.kind === "concept") return { ...concepts.get(n.id)!, parentId: n.parentId };
    // The merge step may organize topics, but cannot add uncited factual explanations.
    return { ...n, explanation: null, references: [] };
  }) });
  if (!checked.success) throw new NoteMindMapOutputError("合并脑图结构没有通过校验");
  return checked.data;
}

