import type { NoteLearningTask } from "./use-notebook-learning-entry";
import { useLayoutEffect, useRef } from "react";
import { useNotebookPaperMotion } from "./use-notebook-paper-motion";

export function NotebookVersionChoice(props: {
  readonly kind: NoteLearningTask;
  readonly regenerating?: boolean;
  readonly version: number;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly hasChanges: boolean;
  readonly existing: boolean;
  readonly onSaved: () => void;
  readonly onSave: () => void;
  readonly onDismiss: () => void;
}) {
  const label = { overview: "速看", recall: "回想", expansion: "往外学", artifact: "互动演示" }[props.kind];
  const ref = useRef<HTMLDialogElement>(null), play = useNotebookPaperMotion();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    play(dialog, "fold");
    return () => { if (dialog.open && typeof dialog.close === "function") dialog.close(); };
  }, [play]);
  return <dialog ref={ref} className="notebook-dialog" aria-labelledby="notebook-learning-confirm-title" aria-modal="true"
    onCancel={event => { event.preventDefault(); if (!props.saving) props.onDismiss(); }}>
    <h3 id="notebook-learning-confirm-title">{props.hasChanges ? "这次从哪一版开始？" : `为这篇准备${label}？`}</h3>
    <p>{props.kind === "overview" ? "整理整篇的重点，每一处都能回到原文核对。"
      : props.kind === "recall" ? "从这篇原文中准备一个问题，先自己想，再按需翻开线索和对照。"
      : props.kind === "artifact" ? "根据原文单独制作新的互动演示，之前的演示仍留在学习记录里。"
      : "从这篇原文出发整理相关笔记草稿，由你挑选、编辑并确认收下。"}</p>
    <p>{props.hasChanges ? `正文还有未存成版本的改动。选择使用 v${props.version}，或先保存当前改动。`
      : `使用已存版本 v${props.version}。${props.kind === "recall" ? "确认后才会准备问题。" : "确认后才会创建 AI 生成任务；离开页面不会取消。"}`}</p>
    <div className="actions">
      <button type="button" className={props.hasChanges ? "button" : "button primary"} disabled={props.saving} onClick={props.onSaved}>
        {props.hasChanges ? props.regenerating ? `用 v${props.version} 重新生成` : props.existing ? `查看 v${props.version} 已有内容` : `用 v${props.version} 开始${label}` : props.kind === "recall" ? "确认准备问题" : "确认生成"}</button>
      {props.hasChanges ? <button type="button" className="button primary" disabled={!props.canSave || props.saving} onClick={props.onSave}>{props.saving ? "正在保存…" : "保存当前改动并开始"}</button> : null}
      <button type="button" className="text-action" disabled={props.saving} onClick={props.onDismiss}>先继续读</button>
    </div>
    {props.hasChanges && !props.canSave ? <p className="small">当前身份不能保存新版本，可以使用已存版本开始。</p> : null}
    {props.error ? <p className="small" role="alert">{props.error}</p> : null}
  </dialog>;
}
