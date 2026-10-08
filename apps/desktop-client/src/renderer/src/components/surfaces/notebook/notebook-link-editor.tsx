import { noteLinkHref, noteLinkTarget } from "@astella/shared/note-markdown";
import { useNoteLinkLibrary } from "./note-library-links";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { BookOpen, Globe, Link2 } from "lucide-react";
import { HudSegmented } from "../../hud/HudControls";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { useNotebookTouch } from "./use-notebook-touch";

const linkKinds = [["web", "网页链接", <Globe aria-hidden="true" />], ["note", "库内笔记", <BookOpen aria-hidden="true" />]] as const;

export function notebookLinkHref(value: string): string | null {
  if (noteLinkTarget(value.trim())?.kind === "id") return value.trim();
  try {
    const url = new URL(value.trim());
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) return url.href;
    if (url.protocol === "mailto:" && /^[^\s@]+@[^\s@]+$/.test(url.pathname)) return url.href;
  } catch { /* Keep the draft in the form until the address is valid. */ }
  return null;
}

function NotebookLinkEditor(props: { currentNoteId: string | null; onApply: (href: string, label?: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<"web" | "note">("web");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const library = useNoteLinkLibrary(kind === "note");
  const notes = library.notes.filter(note => note.id !== props.currentNoteId && note.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = library.notes.find(note => note.id === selectedId);

  const ref = useRef<HTMLDialogElement>(null);
  useNotebookTouch(ref);
  const href = kind === "note" ? selected ? noteLinkHref(selected.id) : null : notebookLinkHref(value);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    dialog.querySelector("input")?.focus();
    return () => { if (dialog.open && typeof dialog.close === "function") dialog.close(); };
  }, []);
  const close = (action: () => void) => { ref.current?.close?.(); action(); };
  return <dialog ref={ref} className="notebook-dialog notebook-link-editor" aria-labelledby="notebook-link-title"
    onCancel={event => { event.preventDefault(); close(props.onCancel); }}>
    <form onSubmit={event => { event.preventDefault(); if (href) close(() => props.onApply(href, kind === "note" ? selected?.title : undefined)); }}>
      <header className="notebook-link-heading"><span aria-hidden="true"><Link2 /></span><h3 id="notebook-link-title">插入链接</h3></header>
      <HudSegmented label="链接类型" value={kind} options={linkKinds} onChange={setKind} />
      <div className="notebook-link-body">
      {kind === "note" ? <>
        <label className="notebook-link-field">搜索笔记<input value={query} placeholder="输入笔记标题" onChange={event => setQuery(event.target.value)} /></label>
        {library.loading ? <p role="status">正在读取笔记库…</p> : library.failure ? <p role="status">{library.failure}<button type="button" className="text-action" onClick={library.retry}>重试</button></p> :
          <div className="notebook-link-notes" role="group" aria-label="选择关联笔记">
            {notes.map(note => <label key={note.id}><input type="radio" name="linked-note" checked={selectedId === note.id} onChange={() => setSelectedId(note.id)} aria-describedby="notebook-link-help" /><BookOpen aria-hidden="true" /><span>{note.title}</span></label>)}
            {!notes.length ? <p>{query ? "没有找到这个标题的笔记。" : "库里暂时没有其他可关联的笔记。"}</p> : null}
          </div>}
        <p id="notebook-link-help">{selected ? `将关联「${selected.title}」。笔记改名后，链接仍能打开。` : "选择库里的一篇笔记；所选文字会成为链接。"}</p>
      </> : <>
      <label className="notebook-link-field">链接地址<input value={value} type="text" inputMode="url" placeholder="https://example.com" maxLength={2000}
        onChange={event => setValue(event.target.value)} aria-invalid={value.length > 0 && !href} aria-describedby="notebook-link-help" /></label>
      <p id="notebook-link-help">{value.length > 0 && !href ? "请输入完整的 http、https 网页地址或 mailto: 邮箱。" : "所选文字会成为链接；没有选中文字时，直接插入地址。"}</p>
      </>}
      </div>
      <div className="actions"><button type="button" className="button" onClick={() => close(props.onCancel)}>取消</button>
        <button type="submit" className="button primary" disabled={!href}>插入链接</button></div>
    </form>
  </dialog>;
}

/** Opening a native modal leaves the live editor selection intact. */
export function useNotebookLinkEditor(editorRef: RefObject<NoteMarkdownEditorHandle | null>, scope: string | null, editable: boolean) {
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => { setOpen(false); }, [scope, editable]);
  useLayoutEffect(() => {
    if (!open && wasOpen.current) editorRef.current?.focus();
    wasOpen.current = open;
  }, [open, editorRef]);
  const close = () => { setOpen(false); };
  return {
    open: () => { if (editable && editorRef.current) setOpen(true); },
    dialog: open ? <NotebookLinkEditor currentNoteId={scope} onCancel={close} onApply={(href, label) => {
      editorRef.current?.toggleLink(href, label);
      close();
    }} /> : null,
  };
}
