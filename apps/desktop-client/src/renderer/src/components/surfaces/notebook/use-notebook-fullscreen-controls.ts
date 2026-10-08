import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNotebookFullscreen } from "./notebook-fullscreen-state";

/** Keep the same document nodes and pin the visible paragraph through the layout change. */
export function useNotebookFullscreenControls(noteId: string, scrollRef: RefObject<HTMLDivElement | null>, closeAttachments: () => void) {
  const { fullscreen, setFullscreen } = useNotebookFullscreen();
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolTriggerRef = useRef<HTMLButtonElement | null>(null);
  const enterRef = useRef<HTMLButtonElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<{ node: HTMLElement; offset: number } | null>(null);
  const latest = useRef({ fullscreen, toolsOpen, closeAttachments, setFullscreen });
  latest.current = { fullscreen, toolsOpen, closeAttachments, setFullscreen };

  const toggleFullscreen = useCallback(() => {
    const current = latest.current;
    const scroll = scrollRef.current;
    if (scroll) {
      const top = scroll.getBoundingClientRect().top;
      const nodes = Array.from(scroll.querySelectorAll<HTMLElement>("[data-block-ordinal], .ProseMirror > *, .cm-line"));
      const node = nodes.find(item => item.getClientRects().length > 0 && item.getBoundingClientRect().bottom > top);
      anchor.current = node ? { node, offset: node.getBoundingClientRect().top - top } : null;
    }
    current.closeAttachments();
    setToolsOpen(false);
    current.setFullscreen(!current.fullscreen);
  }, [scrollRef]);

  const closeTools = useCallback(() => {
    if (chromeRef.current?.contains(document.activeElement)) toolTriggerRef.current?.focus({ preventScroll: true });
    setToolsOpen(false);
  }, []);

  useLayoutEffect(() => {
    const scroll = scrollRef.current, saved = anchor.current;
    const restore = () => {
      if (saved?.node.isConnected && scroll) scroll.scrollTop += saved.node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
    };
    restore();
    anchor.current = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.closest("[hidden], [inert]") || !active.getClientRects().length)) {
      (fullscreen ? scroll : enterRef.current)?.focus({ preventScroll: true });
    }
    if (!saved || !scroll || typeof ResizeObserver === "undefined") return;
    // Returning to the book also remeasures the companion's ordinary seat.
    // Follow those layout commits, but release the anchor on the next user input.
    const observer = new ResizeObserver(restore);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    let timer: number;
    const stop = () => {
      observer.disconnect(); window.clearTimeout(timer);
      document.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("wheel", stop, true);
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("input", stop, true);
    };
    timer = window.setTimeout(stop, 500);
    document.addEventListener("pointerdown", stop, true);
    document.addEventListener("wheel", stop, true);
    document.addEventListener("keydown", stop, true);
    document.addEventListener("input", stop, true);
    return stop;
  }, [fullscreen, scrollRef]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open], [aria-modal='true']")) return;
      const current = latest.current;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f" && !event.altKey) {
        event.preventDefault(); toggleFullscreen(); return;
      }
      if (event.key !== "Escape" || !current.fullscreen) return;
      // Local papers, search panels and companion conversation get the first Escape.
      if (document.querySelector('.companion-hud:not([data-mode="closed"]), .notebook-desk__side-page:not([inert]), .notebook-desk__index:not([inert]), .notebook-note-list__paper:not([inert]), .cm-search')) return;
      event.preventDefault();
      if (current.toolsOpen) closeTools(); else toggleFullscreen();
    };
    const pointerdown = (event: PointerEvent) => {
      if (!latest.current.fullscreen || !latest.current.toolsOpen || !(event.target instanceof Element)) return;
      if (!event.target.closest(".notebook-desk__chrome, .notebook-focus-ribbon, dialog, [aria-modal='true']")) closeTools();
    };
    // Document bubbling follows local editor/popover handling, precedes the room's shortcuts.
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", pointerdown);
    return () => { document.removeEventListener("keydown", keydown); document.removeEventListener("pointerdown", pointerdown); };
  }, [closeTools, toggleFullscreen]);

  useEffect(() => setToolsOpen(false), [noteId]);
  return { fullscreen, toolsOpen, setToolsOpen, closeTools, toggleFullscreen, toolTriggerRef, enterRef, chromeRef };
}
