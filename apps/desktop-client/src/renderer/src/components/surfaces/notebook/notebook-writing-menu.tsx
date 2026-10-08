import { useState, type RefObject } from "react";
import { MoreHorizontal, Minus, Plus } from "lucide-react";
import { WritingPopover } from "./notebook-format-controls";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { collectWritingImages, writingAction } from "./note-writing-assets";
import { updateWritingPreferences, useWritingPreferences } from "./note-writing-preferences";
import { copyText } from "../../../app/clipboard";
import { NotebookLocalFiles } from "./notebook-local-files";
export function NotebookWritingMenu({ editorRef, editable, title = "笔记", localPath, revision, onLocalSaved, local = false }: {
  editorRef: RefObject<NoteMarkdownEditorHandle | null>; editable: boolean; title?: string; localPath?: string; local?: boolean;
  onLocalSaved?: (path: string, markdown: string, revision: number) => void;
  revision?: number;
}) {
  const prefs = useWritingPreferences(), [files, setFiles] = useState(false), [status, setStatus] = useState(""), [busy, setBusy] = useState(false);
  const setPrefs = updateWritingPreferences;
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setStatus(""); try { await action(); } catch (error) { setStatus(error instanceof Error ? error.message : "操作失败，请重试"); } finally { setBusy(false); } };
  const exportNote = (format: "md" | "html" | "pdf" | "docx") => run(async () => {
    const markdown = editorRef.current?.getMarkdown(); if (markdown == null) return;
    const images = await collectWritingImages(markdown, localPath); const result = await writingAction({ action: "export", format, title, markdown, images });
    if (!result.canceled) setStatus(`已导出：${result.path}`);
  });
  const setting = (label: string, choices: readonly (readonly [string, string])[], key: "theme" | "font") => <div className="writing-preference-row"><span>{label}</span><div className="writing-preference-choices">{choices.map(([value, name]) => <button type="button" key={value} aria-label={`${label} ${name}`} aria-pressed={prefs[key] === value} onClick={() => setPrefs({ ...prefs, [key]: value })}>{name}</button>)}</div></div>;
  const stepper = (label: string, key: "size" | "leading" | "width", min: number, max: number, step: number, suffix: string) => <div className="writing-preference-row"><span>{label}</span><div className="writing-preference-stepper"><button type="button" aria-label={`减小${label}`} disabled={prefs[key] <= min} onClick={() => setPrefs({ ...prefs, [key]: Math.max(min, Math.round((prefs[key] - step) * 10) / 10) })}><Minus size={13} /></button><output aria-label={label}>{prefs[key]}{suffix}</output><button type="button" aria-label={`增大${label}`} disabled={prefs[key] >= max} onClick={() => setPrefs({ ...prefs, [key]: Math.min(max, Math.round((prefs[key] + step) * 10) / 10) })}><Plus size={13} /></button></div></div>;
  return <>
    <div className="notebook-writing-menu">
      <WritingPopover label="更多写作工具" trigger={<MoreHorizontal size={17} />} className="notebook-writing-menu__panel" onClose={() => editorRef.current?.focus()}>{close => <>
        <button type="button" onClick={() => { editorRef.current?.openSearch?.(); close(); }}>查找与替换 <kbd>⌘/Ctrl F</kbd></button>
        <fieldset disabled={!editable}><legend>插入</legend><div className="writing-menu-grid">
          {([["math", "公式块"], ["footnote", "脚注"], ["toc", "正文目录"], ["yaml", "YAML 元数据"], ["alert", "提示块"]] as const).map(([kind, label]) => <button key={kind} type="button" onClick={() => { editorRef.current?.insertExtension?.(kind); close(); }}>{label}</button>)}
          {[["highlight", "高亮"], ["subscript", "下标"], ["superscript", "上标"]].map(([kind, label]) => <button key={kind} type="button" onClick={() => { editorRef.current?.toggleExtension?.(kind as "highlight"); close(); editorRef.current?.focus(); }}>{label}</button>)}
        </div></fieldset>
        <fieldset><legend>写作体验</legend>
          <button type="button" className="writing-preference-toggle" role="switch" aria-checked={prefs.focus} onClick={() => setPrefs({ ...prefs, focus: !prefs.focus })}><span>专注当前段落</span><span className="writing-switch" /></button>
          <button type="button" className="writing-preference-toggle" role="switch" aria-checked={prefs.typewriter} onClick={() => setPrefs({ ...prefs, typewriter: !prefs.typewriter })}><span>打字机模式</span><span className="writing-switch" /></button>
          {setting("纸面", [["paper", "暖纸"], ["white", "白纸"], ["night", "夜读"]], "theme")}
          {setting("字体", [["serif", "衬线"], ["sans", "无衬线"], ["mono", "等宽"]], "font")}
          {stepper("阅读字号", "size", 14, 28, 1, " px")}
          {stepper("阅读行距", "leading", 1.4, 2.4, 0.1, "")}
          {stepper("纸面宽度", "width", 520, 1200, 40, " px")}
        </fieldset>
        <fieldset disabled={busy}><legend>复制与导出</legend><div className="writing-menu-grid">
          <button type="button" onClick={() => void run(async () => { const text = editorRef.current?.getSelectedMarkdown?.() ?? editorRef.current?.getMarkdown() ?? ""; if (!await copyText(text)) throw new Error("复制失败"); setStatus("已复制 Markdown"); })}>复制 Markdown</button>
          <button type="button" onClick={() => void run(async () => { const markdown = editorRef.current?.getSelectedMarkdown?.() ?? editorRef.current?.getMarkdown() ?? "", images = await collectWritingImages(markdown, localPath); await writingAction({ action: "clipboard", markdown, images }); setStatus("已复制富文本与 HTML，图片已内嵌"); })}>复制富文本 / HTML</button>
          {["md", "html", "pdf", "docx"].map(format => <button key={format} type="button" onClick={() => void exportNote(format as "md")}>导出 {format.toUpperCase()}</button>)}</div>
          {local ? null : <button type="button" onClick={() => { setFiles(true); close(); }}>打开本地 Markdown / 文件夹</button>}
          {local ? <button type="button" disabled={!localPath || !editable} onClick={() => void run(async () => { const markdown = editorRef.current?.getMarkdown() ?? "", images = await collectWritingImages(markdown, localPath); const result = await writingAction({ action: "assets", path: localPath, revision, markdown, images }); if (result.canceled || !result.path || result.markdown === undefined || result.revision === undefined) return; editorRef.current?.applySource(result.markdown); onLocalSaved?.(result.path, result.markdown, result.revision); setStatus("图片已收集到所选目录，笔记使用相对路径"); })}>整理全部图片资源…</button> : null}
        </fieldset>
        <p role="status" className="writing-menu-status">{busy ? "正在处理笔记和图片…" : status || "输入 :smile 可补全 Emoji · 导出包含图片资源"}</p>
      </>}</WritingPopover>
    </div>
    {files ? <NotebookLocalFiles onClose={() => setFiles(false)} /> : null}
  </>;
}
