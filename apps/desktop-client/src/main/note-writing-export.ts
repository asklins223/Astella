import { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, HeadingLevel, ExternalHyperlink, Math as OfficeMath, MathRun, MathFraction, MathSuperScript, MathSubScript, MathSubSuperScript, MathRadical, AlignmentType, ShadingType, LevelFormat, type MathComponent, type ParagraphChild, type IRunOptions } from "docx";
import { noteMarkdownTree, noteMarkdownText, richStyleFromCss, type NoteMarkdownNode, type NoteMarkdownElement } from "@astella/shared/note-markdown";
import katex from "katex";
import { xml2js, type Element as XmlElement } from "xml-js";
export const escapeNoteHtml = (value: unknown) => String(value ?? "").replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
export const NOTE_EXPORT_STYLE = `body{max-width:820px;margin:40px auto;padding:0 30px;color:#292622;font:16px/1.8 serif}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #bbb;padding:8px}pre{white-space:pre-wrap;background:#f4f2ef;padding:16px}blockquote{border-left:3px solid #aaa;margin-left:0;padding-left:20px}mark{background:#f7e8ab}.katex{font-size:1.1em}nav a{display:block}@media print{body{margin:0;max-width:none}pre,table,img{break-inside:avoid}a{color:inherit}}`;
export function noteExportHtml(title: string, markdown: string, images: Map<string, string>, katexCss = ""): string {
  const tree = noteMarkdownTree(markdown), headings: { text: string; id: string; depth: number }[] = [];
  let ordinal = 0; const ids = new Map<NoteMarkdownElement, string>();
  const collect = (node: NoteMarkdownNode) => { if (node.type !== "element") return;
    if (/^h[1-6]$/.test(node.tagName) && !String(node.properties.id ?? "").endsWith("footnote-label")) { const id = `heading-${++ordinal}`; ids.set(node, id); headings.push({ id, text: noteMarkdownText(node), depth: Number(node.tagName[1]) }); } node.children.forEach(collect);
  }; tree.children.forEach(collect);
  const render = (node: NoteMarkdownNode): string => {
    if (node.type === "text") return escapeNoteHtml(node.value); if (node.type !== "element") return "";
    if (node.properties.dataNoteMath !== undefined) { try { return katex.renderToString(String(node.properties.dataNoteMath), { displayMode: node.properties.dataNoteMathDisplay !== undefined, throwOnError: false, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }); } catch { return escapeNoteHtml(noteMarkdownText(node)); } }
    if (node.properties.dataNoteToc !== undefined) return `<nav>${headings.map(heading => `<a href="#${heading.id}" style="padding-left:${(heading.depth - 1) * 16}px">${escapeNoteHtml(heading.text)}</a>`).join("")}</nav>`;
    const properties = { ...node.properties, ...(ids.has(node) ? { id: ids.get(node) } : {}) };
    if (node.tagName === "img") properties.src = images.get(String(properties.src)) ?? "";
    if (node.tagName === "input") properties.disabled = true;
    const attrs = Object.entries(properties).filter(([key]) => ["src", "href", "alt", "title", "id", "style", "width", "height", "align", "colSpan", "rowSpan", "checked", "disabled", "type"].includes(key)).filter(([, value]) => value !== false).map(([key, value]) => ` ${key.toLowerCase()}="${escapeNoteHtml(value)}"`).join("");
    return `<${node.tagName}${attrs}>${node.children.map(render).join("")}${["img", "hr", "br", "input"].includes(node.tagName) ? "" : `</${node.tagName}>`}`;
  };
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><title>${escapeNoteHtml(title)}</title><style>${NOTE_EXPORT_STYLE}\n${katexCss}</style><body>${title ? `<h1>${escapeNoteHtml(title)}</h1>` : ""}${tree.children.map(render).join("")}</body></html>`;
}
/** Convert KaTeX's MathML to editable Word equations instead of embedding screenshots. */
function wordEquation(value: string, displayMode = false): OfficeMath | TextRun {
  try {
    const xml = xml2js(katex.renderToString(value, { output: "mathml", displayMode, throwOnError: true, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }), { compact: false }) as XmlElement;
    const convert = (node: XmlElement | undefined): MathComponent[] => {
      if (!node) return [];
      if (node.type === "text") return [new MathRun(String(node.text ?? ""))];
      if (node.name === "annotation") return [];
      const elements = node.elements?.filter(item => item.type === "element") ?? [];
      const child = (index: number) => convert(elements[index]);
      if (node.name === "mfrac") return [new MathFraction({ numerator: child(0), denominator: child(1) })];
      if (node.name === "msup") return [new MathSuperScript({ children: child(0), superScript: child(1) })];
      if (node.name === "msub") return [new MathSubScript({ children: child(0), subScript: child(1) })];
      if (node.name === "msubsup") return [new MathSubSuperScript({ children: child(0), subScript: child(1), superScript: child(2) })];
      if (node.name === "msqrt") return [new MathRadical({ children: (node.elements ?? []).flatMap(convert) })];
      if (node.name === "mroot") return [new MathRadical({ children: child(0), degree: child(1) })];
      return (node.elements ?? []).flatMap(convert);
    };
    return new OfficeMath({ children: convert(xml) });
  } catch { return new TextRun({ text: value, font: "Cambria Math" }); }
}
function imageDimensions(bytes: Buffer, mime: string) {
  if (mime === "png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === "gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mime === "jpeg") {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!, length = bytes.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      if (length < 2) break; offset += length + 2;
    }
  }
  return { width: 400, height: 280 };
}
export async function noteExportDocx(title: string, markdown: string, images: Map<string, string>): Promise<Buffer> {
  const tree = noteMarkdownTree(markdown);
  const styleRun = (node: NoteMarkdownElement): IRunOptions => {
    const style = richStyleFromCss(node.properties.style); return { ...(style.color ? { color: style.color.slice(1) } : {}), ...(style.size ? { size: style.size * 1.5 } : {}),
      ...(style.font ? { font: { serif: "Noto Serif SC", sans: "Noto Sans SC", mono: "Consolas" }[style.font] } : {}), ...(style.background ? { shading: { fill: style.background.slice(1), type: ShadingType.CLEAR } } : {}) };
  };
  const inline = (nodes: NoteMarkdownNode[], formatting: IRunOptions = {}): ParagraphChild[] => nodes.flatMap((node): ParagraphChild[] => {
    if (node.type === "text") return [new TextRun({ text: node.value, ...formatting })]; if (node.type !== "element") return [];
    if (node.properties.dataNoteMath !== undefined) return [wordEquation(String(node.properties.dataNoteMath), node.properties.dataNoteMathDisplay !== undefined)];
    if (node.tagName === "br") return [new TextRun({ break: 1 })];
    if (node.tagName === "img") {
      const data = images.get(String(node.properties.src)), match = data?.match(/^data:image\/(png|jpeg|gif);base64,(.+)$/s);
      if (!match) return [new TextRun(`[图片：${node.properties.alt ?? ""}]`)];
      const bytes = Buffer.from(match[2]!, "base64"), dimensions = imageDimensions(bytes, match[1]!);
      const width = Math.min(600, Number(node.properties.width) || dimensions.width || 400), height = Number(node.properties.height) || width * dimensions.height / Math.max(1, dimensions.width);
      const scale = Math.min(1, 800 / Math.max(1, height));
      return [new ImageRun({ type: match[1] === "jpeg" ? "jpg" : match[1] as "png" | "gif", data: bytes, transformation: { width: width * scale, height: height * scale }, altText: { title: String(node.properties.alt ?? ""), description: String(node.properties.alt ?? ""), name: "笔记图片" } })];
    }
    if (node.tagName === "a" && /^https?:/.test(String(node.properties.href))) return [new ExternalHyperlink({ link: String(node.properties.href), children: inline(node.children, formatting) })];
    return inline(node.children, { ...formatting, ...styleRun(node), ...(node.tagName === "strong" ? { bold: true } : node.tagName === "em" ? { italics: true } : node.tagName === "del" ? { strike: true } : node.tagName === "sub" ? { subScript: true } : node.tagName === "sup" ? { superScript: true } : node.tagName === "mark" ? { highlight: "yellow" } : node.tagName === "code" ? { font: "Consolas" } : {}) });
  });
  let listInstance = 0;
  const blocks = (nodes: NoteMarkdownNode[], list?: { ordered: boolean; level: number; instance: number }): (Paragraph | Table)[] => nodes.flatMap((node): (Paragraph | Table)[] => {
    if (node.type !== "element") return node.type === "text" && node.value.trim() ? [new Paragraph({ children: inline([node]) })] : [];
    if (node.tagName === "table") {
      const rows: NoteMarkdownElement[] = []; const gather = (n: NoteMarkdownNode) => { if (n.type !== "element") return; if (n.tagName === "tr") rows.push(n); else n.children.forEach(gather); }; gather(node);
      return [new Table({ rows: rows.map(row => new TableRow({ children: row.children.filter((cell): cell is NoteMarkdownElement => cell.type === "element" && ["td", "th"].includes(cell.tagName)).map(cell => new TableCell({ children: [new Paragraph({ children: inline(cell.children, { bold: cell.tagName === "th" }) })] })) })) })];
    }
    if (["ul", "ol"].includes(node.tagName)) return blocks(node.children, { ordered: node.tagName === "ol", level: Math.min(8, list ? list.level + 1 : 0), instance: ++listInstance });
    if (["blockquote", "section", "div"].includes(node.tagName)) return blocks(node.children, list);
    if (node.properties.dataNoteToc !== undefined) return [new Paragraph({ children: [new TextRun({ text: "目录", bold: true })] }), ...tree.children.filter((n): n is NoteMarkdownElement => n.type === "element" && /^h[1-6]$/.test(n.tagName)).map(heading => new Paragraph({ text: noteMarkdownText(heading) }))];
    const heading = /^h[1-6]$/.test(node.tagName) ? HeadingLevel[`HEADING_${node.tagName[1]}` as keyof typeof HeadingLevel] : undefined;
    const style = richStyleFromCss(node.properties.style), children = node.tagName === "li" ? node.children.flatMap(n => n.type === "element" && n.tagName === "p" ? n.children : n.type === "element" && ["ul", "ol"].includes(n.tagName) ? [] : [n]) : node.children;
    const nested = node.tagName === "li" ? node.children.filter(n => n.type === "element" && ["ul", "ol"].includes(n.tagName)) : [];
    return [new Paragraph({ heading, children: node.properties.dataNoteMath !== undefined ? [wordEquation(String(node.properties.dataNoteMath), node.properties.dataNoteMathDisplay !== undefined)] : inline(children, styleRun(node)),
      alignment: style.align ? { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }[style.align] : undefined,
      indent: style.indent ? { left: style.indent * 480 } : undefined,
      numbering: list && node.tagName === "li" ? { reference: list.ordered ? "ordered" : "bullet", level: list.level, instance: list.instance } : undefined,
      spacing: { after: 160, ...(style.leading ? { line: Math.round(style.leading * 240) } : {}) } }), ...blocks(nested, list)];
  });
  return Packer.toBuffer(new Document({ numbering: { config: ["ordered", "bullet"].map(reference => ({ reference, levels: Array.from({ length: 9 }, (_, level) => ({ level, format: reference === "ordered" ? LevelFormat.DECIMAL : LevelFormat.BULLET, text: reference === "ordered" ? `%${level + 1}.` : "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480 * (level + 1), hanging: 240 } } } })) })) }, sections: [{ children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...blocks(tree.children)] }] }));
}
