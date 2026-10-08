import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, PencilLine, Sparkles, X } from "lucide-react";
import { useNotebookPaperMotion } from "./use-notebook-paper-motion";
import { useNotebookTouch } from "./use-notebook-touch";

/** A selection is a temporary paper slip, anchored to the visible end of the selection. */
export function NotebookSelectionActions(props: {
  readonly range: Range;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly hasAnchor: boolean;
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly companionPending?: boolean;
  readonly onExplain: () => void;
  readonly onWrite: () => void;
  readonly onAskCompanion: () => void;
  readonly onEditWithCompanion?: () => void;
  readonly onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useNotebookTouch(ref);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number } | null>(null);
  const play = useNotebookPaperMotion();
  const act = (action: () => void) => {
    // The slip may disappear. Keep the keyboard path on its reading paper.
    props.scrollRef.current?.focus({ preventScroll: true });
    action();
  };
  useLayoutEffect(() => {
    const update = () => {
      const paper = props.scrollRef.current, slip = ref.current;
      if (!paper || !slip) return;
      const viewport = paper.getBoundingClientRect();
      const rects = Array.from(props.range.getClientRects());
      const visible = rects.filter(rect => rect.bottom > viewport.top && rect.top < viewport.bottom);
      if (rects.length && !visible.length) { setPosition(null); return; }
      const anchor = visible.at(-1) ?? props.range.getBoundingClientRect();
      const leftEdge = Math.max(12, viewport.left + 8), rightEdge = Math.min(window.innerWidth - 12, viewport.right - 8);
      const topEdge = Math.max(12, viewport.top + 8), bottomEdge = Math.min(window.innerHeight - 12, viewport.bottom - 8);
      const maxWidth = Math.max(0, rightEdge - leftEdge);
      slip.style.maxWidth = `${maxWidth}px`;
      const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - slip.offsetWidth));
      const below = anchor.bottom + 8;
      const top = Math.max(topEdge, Math.min(below + slip.offsetHeight > bottomEdge ? anchor.top - slip.offsetHeight - 8 : below, bottomEdge - slip.offsetHeight));
      setPosition({ left, top, maxWidth });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (props.scrollRef.current) observer?.observe(props.scrollRef.current);
    if (ref.current) observer?.observe(ref.current);
    props.scrollRef.current?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); props.scrollRef.current?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [props.range, props.scrollRef]);
  useLayoutEffect(() => { if (position) play(ref.current, "fold"); }, [Boolean(position), play]);
  return createPortal(<div className="notebook-selection-actions" data-note-selection-action="true" ref={ref} role="group" aria-label="已选原文"
    style={position ?? { visibility: "hidden" }} onPointerDown={event => event.preventDefault()}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); act(props.onDismiss); } }}>
    <button type="button" className="text-action" disabled={!props.hasAnchor || props.dirty} onClick={() => act(props.onWrite)}><PencilLine size={15} aria-hidden="true" />写批注</button>
    <button type="button" className="text-action notebook-selection-actions__companion" disabled={props.busy} onClick={() => act(props.onAskCompanion)}><MessageCircle size={16} aria-hidden="true" />{props.companionPending ? "查看伴星进度" : "发给伴星"}</button>
    {props.onEditWithCompanion ? <button type="button" className="text-action" disabled={props.busy} onClick={() => act(props.onEditWithCompanion!)}><PencilLine size={15} aria-hidden="true" />让伴星改这段</button> : null}
    <button type="button" className="text-action" disabled={!props.hasAnchor || props.dirty || props.busy} title={props.dirty ? "先保存版本，再贴回原文" : "生成可回看的原句解读，贴在这里"} onClick={() => act(props.onExplain)}><Sparkles size={15} aria-hidden="true" />{props.busy ? "正在准备…" : props.companionPending ? "查看解释进度" : "原句解读"}</button>
    <button type="button" className="text-action" aria-label="收起选句操作" onClick={() => act(props.onDismiss)}><X size={15} aria-hidden="true" /></button>
    {!props.hasAnchor ? <span className="notebook-selection-actions__reason">选区位置未能核对，或超过 2,000 字，暂时无法贴回批注和解读；仍可发给伴星。</span> : props.dirty ? <span className="notebook-selection-actions__reason">先保存当前版本，才能将批注贴回原文。</span> : null}
  </div>, document.body);
}
