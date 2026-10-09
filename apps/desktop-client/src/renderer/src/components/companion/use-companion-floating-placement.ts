import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { companionFloatingPlacement } from "./companion-interaction-placement";
import { DIRECTORY_RAIL_MODE_EVENT, DIRECTORY_RAIL_STATE_EVENT } from "../DirectoryRail";
import { companionControlsBounds, companionHudControlBounds, companionLayoutBounds } from "./companion-visible-bounds";

export function useCompanionFloatingPlacement(
  anchorRef: RefObject<HTMLDivElement | null>,
  floatingRef: RefObject<HTMLDivElement | null>,
  headRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  preferredHeadWidth?: number,
) {
  const [side, setSide] = useState<"left" | "right">("left");
  const [controlsSide, setControlsSide] = useState<"left" | "right">("left");
  const measureRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const presence = anchorRef.current?.closest<HTMLElement>(".companion-presence");
    const floating = floatingRef.current;
    const head = headRef.current;
    if (!presence || !floating || !head) return;
    let frame = 0;
    const publish = (name: string, value: number, target = floating) => {
      const key = `--companion-${name}`;
      const next = `${Math.round(value)}px`;
      if (target.style.getPropertyValue(key) !== next) target.style.setProperty(key, next);
    };
    // Layout heights exclude the pop animation's transform and shadow overflow.
    // scrollHeight includes those, feeding the overshoot back into placement.
    const contentHeight = () => {
      // The last placement also caps a task bubble's flex body. Lift that cap
      // only during this synchronous layout read; otherwise a larger task can
      // never grow beyond the previous task's height. Restore it before paint.
      const children = Array.from(head.children) as HTMLElement[];
      const constraints = [head, ...children].map(element => ({
        element,
        value: element.style.getPropertyValue("max-height"),
        priority: element.style.getPropertyPriority("max-height"),
      }));
      for (const { element } of constraints) element.style.setProperty("max-height", "none");
      try {
        const gap = Number.parseFloat(getComputedStyle(head).rowGap) || 0;
        return children.reduce((height, child) => {
          const style = getComputedStyle(child);
          return height + child.offsetHeight + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
        }, Math.max(0, children.length - 1) * gap);
      } finally {
        for (const { element, value, priority } of constraints) {
          if (value) element.style.setProperty("max-height", value, priority);
          else element.style.removeProperty("max-height");
        }
      }
    };
    const measure = () => {
      const anchor = presence.querySelector<HTMLElement>(".window-live2d") ?? presence.querySelector<HTMLElement>(".companion-visual-shell");
      if (!anchor) { delete floating.dataset.placementReady; return; }
      const role = companionLayoutBounds(anchor, "head");
      const body = companionLayoutBounds(anchor);
      if (role.right <= role.left || role.bottom <= role.top) { delete floating.dataset.placementReady; return; }
      // Controls face into the room even while a book, settings or another
      // modal suspends the floating bubbles. The registry seat is only a
      // default; a home drag can put the model on either side of the viewport.
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      const facingSide = (role.left + role.right) / 2 >= viewport.width / 2 ? "left" : "right";
      setControlsSide(old => old === facingSide ? old : facingSide);
      const hud = anchorRef.current;
      if (hud) {
        const hudBox = hud.getBoundingClientRect();
        const scaleX = hud.offsetWidth > 0 && hudBox.width > 0 ? hudBox.width / hud.offsetWidth : 1;
        const scaleY = hud.offsetHeight > 0 && hudBox.height > 0 ? hudBox.height / hud.offsetHeight : 1;
        const controls = hud.querySelector<HTMLElement>(".companion-hud__controls");
        const rail = companionControlsBounds(role, viewport, {
          width: (controls?.offsetWidth || 44) * scaleX,
          height: (controls?.offsetHeight || 179) * scaleY,
        }, body);
        const localX = (rail.left - hudBox.left) / scaleX;
        publish("controls-x", facingSide === "left" ? Math.floor(localX) : Math.ceil(localX), hud);
        publish("controls-y", ((rail.top + rail.bottom) / 2 - hudBox.top) / scaleY, hud);
      }
      if (!active) { delete floating.dataset.placementReady; return; }
      const inputOnly = head.childElementCount === 1 && head.firstElementChild?.classList.contains("companion-hud__composer");
      const output = head.querySelector<HTMLElement>(".companion-hud__output");
      const textLength = output?.querySelector(".companion-hud__output-body")?.textContent?.length ?? 0;
      const preferredWidth = preferredHeadWidth ?? (inputOnly || output?.dataset.tone === "note" || output?.dataset.tone === "process" ? 280
        : output && textLength < 80 ? 300 : 340);
      const options = {
        role,
        controls: hud ? companionHudControlBounds(hud) : [],
        viewport,
        headWidth: preferredWidth,
        hasPapers: Boolean(floating.querySelector(".companion-hud__papers")?.childElementCount),
        // Only pending decisions and note status reserve a separate corridor.
        paperWidth: floating.querySelector('.companion-hud__papers > .companion-hud__paper:not([data-kind="note-status"])') ? 360 : 280,
      };
      // Establish width before measuring wrapping; a side corridor may narrow it.
      publish("head-w", Math.min(preferredWidth, options.viewport.width - 28));
      let placement = companionFloatingPlacement({ ...options, headHeight: contentHeight() });
      if (Math.round(placement.head.width) !== Number.parseFloat(floating.style.getPropertyValue("--companion-head-w"))) {
        publish("head-w", placement.head.width);
        placement = companionFloatingPlacement({ ...options, headHeight: contentHeight() });
      }
      for (const [name, value] of Object.entries({
        "head-x": placement.head.left, "head-y": placement.head.top, "head-w": placement.head.width,
        "head-max-h": placement.head.height, "papers-x": placement.papers.left,
        "papers-y": placement.papers.top, "papers-w": placement.papers.width, "papers-max-h": placement.papers.height,
      })) publish(name, value);
      floating.dataset.headDock = placement.headDock;
      floating.dataset.placementReady = "true";
      setSide(old => old === placement.side ? old : placement.side);
    };
    // Coalesce observer notifications into one read phase. GSAP writes the
    // moving anchor each frame, so those mutations already follow real motion;
    // a fixed 1.2s polling tail only forced unrelated page layouts afterward.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    measureRef.current = measure;
    measure();
    const resize = new ResizeObserver(schedule);
    const anchor = presence.querySelector<HTMLElement>(".window-live2d") ?? presence.querySelector<HTMLElement>(".companion-visual-shell");
    if (anchor) resize.observe(anchor);
    for (const control of presence.querySelectorAll(".companion-hud__controls, .companion-goal-tab")) resize.observe(control);
    resize.observe(presence);
    resize.observe(head);
    const mutation = new MutationObserver(schedule);
    mutation.observe(floating, { childList: true, subtree: true, characterData: true });
    mutation.observe(presence, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "data-anchor", "data-user-anchor", "data-projection-state"] });
    const app = presence.closest(".desktop-app");
    if (app) mutation.observe(app, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.addEventListener(DIRECTORY_RAIL_STATE_EVENT, schedule);
    window.addEventListener(DIRECTORY_RAIL_MODE_EVENT, schedule);
    return () => {
      measureRef.current = null;
      delete floating.dataset.placementReady;
      delete floating.dataset.headDock;
      resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.removeEventListener(DIRECTORY_RAIL_STATE_EVENT, schedule);
      window.removeEventListener(DIRECTORY_RAIL_MODE_EVENT, schedule);
    };
  }, [anchorRef, floatingRef, headRef, active, preferredHeadWidth]);
  // The portal stays mounted when closed. Content commits must be positioned
  // before paint, not one observer/animation frame after the bubble appears.
  useLayoutEffect(() => { measureRef.current?.(); });
  return { side, controlsSide };
}
