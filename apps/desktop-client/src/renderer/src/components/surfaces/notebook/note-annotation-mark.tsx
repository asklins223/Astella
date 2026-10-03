import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import { plainCompanionBubbleText } from "../../companion/companion-markdown";

/** The short preview stays inside the visible reading paper, separate from selection text. */
export function NoteAnnotationMark(props: {
  readonly annotation: NoteAnnotationV1;
  readonly number?: number;
  readonly badge?: boolean;
  readonly open?: boolean;
  readonly children: ReactNode;
  readonly onOpen?: (annotation: NoteAnnotationV1) => void;
  /**
   * 浮层里那一格「删掉这条」。给它一个 `ReactNode` 而不是回调，是为了让**确认状态**
   * 留在页面那一份（见 `useAnnotationDeleteConfirm`）——记号与附页是同一个动作的
   * 两个入口，两边各存一份状态会出现「附页里正问着要不要删，浮层里还是平常那枚 ✕」。
   */
  readonly onDelete?: ReactNode;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  /** 指针是否在这枚记号**或**它的浮层上。浮层在 portal 里，两边要合成一个判断。 */
  const overPreview = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressPoint = useRef<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [shown, setShown] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number } | null>(null);
  const tooltipId = useId();
  const plain = plainCompanionBubbleText(props.annotation.explanation).replace(/\s+/gu, " ").trim();
  const characters = Array.from(plain);
  const text = characters.length > 90 ? `${characters.slice(0, 90).join("")}…` : plain;

  const cancelLeave = () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); leaveTimer.current = null; };
  const leave = () => {
    cancelLeave();
    leaveTimer.current = setTimeout(() => { if (!overPreview.current && !preview.current?.contains(document.activeElement)) setShown(false); }, 160);
  };
  useEffect(() => () => cancelLeave(), []);

  useLayoutEffect(() => { if (props.open) setShown(false); }, [props.open]);

  useLayoutEffect(() => {
    if (!shown || !marker.current || !preview.current) return;
    const scroll = marker.current.closest<HTMLElement>(".notebook-desk__scroll");
    const paper = scroll?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const leftEdge = Math.max(12, paper.left + 8), rightEdge = Math.min(window.innerWidth - 12, paper.right - 8);
    const topEdge = Math.max(12, paper.top + 8), bottomEdge = Math.min(window.innerHeight - 12, paper.bottom - 8);
    const rects = Array.from(marker.current.getClientRects()).filter(rect => rect.bottom > topEdge && rect.top < bottomEdge);
    const point = pointer;
    const anchor = rects.find(rect => point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom)
      ?? rects[0] ?? marker.current.getBoundingClientRect();
    const maxWidth = Math.max(0, rightEdge - leftEdge);
    preview.current.style.maxWidth = `${maxWidth}px`;
    const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - preview.current.offsetWidth));
    const below = anchor.bottom + 8;
    const top = Math.max(topEdge, Math.min(below + preview.current.offsetHeight <= bottomEdge ? below : anchor.top - preview.current.offsetHeight - 8, bottomEdge - preview.current.offsetHeight));
    setPosition({ left, top, maxWidth });
    const dismiss = () => setShown(false);
    scroll?.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => { scroll?.removeEventListener("scroll", dismiss); window.removeEventListener("resize", dismiss); };
  }, [shown, pointer]);

  const open = () => { cancelLeave(); setShown(false); props.onOpen?.(props.annotation); };
  return <>
    <span className={props.badge ? "note-annotation-badge" : "note-annotation-anchor"} ref={marker} role="button" tabIndex={0}
      aria-label={props.badge ? `批注 ${props.number} · ${props.annotation.sourceMessageId ? "伴星解释" : props.annotation.generationJobId ? "白话解释" : "自己的批注"}：${props.annotation.anchor.excerpt}` : `打开批注：${props.annotation.anchor.excerpt}`} aria-expanded={props.open ?? false}
      aria-describedby={shown && !props.open ? tooltipId : undefined}
      data-number={props.number}
      onPointerDown={event => { pressPoint.current = { x: event.clientX, y: event.clientY }; setShown(false); }}
      onMouseEnter={event => {
        cancelLeave();
        if (event.buttons || props.open || !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
        setPointer({ x: event.clientX, y: event.clientY }); setPosition(null); setShown(true);
      }}
      onMouseLeave={leave} onFocus={() => { cancelLeave(); if (!props.open) { setPointer(null); setPosition(null); setShown(true); } }} onBlur={leave}
      onClick={event => {
        const start = pressPoint.current;
        pressPoint.current = null;
        const selection = window.getSelection();
        const selectingHere = selection && !selection.isCollapsed && selection.rangeCount > 0
          && selection.getRangeAt(0).intersectsNode(event.currentTarget);
        if (selectingHere || start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
        event.preventDefault(); event.stopPropagation(); open();
      }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setShown(false); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); open(); }
      }}>{props.children}</span>
    {shown && !props.open ? createPortal(<div className="note-annotation-preview" role="tooltip" id={tooltipId} ref={preview}
      style={position ?? { visibility: "hidden" }}
      // 指针**移进浮层**时不能收起：那上面有「删掉这条」，收起它就永远按不到。
      // 记号自己的 mouseleave 也要看这个标记，两边合成一次「指针在记号或浮层上」。
      onMouseEnter={() => { cancelLeave(); overPreview.current = true; }}
      onMouseLeave={() => { overPreview.current = false; leave(); }}
      onFocus={cancelLeave} onBlur={leave}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); marker.current?.focus({ preventScroll: true }); setShown(false); } }}
    ><p>{text}</p><small>{props.badge ? `批注 ${props.number} · 点击角标展开` : "点击原句，展开完整批注"}</small>{props.onDelete ? <div className="note-annotation-preview__actions">{props.onDelete}</div> : null}</div>, document.body) : null}
  </>;
}
