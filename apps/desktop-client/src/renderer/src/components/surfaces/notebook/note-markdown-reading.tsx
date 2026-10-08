import { createElement, useMemo, type ReactNode } from "react";
import { noteBlockMarkdown, noteLinkTarget, noteMarkdownText, noteMarkdownTree, type NoteMarkdownElement, type NoteMarkdownNode } from "@astella/shared/note-markdown";
import { isWebLinkUrl } from "@astella/shared/desktop-ipc-contracts";
import { InlineImage, renderNoteInline, renderNotePlainText, type NoteInlineRenderOptions } from "./note-reading-inline";
import { openExternalLink } from "../../../app/external-link";
import { NoteReadingLink } from "./note-library-links";
import { NoteMermaid } from "./note-mermaid";

/** Render the allowlisted syntax tree as React elements. Annotation offsets follow this same tree. */
export function NoteMarkdownReading({ type, content, options }: { type: string; content: string; options: NoteInlineRenderOptions }) {
  const tree = useMemo(() => noteMarkdownTree(noteBlockMarkdown(type, content)), [type, content]);
  let offset = 0;
  let imageIndex = 0;
  const render = (node: NoteMarkdownNode, key: string, parent?: string, linked = false): ReactNode => {
    if (node.type === "text") {
      if (/^\s*\n\s*$/.test(node.value) && !["pre", "code"].includes(parent ?? "")) return null;
      const start = offset;
      offset += node.value.length;
      return renderNotePlainText(node.value, { ...options, textOffset: start });
    }
    if (node.type !== "element") return null;
    const { tagName: tag, properties: props } = node;
    if (tag === "img") {
      const src = String(props.src ?? "");
      const index = options.galleryStart === undefined ? undefined : options.galleryStart + imageIndex;
      imageIndex += 1;
      const width = positiveSize(props.width), height = positiveSize(props.height);
      return <span key={key} className="note-html-image" style={{ ...(width ? { display: "inline-block", width, height, maxWidth: "100%" } : {}), "--note-image-width": width ?? 320 } as React.CSSProperties}>
        <InlineImage src={src} alt={String(props.alt ?? "")} workspaceEpoch={options.workspaceEpoch}
          linked={linked}
          galleryIndex={index} onOpenGallery={options.onOpenGallery} />
      </span>;
    }
    if (tag === "span" && typeof props.dataNoteMath === "string") {
      const source = noteMarkdownText(node);
      const start = offset; offset += source.length;
      return <span key={key}>{renderNoteInline(source, { ...options, textOffset: start })}</span>;
    }
    if (tag === "pre") {
      const code = node.children.find(child => child.type === "element" && child.tagName === "code") as NoteMarkdownElement | undefined;
      const source = noteMarkdownText(code ?? node);
      const language = (code?.properties.className as string[] | undefined)?.find(name => name.startsWith("language-"))?.slice(9);
      const start = offset; offset += source.length;
      if (language?.toLowerCase() === "mermaid") return <NoteMermaid key={key} source={source} />;
      return <pre key={key} className="code-block" data-language={language}><code>{renderNotePlainText(source, { ...options, textOffset: start })}</code></pre>;
    }
    const children = node.children.map((child, index) => render(child, `${key}-${index}`, tag, linked || tag === "a"));
    if (tag === "a") {
      const href = String(props.href ?? "");
      if (noteLinkTarget(href)) return <NoteReadingLink key={key} href={href}>{children}</NoteReadingLink>;
      if (href.startsWith("#")) return <a key={key} href={href} onClick={event => {
        event.preventDefault();
        scrollNoteAnchor(event.currentTarget, href);
      }}>{children}</a>;
      if (!isWebLinkUrl(href)) return <span key={key}>{children}</span>;
      return <a key={key} href={href} title={String(props.title ?? "")} onClick={event => { event.preventDefault(); void openExternalLink(href); }}>{children}</a>;
    }
    const align = ["left", "center", "right"].includes(String(props.align)) ? props.align as "left" | "center" | "right" : undefined;
    const imageOnly = (child: NoteMarkdownNode): boolean => child.type === "text" ? !child.value.trim() : child.type === "element" && (child.tagName === "img" || child.tagName === "a" && child.children.every(imageOnly));
    const countImages = (child: NoteMarkdownNode): number => child.type !== "element" ? 0 : child.tagName === "img" ? 1 : child.children.reduce((sum, nested) => sum + countImages(nested), 0);
    const onlyImages = tag === "p" && node.children.every(imageOnly) && node.children.reduce((count, child) => count + countImages(child), 0) > 0;
    const row = onlyImages && node.children.reduce((count, child) => count + countImages(child), 0) > 1;
    return createElement(tag, {
      key, ...(props.id ? { id: String(props.id) } : {}),
      ...(tag === "table" ? { className: "md-table" } : {}),
      ...(onlyImages ? { className: row ? "note-image-paragraph note-image-row" : "note-image-paragraph" } : {}),
      ...(tag === "hr" ? { className: "reading-rule" } : {}),
      ...(align ? { style: { textAlign: align } } : {}),
      ...(tag === "ol" && props.start ? { start: Number(props.start) } : {}),
      ...(tag === "input" ? { type: "checkbox", checked: Boolean(props.checked), disabled: true, readOnly: true, "aria-label": props.checked ? "已完成" : "未完成" } : {}),
      ...(tag === "td" || tag === "th" ? { colSpan: Number(props.colSpan ?? 1), rowSpan: Number(props.rowSpan ?? 1) } : {}),
      ...(tag === "th" ? { scope: "col" } : {}),
    }, ...children);
  };
  return <>{tree.children.map((node, index) => render(node, `md-${index}`))}</>;
}

function scrollNoteAnchor(link: HTMLElement, href: string) {
  let anchor: string;
  try { anchor = decodeURIComponent(href.slice(1)); } catch { return; }
  const paper = link.closest(".note-transcript") ?? link.closest(".notebook-desk__page");
  if (!paper) return;
  const explicit = Array.from(paper.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === anchor || node.id === `user-content-${anchor}`);
  const counts = new Map<string, number>();
  const heading = Array.from(paper.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).find(node => {
    const slug = (node.textContent ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return anchor === (count ? `${slug}-${count}` : slug);
  });
  (explicit ?? heading)?.scrollIntoView({ block: "start" });
}

function positiveSize(value: unknown): number | undefined {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.min(size, 4096) : undefined;
}
