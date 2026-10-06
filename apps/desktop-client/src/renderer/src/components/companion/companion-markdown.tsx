/** Conversation layout uses the notebook's canonical inline/table grammar and
 * shared formula renderer. Raw HTML stays text; incomplete streamed marks stay
 * visible. The character-driven speech bubble keeps a plain-text projection. */
import type { ReactNode } from "react";
import { parseInlineMarkdown, parseMarkdownTable, type NoteDocInlineSegment } from "@astella/shared/note-doc-schema";
import { isWebLinkUrl } from "@astella/shared/desktop-ipc-contracts";
import { openExternalLink } from "../../app/external-link";
import { ReadableMath } from "../content/readable-math";

function segmentSource(segment: NoteDocInlineSegment): string {
  switch (segment.kind) {
    case "strong": return `**${segment.text}**`;
    case "em": return `*${segment.text}*`;
    case "strike": return `~~${segment.text}~~`;
    case "code": return `\`${segment.text}\``;
    case "link": return `[${segment.text}](${segment.href})`;
    case "image": return `![${segment.alt}](${segment.src})`;
    default: return segment.text;
  }
}

function inlineParts(text: string) {
  let offset = 0;
  return parseInlineMarkdown(text).map(segment => {
    const source = segmentSource(segment);
    // Preserve multiplication and unfinished bold rather than eating their stars.
    const emphasis = segment.kind !== "em" || (segment.text.trim() === segment.text
      && !/[\w*]/.test(text[offset - 1] ?? "") && !/[\w*]/.test(text[offset + source.length] ?? ""));
    offset += source.length;
    return { segment, source, emphasis };
  });
}

function withLineBreaks(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((line, index) => index ? [<br key={`${key}-br${index}`} />, line] : [line]);
}

function renderInline(text: string, keyBase: string, depth = 0): ReactNode[] {
  if (depth > 8) return withLineBreaks(text, keyBase);
  return inlineParts(text).flatMap(({ segment, source, emphasis }, index): ReactNode[] => {
    const key = `${keyBase}-${index}`;
    switch (segment.kind) {
      case "code": return [<code key={key}>{segment.text}</code>];
      case "math": return [<ReadableMath key={key} source={segment.text} value={segment.value} display={segment.display} />];
      case "strong": return [<strong key={key}>{renderInline(segment.text, key, depth + 1)}</strong>];
      case "strike": return [<del key={key}>{renderInline(segment.text, key, depth + 1)}</del>];
      case "em": return emphasis ? [<em key={key}>{renderInline(segment.text, key, depth + 1)}</em>] : [source];
      case "link": return isWebLinkUrl(segment.href) ? [
        <button type="button" className="companion-md__link" key={key}
          onClick={() => { void openExternalLink(segment.href); }}>
          <span>{renderInline(segment.text, key, depth + 1)}</span><small>{segment.href}</small>
        </button>,
      ] : [source];
      // A model-supplied image is not an authorized download. Retain its source
      // for inspection; actual artifact media uses the existing asset path.
      case "image": return [source];
      default: return withLineBreaks(segment.text, key);
    }
  });
}

const FENCE_LINE = /^```[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9+#-]*)[ \t]*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const DIVIDER = /^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/;

function isBlockStart(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line)
    || QUOTE.test(line) || DIVIDER.test(line);
}

/** Some tool summaries double-encode paragraph breaks. Repair only the visible
 * prose when it contains encoded paragraphs; code, TeX and link destinations
 * remain literal. Stored receipts/audit text are unchanged. */
function visibleParagraphs(text: string): string {
  if (!text.includes("\\n\\n")) return text;
  let encodedParagraph = false;
  const prose = (value: string, depth = 0): string => {
    if (depth > 8) return value;
    return inlineParts(value).map(({ segment, source }) => {
      if (["code", "math", "link", "image"].includes(segment.kind)) return source;
      if (segment.kind === "strong") return `**${prose(segment.text, depth + 1)}**`;
      if (segment.kind === "em") return `*${prose(segment.text, depth + 1)}*`;
      if (segment.kind === "strike") return `~~${prose(segment.text, depth + 1)}~~`;
      if (segment.kind !== "text") return source;
      encodedParagraph ||= segment.text.includes("\\n\\n");
      return segment.text.replace(/\\n/g, "\n");
    }).join("");
  };
  let inCode = false;
  let section: string[] = [];
  const sections: string[] = [];
  for (const line of text.split("\n")) {
    if (!inCode && FENCE_OPEN.test(line)) {
      if (section.length) sections.push(prose(section.join("\n")));
      section = [line]; inCode = true; continue;
    }
    section.push(line);
    if (inCode && FENCE_LINE.test(line)) {
      sections.push(section.join("\n")); section = []; inCode = false;
    }
  }
  if (section.length) sections.push(inCode ? section.join("\n") : prose(section.join("\n")));
  const formatted = sections.join("\n");
  return encodedParagraph ? formatted : text;
}

export function plainCompanionBubbleText(text: string): string {
  const value = visibleParagraphs(text).replace(/^```[^\n]*\n?/gm, "").replace(/^```\s*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "").replace(/^>\s?/gm, "").replace(/__(.*?)__/g, "$1");
  return plainInline(value).replace(/\n{3,}/g, "\n\n").trimEnd();
}

function plainInline(value: string, depth = 0): string {
  if (depth > 8) return value;
  return inlineParts(value).map(({ segment, source, emphasis }) => {
    if (segment.kind === "image") return segment.alt;
    if (segment.kind === "math") return segment.value;
    if (segment.kind === "em" && !emphasis) return source;
    if (["strong", "em", "strike", "link"].includes(segment.kind)) return plainInline(segment.text, depth + 1);
    return segment.text;
  }).join("");
}

function renderList(lines: string[], start: number, key: string, depth: number): { node: ReactNode; next: number } {
  if (depth >= 16) return { node: <p key={key}>{renderInline(lines[start], key)}</p>, next: start + 1 };
  const first = lines[start].match(LIST_ITEM)!;
  const indent = (value: string) => value.replace(/\t/g, "    ").length;
  const base = indent(first[1]), ordered = /^\d/.test(first[2]);
  const items: { text: string; children: ReactNode[] }[] = [];
  let next = start;
  while (next < lines.length) {
    const match = lines[next].match(LIST_ITEM);
    if (!match || indent(match[1]) < base) break;
    if (indent(match[1]) > base && items.length) {
      const child = renderList(lines, next, `${key}-${next}`, depth + 1);
      items[items.length - 1].children.push(child.node); next = child.next; continue;
    }
    if (ordered !== /^\d/.test(match[2])) break;
    items.push({ text: match[3], children: [] }); next += 1;
  }
  const children = items.map((item, n) => <li key={n}>{renderInline(item.text, `${key}-${n}`)}{item.children}</li>);
  return { node: ordered ? <ol className="companion-md__list" start={Number.parseInt(first[2], 10)} key={key}>{children}</ol>
    : <ul className="companion-md__list" key={key}>{children}</ul>, next };
}

export function renderCompanionMarkdown(text: string): ReactNode[] {
  return renderBlocks(visibleParagraphs(text), 0);
}

function renderBlocks(text: string, depth: number): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let cursor = 0;
  let key = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line.trim()) { cursor += 1; continue; }
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const body: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !FENCE_LINE.test(lines[cursor])) body.push(lines[cursor++]);
      if (cursor < lines.length) cursor += 1;
      blocks.push(<pre className="companion-md__code" data-lang={fence[1] || undefined} key={`b${key++}`}>{body.join("\n")}</pre>);
      continue;
    }
    // Multiline display math may contain blank lines or Markdown-looking TeX.
    // Its boundary comes from the same parser as notebook formulas.
    if (line.startsWith("$$")) {
      const remaining = lines.slice(cursor).join("\n");
      const formula = parseInlineMarkdown(remaining)[0];
      if (formula?.kind === "math" && formula.display && ["", "\n"].includes(remaining[formula.text.length] ?? "")) {
        blocks.push(<ReadableMath key={`b${key++}`} source={formula.text} value={formula.value} display />);
        cursor += formula.text.split("\n").length;
        continue;
      }
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push(<p className="companion-md__heading" role="heading" aria-level={heading[1].length} key={`b${key++}`}>
        {renderInline(heading[2], `h${key}`)}</p>);
      cursor += 1; continue;
    }
    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (cursor < lines.length && QUOTE.test(lines[cursor])) quote.push(lines[cursor++].replace(QUOTE, "$1"));
      blocks.push(<blockquote className="companion-md__quote" key={`b${key++}`}>
        {depth < 16 ? renderBlocks(quote.join("\n"), depth + 1) : renderInline(quote.join("\n"), `q${key}`)}</blockquote>);
      continue;
    }
    if (DIVIDER.test(line)) {
      blocks.push(<hr className="companion-md__divider" key={`b${key++}`} />);
      cursor += 1; continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const list = renderList(lines, cursor, `b${key++}`, depth);
      blocks.push(list.node); cursor = list.next;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[] = [];
      let end = cursor;
      while (end < lines.length && lines[end].trim().startsWith("|") && lines[end].trim().endsWith("|")) rows.push(lines[end++]);
      const table = parseMarkdownTable(rows.join("\n"));
      if (table) {
        blocks.push(<div className="companion-md__table-scroll" role="region" aria-label="回复中的表格" tabIndex={0} key={`b${key++}`}>
          <table className="companion-md__table"><thead><tr>{table[0].map((cell, col) =>
            <th scope="col" key={col}>{renderInline(cell, `t${key}-h${col}`)}</th>)}</tr></thead>
            <tbody>{table.slice(2).map((row, r) => <tr key={r}>{row.map((cell, col) =>
              <td key={col}>{renderInline(cell, `t${key}-${r}-${col}`)}</td>)}</tr>)}</tbody></table>
        </div>);
        cursor = end; continue;
      }
    }
    const paragraph: string[] = [];
    do { paragraph.push(lines[cursor++]); }
    while (cursor < lines.length && lines[cursor].trim() && !isBlockStart(lines[cursor]) && !lines[cursor].startsWith("$$"));
    blocks.push(<p className="companion-md__para" key={`b${key++}`}>{renderInline(paragraph.join("\n"), `p${key}`)}</p>);
  }
  return blocks;
}
