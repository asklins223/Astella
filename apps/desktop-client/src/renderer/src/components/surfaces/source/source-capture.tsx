import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ArrowRight, Check, FilePlus2, FileText, Link2, LoaderCircle, Upload, X } from "lucide-react";
import type { DesktopSourceCreateRequest, DesktopSourceDuplicateV1 } from "@ailearn/shared/desktop-surface-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { MAX_CAPTURE_BYTES, TEXT_FILE_PATTERN, captureBytes, formatCaptureSize, hasOpenModal, isEditableTarget } from "../../../app/source-intake";
import { MAX_BATCH_CAPTURE_FILES, captureSourceTasks, readCaptureFiles, type BatchCaptureOutcome } from "../../../app/source-batch-capture";
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

export function CaptureStrip({ disabled, lockedReason, epochRef, receipt, summary, onCaptured, onBatchCaptured, onOpenExisting }: {
  readonly disabled: boolean;
  readonly lockedReason: string | null;
  readonly epochRef: MutableRefObject<number | undefined>;
  readonly receipt: string | null;
  readonly summary: ReactNode;
  readonly onCaptured: (id: string, title: string) => void | Promise<void>;
  /** 一次收下多份时的出口：页面用它写收据并刷新索引（逐份调 onCaptured 会刷新 N 次）。 */
  readonly onBatchCaptured: (result: { readonly accepted: number; readonly failed: number }) => void | Promise<void>;
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
  /** 批量收录的进度：`null` = 此刻没有在收。收多份时它取代那一句「正在采集…」。 */
  const [batch, setBatch] = useState<{ readonly done: number; readonly total: number } | null>(null);
  const [batchFailures, setBatchFailures] = useState<readonly BatchCaptureOutcome[]>([]);
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
  /**
   * 一份文件 → 填进采集表单（老路子：读者想改标题、想先看一眼再决定收不收时走它）。
   * 只有**一份**时才走这里；一次多份是另一件事，见 `acceptFiles`。
   */
  const acceptFile = async (file: File) => {
    const request = ++incoming.current;
    setOpen(true);
    if (!TEXT_FILE_PATTERN.test(file.name)) { setError(`暂不解析 ${file.name}，请选择文本、Markdown 或代码文件。`); return; }
    if (file.size > MAX_CAPTURE_BYTES) { setError("材料超过单次采集的 900 KB 上限，请分段采集。"); return; }
    try { const text = await file.text(); if (alive.current && request === incoming.current) acceptText(text, file.name); }
    catch { if (alive.current && request === incoming.current) setError("这份文件读不出来，可以试着粘贴正文。"); }
  };
  /**
   * 多份文件 → 一份一份建来源（批量那条路）。
   *
   * 刻意**不开采集表单**：一份文件的时候表单是有用的（能改标题、能先看正文），
   * 三十份的时候它只会挡住进度条。所以单份走 `acceptFile`，多份走这里。
   *
   * 收完之后失败的那些要留在这一屏上：读者需要知道**哪几份没进来**才能再去补一次，
   * 只报「已收下 N 份」的话，剩下那几份就凭空消失了。
   */
  const acceptFiles = async (files: readonly File[]) => {
    if (files.length === 0 || busyRef.current || disabled) return;
    const request = ++incoming.current;
    busyRef.current = true;
    setError(null); setDuplicate(null); setOpen(false);
    setBatchFailures([]);
    setBatch({ done: 0, total: files.length });
    try {
      const read = await readCaptureFiles(files);
      if (!alive.current || request !== incoming.current) return;
      const isCurrent = () => alive.current && request === incoming.current;
      // 超上限的那几份要有一行明说：不然它们就是**静默消失**——读者选了 80 份，
      // 收下 50 份，界面上却只字未提剩下的 30 份去了哪。
      const overflowLine: BatchCaptureOutcome[] = read.overflow ? [{
        name: `另外 ${files.length - MAX_BATCH_CAPTURE_FILES} 份`,
        ok: false,
        message: `一次最多收 ${MAX_BATCH_CAPTURE_FILES} 份，超出的这几份没有收进来，请再拖一次。`,
      }] : [];
      if (read.tasks.length === 0) {
        setBatch(null);
        setBatchFailures([...overflowLine, ...read.outcomes]);
        return;
      }
      if (read.outcomes.length > 0 || overflowLine.length > 0) setBatchFailures([...overflowLine, ...read.outcomes]);
      const result = await captureSourceTasks(read.tasks, {
        isCurrent,
        onProgress: (done, total) => { if (isCurrent()) setBatch({ done: read.outcomes.length + done, total: read.outcomes.length + total }); },
      });
      if (!result || !isCurrent()) return;
      setBatch(null);
      // 三样都要留着：超限没收的、读不出来的、建来源失败的。
      // 少留一样，那一份就在读者眼里凭空消失了（这里曾经只留后两样）。
      const failures = [...overflowLine, ...read.outcomes, ...result.outcomes.filter((outcome) => !outcome.ok)];
      setBatchFailures(failures);
      await onBatchCaptured({
        accepted: result.outcomes.filter((outcome) => outcome.ok).length,
        failed: failures.length,
      });
    } finally {
      busyRef.current = false;
      if (alive.current) setBatch(null);
    }
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
        // 多份走批量那条路：这一格现在**就是**批量入口，不必再把读者支去书房空白处。
        if (files.length > 1) { void acceptFiles(files); return; }
        if (files[0]) void acceptFile(files[0]);
        else acceptText(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"));
      }}>
      <span className="source-pocket" aria-hidden="true"><FilePlus2 size={25} /></span>
      <div className="source-capture-summary">{summary}
        {batch ? <p role="status">正在收进第 {Math.min(batch.done + 1, batch.total)}/{batch.total} 份…</p>
          : busy ? <p role="status">正在收下材料…</p>
          : duplicate && !open ? <p role="status">这份材料已经有啦</p> : null}
        {batchFailures.length > 0 ? (
          <ul className="capture-batch-failures" aria-label="没收进来的材料">
            {batchFailures.slice(0, 5).map((outcome) => (
              <li key={outcome.name}><b>{outcome.name}</b>：{outcome.message}</li>
            ))}
            {batchFailures.length > 5 ? <li>另有 {batchFailures.length - 5} 份也没收进来。</li> : null}
          </ul>
        ) : null}
      </div>
      <div className="source-capture-actions" role="group" aria-label="收录材料">
        <button type="button" className="source-icon" aria-label="从文件采集" title="从文件采集（可多选）" disabled={disabled || busy || !!duplicate} onClick={() => fileRef.current?.click()}><Upload size={19} /></button>
        <button ref={triggerRef} type="button" className="button source-capture-trigger" disabled={disabled} title={lockedReason ?? undefined}
          aria-expanded={open} aria-controls="source-capture-sheet" onClick={() => open ? close() : setOpen(true)}>
          <FilePlus2 size={17} aria-hidden="true" />采集新来源
        </button>
      </div>
      {/* multiple：一次选多份是这条路的主要用法，不是例外——单份照样从这里进（acceptFile）。 */}
      <input ref={fileRef} className="source-file-input" type="file" multiple tabIndex={-1} aria-label="文本文件"
        disabled={disabled || busy || !!duplicate}
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 1) { void acceptFiles(files); return; }
          if (files[0]) void acceptFile(files[0]);
        }} />
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
                <button type="button" className="text-action" onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" />选择文件（可多选）</button>
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
