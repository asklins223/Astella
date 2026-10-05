import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";

export function notebookLinkHref(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) return url.href;
    if (url.protocol === "mailto:" && /^[^\s@]+@[^\s@]+$/.test(url.pathname)) return url.href;
  } catch { /* Keep the draft in the form until the address is valid. */ }
  return null;
}

function NotebookLinkEditor(props: { onApply: (href: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const href = notebookLinkHref(value);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    dialog.querySelector("input")?.focus();
    return () => { if (dialog.open && typeof dialog.close === "function") dialog.close(); };
  }, []);
  const close = (action: () => void) => { ref.current?.close?.(); action(); };
  return <dialog ref={ref} className="notebook-version-choice notebook-link-editor" aria-labelledby="notebook-link-title"
    onCancel={event => { event.preventDefault(); close(props.onCancel); }}>
    <form onSubmit={event => { event.preventDefault(); if (href) close(() => props.onApply(href)); }}>
      <h3 id="notebook-link-title">插入链接</h3>
      <label>链接地址<input value={value} type="text" inputMode="url" placeholder="https://example.com" maxLength={2000}
        onChange={event => setValue(event.target.value)} aria-invalid={value.length > 0 && !href} aria-describedby="notebook-link-help" /></label>
      <p id="notebook-link-help">{value.length > 0 && !href ? "请输入完整的 http、https 网页地址或 mailto: 邮箱。" : "所选文字会成为链接；没有选中文字时，直接插入地址。"}</p>
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
    dialog: open ? <NotebookLinkEditor onCancel={close} onApply={href => {
      editorRef.current?.toggleLink(href);
      close();
    }} /> : null,
  };
}
