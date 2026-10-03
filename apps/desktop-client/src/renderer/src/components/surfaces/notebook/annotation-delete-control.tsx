import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";

/**
 * 删批注的**就地两步确认**（用户裁决：不用会冻结整个应用的原生确认框）。
 *
 * ## 为什么不是一个 `window.confirm`
 *
 * 三条理由，最后一条是主要的：
 * 1. 它是全应用唯一的原生弹窗——仓里另有 `notebook-version-choice` 与
 *    `generation-setup` 两处自制对话框，母本语言已经是自制的；
 * 2. 原生框接管整个窗口，HUD 那间书房在它弹出的一瞬变成系统对话框；
 * 3. **它把「连带删了什么」藏在一行系统字里。** 这一删会同时带走这条批注和它
 *    生成的互动演示，而演示是另一次模型调用的产物——重做出来的是另一份。
 *    那句话必须留在纸上，让人读完再按。
 *
 * 两步之间不做任何后台动作：第一步只改本地状态，所以「先不删」永远零副作用。
 */
export type AnnotationDeleteView = "idle" | "confirming";

/**
 * 确认那句话。**两处文案必须同源**（附页长版、记号浮层短版）。
 *
 * 两份各写一遍的话，迟早会有一处漏掉「伴星的对话不受影响」——而那正是用户最想
 * 知道的一句。短版不是长版的缩写，是同一句话去掉了主语。
 */
function consequence(hasArtifact: boolean, compact: boolean): { question: string; note: string } {
  if (compact) {
    return {
      question: hasArtifact ? "连同那个互动演示一起删掉？" : "删掉这条批注？",
      note: "对话记录不受影响",
    };
  }
  return {
    question: hasArtifact
      ? "删掉这条批注？和它一起做的那个互动演示也会被删掉。"
      : "删掉这条批注？",
    note: "伴星的对话记录不受影响。",
  };
}

export function AnnotationDeleteControl(props: {
  readonly annotation: NoteAnnotationV1;
  /** 这一条有没有已经做好的互动演示——决定确认那句话里提不提它。 */
  readonly hasArtifact: boolean;
  readonly view: AnnotationDeleteView;
  /** 记号浮层里那一份：更小、没有外框、句子更短。 */
  readonly compact?: boolean;
  readonly deleting?: boolean;
  readonly error?: string | null;
  readonly onRequest: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { annotation, hasArtifact, view, compact = false, deleting = false } = props;
  const words = consequence(hasArtifact, compact);
  // Escape 随时退出两步——它在两个版本里都该是同一句「算了」的动作。
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (view !== "confirming") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      props.onCancel();
    };
    const node = rootRef.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [view]);

  if (view === "confirming") {
    return <div className="note-annotation-delete" ref={rootRef} data-compact={compact ? "true" : undefined} role="group" aria-label="确认删除这条批注">
      <p>{words.question}</p>
      <p className="note-annotation-delete__note">{words.note}</p>
      <div className="note-annotation-delete__buttons">
        <button type="button" className="button" disabled={deleting} onClick={props.onConfirm}>{deleting ? "正在删除…" : "确定删掉"}</button>
        <button type="button" className="text-action" disabled={deleting} onClick={props.onCancel}>先不删</button>
      </div>
      {props.error ? <p className="small" role="alert">批注还在：{props.error}</p> : null}
    </div>;
  }
  return <div className="note-annotation-delete" ref={rootRef} data-compact={compact ? "true" : undefined}>
    <button type="button" className="text-action" disabled={deleting} aria-label={`删掉这条批注：${annotation.anchor.excerpt.slice(0, 40)}`} onClick={props.onRequest}>
      <X size={13} aria-hidden="true" />{deleting ? "正在删除…" : compact ? "删掉这条" : "删掉这条批注"}
    </button>
    {props.error ? <p className="small" role="alert">批注还在：{props.error}</p> : null}
  </div>;
}

/**
 * 确认状态挂在**页面**上而不是各自组件里。
 *
 * 记号浮层与批注附页是同一个动作的两个入口：两处各存一份状态的话，会出现
 * 「附页里正问着要不要删，浮层里还是那枚平常的 ✕」。这个 hook 让两处读同一份。
 */
export function useAnnotationDeleteConfirm() {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ noteId: string; annotationId: string; message: string } | null>(null);
  return {
    confirmingId,
    /** 第一步只改本地状态——所以「先不删」永远是零副作用。 */
    request: (annotation: NoteAnnotationV1) => { setFailure(null); setConfirmingId(annotation.annotationId); },
    cancel: () => { setFailure(null); setConfirmingId(null); },
    /** 换一篇笔记时清掉：那时的确认对应的是另一篇纸上的东西。 */
    reset: () => { setFailure(null); setConfirmingId(null); },
    fail: (annotation: NoteAnnotationV1, message: string) => setFailure({
      noteId: annotation.noteId, annotationId: annotation.annotationId, message,
    }),
    errorFor: (annotation: NoteAnnotationV1 | null): string | null => annotation
      && failure?.noteId === annotation.noteId && failure.annotationId === annotation.annotationId ? failure.message : null,
    viewFor: (annotation: NoteAnnotationV1): AnnotationDeleteView => (confirmingId === annotation.annotationId ? "confirming" : "idle"),
  };
}
