import { useLayoutEffect, useState } from "react";
import type { GuideRect } from "./guide-layout";

export type GuideAnchor = GuideRect & { element: HTMLElement };

/** Selectors are ordered by meaning, not by their incidental order in the DOM. */
export function findGuideAnchor(selector: string): GuideAnchor | null {
  for (const target of selector.split(",")) {
    for (const node of document.querySelectorAll<HTMLElement>(target.trim())) {
      if (!node.getClientRects().length || node.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
      let visible = true;
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity || 1) < .08) { visible = false; break; }
      }
      if (!visible) continue;
      const bounds = node.getBoundingClientRect();
      if (bounds.width < 8 || bounds.height < 8 || bounds.bottom < 8 || bounds.top > innerHeight - 8 || bounds.right < 8 || bounds.left > innerWidth - 8) continue;
      // A background entrance behind an actual panel is not a usable entrance.
      const point = { x: Math.max(1, Math.min(innerWidth - 1, bounds.left + bounds.width / 2)), y: Math.max(1, Math.min(innerHeight - 1, bounds.top + bounds.height / 2)) };
      const front = document.elementsFromPoint?.(point.x, point.y).find(element => !element.closest(".guidance-stage") && getComputedStyle(element).pointerEvents !== "none");
      if (front && front !== node && !node.contains(front)) continue;
      return { element: node, left: Math.max(3, bounds.left - 7), top: Math.max(3, bounds.top - 7), width: Math.min(bounds.width + 14, innerWidth - Math.max(3, bounds.left - 7) - 3), height: Math.min(bounds.height + 14, innerHeight - Math.max(3, bounds.top - 7) - 3) };
    }
  }
  return null;
}

/** The outline has no input of its own; the highlighted real button remains usable. */
export function useGuideAnchor(selector?: string) {
  const [box, setBox] = useState<GuideAnchor | null>(null);
  useLayoutEffect(() => {
    if (!selector) { setBox(null); return; }
    const measure = () => {
      const next = findGuideAnchor(selector);
      setBox(old => old?.element === next?.element && (!old || !next || ["left", "top", "width", "height"].every(key => Math.abs(old[key as keyof GuideRect] - next[key as keyof GuideRect]) < .5)) ? old : next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(document.documentElement);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    const timer = window.setInterval(measure, 160);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); window.clearInterval(timer); };
  }, [selector]);
  return box;
}
