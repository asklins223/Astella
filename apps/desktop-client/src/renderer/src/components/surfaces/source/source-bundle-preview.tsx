import { ArrowRight, FileArchive, FolderOpen, Image, FileText } from "lucide-react";
import type { MarkdownBundleKind, MarkdownBundlePreviewV1 } from "@astella/shared/desktop-ipc-contracts";
import { formatCaptureSize } from "../../../app/source-intake";

export function SourceBundlePreview({ preview, reading, onPick, onCommit, onClear }: {
  readonly preview: MarkdownBundlePreviewV1 | null;
  readonly reading: boolean;
  readonly onPick: (kind: MarkdownBundleKind) => void;
  readonly onCommit: () => void;
  readonly onClear: () => void;
}) {
  const name = preview?.bundlePath?.split(/[\\/]/).filter(Boolean).at(-1);
  return <section className="capture-bundle" aria-label="Markdown 与图片导入" aria-busy={reading}>
    <p>把 Markdown 正文和随文图片一起收进来源库。保留原来的文件夹结构即可。</p>
    <div className="capture-bundle__pickers">
      <button type="button" aria-label="选文件夹" data-bundle-pick disabled={reading} onClick={() => onPick("folder")}>
        <FolderOpen size={24} aria-hidden="true" /><span>选文件夹<small>包含 .md 和图片</small></span>
      </button>
      <button type="button" aria-label="选 zip" data-bundle-pick disabled={reading} onClick={() => onPick("zip")}>
        <FileArchive size={24} aria-hidden="true" /><span>选 zip<small>同样的文件打成包</small></span>
      </button>
    </div>
    {reading ? <p role="status">正在检查正文与图片…</p> : preview ? <>
      <div className="capture-bundle__receipt" role="status">
        <b className="capture-bundle__name">{name || "所选材料"}</b>
        <dl>
          <div><dt><FileText size={15} aria-hidden="true" />正文</dt><dd>{preview.files} 篇</dd></div>
          <div><dt><Image size={15} aria-hidden="true" />随文图片</dt><dd>{preview.localizable} 张<small>{formatCaptureSize(preview.imageBytes)}</small></dd></div>
        </dl>
        {preview.files === 0 ? <p>没有找到可导入的 Markdown 正文，请选包含 .md 文件的材料。</p> : <p>收下后进入来源库，可继续整理成笔记。</p>}
        {preview.overflow > 0 ? <p className="capture-bundle__warning">另有 {preview.overflow} 篇超出单次上限，这次不会导入。</p> : null}
      </div>
      {preview.issues.length > 0 || preview.issueOverflow > 0 ? <details className="capture-bundle__issues" open>
        <summary>有 {preview.issues.length + preview.issueOverflow} 处需要留意</summary>
        <ul>{preview.issues.map((item, index) => <li key={`${index}-${item.src}`}><b>{item.src}</b><span>{item.message}</span></li>)}</ul>
        {preview.issueOverflow > 0 ? <p>另外 {preview.issueOverflow} 处未在这里展开。</p> : null}
        {preview.files > 0 ? <p>仍可收下正文；缺失的图片需要之后补齐。</p> : null}
      </details> : null}
      <div className="capture-form__actions">
        <button type="button" className="button primary" disabled={reading || preview.files === 0} onClick={onCommit}><ArrowRight size={16} aria-hidden="true" />收下这 {preview.files} 篇</button>
        <button type="button" className="text-action" disabled={reading} onClick={onClear}>先不收</button>
      </div>
    </> : <p className="capture-bundle__hint">先预览，确认收下时才上传图片。</p>}
  </section>;
}
