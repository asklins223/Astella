import { useLayoutEffect, useState, type RefObject } from "react";
import { companionHistoryPlacement } from "./companion-interaction-placement";
import { DIRECTORY_RAIL_MODE_EVENT, DIRECTORY_RAIL_STATE_EVENT } from "../DirectoryRail";
import { companionHudControlBounds, companionLayoutBounds } from "./companion-visible-bounds";

/** Shared placement for the book and settings paper; underlying geometry stays intact. */
export function useCompanionPaperPlacement(
  anchorRef: RefObject<HTMLDivElement | null>,
  drawerRef: RefObject<HTMLElement | null>,
  active: boolean,
  fallbackSide: "left" | "right",
  preferredWidth = 760,
) {
  const [side, setSide] = useState(fallbackSide);
  useLayoutEffect(() => {
    const presence = anchorRef.current?.closest<HTMLElement>(".companion-presence");
    const drawer = drawerRef.current;
    if (!active || !presence || !drawer) return;
    let frame = 0;
    let observedAnchor: HTMLElement | null = null;
    const measure = () => {
      const anchor = presence.querySelector<HTMLElement>(".window-live2d") ?? presence.querySelector<HTMLElement>(".companion-visual-shell");
      if (!anchor) { delete drawer.dataset.placementReady; return; }
      if (anchor !== observedAnchor) {
        if (observedAnchor) resize.unobserve(observedAnchor);
        resize.observe(anchor);
        observedAnchor = anchor;
      }
      const box = companionLayoutBounds(anchor, "head");
      if (box.right <= box.left || box.bottom <= box.top) { delete drawer.dataset.placementReady; return; }
      const placement = companionHistoryPlacement(box, document.documentElement.clientWidth, preferredWidth,
        anchorRef.current ? companionHudControlBounds(anchorRef.current) : []);
      drawer.style.setProperty("--companion-paper-x", `${Math.round(placement.left)}px`);
      drawer.style.setProperty("--companion-paper-w", `${Math.round(placement.width)}px`);
      drawer.dataset.placementReady = "true";
      setSide(old => old === placement.side ? old : placement.side);
    };
    // Coalesce observer notifications into one read phase. GSAP writes the
    // moving anchor each frame, so those mutations already follow real motion;
    // a fixed 1.2s polling tail only forced unrelated page layouts afterward.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    const resize = new ResizeObserver(schedule);
    for (const control of presence.querySelectorAll(".companion-hud__controls, .companion-goal-tab")) resize.observe(control);
    const mutation = new MutationObserver(schedule);
    mutation.observe(presence, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "data-user-anchor", "data-projection-state"] });
    const app = presence.closest(".desktop-app");
    if (app) mutation.observe(app, { attributes: true, attributeFilter: ["class"] });
    measure();
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.addEventListener(DIRECTORY_RAIL_STATE_EVENT, schedule);
    window.addEventListener(DIRECTORY_RAIL_MODE_EVENT, schedule);
    return () => {
      delete drawer.dataset.placementReady;
      cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.removeEventListener(DIRECTORY_RAIL_STATE_EVENT, schedule);
      window.removeEventListener(DIRECTORY_RAIL_MODE_EVENT, schedule);
    };
  }, [anchorRef, drawerRef, active, preferredWidth]);
  return side;
}
