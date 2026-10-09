import { useEffect, useRef, useState } from "react";
import { Check, Copy, ImageOff, Image as ImageIcon, Maximize2 } from "lucide-react";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { copyText } from "../../app/clipboard";
import { LightboxViewer } from "../surfaces/source/image-viewer";
import { useSourceImage } from "../surfaces/source/source-image";
import { renderCompanionMarkdown } from "./companion-markdown";

function ImagePlaceholder({ loading, retry }: { loading: boolean; retry: () => void }) {
  return <div className="companion-record__image-placeholder" role="status">
    {loading ? <><ImageIcon size={24} aria-hidden="true" /><span>正在载入图片…</span></> : <><ImageOff size={24} aria-hidden="true" /><span>图片取不回来，可以再试一次。</span><button type="button" onClick={retry}>重试</button></>}
  </div>;
}

/** Shared by the reply preview and the saved record. Site images still load
 * through main; opening the body portal keeps the reply's reading clock paused. */
export function CompanionRecordImage({ block, onReadingChange }: {
  block: Extract<CompanionContentBlockV1, { type: "image" }>;
  onReadingChange?: (reading: boolean) => void;
}) {
  const { state, retry, reload } = useSourceImage(block.url);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    onReadingChange?.(true);
    return () => onReadingChange?.(false);
  }, [open, onReadingChange]);
  useEffect(() => {
    if (!open) return;
    const dialog = document.querySelector<HTMLElement>('.image-lightbox[data-companion-owned="true"]');
    dialog?.querySelector<HTMLButtonElement>(".image-lightbox-close")?.focus();
    const keepFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const target = event.shiftKey ? buttons.at(-1) : buttons[0];
      if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === buttons[0] : document.activeElement === buttons.at(-1))) {
        event.preventDefault(); target?.focus();
      }
    };
    window.addEventListener("keydown", keepFocus, true);
    return () => { window.removeEventListener("keydown", keepFocus, true); trigger.current?.focus({ preventScroll: true }); };
  }, [open]);
  const ready = state.status === "ready" || state.status === "external";
  return <figure className="companion-record__image" data-state={state.status}>
    {ready ? <button ref={trigger} type="button" className="companion-record__image-preview" aria-label={`放大查看：${block.label}`} onClick={() => setOpen(true)}>
      <img src={state.src} alt={block.alt ?? block.label} loading="lazy" onError={state.status === "ready" ? retry : undefined} />
      <span className="companion-record__image-zoom"><Maximize2 size={13} aria-hidden="true" />放大</span>
    </button> : <ImagePlaceholder loading={state.status === "loading"} retry={reload ?? retry} />}
    <figcaption>{block.label}</figcaption>
    {open ? <LightboxViewer alt={block.alt ?? block.label} count={1} index={0} ownedByCompanion onClose={() => setOpen(false)}>
      {ready ? <img src={state.src} alt={block.alt ?? block.label} onError={state.status === "ready" ? retry : undefined} /> : <ImagePlaceholder loading={state.status === "loading"} retry={reload ?? retry} />}
    </LightboxViewer> : null}
  </figure>;
}

export function CompanionCodeBlock({ block }: { block: Extract<CompanionContentBlockV1, { type: "code" }> }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  return <figure className="companion-record__code-sheet">
    <figcaption><span>{block.language || "代码片段"}</span><button type="button" disabled={busy} aria-label="复制代码" onClick={() => {
      setBusy(true);
      void copyText(block.code).then(ok => setCopied(ok ? "copied" : "failed")).finally(() => setBusy(false));
    }}>{copied === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}<span>{busy ? "正在复制" : copied === "copied" ? "已复制" : "复制"}</span></button></figcaption>
    <pre className="companion-record__code" tabIndex={0} aria-label={`${block.language || "代码"}内容`}><code>{block.code}</code></pre>
    {copied === "failed" ? <p className="companion-record__copy-status" role="status">没能复制，请再试一次。</p> : null}
    <span className="sr-only" role="status">{copied === "copied" ? "代码已复制" : ""}</span>
  </figure>;
}

export function CompanionDiagramBlock({ block }: { block: Extract<CompanionContentBlockV1, { type: "diagram" }> }) {
  return <figure className="companion-record__diagram">
    <figcaption>{block.title}</figcaption>
    <ol>{block.steps.map((step, index) => <li key={index}>
      <span className="companion-record__step-no">{index + 1}</span>
      <div><strong>{step.label}</strong>{step.detail ? <div className="companion-record__step-detail">{renderCompanionMarkdown(step.detail)}</div> : null}</div>
    </li>)}</ol>
  </figure>;
}

export function CompanionCardBlock({ block }: { block: Extract<CompanionContentBlockV1, { type: "card" }> }) {
  return <figure className="companion-record__card">
    <figcaption>{block.knowledgeForm ? `题面预览 · ${block.knowledgeForm}` : "题面预览"}</figcaption>
    <div className="companion-record__card-front">{renderCompanionMarkdown(block.front)}</div>
    {block.summary ? <div className="companion-record__card-summary">{renderCompanionMarkdown(block.summary)}</div> : null}
  </figure>;
}
