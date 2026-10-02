import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";

type NoteNode = { type?: string; text?: string; attrs?: { level?: number; value?: string }; content?: NoteNode[] };
export type NoteOutlineEntry = { readonly block: number; readonly level: number; readonly title: string };
const text = (node: NoteNode): string => node.text ?? node.attrs?.value ?? node.content?.map(text).join("") ?? "";

export function noteOutline(fragment: Y.XmlFragment | null, fallback: readonly NoteBlockProjectionV1[]): NoteOutlineEntry[] {
  if (!fragment) return fallback.flatMap((block) => block.type === "heading"
    ? [{ block: block.ordinal, level: 1, title: block.content }] : []);
  const document = yXmlFragmentToProsemirrorJSON(fragment) as NoteNode;
  return (document.content ?? []).flatMap((node, block) => node.type === "heading"
    ? [{ block, level: Math.max(1, Math.min(6, node.attrs?.level ?? 1)), title: text(node) || "未命名小节" }] : []);
}
