import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ArrowRight, Check, FilePlus2, FileText, Link2, LoaderCircle, Upload, X } from "lucide-react";
import type { DesktopSourceCreateRequest, DesktopSourceDuplicateV1 } from "@ailearn/shared/desktop-surface-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { MAX_CAPTURE_BYTES, TEXT_FILE_PATTERN, captureBytes, formatCaptureSize, hasOpenModal, isEditableTarget } from "../../../app/source-intake";
import { SpaceSharingNotice } from "../../space-sharing-notice";
import { formatRelative } from "../notebook/surface-data";
import { useSourceSheetMotion } from "./use-source-motion";

export function captureLink(text: string): string | null {
  try {
    const value = text.trim();
    const url = new URL(value);
    return /\s/.test(value) || url.username || url.password || !["https:", "http:"].includes(url.protocol) ? null : value;
  } catch { return null; }
}

export function CaptureStrip({ disabled, lockedReason, epochRef, receipt, summary, onCaptured, onOpenExisting }: {
  readonly disabled: boolean;
  readonly lockedReason: string | null;
  readonly epochRef: MutableRefObject<number | undefined>;
  readonly receipt: string | null;
  readonly summary: ReactNode;
  readonly onCaptured: (id: string, title: string) => void | Promise<void>;
  readonly onOpenExisting: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"text" | "url">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [duplicate, setDuplicate] = useState<{ existing: DesktopSourceDuplicateV1; request: DesktopSourceCreateRequest } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const incoming = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dragDepth = useRef(0);
  useSourceSheetMotion(sheetRef, open);
  useLayoutEffect(() => {
    const current = document.activeElement;
    if (current && sheetRef.current?.contains(current) && current.matches("input, textarea")) return;
    if (open) sheetRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(mode === "text" ? "textarea" : "input[type='url']")?.focus({ preventScroll: true });
  }, [open, mode, focusRequest]);

  const bytes = captureBytes(content);
  const overLimit = bytes > MAX_CAPTURE_BYTES;
  const close = () => { incoming.current++; setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  const reset = () => { close(); setTitle(""); setContent(""); setUrl(""); setError(null); setDuplicate(null); };
  const acceptText = (text: string, name?: string) => {
    setOpen(true); setDuplicate(null);
    if (captureBytes(text) > MAX_CAPTURE_BYTES) {
      setError(`这份材料约 ${formatCaptureSize(captureBytes(text))}，超过单次采集的 900 KB 上限。请分段采集。`); return;
    }
    const link = !name ? captureLink(text) : null;
    if (link) { setMode("url"); setUrl(link); }
    else { setMode("text"); setContent(text); }
    if (name) setTitle(current => current.trim() ? current : name.replace(/\.[^.]+$/, ""));
    setFocusRequest(current => current + 1);
    setError(null);
  };
  const acceptFile = async (file: File) => {
    const request = ++incoming.current;
    setOpen(true);
    if (!TEXT_FILE_PATTERN.test(file.name)) { setError(`暂不解析 ${file.name}，请选择文本、Markdown 或代码文件。`); return; }
    if (file.size > MAX_CAPTURE_BYTES) { setError("材料超过单次采集的 900 KB 上限，请分段采集。"); return; }
    try { const text = await file.text(); if (alive.current && request === incoming.current) acceptText(text, file.name); }
    catch { if (alive.current && request === incoming.current) setError("这份文件读不出来，可以试着粘贴正文。"); }
  };
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || disabled || open || busyRef.current || isEditableTarget(event.target) || hasOpenModal()) return;
      const text = event.clipboardData?.getData("text/plain");
      if (!text?.trim()) return;
      event.preventDefault(); acceptText(text);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });
  const save = async (request: DesktopSourceCreateRequest) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const created = unwrapGatewayResult(await window.ailearn.source.create({ meta: createRequestMeta(epochRef.current), request }));
      if (!alive.current) return;
      if (created.duplicateOf) {
        setDuplicate({ existing: created.duplicateOf, request: { ...request, force: true } }); return;
      }
      reset();
      await onCaptured(created.source.id, created.source.title);
    } catch (failure) { if (alive.current) setError(gatewayErrorMessage(failure)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current || disabled || duplicate) return;
    const text = content.trim(), link = captureLink(mode === "url" ? url : content);
    if (mode === "text" && !text) { setError("先粘贴或拖入要采集的内容。"); return; }
    if (mode === "url" && !link) { setError("请输入以 http:// 或 https:// 开头的完整地址。"); return; }
    if (mode === "text" && !link && overLimit) { setError("材料超过单次采集的 900 KB 上限，请分段采集。"); return; }
    void save({ ...(link ? { url: link } : { content: text }), ...(title.trim() ? { title: title.trim() } : {}) });
  };
  return (
    <aside className="capture-strip" data-armed={dragging || undefined}
      onPaste={event => {
        if (disabled || open || busyRef.current) return;
        const text = event.clipboardData.getData("text/plain");
        if (text.trim()) { event.preventDefault(); acceptText(text); }
      }}
      onDragEnter={event => { if (!disabled && !busyRef.current) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
      onDragOver={event => { if (!disabled) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={event => {
        event.preventDefault(); dragDepth.current = 0; setDragging(false);
        if (disabled || busyRef.current) return;
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 1) { setOpen(true); setError("这里一次收一份材料；多份文件可以拖到书房空白处一起收。"); return; }
        if (files[0]) void acceptFile(files[0]);
        else acceptText(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"));
      }}>
      <span className="source-pocket" aria-hidden="true"><FilePlus2 size={25} /></span>
      <div className="source-capture-summary">{summary}
        {busy ? <p role="status">正在收下材料…</p> : duplicate && !open ? <p role="status">这份材料已经有啦</p> : null}
      </div>
      <div className="source-capture-actions" role="group" aria-label="收录材料">
        <button type="button" className="source-icon" aria-label="从文件采集" title="从文件采集" disabled={disabled || busy || !!duplicate} onClick={() => fileRef.current?.click()}><Upload size={19} /></button>
        <button ref={triggerRef} type="button" className="button source-capture-trigger" disabled={disabled} title={lockedReason ?? undefined}
          aria-expanded={open} aria-controls="source-capture-sheet" onClick={() => open ? close() : setOpen(true)}>
          <FilePlus2 size={17} aria-hidden="true" />采集新来源
        </button>
      </div>
      <input ref={fileRef} className="source-file-input" type="file" tabIndex={-1} aria-label="文本文件"
        disabled={disabled || busy || !!duplicate} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void acceptFile(file); }} />
      {lockedReason ? <p className="capture-locked">{lockedReason}</p> : null}
      {receipt ? <p className="capture-ok" role="status"><Check size={15} aria-hidden="true" />{receipt}</p> : null}
      <div ref={sheetRef} id="source-capture-sheet" className="source-capture-sheet" role="dialog" aria-label="采集新来源" aria-modal="false" inert={!open}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
        <header className="source-sheet-heading"><h2>带一份材料进来</h2>
          <button type="button" className="source-icon" aria-label="收起采集" title="收起采集" onClick={close}><X size={18} /></button>
        </header>
        <form className="capture-form" onSubmit={submit} aria-busy={busy}
          onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
          <div className="capture-modes" role="radiogroup" aria-label="采集方式">
            <button type="button" role="radio" aria-checked={mode === "text"} disabled={busy || !!duplicate} onClick={() => { incoming.current++; setMode("text"); setError(null); }}><FileText size={16} aria-hidden="true" />文本</button>
            <button type="button" role="radio" aria-checked={mode === "url"} disabled={busy || !!duplicate} onClick={() => { incoming.current++; setMode("url"); setError(null); }}><Link2 size={16} aria-hidden="true" />链接</button>
          </div>
          <fieldset disabled={busy || !!duplicate || disabled}>
            {mode === "text" ? <>
              <label htmlFor="capture-content">正文</label>
              <textarea id="capture-content" value={content} placeholder="粘贴正文或网页地址" onChange={event => { incoming.current++; setContent(event.currentTarget.value); }}
                onPaste={event => { const link = !content.trim() ? captureLink(event.clipboardData.getData("text/plain")) : null; if (link) { incoming.current++; event.preventDefault(); setUrl(link); setMode("url"); } }} />
              <div className="source-file-line"><span className={`capture-count${overLimit ? " over" : ""}`}>{bytes ? `${formatCaptureSize(bytes)} / 900 KB` : "文本、Markdown、代码"}</span>
                <button type="button" className="text-action" onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" />选择文件</button>
              </div>
            </> : <><label htmlFor="capture-url">网页地址</label>
              <input id="capture-url" type="url" value={url} placeholder="https://" onChange={event => { incoming.current++; setUrl(event.currentTarget.value); }} />
            </>}
            <label htmlFor="capture-title">标题 <small>可留空</small></label>
            <input id="capture-title" value={title} placeholder="给这份材料起个名字" maxLength={500} onChange={event => setTitle(event.currentTarget.value)} />
          </fieldset>
          <SpaceSharingNotice />
          {error ? <p className="capture-error" role="alert">{error}</p> : null}
          {duplicate ? <div className="capture-duplicate" role="status">
            <h3>这份已经有啦</h3>
            <p>这份材料在 {formatRelative(duplicate.existing.createdAt)} 就采过了：<b>《{duplicate.existing.title}》</b>。</p>
            <div className="capture-form__actions">
              <button type="button" className="button primary" disabled={busy} onClick={() => { const id = duplicate.existing.sourceId; reset(); onOpenExisting(id); }}>打开已有来源<ArrowRight size={15} aria-hidden="true" /></button>
              <button type="button" className="text-action" disabled={busy || disabled} onClick={() => void save(duplicate.request)}>仍然再采一次</button>
              <button type="button" className="text-action" disabled={busy} onClick={() => setDuplicate(null)}>返回修改</button>
            </div>
          </div> : <div className="capture-form__actions">
            <button type="submit" className="button primary" disabled={busy || disabled}>
              {busy ? <LoaderCircle size={16} className="source-spin" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}{busy ? "正在采集…" : "开始解析"}
            </button>
            <button type="button" className="text-action" onClick={close}>取消</button>
          </div>}
        </form>
      </div>
    </aside>
  );
}
