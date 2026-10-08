import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Root, Element, RootContent } from "hast";
import type { Root as MarkdownRoot, RootContent as MarkdownContent } from "mdast";

export type { Root as NoteMarkdownTree, Element as NoteMarkdownElement, RootContent as NoteMarkdownNode } from "hast";
export type { RootContent as NoteMarkdownSyntaxNode } from "mdast";
const syntax = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(noteWikiLinks).use(noteImageElements);
export function noteMarkdownSyntax(source: string): MarkdownRoot { return syntax.runSync(syntax.parse(source), { value: source }) as MarkdownRoot; }

export function noteImageSize(value: unknown): number | null {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.min(4096, Math.round(size)) : null;
}

/** Sized images use portable HTML; ordinary images retain Markdown syntax. */
export function noteImageMarkdown(attrs: Record<string, unknown>, forceHtml = false): string {
  const src = String(attrs.src ?? ""), alt = String(attrs.alt ?? ""), title = String(attrs.title ?? "");
  const width = noteImageSize(attrs.width), height = noteImageSize(attrs.height);
  const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (width || height || forceHtml) {
    const image = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ""}${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""} />`;
    return forceHtml && attrs.linkHref ? `<a href="${escapeHtml(String(attrs.linkHref))}">${image}</a>` : image;
  }
  const label = alt.replace(/[\\[\]]/g, "\\$&");
  const url = src.replace(/\\/g, "%5C").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, value => encodeURIComponent(value));
  return `![${label}](${url}${title ? ` "${title.replace(/[\\"]/g, "\\$&")}"` : ""})`;
}

/** Only a standalone, sanitized img becomes an editor atom; other HTML stays source. */
export function noteImageHtmlAttrs(value: string): Record<string, unknown> | null {
  const images = noteImageHtmlSequence(value);
  return images?.length === 1 ? images[0]! : null;
}
function noteImageHtmlSequence(value: string): Record<string, unknown>[] | null {
  if (!/^(?:\s*<img\b[^>]*>\s*|\s*<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>\s*)+$/i.test(value)) return null;
  const images: Record<string, unknown>[] = [];
  const walk = (node: Root | RootContent, linkHref: string | null = null): boolean => {
    if (node.type === "text") return !node.value.trim();
    if (node.type === "root" || node.type === "element" && node.tagName === "p") return node.children.every(child => walk(child, linkHref));
    if (node.type === "element" && node.tagName === "a") return node.children.every(child => walk(child, String(node.properties.href ?? "") || null));
    if (node.type !== "element" || node.tagName !== "img" || typeof node.properties.src !== "string" || !node.properties.src) return false;
    images.push({ src: node.properties.src, alt: String(node.properties.alt ?? ""), title: String(node.properties.title ?? ""), width: noteImageSize(node.properties.width), height: noteImageSize(node.properties.height), ...(linkHref ? { linkHref } : {}) });
    return true;
  };
  return walk(imageHtmlProcessor.runSync(imageHtmlProcessor.parse(value)) as Root) && images.length ? images : null;
}

export function noteImageElements() {
  return (tree: MarkdownRoot) => {
    const imagesFrom = (attrs: Record<string, unknown>[], position: MarkdownContent["position"]): MarkdownContent[] => attrs.map(attrs => {
      const image = { type: "image" as const, url: String(attrs.src), alt: String(attrs.alt), title: String(attrs.title),
        data: { hProperties: { width: noteImageSize(attrs.width) ?? undefined, height: noteImageSize(attrs.height) ?? undefined, ...(attrs.linkHref ? { noteImageLinkHref: String(attrs.linkHref) } : {}) } }, position };
      return attrs.linkHref ? { type: "link" as const, url: String(attrs.linkHref), children: [image], position } : image;
    });
    const walk = (parent: { type: string; position?: MarkdownContent["position"]; children?: MarkdownContent[] }) => {
      if (!parent.children) return;
      if (parent.type === "paragraph" && parent.children.every(child => child.type === "html" || child.type === "text" && !child.value.trim())) {
        const attrs = noteImageHtmlSequence(parent.children.map(child => "value" in child ? child.value : "").join(""));
        if (attrs) { parent.children = imagesFrom(attrs, parent.position); return; }
      }
      parent.children = parent.children.flatMap(child => {
        if (child.type === "html") {
          const attrs = noteImageHtmlSequence(child.value);
          if (attrs) {
            const images = imagesFrom(attrs, child.position);
            return parent.type === "root" ? [{ type: "paragraph", children: images, position: child.position } as MarkdownContent] : images;
          }
        }
        walk(child as never);
        return [child];
      });
    };
    walk(tree as never);
  };
}

export const noteLinkHref = (noteId: string): string => `astella-note:${encodeURIComponent(noteId)}`;
export function noteLinkTarget(href: string): { kind: "id" | "title"; value: string } | null {
  if (/^(?![a-z][a-z\d+.-]*:|\/\/)[^?#]+\.md$/i.test(href)) {
    try { return { kind: "title", value: decodeURIComponent(href.split("/").at(-1)!).replace(/\.md$/i, "") }; } catch { return null; }
  }
  const match = /^(astella-note|astella-note-title):(.+)$/.exec(href);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[2]!).trim();
    return value && !/[\u0000-\u001f]/.test(value) ? { kind: match[1] === "astella-note" ? "id" : "title", value } : null;
  } catch { return null; }
}

/** Expand wiki links only in prose; code, URLs and image descriptions stay literal. */
export function noteWikiLinks() {
  return (tree: MarkdownRoot, file: { value: unknown }) => {
    const source = String(file.value);
    const plainText = (node: { value?: string; children?: unknown[] }): string => node.value ?? node.children?.map(child => plainText(child as never)).join("") ?? "";
    const walk = (node: { type: string; children?: MarkdownContent[] }) => {
      if (["code", "inlineCode", "link", "image", "html"].includes(node.type)) return;
      if (!node.children) return;
      node.children = node.children?.flatMap(child => {
        if (child.type !== "text") { walk(child as never); return [child]; }
        const parts: MarkdownContent[] = [];
        let cursor = 0;
        // Inspect original source: remark has already unescaped literal \[ brackets.
        const raw = source.slice(child.position?.start.offset ?? 0, child.position?.end.offset ?? 0);
        for (const rawMatch of raw.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
          const before = raw.slice(0, rawMatch.index);
          if ((/\\+$/.exec(before)?.[0].length ?? 0) % 2) continue;
          const at = plainText(syntax.parse(before.trimEnd())).length + (/\s+$/.exec(before)?.[0].length ?? 0);
          const match = /^\[\[([^\]\n]+)\]\]/.exec(child.value.slice(at));
          if (!match || at < cursor) continue;
          const [target, ...alias] = match[1]!.split("|");
          if (!target!.trim()) continue;
          if (at > cursor) parts.push({ type: "text", value: child.value.slice(cursor, at) });
          parts.push({ type: "link", url: `astella-note-title:${encodeURIComponent(target!.trim())}`,
            children: [{ type: "text", value: alias.join("|").trim() || target!.trim() }] });
          cursor = at + match[0].length;
        }
        if (!parts.length) return [child];
        if (cursor < child.value.length) parts.push({ type: "text", value: child.value.slice(cursor) });
        return parts;
      });
    };
    walk(tree as never);
  };
}

/** Math source is the annotation atom; generated glyphs never enter the source coordinate. */
function mathSource() {
  return (tree: MarkdownRoot, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; data?: unknown; children?: unknown[] }) => {
      if (node.type === "math" || node.type === "inlineMath") {
        const raw = source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
        const valid = raw.startsWith("$$") || /^\$(?!\s)(?:\\.|[^$\\\n])*(?<!\s)\$$/.test(raw) && !/^\$\d/.test(raw);
        node.data = { hName: "span", hProperties: valid ? { dataNoteMath: node.value ?? "", dataNoteMathDisplay: node.type === "math" } : {},
          hChildren: [{ type: "text", value: raw.replace(/\n/g, "") }] };
      }
      node.children?.forEach(child => walk(child as never));
    };
    walk(tree);
  };
}

const sanitizeSchema = {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] ?? []), 'align'],
      span: [...(defaultSchema.attributes?.span ?? []), 'dataNoteMath', 'dataNoteMathDisplay'],
      img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
    },
    protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), 'astella-note', 'astella-note-title'] },
  };
const imageHtmlProcessor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
  .use(rehypeSanitize, { ...sanitizeSchema, protocols: { ...sanitizeSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "uploading"] } });
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: true })
  .use(noteWikiLinks).use(noteImageElements).use(mathSource).use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw).use(rehypeSanitize, sanitizeSchema);

/** Parsed and allowlisted elements, never executable HTML. Shared by reader and API anchors. */
const treeCache = new Map<string, Root>();
export function noteMarkdownTree(source: string): Root {
  const cached = treeCache.get(source);
  if (cached) return cached;
  const tree = processor.runSync(processor.parse(source), { value: source }) as Root;
  const clean = (node: Root | Element) => {
    if (node.type === "element" && node.tagName === "pre") {
      const code = node.children.find(child => child.type === "element" && child.tagName === "code") as Element | undefined;
      const last = code?.children.at(-1);
      if (last?.type === "text") last.value = last.value.replace(/\n$/, "");
    }
    if (!(node.type === "element" && ["code", "pre"].includes(node.tagName))) {
      node.children = node.children.flatMap((child, index): RootContent[] => {
        if (child.type !== "text") return [child];
        if (/^\s*\n\s*$/.test(child.value)) return [];
        const previous = node.children[index - 1];
        const value = previous?.type === "element" && previous.tagName === "input" ? child.value.replace(/^ /, "") : child.value;
        return value.split("\n").flatMap((line, at): RootContent[] => [
          ...(at ? [{ type: "element" as const, tagName: "br", properties: {}, children: [] }] : []),
          ...(line ? [{ type: "text" as const, value: line }] : []),
        ]);
      });
    }
    node.children.forEach(child => { if (child.type === "element") clean(child); });
  };
  clean(tree);
  if (source.length <= 50_000) {
    treeCache.set(source, tree);
    if (treeCache.size > 128) treeCache.delete(treeCache.keys().next().value!);
  }
  return tree;
}

export function noteMarkdownText(tree: Root | Element | RootContent): string {
  if (tree.type === "text") return tree.value;
  if (tree.type !== "root" && tree.type !== "element") return "";
  if (tree.type === "element" && ["img", "input", "br", "hr"].includes(tree.tagName)) return "";
  return tree.children.map(child => {
    // HAST inserts formatting newlines between block elements. They aren't note characters.
    if (child.type === "text" && /^\s*\n\s*$/.test(child.value) && !(tree.type === "element" && ["pre", "code"].includes(tree.tagName))) return "";
    return noteMarkdownText(child);
  }).join("");
}

export function noteBlockMarkdown(type: string, content: string): string {
  if (type === "heading" && /^\s*<h[1-6]\b/i.test(content)) return content;
  if (type === "heading") return /^\s*#{1,6}\s/.test(content) ? content : `## ${content}`;
  if (type === "code") {
    if (/^\s*(`{3,}|~{3,})/.test(content)) return content;
    const fence = "`".repeat(Math.max(3, ...Array.from(content.matchAll(/`+/g), match => match[0].length + 1)));
    return `${fence}\n${content}\n${fence}`;
  }
  if (type === "quote") return /^\s*(?:>|<blockquote\b)/i.test(content) ? content : content.split("\n").map(line => `> ${line}`).join("\n");
  if (type === "list") return /^\s*(?:[-+*]|\d+[.)])\s/.test(content) ? content : content.split("\n").map(line => `- ${line}`).join("\n");
  return content;
}
