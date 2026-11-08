import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { markdownToBlocks } from "@astella/shared/markdown-parser";
import { Archive, ChevronDown, FileText, FolderOpen, LoaderCircle, Sparkles, X } from "lucide-react";
import { NoteDocumentEditor } from "./note-document-editor.tsx";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor.tsx";
import { NotebookEditorTools } from "./notebook-editor-tools.tsx";
import { useNotebookLinkEditor } from "./notebook-link-editor.tsx";
import { noteImageMarkdown } from "@astella/shared/note-markdown";
import { writingAction, collectWritingImages } from "./note-writing-assets.ts";
import { useWritingPreferences, writingPreferenceAttributes } from "./note-writing-preferences.ts";
import type { NoteBodyMode } from "./note-document-mode.ts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../../app/client/desktop-client";
import { useRoomStore } from "../../../../app/home/room-store";

export type OpenedDeskFile = { readonly path: string; readonly name: string };

/**
 * 本地 Markdown 稿纸。
 *
 * 系统文件关联（双击 .md）直接落到这里：打开就是可编辑正文，⌘/Ctrl+S 写回原文件，
 * 外部改动过会拦住不覆盖。底下三颗动作把这份稿子带进 Astella：
 * 「收进来源库」保留为材料，「转成笔记」直接落成云笔记，「让伴星读」把当前正文
 * 作为附件交给伴星——三条路都先保存本地文件，改过的字不会只活在弹窗里。
 */
export function NotebookLocalFiles({ onClose, initialPath, initialEntries, onAskCompanion }: {
  readonly onClose: () => void;
  /** 系统刚打开的那一份；挂载后自动读入。 */
  readonly initialPath?: string;
  /** 这批一起打开的文件，作为左侧列表；点一下切换，未保存的改动先问。 */
  readonly initialEntries?: readonly OpenedDeskFile[];
  /** 稿子在本地保存好之后，交给宿主去开伴星对话。 */
  readonly onAskCompanion?: (file: { readonly path: string; readonly name: string; readonly markdown: string }) => void;
}) {
  const writingPreferences = useWritingPreferences();
  const [document] = useState(() => new Y.Doc()), editorRef = useRef<NoteMarkdownEditorHandle | null>(null), fileMenuRef = useRef<HTMLDetailsElement>(null);
  const [path, setPath] = useState(""), [revision, setRevision] = useState<number>(), [markdown, setMarkdown] = useState(""), [dirty, setDirty] = useState(false), [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [mode, setMode] = useState<NoteBodyMode>("live-preview");
  const [entries, setEntries] = useState<{ path: string; name: string }[]>(() => [...(initialEntries ?? [])]), [pending, setPending] = useState<(() => void) | null>(null);
  /** 「带图转进 Astella」在读者点头之前先摆出来的那一份：有几张图没找到，说清楚再走。 */
  const [pendingImport, setPendingImport] = useState<{ readonly kind: "note" | "source"; readonly prepared: { readonly markdown: string; readonly uploaded: number; readonly issues: readonly { readonly src: string; readonly message: string }[] }; readonly title: string } | null>(null);
  const [permissions, setPermissions] = useState<{ readonly note: boolean; readonly source: boolean } | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);
  const hasWorkspace = Boolean(useRoomStore(state => state.spaceIdentity));
  const initialOpened = useRef(false);
  const fileName = path.split(/[\\/]/).pop() || "未命名稿纸";
  const imageInput = useRef<HTMLInputElement | null>(null), imageUrls = useRef<string[]>([]);
  const link = useNotebookLinkEditor(editorRef, "local-note", !busy);
  const images = (files: readonly File[]) => { const valid = files.filter(file => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) && file.size <= 12_000_000);
    if (valid.length !== files.length) setStatus("支持 PNG、JPEG、GIF、WebP，每张图片不超过 12 MB");
    const markdown = valid.map(file => { const url = URL.createObjectURL(file); imageUrls.current.push(url); return noteImageMarkdown({ src: url, alt: file.name }); }).join(" ");
    if (markdown) editorRef.current?.insertImageMarkdown?.(markdown);
  };
  useEffect(() => () => { imageUrls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => {
    // 必须等编辑器就绪再读：读回来的正文要走 `applySource`，在那之前它还是空的。
    if (!editorReady || initialOpened.current || !initialPath) return;
    initialOpened.current = true;
    void open(initialPath);
  }, [editorReady, initialPath]);
  useEffect(() => {
    if (!hasWorkspace) { setPermissions(null); return; }
    let active = true;
    void window.astella.capabilities.get({ meta: createRequestMeta() }).then(response => {
      if (!active) return;
      const caps = unwrapGatewayResult(response).actionCapabilities;
      setPermissions({ note: caps["note.create"] === "allowed", source: caps["source.create"] === "allowed" });
    }).catch(() => { if (active) setPermissions(null); });
    return () => { active = false; };
  }, [hasWorkspace]);
  const current = useRef({ path, revision, markdown }); current.current = { path, revision, markdown };
  const savedMarkdown = useRef("");
  /**
   * 本地稿纸不是弹窗：它要在 Live2D 伴星和现有对话面板之下铺满房间，
   * 但把书房自己的导航藏起来。`localPaperOpen` 让外壳隐藏 Chrome 并让出快捷键；
   * HUD 页用同一个 store 直接写/还原，避免 useHudPage 卸载时把父页面重置成 home。
   */
  useEffect(() => {
    const room = useRoomStore.getState();
    const previousHudPage = room.hudPage;
    room.setLocalPaperOpen(true);
    room.setHudPage("local-paper");
    const active = window.document.activeElement as HTMLElement | null;
    return () => {
      room.setLocalPaperOpen(false);
      useRoomStore.getState().setHudPage(previousHudPage);
      document.destroy();
      active?.focus();
    };
  }, [document]);
  const guard = (action: () => void) => { if (dirty) setPending(() => action); else action(); };
  const run = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); setStatus(""); try { await operation(); } catch (error) { setStatus(error instanceof Error ? error.message : "文件操作失败"); } finally { setBusy(false); } };
  const open = (file?: string) => void run(async () => { const result = await writingAction({ action: file ? "read" : "open", path: file }); if (result.canceled || result.markdown === undefined || !result.path) return;
    savedMarkdown.current = result.markdown; setPath(result.path); setRevision(result.revision); setMarkdown(result.markdown); setDirty(false);
    /**
     * 正文要等编辑器实例真的可用再灌进去。系统打开时这一步发生在弹窗刚挂载的一瞬间，
     * 合并句柄可能还没写回 `editorRef`；`applySource` 自己会吞掉异常并回 false，
     * 所以这里按帧重试，而不是把一次时序巧合当成"文件是空的"。
     */
    let attempts = 0;
    const paint = () => {
      const handle = editorRef.current;
      if (handle) {
        handle.setLocalFile?.(result.path!);
        if (handle.applySource(result.markdown!)) { handle.clearHistory?.(); handle.focus(); return; }
      }
      if (attempts++ < 60) window.requestAnimationFrame(paint);
      else setStatus("正文没能画出来，切到「Markdown 源码」看看原文。");
    };
    paint();
  });
  const save = async () => { let saved = false; await run(async () => { const value = editorRef.current?.getMarkdown() ?? current.current.markdown; const images = await collectWritingImages(value, current.current.path || undefined);
    const result = await writingAction({ action: "save", title: current.current.path.split(/[\\/]/).pop()?.replace(/\.md$/, "") || "笔记", path: current.current.path || undefined, revision: current.current.revision, markdown: value, images });
    if (result.canceled || !result.path) return; savedMarkdown.current = result.markdown ?? value; editorRef.current?.setLocalFile?.(result.path); if (result.markdown !== undefined) editorRef.current?.applySource(result.markdown);
    setPath(result.path); setRevision(result.revision); setMarkdown(result.markdown ?? value); setDirty(false); setStatus("已保存到本地文件"); setSavedPulse(true); window.setTimeout(() => setSavedPulse(false), 2400); saved = true;
  }); return saved; };
  /**
   * 三条进 Astella 的路共用前半段：先把本地文件存好，再把正文里的相对图片
   * 传成站内地址。上传发生在「读者已经明确点了动作」之后，看稿子本身不写库。
   */
  const prepareImport = async (kind: "note" | "source") => {
    if (busy) return;
    setStatus("");
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    const filePath = current.current.path;
    if (!filePath) { setStatus("先保存成一个本地文件，再收进 Astella。"); return; }
    const value = editorRef.current?.getMarkdown() ?? current.current.markdown;
    setBusy(true);
    try {
      const prepared = unwrapGatewayResult(await window.astella.openedFile.prepareImport({
        meta: createRequestMeta(), request: { version: 1, path: filePath, markdown: value },
      }));
      const title = (filePath.split(/[\\/]/).pop() || "笔记").replace(/\.[^.]+$/, "");
      const next = { kind, prepared, title } as const;
      if (prepared.issues.length === 0) await commitImport(next);
      else setPendingImport(next);
    } catch (error) {
      setStatus(gatewayErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const commitImport = async (next: NonNullable<typeof pendingImport>) => {
    const { kind, prepared, title } = next;
    try {
      if (kind === "note") {
        const blocks = markdownToBlocks(prepared.markdown);
        if (!blocks.length) throw new Error("正文是空的，先写一点再转成笔记。");
        const created = unwrapGatewayResult(await window.astella.note.create({
          meta: createRequestMeta(), request: { title, blocks },
        }));
        useRoomStore.getState().setActiveNoteRef({ noteId: created.noteId, noteVersionId: created.currentVersionId, mode: "live-preview" });
        onClose();
        useRoomStore.getState().invoke("open-notebook");
      } else {
        const created = unwrapGatewayResult(await window.astella.source.create({
          meta: createRequestMeta(), request: { content: prepared.markdown, title, origin: `文件 ${fileName}` },
        }));
        const room = useRoomStore.getState();
        room.setActiveSourceId(created.source.id);
        onClose();
        room.invoke("open-source");
        room.setReturnTarget({ label: "返回来源库", run: () => useRoomStore.getState().invoke("open-sources") });
      }
      setPendingImport(null);
    } catch (error) {
      setStatus(gatewayErrorMessage(error));
    }
  };

  const runImport = (kind: "note" | "source") => {
    if (!hasWorkspace) { setStatus("登录或加入空间后，才能把它收进 Astella。"); return; }
    const allowed = kind === "note" ? permissions?.note : permissions?.source;
    if (!allowed) { setStatus(kind === "note" ? "只有空间主人可以新建笔记。" : "只有空间所有者可以收录来源。"); return; }
    void prepareImport(kind);
  };

  const closeFileMenu = () => fileMenuRef.current?.removeAttribute("open");
  const openFolder = () => void run(async () => {
    const result = await writingAction({ action: "folder" });
    if (!result.canceled) { setEntries(result.entries ?? []); setStatus(`${result.entries?.length ?? 0} 篇 Markdown`); }
  });
  const newFile = () => {
    savedMarkdown.current = ""; editorRef.current?.setLocalFile?.(""); editorRef.current?.applySource(""); editorRef.current?.clearHistory?.();
    setPath(""); setRevision(undefined); setMarkdown(""); setDirty(false); setStatus("");
  };
  /** 稿纸层自己的键盘：⌘S 写回，Esc 先关弹层再走未保存确认。 */
  const onPaperKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy) void save(); return; }
    if (event.key !== "Escape" || window.document.querySelector("dialog[open]")) return;
    event.preventDefault(); event.stopPropagation();
    if (pendingImport) { setPendingImport(null); return; }
    guard(onClose);
  };

  const revealFile = async () => {
    if (!path) return;
    try {
      const result = unwrapGatewayResult(await window.astella.openedFile.reveal({ meta: createRequestMeta(), request: { version: 1, path } }));
      if (!result.revealed) setStatus("这个文件不是通过系统打开或文件选择器交进来的，不能在文件夹中显示它。");
    } catch (error) {
      setStatus(gatewayErrorMessage(error));
    }
  };

  /** 稿子先留在本地；伴星读到的是保存之后的这一份，不是弹窗里尚未落盘的草稿。 */
  const askCompanion = async () => {
    if (!hasWorkspace) { setStatus("登录之后才能和伴星聊这篇。"); return; }
    if (!onAskCompanion) return;
    if (!path) { setStatus("先保存成一个本地文件，伴星才能读到它。"); return; }
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    onAskCompanion({ path: current.current.path, name: fileName, markdown: editorRef.current?.getMarkdown() ?? current.current.markdown });
  };

  return <div
    className="local-paper-overlay"
    role="dialog"
    aria-modal="false"
    aria-label="本地稿纸"
    data-busy={busy || undefined}
    onKeyDownCapture={onPaperKeyDown}
  >
    <div className="local-paper-frame" {...writingPreferenceAttributes(writingPreferences)}>
      <div className="local-paper-page">
        <header className="local-paper-titlebar">
          {entries.length > 1 ? (
            <div className="local-paper-tabs" role="tablist" aria-label="这次打开的 Markdown">
              {entries.map(entry => (
                <button key={entry.path} type="button" role="tab" disabled={busy} aria-current={path === entry.path ? "page" : undefined}
                  onClick={() => guard(() => open(entry.path))}>{entry.name}</button>
              ))}
            </div>
          ) : (
            <div className="local-paper-tab">
              <span className="mark" aria-hidden="true" />
              <span className="name">{fileName}</span>
              <span className="path" title={path || undefined}>{path || "还没有保存到本地"}</span>
              {dirty ? <span className="dirty">未保存</span> : null}
            </div>
          )}
          <span className="grow" />
          <details className="local-paper-file-menu" ref={fileMenuRef}>
            <summary className="lp-btn lp-ghost" aria-label="文件操作">
              <FolderOpen size={15} aria-hidden="true" /><span>文件</span><ChevronDown size={12} aria-hidden="true" />
            </summary>
            <div className="lp-menu">
              <button type="button" disabled={busy} onClick={() => { closeFileMenu(); guard(() => open()); }}>打开文件…</button>
              <button type="button" disabled={busy} onClick={() => { closeFileMenu(); guard(openFolder); }}>打开文件夹…</button>
              <button type="button" disabled={busy} onClick={() => { closeFileMenu(); guard(newFile); }}>新建</button>
              <button type="button" disabled={busy || !path} onClick={() => { closeFileMenu(); void revealFile(); }}>在文件夹中显示</button>
            </div>
          </details>
          <button type="button" className="lp-btn lp-ghost" disabled={busy || !hasWorkspace || !permissions?.source}
            title={!hasWorkspace ? "登录或加入空间后可用" : permissions?.source === false ? "只有空间所有者可以收录来源" : "把这份稿子收进来源库，之后可以基于它写笔记"}
            onClick={() => runImport("source")}><Archive size={15} aria-hidden="true" /><span>收进来源库</span></button>
          <button type="button" className="lp-btn lp-primary" disabled={busy || !hasWorkspace || !permissions?.note}
            title={!hasWorkspace ? "登录或加入空间后可用" : permissions?.note === false ? "只有空间主人可以新建笔记" : "把当前正文直接建成一篇云笔记"}
            onClick={() => runImport("note")}>
            {busy ? <LoaderCircle className="lp-spin" size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
            <span>{busy ? "正在处理…" : "转成笔记"}</span>
          </button>
          <button type="button" className="lp-btn lp-mint" disabled={busy || !hasWorkspace || !onAskCompanion}
            title={!hasWorkspace ? "登录或加入空间后可用" : "保存后把这篇正文交给伴星读"}
            onClick={() => void askCompanion()}><Sparkles size={15} aria-hidden="true" /><span>让伴星读</span></button>
          <button type="button" className="lp-close" aria-label="关闭稿纸" title="关闭稿纸" disabled={busy} onClick={() => guard(onClose)}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="local-paper-toolstrip">
          <div className="local-paper-format">
            <NotebookEditorTools editorRef={editorRef} editable={!busy} canUpload={!busy} title={fileName.replace(/\.md$/, "") || "笔记"}
              onLink={link.open} fileInputRef={imageInput} onImages={files => images(Array.from(files ?? []))}
              legend="⌘/Ctrl+S 保存 · 图片可粘贴或拖入"
              writing={{ local: true, localPath: path || undefined, revision, onLocalSaved: (nextPath, nextMarkdown, nextRevision) => { savedMarkdown.current = nextMarkdown; setPath(nextPath); setMarkdown(nextMarkdown); setRevision(nextRevision); setDirty(false); } }} />
          </div>
          <button type="button" className="lp-save" data-dirty={dirty || undefined} disabled={busy} onClick={() => void save()}>
            {dirty ? "保存" : "已保存"}
          </button>
          <div className="lp-mode-switch" role="group" aria-label="正文视图">
            <button type="button" aria-current={mode === "live-preview" ? "true" : undefined} onClick={() => setMode("live-preview")}>排版</button>
            <button type="button" aria-current={mode === "source" ? "true" : undefined} onClick={() => setMode("source")}>源码</button>
          </div>
        </div>

        <div className="local-paper-scroll">
          <div className="local-paper-sheet">
            <NoteDocumentEditor ref={editorRef} fragment={document.getXmlFragment("content")} initialMarkdown="" localFilePath={path} mode={mode} disabled={busy}
              onReady={() => setEditorReady(true)}
              onImagesPaste={images} onChange={value => { setMarkdown(value); setDirty(value !== savedMarkdown.current); }} />
          </div>
        </div>

        <footer className="local-paper-foot" role="status">
          <span>{busy ? "正在读取、上传或写入…" : status || "正在编辑本地文件"}</span>
          <span className="hint">⌘S 写回</span>
        </footer>

        {savedPulse ? <div className="local-paper-stamp" role="status">✓ 已写回本地</div> : null}
        {pendingImport ? <div className="local-paper-popover" role="alertdialog" aria-label="带图收进 Astella">
          <div className="kick">还差几步</div>
          <h3>有 {pendingImport.prepared.issues.length} 处图片没带过来</h3>
          <ul>{pendingImport.prepared.issues.slice(0, 5).map((issue, index) => <li key={index}><code>{issue.src}</code>：{issue.message}</li>)}</ul>
          <div className="row">
            <button type="button" className="lp-btn lp-primary" disabled={busy} onClick={() => void commitImport(pendingImport)}>
              {pendingImport.kind === "note" ? "照样转成笔记" : "照样收进来源库"}
            </button>
            <button type="button" className="lp-btn lp-ghost" disabled={busy} onClick={() => setPendingImport(null)}>取消</button>
          </div>
        </div> : null}

        {link.dialog}
        {pending ? <div className="local-paper-confirm" role="alertdialog" aria-label="保存本地修改">
          <div className="card">
            <p>这篇本地笔记还有未保存的修改。</p>
            <div className="row">
              <button type="button" className="lp-btn lp-primary" disabled={busy} onClick={() => void save().then(saved => { if (!saved) return; const action = pending; setPending(null); action(); })}>保存</button>
              <button type="button" className="lp-btn lp-ghost" disabled={busy} onClick={() => { const action = pending; setPending(null); setDirty(false); action(); }}>放弃修改并继续</button>
              <button type="button" className="lp-btn lp-ghost" onClick={() => setPending(null)}>继续编辑</button>
            </div>
          </div>
        </div> : null}
      </div>
    </div>
  </div>
}
