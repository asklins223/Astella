import { useEffect, type RefObject } from "react";
import { ArrowLeft, BookOpen, ChevronDown, ChevronUp, Minimize2 } from "lucide-react";
import { useRoomStore } from "../../../app/room-store";
import type { NoteBodyMode } from "./note-document-mode";

/** The return path stays reachable even while a linked note is loading or cannot be read. */
export function NotebookFullscreenRibbon(props: {
  readonly mode?: NoteBodyMode;
  readonly toolsOpen?: boolean;
  readonly toolTriggerRef?: RefObject<HTMLButtonElement | null>;
  readonly onToggleTools?: () => void;
  readonly onExit: () => void;
}) {
  const returnTarget = useRoomStore(state => state.returnTarget);
  useEffect(() => {
    if (props.onToggleTools) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open], [aria-modal='true'], .companion-hud:not([data-mode='closed'])")) return;
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f" && !event.altKey)) {
        event.preventDefault(); props.onExit();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [props.onToggleTools, props.onExit]);
  return <div className="notebook-focus-ribbon">
    {returnTarget ? <button type="button" className="text-action notebook-focus-ribbon__back" aria-label={returnTarget.label} title={returnTarget.label}
      onMouseDown={event => event.preventDefault()} onClick={returnTarget.run}><ArrowLeft size={17} aria-hidden="true" /></button> : null}
    {props.onToggleTools ? <button type="button" className="text-action notebook-focus-ribbon__tools" ref={props.toolTriggerRef}
      aria-label={props.toolsOpen ? "收起笔记工具" : "展开笔记工具"} aria-expanded={props.toolsOpen} aria-controls="notebook-tool-page"
      onMouseDown={event => event.preventDefault()} onClick={props.onToggleTools}>
      <BookOpen size={17} aria-hidden="true" /><span>笔记工具</span><small>{props.mode === "preview" ? "阅读" : props.mode === "source" ? "源码" : "编辑"}</small>
      {props.toolsOpen ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    </button> : null}
    <button type="button" className="text-action notebook-focus-ribbon__exit" aria-label="退出全屏笔记" title="退出全屏 · ⌘/Ctrl+Shift+F 或 Esc"
      onMouseDown={event => event.preventDefault()} onClick={props.onExit}><Minimize2 size={17} aria-hidden="true" /></button>
  </div>;
}
