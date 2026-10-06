import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRoomStore } from "../app/room-store";
import type { RoomIntent } from "../app/room-machine";
import { resolveSceneMotionMode } from "../scene/scene-motion";
import { createDirectoryRailMotion, directoryBox } from "./directory-rail-motion";

/** Mockup nav icon paths, copied from desktop-pages-v3 `mockup.html`. */
const NAV_ICONS = {
  home: "M4 11.5 12 4l8 7.5M6.5 10.3V20h11v-9.7M10 20v-5h4v5",
  sources: "M5 3.5h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM8.5 8h7M8.5 12h7M8.5 16h4.5",
  notes: "M5 19.5 7.3 14 16 5.3a2 2 0 0 1 2.8 2.8L10.2 17 5 19.5Zm9-12.3 2.8 2.8M7.3 14l2.9 3",
  goals: "m12 3 8 9-8 9-8-9 8-9Zm0 5 3.5 4-3.5 4-3.5-4 3.5-4Z",
  // The second authored glyph (今日学习 was the first): the mockup's rail has no
  // 星图 chip, but the page is a real destination now. Same 24×24 / 1.7-stroke
  // outline language — a small constellation: three star nodes joined by two
  // lines, with the brightest star sitting higher, reading as "the map of
  // relations between stars" next to 理解 (its diamond) at 19px.
  graph: "M5.2 18.6 11.2 11.2 18.8 16.4M11.2 11.2l4.6-6.2M5.2 18.6m-1.9 0a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0M11.2 11.2m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M18.8 16.4m-1.6 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M15.8 5m-1.9 0a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0",
  // The only glyph here with no mockup counterpart. The mockup's rail has eight
  // chips and routes 复习 straight to page 14 (`data-target="14"`), so it never
  // draws a 今日学习 entry; this one is authored in the same 24×24 / 1.7-stroke
  // outline language — calendar frame, top hangers, month rule, then a marked
  // date cell — so 今日学习 and 复习 can sit side by side as two destinations.
  //
  // The date marker is deliberately off-centre with a rule beside it: a single
  // centred ring reads as a camera lens next to 来源 and 复习 at 19px.
  today: "M8 3v2.6M16 3v2.6M6.8 5.6h10.4a2.2 2.2 0 0 1 2.2 2.2v10.4a2.2 2.2 0 0 1-2.2 2.2H6.8a2.2 2.2 0 0 1-2.2-2.2V7.8a2.2 2.2 0 0 1 2.2-2.2ZM4.6 10.6h14.8M10.4 13.5a2 2 0 1 0 0 4 2 2 0 1 0 0-4M14.6 15.5h1.4",
  review: "M19 8a7.5 7.5 0 1 0 .4 7M19 4v4h-4M12 8v4l2.5 1.7",
  search: "M16 10.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Zm-1 4.5 5 5",
  companion: "M12 3.5c.7 4.7 3.8 7.8 8.5 8.5-4.7.7-7.8 3.8-8.5 8.5-.7-4.7-3.8-7.8-8.5-8.5 4.7-.7 7.8-3.8 8.5-8.5Z",
  settings: "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm4 1.5v-3l-2-.6-.7-1.6 1-1.8-2.1-2.1-1.8 1-1.6-.7-.6-2h-3l-.6 2-1.6.7-1.8-1-2.1 2.1 1 1.8-.7 1.6-2 .6v3l2 .6.7 1.6-1 1.8 2.1 2.1 1.8-1 1.6.7.6 2h3l.6-2 1.6-.7 1.8 1 2.1-2.1-1-1.8.7-1.6 2-.6Z",
} as const;

type DirectoryItem = {
  readonly id: keyof typeof NAV_ICONS;
  readonly label: string;
  readonly intent: RoomIntent;
};

const DIRECTORY_ITEMS: readonly DirectoryItem[] = [
  { id: "home", label: "首页", intent: "home" },
  { id: "sources", label: "来源", intent: "open-sources" },
  { id: "notes", label: "笔记", intent: "open-notes" },
  { id: "goals", label: "学习卡", intent: "open-objectives" },
  // 星图 (page 19) sits with the understanding group: it is the topology view
  // of the same sources → notes → objectives chain the three chips above open.
  { id: "graph", label: "星图", intent: "graph" },
  // 今日学习 (page 14) and 复习 (page 15) are two different pages, and the rail
  // is the only place either one can be reached from. `continue` is the intent
  // `room-machine.ts` resolves to `{ surface: "study" }`, i.e. page 14.
  { id: "today", label: "今日学习", intent: "continue" },
  { id: "review", label: "复习", intent: "review" },
  { id: "search", label: "查找", intent: "search" },
  { id: "companion", label: "伴星", intent: "open-companion-center" },
  { id: "settings", label: "设置", intent: "open-settings" },
];

export type DirectoryRailMode = "auto" | "expanded" | "collapsed";

export const DIRECTORY_COLLAPSED_KEY = "astella.directory-rail.collapsed.v1";
export const DIRECTORY_RAIL_MODE_KEY = "astella.directory-rail.mode.v1";
export const DIRECTORY_RAIL_STATE_EVENT = "astella:directory-rail-state";
export const DIRECTORY_RAIL_MODE_EVENT = "astella:directory-rail-mode";
export const DIRECTORY_RAIL_TOGGLE_EVENT = "astella:directory-rail-toggle";

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(DIRECTORY_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function readDirectoryRailMode(): DirectoryRailMode {
  try {
    const stored = window.localStorage.getItem(DIRECTORY_RAIL_MODE_KEY);
    if (stored === "auto" || stored === "expanded" || stored === "collapsed") return stored;
    // Older builds only persisted the explicit bottom-island toggle. Treat an
    // untouched preference as responsive auto mode, while preserving a prior
    // manual collapse for users who already chose it.
    return readCollapsedPreference() ? "collapsed" : "auto";
  } catch {
    return "auto";
  }
}

type LayoutBox = {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type RailLayoutSnapshot = {
  readonly collapsed: boolean;
  readonly moving: ReadonlyArray<{
    readonly element: HTMLElement;
    readonly box: LayoutBox;
  }>;
};

type SpringFrameFactory = (progress: number, time: number) => Keyframe;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function springProgress(time: number, strength = 6.4): number {
  const t = clamp01(time);
  return t === 1 ? 1 : 1 - (1 + strength * t) * Math.exp(-strength * t);
}

function springFrames(factory: SpringFrameFactory, count = 38, strength = 6.4): Keyframe[] {
  return Array.from({ length: count }, (_, index) => {
    const time = index / (count - 1);
    return { offset: time, ...factory(springProgress(time, strength), time) };
  });
}

function layoutBox(element: HTMLElement): LayoutBox {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function readRailLayout(rail: HTMLElement, collapsed: boolean): RailLayoutSnapshot {
  const moving = [
    rail,
    document.querySelector<HTMLElement>(".home-v2-hud"),
    document.querySelector<HTMLElement>(".hud-surface .content"),
    document.querySelector<HTMLElement>(".hud-surface .return-home"),
  ].filter((element): element is HTMLElement => Boolean(element));

  return {
    collapsed,
    moving: [...new Set(moving)].map((element) => ({ element, box: layoutBox(element) })),
  };
}

function trackAnimation(
  animation: Animation,
  activeAnimations: Animation[],
) {
  activeAnimations.push(animation);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const index = activeAnimations.indexOf(animation);
    if (index >= 0) activeAnimations.splice(index, 1);
  };
  animation.oncancel = cleanup;
  animation.onfinish = () => {
    // WAAPI never changed inline styles. Release its identity end frame to the
    // current owner (including an in-flight TaskSurface entrance), instead of
    // writing back a stale transform captured before the rail toggle.
    animation.cancel();
    cleanup();
  };
}

function animateFlip(
  element: HTMLElement,
  before: LayoutBox,
  after: LayoutBox,
  duration: number,
  activeAnimations: Animation[],
) {
  if (after.width <= 0 || after.height <= 0) return;
  const translateX = before.left - after.left;
  const translateY = before.top - after.top;
  const scaleX = before.width / after.width;
  const scaleY = before.height / after.height;
  if (
    Math.abs(translateX) < 0.5
    && Math.abs(translateY) < 0.5
    && Math.abs(scaleX - 1) < 0.005
    && Math.abs(scaleY - 1) < 0.005
  ) return;

  const animation = element.animate(
    springFrames((progress) => {
      const rest = 1 - progress;
      return {
        transformOrigin: "top left",
        transform: `translate3d(${translateX * rest}px, ${translateY * rest}px, 0) scale(${1 + (scaleX - 1) * rest}, ${1 + (scaleY - 1) * rest})`,
      };
    }),
    { duration, easing: "linear", fill: "both" },
  );
  trackAnimation(animation, activeAnimations);
}

function NavIcon({ id }: { readonly id: keyof typeof NAV_ICONS }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={NAV_ICONS[id]} />
    </svg>
  );
}

/**
 * `readOnly` is the first-entry scene (mockup 04A): the rail is drawn, but there
 * is no space bound yet, so every destination behind it would open a page with
 * nothing to read. The collapse toggle stays live — it is a local preference,
 * not a destination.
 */
export function DirectoryRail({ readOnly = false }: { readonly readOnly?: boolean } = {}) {
  const surface = useRoomStore((state) => state.surface);
  const invoke = useRoomStore((state) => state.invoke);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const [mode, setMode] = useState<DirectoryRailMode>(readDirectoryRailMode);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const previousLayoutRef = useRef<RailLayoutSnapshot | null>(null);
  const railMotionRef = useRef<ReturnType<typeof createDirectoryRailMotion> | null>(null);
  if (!railMotionRef.current) railMotionRef.current = createDirectoryRailMotion();
  const activeAnimationsRef = useRef<Animation[]>([]);
  const collapsed = mode === "collapsed" || (mode === "auto" && autoCollapsed);

  useLayoutEffect(() => {
    setPortalHost(document.querySelector<HTMLElement>(".desktop-app"));
  }, []);

  useEffect(() => {
    // 「自动」是给书房首页让位用的：收起后场景才露得出来。任务页开着时整列
    // 只值 30px（笔记详情页正文左缘实测 expanded 365px / collapsed 335px），
    // 换到的空间没有东西可露，代价却是每次跳页都把这一列展开、1.9 秒后再收起——
    // 实窗量到一趟导航两次形变，用户读到的就是"目录栏一直闪"。所以有页面开着时
    // 不自动收，回书房才收。
    if (mode !== "auto" || surface) {
      setAutoCollapsed(false);
      return undefined;
    }
    setAutoCollapsed(false);
    const timer = window.setTimeout(() => setAutoCollapsed(true), 1900);
    return () => window.clearTimeout(timer);
  }, [mode, surface]);

  useLayoutEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    const rail = railRef.current;
    if (!app || !rail) return;

    const previousLayout = previousLayoutRef.current;
    // Capture live presentation before cancelling: a reverse command must not
    // restart from the last target's stored geometry.
    const before = readRailLayout(rail, previousLayout?.collapsed ?? collapsed);
    const beforeRail = layoutBox(rail);
    const beforeButton = directoryBox(rail.querySelector(".nav-collapse")!);
    const shouldAnimate = Boolean(previousLayout)
      && motionMode !== "off"
      && previousLayout?.collapsed !== collapsed;
    railMotionRef.current?.prepare(rail, before.collapsed, shouldAnimate);
    for (const animation of [...activeAnimationsRef.current]) animation.cancel();
    activeAnimationsRef.current = [];
    app.dataset.directoryRail = collapsed ? "collapsed" : "expanded";
    app.dataset.directoryRailMode = mode;
    app.classList.toggle("nav-collapsed", collapsed);
    const nextLayout = readRailLayout(rail, collapsed);

    if (shouldAnimate) {
      railMotionRef.current?.run(rail, before.collapsed, collapsed, motionMode, beforeRail, beforeButton);
      for (const current of nextLayout.moving) {
        if (current.element === rail || typeof current.element.animate !== "function") continue;
        const previous = before.moving.find(item => item.element === current.element);
        if (previous) animateFlip(current.element, previous.box, current.box, motionMode === "full" ? 520 : 280, activeAnimationsRef.current);
      }
    } else railMotionRef.current?.finish();
    previousLayoutRef.current = nextLayout;

    try {
      window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, mode);
      window.localStorage.setItem(DIRECTORY_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Preference persistence is progressive enhancement.
    }
    window.dispatchEvent(new CustomEvent(DIRECTORY_RAIL_STATE_EVENT, {
      detail: { collapsed, mode },
    }));
  }, [collapsed, mode, motionMode, surface]);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    return () => {
      railMotionRef.current?.finish();
      for (const animation of [...activeAnimationsRef.current]) animation.cancel();
      activeAnimationsRef.current = [];
      if (app) {
        delete app.dataset.directoryRail;
        delete app.dataset.directoryRailMode;
        app.classList.remove("nav-collapsed");
      }
    };
  }, []);

  useEffect(() => {
    const onToggle = (event: Event) => {
      const next = (event as CustomEvent<{ collapsed?: unknown }>).detail?.collapsed;
      setMode((current) => {
        if (typeof next === "boolean") return next ? "collapsed" : "expanded";
        return current === "collapsed" ? "expanded" : "collapsed";
      });
    };
    const onMode = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: unknown }>).detail?.mode;
      if (next === "auto" || next === "expanded" || next === "collapsed") setMode(next);
    };
    window.addEventListener(DIRECTORY_RAIL_TOGGLE_EVENT, onToggle);
    window.addEventListener(DIRECTORY_RAIL_MODE_EVENT, onMode);
    return () => {
      window.removeEventListener(DIRECTORY_RAIL_TOGGLE_EVENT, onToggle);
      window.removeEventListener(DIRECTORY_RAIL_MODE_EVENT, onMode);
    };
  }, []);

  const activeId = useMemo<DirectoryItem["id"]>(() => {
    if (!surface) return "home";
    if (surface === "study") return "today";
    if (surface.startsWith("source-")) return "sources";
    if (surface.startsWith("note")) return "notes";
    if (surface.startsWith("objective") || surface === "card-generation") return "goals";
    if (surface === "graph") return "graph";
    if (surface === "review" || surface === "validation") return "review";
    if (surface === "search") return "search";
    if (surface === "companion-center") return "companion";
    if (surface === "settings") return "settings";
    return "home";
  }, [surface]);

  const portalTarget = portalHost ?? document.body;
  return createPortal(
    <nav ref={railRef} className="hud-rail" aria-label="学习空间目录">
      {DIRECTORY_ITEMS.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-chip${item.id === "settings" ? " settings-chip" : ""}${active ? " active" : ""}`}
            data-label={item.label}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            aria-hidden={collapsed || undefined}
            tabIndex={collapsed ? -1 : undefined}
            title={collapsed ? item.label : undefined}
            disabled={readOnly}
            onClick={() => invoke(item.intent)}
          >
            <NavIcon id={item.id} />
          </button>
        );
      })}
      <button
        type="button"
        className="nav-collapse"
        aria-label={collapsed ? "展开目录" : "收起目录"}
        aria-expanded={!collapsed}
        onClick={() => setMode(collapsed ? "expanded" : "collapsed")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="m7 9 5 5 5-5" />
        </svg>
      </button>
      <span className="nav-island-copy">学习空间目录</span>
    </nav>,
    portalTarget,
  );
}
