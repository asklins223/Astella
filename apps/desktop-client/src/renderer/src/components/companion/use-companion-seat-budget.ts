import { useLayoutEffect, type RefObject } from "react";
import { companionControlsBounds, companionLayoutBounds } from "./companion-visible-bounds";

/** The paper reserves the occupied role + control rail, never the floating replies. */
export function useCompanionSeatBudget(anchorRef: RefObject<HTMLDivElement | null>, present: boolean, scale: number, interaction: string, sceneKey: string) {
  useLayoutEffect(() => {
    const presence = anchorRef.current?.closest<HTMLElement>(".companion-presence");
    const app = presence?.closest<HTMLElement>(".desktop-app");
    if (!presence || !app || sceneKey === "room") return;
    let frame = 0;
    const keys = ["right", "left", "left-collapsed", "right-compact", "left-compact", "left-collapsed-compact"];
    const publish = (key: string, value: number) => {
      const next = `${Math.ceil(value)}px`;
      if (app.style.getPropertyValue(key) !== next) app.style.setProperty(key, next);
    };
    const measure = () => {
      const model = presence.querySelector<HTMLElement>(".window-live2d");
      if (!present || !model) return;
      const role = companionLayoutBounds(model, "head");
      const body = companionLayoutBounds(model);
      if (role.right <= role.left || role.bottom <= role.top) return;
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      const hud = presence.querySelector<HTMLElement>(".companion-hud");
      const controls = hud?.querySelector<HTMLElement>(".companion-hud__controls");
      const hudBox = hud?.getBoundingClientRect();
      const scaleX = hudBox && hud && hud.offsetWidth > 0 ? hudBox.width / hud.offsetWidth : 1;
      const scaleY = hudBox && hud && hud.offsetHeight > 0 ? hudBox.height / hud.offsetHeight : 1;
      // History removes the icons temporarily, but opening its overlay must
      // not release their seat and resize the task paper underneath it.
      const rail = interaction !== "none" ? companionControlsBounds(role, viewport, {
        width: (controls?.offsetWidth || 44) * scaleX, height: (controls?.offsetHeight || 179) * scaleY,
      }, body) : null;
      const left = Math.max(role.right, rail?.right ?? role.right) + 12;
      const right = viewport.width - Math.min(role.left, rail?.left ?? role.left) + 12;
      for (const key of keys) publish(`--companion-seat-${key}`, key.startsWith("left") ? left : right);
      const occupied = (role.left + role.right) / 2 >= viewport.width / 2 ? right : left;
      publish("--companion-universe-seat-gutter", occupied);
      publish("--companion-universe-seat-gutter-compact", occupied);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(presence);
    if (anchorRef.current) resize.observe(anchorRef.current);
    const mutation = new MutationObserver(schedule);
    mutation.observe(presence, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "data-surface"] });
    // This hook publishes the seat variables on app.style itself. Observing
    // that style also re-entered measurement for our own writes and every
    // camera tick; page/rail classes and viewport events carry real changes.
    mutation.observe(app, { attributes: true, attributeFilter: ["class", "data-directory-rail"] });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      for (const key of keys) app.style.removeProperty(`--companion-seat-${key}`);
      app.style.removeProperty("--companion-universe-seat-gutter");
      app.style.removeProperty("--companion-universe-seat-gutter-compact");
    };
  }, [anchorRef, present, scale, interaction, sceneKey]);
}
