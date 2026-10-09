import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ArrowRight, Check, FilePlus2, FileText, FolderOpen, Link2, LoaderCircle, Upload, X } from "lucide-react";
import type { DesktopSourceCreateRequest, DesktopSourceDuplicateV1 } from "@astella/shared/desktop-surface-contracts";
import type { MarkdownBundleKind, MarkdownBundlePreviewV1 } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { DOCUMENT_FILE_PATTERN, MAX_CAPTURE_BYTES, captureBytes, formatCaptureSize, hasOpenModal, isEditableTarget } from "../../../app/source-intake";
import { MAX_BATCH_CAPTURE_FILES, captureSourceTasks, readCaptureFile, readCaptureFiles, type BatchCaptureOutcome, type CaptureTask } from "../../../app/source-batch-capture";
import { inspectMarkdownBundle, localizeMarkdownBundle } from "../../../app/source-bundle-capture";
import { SpaceSharingNotice } from "../../space-sharing-notice";
import { formatRelative } from "../notebook/surface-data";
import { useSourceSheetMotion } from "./use-source-motion";
import { SourceBundlePreview } from "./source-bundle-preview";

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
  const [mode, setMode] = useState<"text" | "url" | "bundle">("text");
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
  const [imageWarnings, setImageWarnings] = useState<readonly BatchCaptureOutcome[]>([]);
  /** 正在本机解析的那一份：`null` = 此刻没在解析。PDF 不是零耗时，这一句要说实话。 */
  const [reading, setReading] = useState<{ readonly name: string; readonly index: number; readonly total: number } | null>(null);
  /** 带图导入：读者点头之前先看一眼的那份数（null = 这一轮还没有待确认的包）。 */
  const [bundle, setBundle] = useState<MarkdownBundlePreviewV1 | null>(null);
  /** 包这一侧正在做哪一段：在盘上归类，还是在传图。 */
  const [bundling, setBundling] = useState<null | "reading" | "uploading">(null);
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
    if (current && sheetRef.current?.contains(current) && current.matches("input, textarea, [role='radio'][aria-checked='true']")) return;
    if (open) sheetRef.current?.querySelector<HTMLElement>(
      mode === "text" ? "textarea" : mode === "url" ? "input[type='url']" : "[data-bundle-pick]",
    )?.focus({ preventScroll: true });
  }, [open, mode, focusRequest]);

  const bytes = captureBytes(content);
  const overLimit = bytes > MAX_CAPTURE_BYTES;
  const processing = busy || !!reading || !!batch || bundling !== null;
  const close = () => { incoming.current++; setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  const reset = () => { close(); setTitle(""); setContent(""); setUrl(""); setError(null); setDuplicate(null); };
  const acceptText = (text: string, name?: string) => {
    setOpen(true); setDuplicate(null);
    if (captureBytes(text) > MAX_CAPTURE_BYTES) {
      setError(`这份材料约 ${formatCaptureSize(captureBytes(text))}，超过单份正文的 ${formatCaptureSize(MAX_CAPTURE_BYTES)} 上限。请分段采集。`); return;
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
   *
   * PDF 与 Word 例外，直接交给批量那一条路：解析要几秒到几十秒，把读者按在表单里等
   * 一屏空白不如给他那一条一直在走的进度；而且几十页正文塞进一个可编辑的文本框也读不动。
   */
  const acceptFile = async (file: File) => {
    if (DOCUMENT_FILE_PATTERN.test(file.name)) { void acceptFiles([file]); return; }
    const request = ++incoming.current;
    setOpen(true);
    const read = await readCaptureFile(file);
    if (!alive.current || request !== incoming.current) return;
    if (!read.ok) { setError(read.message); return; }
    acceptText(read.text, file.name);
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
    setBatchFailures([]); setImageWarnings([]);
    try {
      // 读那一段（PDF 与 Word 在这里解析）由 `reading` 报，进度条那句留给「收进第几份」。
      const read = await readCaptureFiles(files, MAX_BATCH_CAPTURE_FILES, (index, total, name) => {
        if (alive.current && request === incoming.current) setReading({ index, total, name });
      });
      if (!alive.current || request !== incoming.current) return;
      setReading(null);
      setBatch({ done: 0, total: files.length });
      const isCurrent = () => alive.current && request === incoming.current;
      // 超上限的那几份要有一行明说：不然它们就是**静默消失**——读者选了 80 份，
      // 收下 50 份，界面上却只字未提剩下的 30 份去了哪。
      const overflowLine: BatchCaptureOutcome[] = read.overflow ? [{
        name: `另外 ${files.length - MAX_BATCH_CAPTURE_FILES} 份`,
        ok: false,
        count: files.length - MAX_BATCH_CAPTURE_FILES,
        message: `一次最多收 ${MAX_BATCH_CAPTURE_FILES} 份，超出的这几份没有收进来，请再拖一次。`,
      }] : [];
      if (read.tasks.length === 0) {
        setBatch(null);
        setBatchFailures([...overflowLine, ...read.outcomes]);
        return;
      }
      if (read.outcomes.length > 0 || overflowLine.length > 0) setBatchFailures([...overflowLine, ...read.outcomes]);
      await runTasks(read.tasks, [...overflowLine, ...read.outcomes], () => alive.current && request === incoming.current);
    } finally {
      busyRef.current = false;
      if (alive.current) { setBatch(null); setReading(null); }
    }
  };
  /**
   * 一份一份建来源，回执留在这一屏上。
   *
   * 批量拖文件与带图导入两条入口共用这一句：`preFailures` 是**这一步之前**就已经知道的失败
   * （读不出来的、超限没收的、图片没落地的），进度与最后那行「N 份没收进来」都要把它们算进去，
   * 不然两处会各说一套数。
   */
  const runTasks = async (tasks: readonly CaptureTask[], preFailures: readonly BatchCaptureOutcome[], isCurrent: () => boolean, warnings: readonly BatchCaptureOutcome[] = []) => {
    setImageWarnings(warnings);
    if (tasks.length === 0) { setBatch(null); setBatchFailures(preFailures); return; }
    const result = await captureSourceTasks(tasks, {
      isCurrent,
      onProgress: (done, total) => { if (isCurrent()) setBatch({ done, total }); },
    });
    if (!result || !isCurrent()) return;
    setBatch(null);
    // 三类都要留着：超限没收的、读不出来的、建来源失败的。
    // 少留一样，那一份就在读者眼里凭空消失了（这里曾经只留后两样）。
    const failures = [...preFailures, ...result.outcomes.filter((outcome) => !outcome.ok)];
    setBatchFailures(failures);
    await onBatchCaptured({
      accepted: result.outcomes.filter((outcome) => outcome.ok).length,
      failed: failures.reduce((count, failure) => count + (failure.count ?? 1), 0),
    });
  };
  /**
   * 选一个包，先只看一眼：主进程在盘上把几篇正文与图片引用归类，一次网络都不发。
   *
   * 这一步刻意不传图。一个包动辄几百张图，选错了文件夹还要等一轮上传，比多按一次按钮贵得多。
   */
  const openBundle = async (kind: MarkdownBundleKind) => {
    if (disabled || busyRef.current) return;
    const request = ++incoming.current;
    busyRef.current = true;
    setBundling("reading"); setError(null); setDuplicate(null); setOpen(true); setMode("bundle");
    try {
      const preview = await inspectMarkdownBundle(kind);
      if (!alive.current || request !== incoming.current) return;
      // 取消选择什么也不留；报了问题的包照样铺开在那一屏上，读者看得见为什么。
      if (preview) setBundle(preview);
    } catch (failure) {
      if (alive.current && request === incoming.current) setError(gatewayErrorMessage(failure));
    } finally {
      busyRef.current = false;
      if (alive.current) setBundling(null);
    }
  };
  /** 传图 + 改写正文，然后把改写好的那几份交给批量那一条路。 */
  const commitBundle = async () => {
    if (!bundle || disabled || busyRef.current) return;
    const request = ++incoming.current;
    busyRef.current = true; setBusy(true); setError(null); setOpen(false); setBatchFailures([]); setImageWarnings([]);
    setBatch({ done: 0, total: bundle.files });
    setBundling("uploading");
    const isCurrent = () => alive.current && request === incoming.current;
    try {
      const localized = await localizeMarkdownBundle(bundle);
      if (!isCurrent()) return;
      setBundle(null);
      setBundling(null);
      await runTasks(localized.tasks, localized.outcomes, isCurrent, localized.warnings);
    } catch (failure) {
      if (isCurrent()) { setBatch(null); setOpen(true); setError(gatewayErrorMessage(failure)); }
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setBundling(null); setReading(null); }
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
      const created = unwrapGatewayResult(await window.astella.source.create({ meta: createRequestMeta(epochRef.current), request }));
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
    // 「带图的包」这一格自己有一套按钮（先选包、再决定收不收），表单那一下不该替它决定。
    if (busyRef.current || disabled || duplicate || mode === "bundle") return;
    const text = content.trim(), link = captureLink(mode === "url" ? url : content);
    if (mode === "text" && !text) { setError("先粘贴或拖入要采集的内容。"); return; }
    if (mode === "url" && !link) { setError("请输入以 http:// 或 https:// 开头的完整地址。"); return; }
    if (mode === "text" && !link && overLimit) { setError(`材料超过单份正文的 ${formatCaptureSize(MAX_CAPTURE_BYTES)} 上限，请分段采集。`); return; }
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
        {bundling === "reading" ? <p role="status">正在看这个包里有几篇、几张图…</p>
          : bundling === "uploading" ? <p role="status">正在导入随文图片…</p>
          : reading ? <p role="status">正在本机解析《{reading.name}》{reading.total > 1 ? `（第 ${reading.index + 1}/${reading.total} 份）` : ""}，收录正文与图片…</p>
          : batch ? <p role="status">正在收进第 {Math.min(batch.done + 1, batch.total)}/{batch.total} 份…</p>
          : busy ? <p role="status">正在收下材料…</p>
          : duplicate && !open ? <p role="status">这份材料已经有啦</p> : null}
        {batchFailures.length > 0 ? (
          <details className="capture-report" open><summary>{batchFailures.reduce((count, item) => count + (item.count ?? 1), 0)} 份材料未能收录</summary>
            <ul className="capture-batch-failures" aria-label="没收进来的材料">{batchFailures.map((outcome, index) => <li key={`${index}-${outcome.name}`}><b>{outcome.name}</b>：{outcome.message}</li>)}</ul>
          </details>
        ) : null}
        {imageWarnings.length > 0 ? <details className="capture-report"><summary>部分图片未能导入，点此查看</summary>
          <ul className="capture-batch-failures" aria-label="未能导入的图片">{imageWarnings.map((item, index) => <li key={`${index}-${item.name}`}><b>{item.name}</b>：{item.message}</li>)}</ul>
        </details> : null}
      </div>
      <div className="source-capture-actions" role="group" aria-label="收录材料">
        <button type="button" className="source-icon" aria-label="从文件采集" title="从文件采集（可多选）" disabled={disabled || processing || !!duplicate} onClick={() => fileRef.current?.click()}><Upload size={19} /></button>
        <button ref={triggerRef} type="button" className="button source-capture-trigger" disabled={disabled || processing && bundling !== "reading"} title={lockedReason ?? undefined}
          aria-expanded={open} aria-controls="source-capture-sheet" onClick={() => { incoming.current++; setOpen(current => !current); triggerRef.current?.focus({ preventScroll: true }); }}>
          <FilePlus2 size={17} aria-hidden="true" />采集新来源
        </button>
      </div>
      {/* multiple：一次选多份是这条路的主要用法，不是例外——单份照样从这里进（acceptFile）。 */}
      <input ref={fileRef} className="source-file-input" type="file" multiple tabIndex={-1} aria-label="要采集的文件"
        disabled={disabled || processing || !!duplicate}
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
          <div className="capture-modes" role="radiogroup" aria-label="采集方式" onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || processing || duplicate) return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='radio']")];
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[target]?.click(); buttons[target]?.focus();
          }}>
            <button type="button" role="radio" tabIndex={mode === "text" ? 0 : -1} aria-checked={mode === "text"} disabled={processing || !!duplicate} onClick={() => { incoming.current++; setMode("text"); setError(null); }}><FileText size={16} aria-hidden="true" />文本</button>
            <button type="button" role="radio" tabIndex={mode === "url" ? 0 : -1} aria-checked={mode === "url"} disabled={processing || !!duplicate} onClick={() => { incoming.current++; setMode("url"); setError(null); }}><Link2 size={16} aria-hidden="true" />链接</button>
            <button type="button" role="radio" tabIndex={mode === "bundle" ? 0 : -1} aria-checked={mode === "bundle"} disabled={processing || !!duplicate} onClick={() => { incoming.current++; setMode("bundle"); setError(null); }}><FolderOpen size={16} aria-hidden="true" />带图的包</button>
          </div>
          <fieldset disabled={busy || !!duplicate || disabled}>
            {mode === "text" ? <>
              <label htmlFor="capture-content">正文</label>
              <textarea id="capture-content" value={content} placeholder="粘贴正文或网页地址" onChange={event => { incoming.current++; setContent(event.currentTarget.value); }}
                onPaste={event => { const link = !content.trim() ? captureLink(event.clipboardData.getData("text/plain")) : null; if (link) { incoming.current++; event.preventDefault(); setUrl(link); setMode("url"); } }} />
              <div className="source-file-line"><span className={`capture-count${overLimit ? " over" : ""}`}>{bytes ? `${formatCaptureSize(bytes)} / ${formatCaptureSize(MAX_CAPTURE_BYTES)}` : "文本、Markdown、代码、PDF、Word"}</span>
                <button type="button" className="text-action" onClick={() => fileRef.current?.click()}><Upload size={14} aria-hidden="true" />选择文件（可多选）</button>
              </div>
            </> : mode === "url" ? <><label htmlFor="capture-url">网页地址</label>
              <input id="capture-url" type="url" value={url} placeholder="https://" onChange={event => { incoming.current++; setUrl(event.currentTarget.value); }} />
            </> : <SourceBundlePreview preview={bundle} reading={bundling === "reading"} onPick={kind => void openBundle(kind)} onCommit={() => void commitBundle()} onClear={() => setBundle(null)} />}
            {mode === "bundle" ? null : <>
              <label htmlFor="capture-title">标题 <small>可留空</small></label>
              <input id="capture-title" value={title} placeholder="给这份材料起个名字" maxLength={500} onChange={event => setTitle(event.currentTarget.value)} />
            </>}
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
          </div> : mode === "bundle" ? null : <div className="capture-form__actions">
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
