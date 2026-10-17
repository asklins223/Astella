import * as Y from "yjs";
import type { ReflectionSourceV1 } from "@astella/shared/note-learning-reflection-contracts";

export class PendingReflectionAppendError extends Error {}

export function reflectionDocumentLines(source: ReflectionSourceV1, annotation: string): string[] {
  return [source.ref.kind === "teaching" ? "AI 整理建议（本人选择保留）" : "本人原话（学习作答）",
    ...source.text.split(/\n\s*\n/).filter(Boolean), ...(annotation.trim() ? [`本人批注：${annotation.trim()}`] : [])];
}
/** Insert only new nodes at the end of the shared fragment; never rewrite existing text. */
export function appendReflectionToDocument(fragment: Y.XmlFragment, source: ReflectionSourceV1, annotation: string): void {
  if (!fragment.doc) throw new Error("正文还没准备好，请重新打开笔记后再试。");
  const nodes = reflectionDocumentLines(source, annotation).map(line => {
    const node = new Y.XmlElement("paragraph");
    node.insert(0, [new Y.XmlText(line)]);
    return node;
  });
  fragment.doc.transact(() => fragment.insert(fragment.length, nodes), "note-reflection");
}

/** A failed checkpoint leaves the insertion in the live document; retry that exact draft only. */
export function stageReflectionAppend(fragment: Y.XmlFragment, noteId: string, source: ReflectionSourceV1, annotation: string, pending: Map<string, string>): void {
  const key = `${noteId}:${source.ref.kind}:${source.ref.id}`;
  const previous = pending.get(key);
  if (previous !== undefined) {
    if (previous !== annotation) throw new PendingReflectionAppendError("上一次正文还没保存。请先用笔记页的“重试保存”完成它，再留下新的批注。");
    return;
  }
  appendReflectionToDocument(fragment, source, annotation);
  pending.set(key, annotation);
}
