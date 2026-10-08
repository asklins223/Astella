import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import { NoteDocumentEditor } from "./note-document-editor";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { NotebookEditorTools } from "./notebook-editor-tools";
import { useNotebookLinkEditor } from "./notebook-link-editor";
import { noteImageMarkdown } from "@astella/shared/note-markdown";
import { writingAction, collectWritingImages } from "./note-writing-assets";
import { useWritingPreferences, writingPreferenceAttributes } from "./note-writing-preferences";
import type { NoteBodyMode } from "./note-document-mode";
export function NotebookLocalFiles({ onClose }: { onClose: () => void }) {
  const writingPreferences = useWritingPreferences();
  const [document] = useState(() => new Y.Doc()), editorRef = useRef<NoteMarkdownEditorHandle | null>(null), dialogRef = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(""), [revision, setRevision] = useState<number>(), [markdown, setMarkdown] = useState(""), [dirty, setDirty] = useState(false), [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [mode, setMode] = useState<NoteBodyMode>("live-preview");
  const [entries, setEntries] = useState<{ path: string; name: string }[]>([]), [pending, setPending] = useState<(() => void) | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null), imageUrls = useRef<string[]>([]);
  const link = useNotebookLinkEditor(editorRef, "local-note", !busy);
  const images = (files: readonly File[]) => { const valid = files.filter(file => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) && file.size <= 12_000_000);
    if (valid.length !== files.length) setStatus("支持 PNG、JPEG、GIF、WebP，每张图片不超过 12 MB");
    const markdown = valid.map(file => { const url = URL.createObjectURL(file); imageUrls.current.push(url); return noteImageMarkdown({ src: url, alt: file.name }); }).join(" ");
    if (markdown) editorRef.current?.insertImageMarkdown?.(markdown);
  };
  useEffect(() => () => { imageUrls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  const current = useRef({ path, revision, markdown }); current.current = { path, revision, markdown };
  const savedMarkdown = useRef("");
  useEffect(() => { dialogRef.current?.showModal(); const active = window.document.activeElement as HTMLElement | null; return () => { queueMicrotask(() => { if (!dialogRef.current?.isConnected) document.destroy(); }); active?.focus(); }; }, [document]);
  const guard = (action: () => void) => { if (dirty) setPending(() => action); else action(); };
  const run = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); setStatus(""); try { await operation(); } catch (error) { setStatus(error instanceof Error ? error.message : "文件操作失败"); } finally { setBusy(false); } };
  const open = (file?: string) => void run(async () => { const result = await writingAction({ action: file ? "read" : "open", path: file }); if (result.canceled || result.markdown === undefined || !result.path) return;
    savedMarkdown.current = result.markdown; editorRef.current?.setLocalFile?.(result.path); editorRef.current?.applySource(result.markdown); editorRef.current?.clearHistory?.(); setPath(result.path); setRevision(result.revision); setMarkdown(result.markdown); setDirty(false); editorRef.current?.focus();
  });
  const save = async () => { let saved = false; await run(async () => { const value = editorRef.current?.getMarkdown() ?? current.current.markdown; const images = await collectWritingImages(value, current.current.path || undefined);
    const result = await writingAction({ action: "save", title: current.current.path.split(/[\\/]/).pop()?.replace(/\.md$/, "") || "笔记", path: current.current.path || undefined, revision: current.current.revision, markdown: value, images });
    if (result.canceled || !result.path) return; savedMarkdown.current = result.markdown ?? value; editorRef.current?.setLocalFile?.(result.path); if (result.markdown !== undefined) editorRef.current?.applySource(result.markdown);
    setPath(result.path); setRevision(result.revision); setMarkdown(result.markdown ?? value); setDirty(false); setStatus("已保存，图片位于旁边的资源目录"); saved = true;
  }); return saved; };
  return createPortal(<dialog ref={dialogRef} className="notebook-local-dialog hud-surface" aria-label="本地 Markdown 书桌" onCancel={event => { event.preventDefault(); guard(onClose); }}>
    <section className="notebook-workspace" {...writingPreferenceAttributes(writingPreferences)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy) void save(); } }}>
      <header><strong>本地 Markdown</strong><span>{path || "未命名笔记"}{dirty ? " · 未保存" : ""}</span><button type="button" disabled={busy} onClick={() => guard(onClose)}>关闭</button></header>
      <div className="local-note-tools"><button type="button" disabled={busy} onClick={() => guard(() => open())}>打开文件</button>
        <button type="button" disabled={busy} onClick={() => guard(() => void run(async () => { const result = await writingAction({ action: "folder" }); if (!result.canceled) { setEntries(result.entries ?? []); setStatus(`${result.entries?.length ?? 0} 篇 Markdown`); } }))}>打开文件夹</button>
        <button type="button" disabled={busy} onClick={() => guard(() => { savedMarkdown.current = ""; editorRef.current?.setLocalFile?.(""); editorRef.current?.applySource(""); editorRef.current?.clearHistory?.(); setPath(""); setRevision(undefined); setMarkdown(""); setDirty(false); })}>新建</button>
        <button type="button" disabled={busy} onClick={() => void save()}>保存</button><button type="button" onClick={() => setMode(mode === "source" ? "live-preview" : "source")}>{mode === "source" ? "排版正文" : "Markdown 源码"}</button>
      </div>
      <div className="notebook-volume__tools local-note-format-tools"><NotebookEditorTools editorRef={editorRef} editable={!busy} canUpload={!busy} title={path.split(/[\\/]/).pop()?.replace(/\.md$/, "") || "笔记"} onLink={link.open} fileInputRef={imageInput} onImages={files => images(Array.from(files ?? []))} legend="⌘/Ctrl+S 保存 · 图片可粘贴或拖入" writing={{ local: true, localPath: path || undefined, revision, onLocalSaved: (nextPath, nextMarkdown, nextRevision) => { savedMarkdown.current = nextMarkdown; setPath(nextPath); setMarkdown(nextMarkdown); setRevision(nextRevision); setDirty(false); } }} /></div>
      <div className="local-note-body">{entries.length ? <nav aria-label="文件夹中的 Markdown">{entries.map(entry => <button type="button" disabled={busy} key={entry.path} aria-current={path === entry.path ? "page" : undefined} onClick={() => guard(() => open(entry.path))}>{entry.name}</button>)}</nav> : null}
        <div className="note-draft"><NoteDocumentEditor ref={editorRef} fragment={document.getXmlFragment("content")} initialMarkdown="" localFilePath={path} mode={mode} disabled={busy}
          onImagesPaste={images} onChange={value => { setMarkdown(value); setDirty(value !== savedMarkdown.current); }} /></div></div>
      <footer role="status">{busy ? "正在读取或写入…" : status || "本地文件独立编辑 · ⌘/Ctrl+S 保存"}</footer>
      {link.dialog}
      {pending ? <div className="local-note-confirm" role="alertdialog" aria-label="保存本地修改"><p>这篇本地笔记还有未保存的修改。</p>
        <button type="button" disabled={busy} onClick={() => void save().then(saved => { if (!saved) return; const action = pending; setPending(null); action(); })}>保存</button>
        <button type="button" disabled={busy} onClick={() => { const action = pending; setPending(null); setDirty(false); action(); }}>放弃修改并继续</button><button type="button" onClick={() => setPending(null)}>继续编辑</button></div> : null}
    </section>
  </dialog>, window.document.body);
}
