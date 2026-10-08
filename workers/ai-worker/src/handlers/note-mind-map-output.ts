import { mindMapContentV1Schema, type MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { NoteMindMapOutputError } from "../lib/non-retryable-errors.ts";
import { exactQuote, imageSafeText, type SourceBlock } from "./note-mind-map-source.ts";
/** Validation belongs inside the model step, so an invalid response never becomes a checkpoint. */
export function parseMindMap(raw: string, sources: readonly SourceBlock[]): MindMapContentV1 {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["schemaVersion", "rootId", "nodes"]); }
  catch { throw new NoteMindMapOutputError("脑图不是有效 JSON"); }
  const parsed = mindMapContentV1Schema.safeParse(value);
  if (!parsed.success) throw new NoteMindMapOutputError("脑图结构不完整或缺少原文依据");
  const byOrdinal = new Map(sources.filter(b => b.type !== "image").map(b => [b.ordinal, b.content]));
  return { ...parsed.data, nodes: parsed.data.nodes.map(node => ({ ...node,
    references: node.references.map(ref => {
      const source = byOrdinal.get(ref.blockOrdinal);
      const quote = source === undefined || !exactQuote(imageSafeText(source).text, ref.quote) ? null : exactQuote(source, ref.quote);
      if (!quote) throw new NoteMindMapOutputError("脑图引用无法在读取的段落中核对");
      return { blockOrdinal: ref.blockOrdinal, quote };
    }),
  })) };
}

export function reconcileMergedMindMap(map: MindMapContentV1, parts: readonly MindMapContentV1[]): MindMapContentV1 {
  const concepts = new Map(parts.flatMap(p => p.nodes.filter(n => n.kind === "concept")).map(n => [n.id, n]));
  const actual = map.nodes.filter(n => n.kind === "concept");
  if (actual.length !== concepts.size || actual.some(n => !concepts.has(n.id))) throw new NoteMindMapOutputError("合并脑图遗漏了已读取的知识节点");
  const checked = mindMapContentV1Schema.safeParse({ ...map, nodes: map.nodes.map(n => {
    if (n.kind === "concept") return { ...concepts.get(n.id)!, parentId: n.parentId };
    // The merge step may organize topics, but cannot add uncited factual explanations.
    return { ...n, explanation: null, references: [] };
  }) });
  if (!checked.success) throw new NoteMindMapOutputError("合并脑图结构没有通过校验");
  return checked.data;
}

