import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import type { NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import { noteBlockMarkdown, noteMarkdownText, noteMarkdownTree } from "@astella/shared/note-markdown";

type NoteNode = { type?: string; text?: string; attrs?: { level?: number; value?: string }; content?: NoteNode[] };
export type NoteOutlineEntry = { readonly block: number; readonly level: number; readonly title: string };
const text = (node: NoteNode): string => node.text ?? node.attrs?.value ?? node.content?.map(text).join("") ?? "";

/**
 * The directory names each heading the way the page shows it. The stored block
 * is Markdown (`# title`, `<h2>title</h2>`), so the fallback path — used before
 * the live document is attached — renders the heading text rather than leaking
 * the marker into the index.
 */
function blockHeadingText(block: NoteBlockProjectionV1): string {
  return noteMarkdownText(noteMarkdownTree(noteBlockMarkdown("heading", block.content)))
    .replace(/\s+/g, " ").trim() || "未命名小节";
}

export function noteOutline(fragment: Y.XmlFragment | null, fallback: readonly NoteBlockProjectionV1[]): NoteOutlineEntry[] {
  if (!fragment) return fallback.flatMap((block) => block.type === "heading"
    ? [{ block: block.ordinal, level: 1, title: blockHeadingText(block) }] : []);
  const document = yXmlFragmentToProsemirrorJSON(fragment) as NoteNode;
  return (document.content ?? []).flatMap((node, block) => node.type === "heading"
    ? [{ block, level: Math.max(1, Math.min(6, node.attrs?.level ?? 1)), title: text(node) || "未命名小节" }] : []);
}
