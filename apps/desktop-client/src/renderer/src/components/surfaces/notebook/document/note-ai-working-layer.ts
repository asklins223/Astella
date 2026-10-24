import { useEffect, useRef, type RefObject } from "react";
import { createNotePointWave } from "./note-point-wave";

/** One overlay per connected passage, shared by rich and source editors.
 * Paragraph decorations only enforce selection/edit locks; they never animate.
 */
export type WorkingPassage = { id: string; label: string; elements: readonly HTMLElement[] };
export function createNoteWorkingLayer(host: HTMLElement, passages: () => readonly WorkingPassage[]) {
  const originalPosition = host.style.position;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const root = document.createElement("div");
  root.className = "note-ai-work-layer"; root.setAttribute("aria-hidden", "true"); host.append(root);
  const clouds = new Map<HTMLElement, ReturnType<typeof createNotePointWave>>();
  const visible = new IntersectionObserver(entries => {
    for (const entry of entries) entry.target.classList.toggle("is-offscreen", !entry.isIntersecting);
  }, { rootMargin: "80px" });
  let frame = 0;
  const paint = () => {
    frame = 0;
    const origin = host.getBoundingClientRect(), seen = new Set<string>();
    for (const passage of passages()) {
      const rects = passage.elements.filter(element => element.isConnected).map(element => element.getBoundingClientRect()).filter(rect => rect.height > 0);
      if (!rects.length) continue;
      seen.add(passage.id);
      let layer = Array.from(root.children).find(element => (element as HTMLElement).dataset.passage === passage.id) as HTMLElement | undefined;
      if (!layer) {
        layer = document.createElement("div"); layer.className = "note-ai-work-range is-offscreen"; layer.dataset.passage = passage.id;
        const waves = document.createElement("canvas"); waves.className = "note-ai-work-cloud";
        const label = document.createElement("span"); label.className = "note-ai-work-label";
        layer.append(waves, label); root.append(layer); clouds.set(layer, createNotePointWave(waves, passage.id)); visible.observe(layer);
      }
      const left = Math.min(...rects.map(rect => rect.left)), top = Math.min(...rects.map(rect => rect.top));
      Object.assign(layer.style, { left: `${left - origin.left + host.scrollLeft - 6}px`, top: `${top - origin.top + host.scrollTop - 6}px`,
        width: `${Math.max(...rects.map(rect => rect.right)) - left + 12}px`, height: `${Math.max(...rects.map(rect => rect.bottom)) - top + 12}px` });
      const height = Math.max(...rects.map(rect => rect.bottom)) - top + 12;
      const visibleTop = Math.max(0, -top + 6 - 48);
      const visibleBottom = Math.min(height, window.innerHeight - top + 6 + 48);
      clouds.get(layer)!.resize({ width: Math.max(...rects.map(rect => rect.right)) - left + 12, height,
        top: visibleTop, visibleHeight: Math.max(1, visibleBottom - visibleTop) });
      layer.querySelector("span")!.textContent = passage.label;
    }
    for (const layer of Array.from(root.children)) if (!seen.has((layer as HTMLElement).dataset.passage!)) {
      clouds.get(layer as HTMLElement)?.destroy(); clouds.delete(layer as HTMLElement); visible.unobserve(layer); layer.remove();
    }
  };
  const update = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const visibility = () => { root.classList.toggle("is-paused", document.hidden); };
  const resize = new ResizeObserver(update); resize.observe(host);
  // Capture nested scroll containers too (source mode virtualizes its lines).
  host.addEventListener("scroll", update, true); window.addEventListener("resize", update);
  document.addEventListener("visibilitychange", visibility); visibility(); update();
  return { update, destroy() { cancelAnimationFrame(frame); resize.disconnect(); visible.disconnect(); host.removeEventListener("scroll", update, true);
    window.removeEventListener("resize", update); document.removeEventListener("visibilitychange", visibility);
    for (const cloud of clouds.values()) cloud.destroy(); clouds.clear(); root.remove(); host.style.position = originalPosition; } };
}

export function workingPassagesIn(root: HTMLElement): WorkingPassage[] {
  const groups = new Map<string, WorkingPassage>();
  root.querySelectorAll<HTMLElement>("[data-ai-group]").forEach(element => {
    const id = element.dataset.aiGroup!, current = groups.get(id);
    groups.set(id, { id, label: element.dataset.aiLabel ?? "伴星正在处理", elements: [...(current?.elements ?? []), element] });
  });
  return Array.from(groups.values());
}

export function useNotebookWorkingLayer(body: RefObject<HTMLElement | null>, active: boolean, identity: string, rangeKey: string) {
  const layer = useRef<ReturnType<typeof createNoteWorkingLayer> | null>(null);
  useEffect(() => {
    const host = body.current; if (!active || !host) return;
    const current = createNoteWorkingLayer(host, () => workingPassagesIn(host)); layer.current = current;
    return () => { current.destroy(); if (layer.current === current) layer.current = null; };
  }, [active, identity, body]);
  useEffect(() => {
    layer.current?.update();
    const selection = window.getSelection(), host = body.current;
    if (selection?.rangeCount && host && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (Array.from(host.querySelectorAll(".note-ai-locked")).some(element => range.intersectsNode(element))) selection.removeAllRanges();
    }
  }, [active, rangeKey, body]);
}
