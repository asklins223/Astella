import { gemoji } from "gemoji";
export const noteEmojiEntries = gemoji.flatMap(entry => entry.names.map(name => ({ name, emoji: entry.emoji })));
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Root, Element, RootContent } from "hast";
import type { Root as MarkdownRoot, RootContent as MarkdownContent } from "mdast";

export type { Root as NoteMarkdownTree, Element as NoteMarkdownElement, RootContent as NoteMarkdownNode } from "hast";
export type { RootContent as NoteMarkdownSyntaxNode } from "mdast";
const syntax = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkFrontmatter).use(noteWritingExtensions).use(noteRichStyles).use(noteWikiLinks).use(noteImageElements);
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
    const equations: string[] = []; const collect = (node: { type: string; value?: string; children?: unknown[] }) => { if (node.type === "math") equations.push(node.value ?? ""); node.children?.forEach(child => collect(child as never)); }; collect(tree);
    const labels = noteEquationLabels(equations); let equation = 0;
    const walk = (node: { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; data?: unknown; children?: unknown[] }) => {
      if (node.type === "math" || node.type === "inlineMath") {
        const raw = node.position ? source.slice(node.position.start.offset ?? 0, node.position.end.offset ?? 0) : `${node.type === "math" ? "$$" : "$"}${node.value ?? ""}${node.type === "math" ? "$$" : "$"}`;
        const valid = raw.startsWith("$$") || /^\$(?!\s)(?:\\.|[^$\\\n])*(?<!\s)\$$/.test(raw) && !/^\$\d/.test(raw);
        node.data = { hName: "span", hProperties: valid ? { dataNoteMath: noteEquationValue(node.value ?? "", labels, node.type === "math" ? ++equation : undefined), ...(node.type === "math" ? { dataNoteMathDisplay: true } : {}) } : {},
          hChildren: [{ type: "text", value: raw.replace(/\n/g, "") }] };
      }
      node.children?.forEach(child => walk(child as never));
    };
    walk(tree);
  };
}

const sanitizeSchema = {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), "mark", "sub", "sup", "nav"],
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] ?? []), 'align', 'style'],
      span: [...(defaultSchema.attributes?.span ?? []), 'dataNoteMath', 'dataNoteMathDisplay'],
      sup: [...(defaultSchema.attributes?.sup ?? []), 'dataNoteFootnoteSource'],
      blockquote: ['dataNoteAlert'], nav: ['dataNoteToc'],
      img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
    },
    protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), 'astella-note', 'astella-note-title'] },
  };
const imageHtmlProcessor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
  .use(sanitizeNoteInlineImages).use(rehypeSanitize, { ...sanitizeSchema, protocols: { ...sanitizeSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "uploading", "blob", "data"] } });
const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath, { singleDollarTextMath: true })
  .use(remarkFrontmatter).use(noteWritingExtensions).use(noteRichStyles).use(noteWikiLinks).use(noteImageElements).use(mathSource).use(remarkRehype, { allowDangerousHtml: true, footnoteLabel: "脚注", footnoteBackLabel: "返回引用" })
  .use(rehypeRaw).use(sanitizeNoteStyles).use(sanitizeNoteInlineImages).use(rehypeSanitize, { ...sanitizeSchema, protocols: { ...sanitizeSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data", "blob"] } });

function sanitizeNoteInlineImages() { return (tree: Root) => { const walk = (node: Root | RootContent) => {
  if (node.type === "element" && node.tagName === "img" && String(node.properties.src).startsWith("data:") && (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(String(node.properties.src)) || String(node.properties.src).length > 4_000_000)) delete node.properties.src;
  if ("children" in node) node.children.forEach(walk);
}; walk(tree); }; }

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
  if (tree.type === "element" && tree.tagName === "sup") {
    const reference = tree.children.find((child): child is Element => child.type === "element" && child.tagName === "a" && child.properties.dataFootnoteRef !== undefined);
    if (reference) return String(tree.properties.dataNoteFootnoteSource ?? `[^${decodeURIComponent(String(reference.properties.href).split("fn-")[1] ?? "")}]`);
  }
  return tree.children.map(child => {
    // HAST inserts formatting newlines between block elements. They aren't note characters.
    if (child.type === "text" && /^\s*\n\s*$/.test(child.value) && !(tree.type === "element" && ["pre", "code"].includes(tree.tagName))) return "";
    return noteMarkdownText(child);
  }).join("");
}
export function noteFootnoteBody(content: string): { label: string; body: string } | null {
  const match = content.trim().match(/^\[\^([^\]]+)\]:[ \t]*([^]*)$/); return match ? { label: match[1]!, body: match[2]!.replace(/^ {4}/gm, "") } : null;
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

/** Typora-style extensions share one AST across editor, reader, projections and exports. */
export function noteWritingExtensions(this: unknown) {
  // Milkdown's serializer needs handlers for the three additional phrasing nodes.
  const processor = this as unknown as { data(key: string, value?: unknown): unknown };
  const extensions = processor.data("toMarkdownExtensions") as unknown[] | undefined;
  processor.data("toMarkdownExtensions", [...(extensions ?? []), { handlers: { text: (node: { value: string }, _parent: unknown, state: { safe(value: string, info: unknown): string }, info: unknown) => {
    let value = "", cursor = 0;
    for (const match of node.value.matchAll(/\$\$[^]*?\$\$|(?<![\\$])\$(?![\s\d])[^$\n]+?(?<!\s)\$(?!\$)/g)) {
      value += state.safe(node.value.slice(cursor, match.index), info) + match[0]; cursor = match.index + match[0].length;
    } return value + state.safe(node.value.slice(cursor), info);
  }, ...Object.fromEntries([
    ["noteHighlight", "=="], ["noteSubscript", "~"], ["noteSuperscript", "^"],
  ].map(([type, delimiter]) => [type, (node: unknown, _parent: unknown, state: { containerPhrasing(node: unknown, info: unknown): string }, info: unknown) => `${delimiter}${state.containerPhrasing(node, info)}${delimiter}`])) } }]);
  return (tree: MarkdownRoot, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: { type: string; value?: string; children?: unknown[]; data?: unknown; position?: MarkdownContent["position"] }) => {
      if (node.type === "footnoteReference" && node.position) node.data = { hProperties: { dataNoteFootnoteSource: source.slice(node.position.start.offset, node.position.end.offset) } };
      if (node.type === "footnoteDefinition") {
        (node as unknown as { noteFootnoteSource: string }).noteFootnoteSource = source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0).replace(/^\[\^[^\]]+\]:\s*/, "").replace(/\n {4}/g, "\n");
      }
      if (!node.children || ["code", "inlineCode", "math", "inlineMath", "html", "yaml"].includes(node.type)) return;
      node.children = node.children.flatMap(childValue => {
        const child = childValue as typeof node;
        if (child.type !== "text" || !child.value) { walk(child); return [child]; }
        const parts: unknown[] = []; let cursor = 0;
        // Original escapes remain literal; remark's decoded text alone cannot tell them apart.
        const original = source.slice(child.position?.start.offset ?? 0, child.position?.end.offset ?? 0);
        if (/\\[=~^:]/.test(original)) return [child];
        for (const match of child.value.matchAll(/==([^=\n]+)==|(?<!~)~([^~\s]+)~(?!~)|\^([^\^\s]+)\^/g)) {
          if (match.index > cursor) parts.push({ type: "text", value: child.value.slice(cursor, match.index) });
          const type = match[1] ? "noteHighlight" : match[2] ? "noteSubscript" : "noteSuperscript";
          const value = match[1] ?? match[2] ?? match[3]!, tag = match[1] ? "mark" : match[2] ? "sub" : "sup";
          parts.push({ type, children: [{ type: "text", value }], data: { hName: tag } }); cursor = match.index + match[0].length;
        }
        if (cursor < child.value.length) parts.push({ ...child, value: child.value.slice(cursor) });
        return cursor ? parts : [child];
      });
      if (node.type === "blockquote") {
        const first = node.children[0] as { type?: string; children?: { type: string; value?: string }[] } | undefined;
        const text = first?.children?.[0]; const match = text?.value?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
        if (match) node.data = { hName: "blockquote", hProperties: { dataNoteAlert: match[1]!.toLowerCase() } };
      }
      if (node.type === "paragraph" && node.children.length === 1 && (node.children[0] as { value?: string }).value?.trim().toLowerCase() === "[toc]") {
        node.data = { hName: "nav", hProperties: { dataNoteToc: true }, hChildren: [] };
      }
    }; walk(tree);
  };
}

export function noteSourceMarkdown(kind: string, value: string, label = ""): string {
  if (kind === "math") return `$$\n${value}\n$$`;
  if (kind === "yaml") return `---\n${value}\n---`;
  if (kind === "toc") return "[toc]";
  if (kind === "footnote") return `[^${label || "1"}]: ${value.replace(/\n/g, "\n    ")}`;
  return value;
}

export type NoteRichStyle = { color?: string; background?: string; font?: "serif" | "sans" | "mono"; size?: number; align?: "left" | "center" | "right" | "justify"; indent?: number; leading?: number };
export function cleanNoteRichStyle(value: unknown): NoteRichStyle {
  let raw: Record<string, unknown> = {}; try { raw = typeof value === "string" ? JSON.parse(value) : value as Record<string, unknown> ?? {}; } catch { return {}; }
  const result: NoteRichStyle = {};
  for (const key of ["color", "background"] as const) if (/^#[0-9a-f]{6}$/i.test(String(raw[key]))) result[key] = String(raw[key]);
  if (["serif", "sans", "mono"].includes(String(raw.font))) result.font = raw.font as NoteRichStyle["font"];
  if (Number(raw.size) >= 10 && Number(raw.size) <= 48) result.size = Number(raw.size);
  if (["left", "center", "right", "justify"].includes(String(raw.align))) result.align = raw.align as NoteRichStyle["align"];
  if (Number(raw.indent) >= 0 && Number(raw.indent) <= 8) result.indent = Number(raw.indent);
  if (Number(raw.leading) >= 1.2 && Number(raw.leading) <= 3) result.leading = Number(raw.leading);
  return result;
}
export function noteRichStyleCss(value: unknown): string {
  const style = cleanNoteRichStyle(value); return [style.color && `color:${style.color}`, style.background && `background-color:${style.background}`, style.font && `font-family:${{ serif: "serif", sans: "sans-serif", mono: "monospace" }[style.font]}`,
    style.size && `font-size:${style.size}px`, style.align && `text-align:${style.align}`, style.indent !== undefined && `margin-left:${style.indent * 2}em`, style.leading && `line-height:${style.leading}`].filter(Boolean).join(";");
}
export function richStyleFromCss(css: unknown): NoteRichStyle {
  const fields = Object.fromEntries(String(css ?? "").split(";").map(part => part.split(":").map(value => value.trim())));
  const color = (value: string | undefined) => { const rgb = value?.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i); return rgb ? `#${rgb.slice(1).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2,"0")).join("")}` : value; };
  return cleanNoteRichStyle({ color: color(fields.color), background: color(fields["background-color"]),
    font: ({ serif: "serif", "sans-serif": "sans", monospace: "mono" } as Record<string,string>)[fields["font-family"]?.trim() ?? ""], size: Number(fields["font-size"]?.replace(/px$/, "")), align: fields["text-align"]?.trim(), indent: fields["margin-left"]?.endsWith("em") ? Number(fields["margin-left"].replace(/em$/, "")) / 2 : undefined, leading: Number(fields["line-height"]) });
}
const styleHtmlProcessor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw);
const htmlEscape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function noteStyledPmHtml(node: { type: string; text?: string; attrs?: Record<string, unknown>; marks?: readonly { type: string; attrs?: Record<string, unknown> }[]; content?: readonly unknown[] }): string {
  const render = (value: typeof node): string => {
    if (value.type === "image") return noteImageMarkdown(value.attrs ?? {}, true);
    if (value.type === "hardbreak") return "<br>";
    if (value.type === "note_ref") return `<sup data-note-ref="${htmlEscape(value.attrs?.label)}">[${htmlEscape(value.attrs?.label)}]</sup>`;
    let text = value.text !== undefined ? htmlEscape(value.text) : (value.content ?? []).map(child => render(child as typeof node)).join("");
    for (const mark of value.marks ?? []) {
      const tag = ({ strong: "strong", emphasis: "em", inlineCode: "code", strike_through: "del", noteHighlight: "mark", noteSubscript: "sub", noteSuperscript: "sup" } as Record<string, string>)[mark.type];
      if (tag) text = `<${tag}>${text}</${tag}>`; else if (mark.type === "link") text = `<a href="${htmlEscape(mark.attrs?.href)}">${text}</a>`;
      else if (mark.type === "noteStyle") text = `<span style="${noteRichStyleCss(mark.attrs?.noteStyle)}">${text}</span>`;
    }
    if (["paragraph", "heading"].includes(value.type) && Object.keys(cleanNoteRichStyle(value.attrs?.noteStyle)).length) {
      const tag = value.type === "heading" ? `h${Number(value.attrs?.level) || 2}` : "p"; text = `<${tag} style="${noteRichStyleCss(value.attrs?.noteStyle)}">${text}</${tag}>`;
    } return text;
  }; return render(node);
}
export function noteRichStyles(this: unknown) {
  const processor = this as { data(key: string, value?: unknown): unknown }, extensions = processor.data("toMarkdownExtensions") as unknown[] | undefined;
  processor.data("toMarkdownExtensions", [...(extensions ?? []), { handlers: { noteStyle(node: { noteStyle: unknown; children: unknown[] }) {
    const render = (node: { type: string; value?: string; url?: string; identifier?: string; children?: unknown[]; noteStyle?: unknown }): string => {
      if (node.type === "text") return htmlEscape(node.value); if (node.type === "image") return noteImageMarkdown({ src: node.url }, true);
      if (node.type === "footnoteReference") return `<sup data-note-ref="${htmlEscape(node.identifier)}">[${htmlEscape(node.identifier)}]</sup>`;
      const tag = ({ strong: "strong", emphasis: "em", delete: "del", inlineCode: "code", noteHighlight: "mark", noteSubscript: "sub", noteSuperscript: "sup", noteStyle: "span", link: "a" } as Record<string, string>)[node.type];
      const value = node.children?.map(child => render(child as typeof node)).join("") ?? htmlEscape(node.value); return tag ? `<${tag}${node.type === "noteStyle" ? ` style="${noteRichStyleCss(node.noteStyle)}"` : node.type === "link" ? ` href="${htmlEscape(node.url)}"` : ""}>${value}</${tag}>` : value;
    }; return `<span style="${noteRichStyleCss(node.noteStyle)}">${node.children.map(child => render(child as never)).join("")}</span>`;
  } } }]);
  return (tree: MarkdownRoot) => {
    const convert = (node: RootContent): unknown[] => {
      if (node.type === "text") { const parts: unknown[] = []; let cursor = 0;
        for (const match of node.value.matchAll(/(?<!\\)\$(?!\s|\d)(?:\\.|[^$\\\n])*(?<!\s)\$/g)) { if (match.index > cursor) parts.push({ type: "text", value: node.value.slice(cursor, match.index) }); parts.push({ type: "inlineMath", value: match[0].slice(1,-1) }); cursor = match.index + match[0].length; }
        if (cursor < node.value.length) parts.push({ type: "text", value: node.value.slice(cursor) }); return parts;
      } if (node.type !== "element") return [];
      if (node.tagName === "sup" && typeof node.properties.dataNoteRef === "string") return [{ type: "footnoteReference", identifier: node.properties.dataNoteRef, label: node.properties.dataNoteRef }];
      const children = node.children.flatMap(convert), style = richStyleFromCss(node.properties.style), css = noteRichStyleCss(style);
      const type = ({ p: "paragraph", strong: "strong", b: "strong", em: "emphasis", i: "emphasis", del: "delete", s: "delete", mark: "noteHighlight", sub: "noteSubscript", sup: "noteSuperscript" } as Record<string, string>)[node.tagName];
      if (node.tagName === "img") return [{ type: "image", url: node.properties.src, alt: node.properties.alt ?? "", data: { hProperties: { width: node.properties.width, height: node.properties.height } } }];
      if (node.tagName === "br") return [{ type: "break" }]; if (node.tagName === "code") return [{ type: "inlineCode", value: noteMarkdownText(node) }];
      if (node.tagName === "a") return [{ type: "link", url: node.properties.href, children }];
      if (node.tagName === "span" && css) return [{ type: "noteStyle", noteStyle: style, children, data: { hName: "span", hProperties: { style: css } } }];
      if (/^h[1-6]$/.test(node.tagName)) return [{ type: "heading", depth: Number(node.tagName[1]), children, data: { noteStyle: style, hProperties: { style: css } } }];
      if (type) return [{ type, children, data: { noteStyle: style, ...(["noteHighlight", "noteSubscript", "noteSuperscript"].includes(type) ? { hName: node.tagName } : {}), ...(css ? { hProperties: { style: css } } : {}) } }]; return children;
    };
    const walk = (parent: { children?: unknown[]; type: string; data?: unknown }) => { if (!parent.children || ["code", "inlineCode"].includes(parent.type)) return;
      // Collect HTML inline spans with their Markdown children as one fragment.
      const input = parent.children, result: unknown[] = [];
      for (let i = 0; i < input.length; i++) { const node = input[i] as { type: string; value?: string; children?: unknown[] };
        if (node.type === "html" && /<(?:p|h[1-6]|span)\b[^>]*style=/i.test(node.value ?? "")) {
          let html = node.value ?? "";
          if (/^<span\b[^>]*>$/i.test(html.trim())) { let depth = 1; while (i + 1 < input.length && depth > 0) {
            const next = input[++i] as typeof node; if (next.type === "html") { html += next.value; if (/^<span\b/i.test(next.value ?? "")) depth++; if (/^<\/span>/i.test(next.value ?? "")) depth--; }
            else if (next.type === "text") html += htmlEscape(next.value); else { walk(next); html += noteStyledMdastHtml(next); }
          } }
          const tree = styleHtmlProcessor.runSync(styleHtmlProcessor.parse(html)) as Root, converted = tree.children.flatMap(convert);
          if (parent.type !== "root" && converted.length === 1 && (converted[0] as { type: string }).type === "paragraph") { parent.data = (converted[0] as { data?: unknown }).data; result.push(...(converted[0] as { children: unknown[] }).children); } else result.push(...converted);
        } else { walk(node); result.push(node); }
      } parent.children = result;
    }; walk(tree);
  };
}
function sanitizeNoteStyles() { return (tree: Root) => { const walk = (node: Root | RootContent) => { if (node.type === "element" && node.properties.style) { const css = noteRichStyleCss(richStyleFromCss(node.properties.style)); if (css) node.properties.style = css; else delete node.properties.style; } if ("children" in node) node.children.forEach(walk); }; walk(tree); }; }

export function noteStyledMdastHtml(node: { type: string; value?: string; url?: string; identifier?: string; children?: unknown[]; noteStyle?: unknown }): string {
  if (node.type === "text") return htmlEscape(node.value);
  if (node.type === "image") return noteImageMarkdown({ src: node.url }, true);
  if (node.type === "break") return "<br>";
  if (node.type === "inlineMath") return htmlEscape(`$${node.value ?? ""}$`);
  if (node.type === "footnoteReference") return `<sup data-note-ref="${htmlEscape(node.identifier)}">[${htmlEscape(node.identifier)}]</sup>`;
  const tag = ({ strong: "strong", emphasis: "em", delete: "del", inlineCode: "code", noteHighlight: "mark", noteSubscript: "sub", noteSuperscript: "sup", link: "a", noteStyle: "span" } as Record<string,string>)[node.type];
  const value = node.children?.map(child => noteStyledMdastHtml(child as typeof node)).join("") ?? htmlEscape(node.value);
  return tag ? `<${tag}${node.type === "link" ? ` href="${htmlEscape(node.url)}"` : node.type === "noteStyle" ? ` style="${noteRichStyleCss(node.noteStyle)}"` : ""}>${value}</${tag}>` : value;
}

export function noteEquationLabels(values: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>(); values.forEach((value, index) => { const number = value.match(/\\tag\{([^}]+)\}/)?.[1] ?? String(index + 1); for (const match of value.matchAll(/\\label\{([^}]+)\}/g)) if (!labels.has(match[1]!)) labels.set(match[1]!, number); }); return labels;
}
export function noteEquationValue(value: string, labels: Map<string, string>, number?: number): string {
  const hasLabel = /\\label\{/.test(value); let result = value.replace(/\\label\{[^}]+\}/g, "").replace(/\\(?:eqref|ref)\{([^}]+)\}/g, (_all, label: string) => `\\text{(${labels.get(label) ?? "?"})}`);
  if (hasLabel && number !== undefined && !/\\tag\{/.test(result)) result += `\\tag{${number}}`; return result;
}
