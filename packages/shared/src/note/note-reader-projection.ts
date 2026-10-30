import { noteBlockMarkdown, noteImageMarkdown, noteFootnoteBody, noteMarkdownText, noteMarkdownTree } from "./note-markdown.ts";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
type Node = ReturnType<typeof noteMarkdownTree> | ReturnType<typeof noteMarkdownTree>["children"][number];

/** Serialize only the shared, sanitized HAST. Math keeps its immutable source atom;
 * generated glyphs are decoration and never enter annotation coordinates. */
function html(node: Node): string {
  if (node.type === "text") return escape(node.value);
  if (node.type !== "root" && node.type !== "element") return "";
  if (node.type === "root") return node.children.map(html).join("");
  const source = node.properties.dataNoteFootnoteSource;
  if (typeof source === "string") return `<span data-note-atom="true">${escape(source)}</span>`;
  const properties = Object.entries(node.properties).flatMap(([key, value]) => {
    if (value == null || value === false || /^on/i.test(key)) return [];
    const name = key === "className" ? "class" : key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
    return [` ${name}="${escape(Array.isArray(value) ? value.join(" ") : value)}"`];
  }).join("");
  if (["img", "br", "hr", "input"].includes(node.tagName)) return `<${node.tagName}${properties}>`;
  return `<${node.tagName}${properties}>${node.children.map(html).join("")}</${node.tagName}>`;
}

export function projectReaderBlock<T extends { type: string; content: string }>(block: T) {
  let body = noteFootnoteBody(block.content)?.body ?? noteBlockMarkdown(block.type, block.content);
  if (block.type === "image") {
    try {
      const image = JSON.parse(block.content) as { url?: string; src?: string; alt?: string; caption?: string };
      body = noteImageMarkdown({ src: image.url ?? image.src, alt: image.alt ?? image.caption }, true);
    } catch {
      if (/^(?:https?:\/\/|\/uploads\/|\/api\/uploads\/)/.test(block.content.trim())) body = noteImageMarkdown({ src: block.content.trim() }, true);
    }
  }
  const tree = noteMarkdownTree(body);
  return { ...block, renderedHTML: html(tree), renderedText: block.type === "image" ? "" : noteMarkdownText(tree) };
}
