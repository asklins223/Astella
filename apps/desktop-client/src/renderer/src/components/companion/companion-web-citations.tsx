import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, Search, X } from "lucide-react";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { copyText } from "../../app/clipboard";
import { openExternalLink } from "../../app/external-link";

type CitationBlock = Extract<CompanionContentBlockV1, { type: "citation" }>;
export type WebCitation = CitationBlock & { referenceId: string; target: { kind: "external_https"; href: string } };
export function companionWebCitations(blocks: readonly CompanionContentBlockV1[]): WebCitation[] {
  const seen = new Set<string>();
  return blocks.filter((block): block is WebCitation => {
    if (block.type !== "citation" || !block.referenceId || block.target.kind !== "external_https" || seen.has(block.referenceId)) return false;
    seen.add(block.referenceId); return true;
  });
}
export const WebCitationContext = createContext<readonly WebCitation[]>([]);

function CitationButton({ source, number, label }: { source: WebCitation; number: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const box = panel.current!;
      const width = Math.min(360, window.innerWidth - 32);
      box.style.width = `${width}px`;
      box.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
      box.style.top = `${Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - box.offsetHeight - 16))}px`;
    };
    panel.current.showPopover?.(); place(); panel.current.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const host = new URL(source.target.href).hostname;
  return <>
    <button ref={trigger} type="button" className={label ? "companion-web-source-row" : "companion-web-citation"}
      aria-label={`来源 ${number}：${source.label}`} aria-expanded={open} aria-haspopup="dialog"
      title={source.label} onClick={() => { setNotice(null); setOpen(value => !value); }}>
      <span>{number}</span>{label ? <span><strong>{label}</strong><small>{source.media || host}</small></span> : null}
    </button>
    {open ? createPortal(<div ref={panel} className="companion-web-source" popover="auto" role="dialog" tabIndex={-1}
      aria-label={`网页来源 ${number}`} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      }} onToggle={event => { if (event.newState === "closed") setOpen(false); }}>
      <div className="companion-web-source__heading"><small>来源 {number} · {source.media || host}</small><button type="button" aria-label="关闭网页来源" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={15} /></button></div>
      <strong>{source.label}</strong>{source.publishDate ? <small>{source.publishDate}</small> : null}
      <span className="companion-web-source__url">{source.target.href}</span>
      <div className="companion-web-source__actions"><button type="button" onClick={() => { void copyText(source.target.href).then(ok => setNotice(ok ? "链接已复制" : "复制失败，请重试")); }}><Copy size={14} />复制链接</button>
        <button type="button" onClick={() => { void openExternalLink(source.target.href).then(ok => { if (!ok) setNotice("浏览器未能打开，可以复制链接后重试。"); }); }}><ExternalLink size={14} />浏览器打开</button></div>
      {notice ? <small role="status">{notice}</small> : null}
    </div>, document.body) : null}
  </>;
}

/** Only trusted source identities become clickable; invented markers stay absent. */
export function WebCitationText({ text }: { text: string }) {
  const sources = useContext(WebCitationContext);
  // Streaming and the reading clock can end halfway through a marker.
  const visibleText = text.replace(/\[\^(?:w|we|web|web-[a-zA-Z0-9_-]*)?$/, "");
  const nodes: ReactNode[] = [];
  const prose = (value: string, key: string) => value.split("\n").flatMap((line, index) => index ? [<br key={`${key}-${index}`} />, line] : [line]);
  let end = 0;
  for (const match of visibleText.matchAll(/\[\^(web-[a-zA-Z0-9_-]+)\]/g)) {
    nodes.push(...prose(visibleText.slice(end, match.index), `p${end}`));
    const index = sources.findIndex(source => source.referenceId === match[1]);
    if (index >= 0) nodes.push(<CitationButton key={`${match.index}-${match[1]}`} source={sources[index]} number={index + 1} />);
    end = match.index! + match[0].length;
  }
  nodes.push(...prose(visibleText.slice(end), `p${end}`));
  return <>{nodes}</>;
}

export function CompanionWebSources({ sources }: { sources: readonly WebCitation[] }) {
  if (!sources.length) return null;
  return <details className="companion-web-sources"><summary><Search size={14} aria-hidden="true" />搜索到 {sources.length} 个网页</summary>
    <div>{sources.map((source, index) => <CitationButton key={source.referenceId} source={source} number={index + 1} label={source.label} />)}</div>
  </details>;
}
