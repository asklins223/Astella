import { openCompanionGuide } from "../companion/guidance/guide-definitions";
// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import { CircleAlert } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCompanionHomeProjection } from "../../app/companion-pages/companion-home-projection";
import { useHomeProjection } from "../../app/home/home-projection";
import { homePresentation } from "../../app/home/home-presentation";
import { useRoomStore } from "../../app/home/room-store";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { HOME_V2_CAMERA_PRESETS, type HomeV2Zone } from "./home-v2";
import {
  getHomeFeature,
  isHomeFeatureId,
  type HomeFeatureDefinitionV1,
  type HomeFeatureId,
} from "./home-feature-registry";
import { HOME_FEATURE_ICONS } from "./home-feature-icons";
import { HomeV2AudioController } from "./HomeV2AudioController";
import {
  homeSceneTimeForThemeMode,
  type HomeSceneTimeV1,
} from "./home-scene-profile";

export type HomeFeatureRuntimeV1 = Readonly<{
  definition: HomeFeatureDefinitionV1;
  title: string;
  detail: string;
  state: "ready" | "pending" | "loading" | "error";
  meta: string;
}>;

type HomeV2ContextValue = {
  readonly zone: HomeV2Zone;
  readonly sceneTime: HomeSceneTimeV1;
  readonly modalOpen: boolean;
  readonly focusRegion: (zone: Exclude<HomeV2Zone, "wide">) => void;
  readonly exitRegion: () => void;
  readonly setZone: (zone: HomeV2Zone) => void;
  readonly replayIntro: () => void;
  readonly runFeature: (featureId: HomeFeatureId) => void;
  readonly featurePresentation: (featureId: HomeFeatureId) => HomeFeatureRuntimeV1;
};

const HOME_V2_REGION_TRIGGER_IDS: Readonly<Record<Exclude<HomeV2Zone, "wide">, string>> = Object.freeze({
  desk: "home-v2-object-desk-book",
  shelf: "home-v2-object-bookshelf",
  window: "home-v2-object-window-stars",
  rest: "home-v2-object-rest-cushion",
});
const HOME_PROJECTION_FEATURE_IDS = new Set<HomeFeatureId>([
  "continue",
  "current-notebook",
]);

const DEFAULT_CONTEXT: HomeV2ContextValue = {
  zone: "wide",
  sceneTime: "day",
  modalOpen: false,
  focusRegion: () => {},
  exitRegion: () => {},
  setZone: () => {},
  replayIntro: () => {},
  runFeature: () => {},
  featurePresentation: (featureId) => {
    const definition = getHomeFeature(featureId);
    return {
      definition,
      title: definition.title,
      detail: definition.purpose,
      state: definition.availability === "native" ? "ready" : "pending",
      meta: definition.availability === "native" ? "小屋可用" : "新版页面尚未接入",
    };
  },
};

const HomeV2Context = createContext<HomeV2ContextValue>(DEFAULT_CONTEXT);

export const useHomeV2 = () => useContext(HomeV2Context);

export function HomeV2Provider({ children }: { readonly children: ReactNode }) {
  const [zone, setZoneState] = useState<HomeV2Zone>("wide");
  const [selectedFeatureId, setSelectedFeatureId] = useState<HomeFeatureId | null>(null);
  const [sceneTime, setSceneTime] = useState<HomeSceneTimeV1>(() => homeSceneTimeForThemeMode({
    themeMode: useRoomStore.getState().themeMode,
    theme: useRoomStore.getState().theme,
    now: new Date(),
  }));
  const zoneRef = useRef<HomeV2Zone>("wide");
  const regionTriggerIdRef = useRef<string | null>(null);
  const featureTriggerRef = useRef<HTMLElement | null>(null);
  const surface = useRoomStore((state) => state.surface);
  const applyTimeTheme = useRoomStore((state) => state.applyTimeTheme);
  const theme = useRoomStore((state) => state.theme);
  const themeMode = useRoomStore((state) => state.themeMode);
  const invoke = useRoomStore((state) => state.invoke);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const finishOnboarding = useRoomStore((state) => state.finishOnboarding);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const { projection, loading, failure } = useHomeProjection();
  const companionHome = useCompanionHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const modalOpen = selectedFeatureId !== null;

  const setZone = useCallback((nextZone: HomeV2Zone) => {
    zoneRef.current = nextZone;
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (app) app.dataset.homeV2Zone = nextZone;
    setZoneState(nextZone);
  }, []);

  const focusRegion = useCallback((nextZone: Exclude<HomeV2Zone, "wide">) => {
    if (zoneRef.current === nextZone) return;
    regionTriggerIdRef.current = document.activeElement instanceof HTMLElement && document.activeElement.id
      ? document.activeElement.id
      : HOME_V2_REGION_TRIGGER_IDS[nextZone];
    setZone(nextZone);
    window.dispatchEvent(new CustomEvent("astella:home-v2-sound", { detail: { kind: "footstep" } }));
  }, [setZone]);

  const exitRegion = useCallback(() => {
    const triggerId = regionTriggerIdRef.current;
    regionTriggerIdRef.current = null;
    setZone("wide");
    if (!triggerId) return;
    window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus({ preventScroll: true }));
  }, [setZone]);

  useEffect(() => {
    const syncWithLocalTime = () => {
      const next = homeSceneTimeForThemeMode({
        themeMode,
        theme: useRoomStore.getState().theme,
        now: new Date(),
      });
      setSceneTime(next);
      if (themeMode === "system") applyTimeTheme(next === "night" ? "night" : "day");
    };
    syncWithLocalTime();
    if (themeMode !== "system") return undefined;
    const timer = window.setInterval(syncWithLocalTime, 60_000);
    return () => window.clearInterval(timer);
  }, [applyTimeTheme, theme, themeMode]);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (!app) return undefined;
    if (modalOpen) app.dataset.homeV2Modal = "true";
    else delete app.dataset.homeV2Modal;
    return () => { delete app.dataset.homeV2Modal; };
  }, [modalOpen]);

  const replayIntro = useCallback(() => openCompanionGuide("welcome"), []);

  // The legacy onboarding flag has no V2 presentation. Clear it defensively so
  // stale state from an older build cannot hide the V2 HUD layers.
  useEffect(() => {
    if (onboardingOpen) finishOnboarding();
  }, [finishOnboarding, onboardingOpen]);

  const featurePresentation = useCallback((featureId: HomeFeatureId): HomeFeatureRuntimeV1 => {
    const definition = getHomeFeature(featureId);
    let detail = definition.purpose;
    let meta = definition.availability === "native" ? "小屋可用" : "新版页面尚未接入";
    let state: HomeFeatureRuntimeV1["state"] = definition.availability === "native" ? "ready" : "pending";

    switch (featureId) {
      case "continue":
        detail = home.note?.title ?? "还没有打开过的笔记";
        meta = home.note ? "继续阅读" : "去笔记库";
        break;
      case "current-notebook":
        detail = home.note?.title ?? "还没有打开过的笔记";
        meta = home.note ? "继续阅读" : "从一份材料开始";
        break;
      case "companion-center":
        detail = companionHome.projection?.profileSummary.name
          ? `打开 ${companionHome.projection.profileSummary.name} 的对话、日记、人格与记忆`
          : definition.purpose;
        meta = "小屋可用";
        break;
      default:
        break;
    }

    if (HOME_PROJECTION_FEATURE_IDS.has(featureId) && home.blockingLoading) {
      state = "loading";
      meta = "同步中";
    } else if (HOME_PROJECTION_FEATURE_IDS.has(featureId) && failure) {
      state = "error";
      meta = "状态待恢复";
    }

    return { definition, title: definition.title, detail, state, meta };
  }, [companionHome.projection, failure, home]);

  const openFeatureNotice = useCallback((featureId: HomeFeatureId) => {
    featureTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSelectedFeatureId(featureId);
    window.dispatchEvent(new CustomEvent("astella:home-v2-sound", { detail: { kind: "page" } }));
  }, []);

  const closeFeatureNotice = useCallback((restoreFocus = true) => {
    setSelectedFeatureId(null);
    const trigger = featureTriggerRef.current;
    featureTriggerRef.current = null;
    if (restoreFocus && trigger?.isConnected) {
      window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  }, []);

  const runFeature = useCallback((featureId: HomeFeatureId) => {
    const feature = getHomeFeature(featureId);
    if (feature.id === "companion-center") {
      invoke("open-companion-center");
      return;
    }
    if (feature.id === "continue") {
      if (home.note) {
        setActiveNoteRef({ noteId: home.note.noteId, noteVersionId: home.note.noteVersionId });
        invoke("open-notebook");
      } else {
        invoke("open-notes");
      }
      return;
    }
    if (feature.id === "current-notebook") {
      if (home.note) setActiveNoteRef({ noteId: home.note.noteId, noteVersionId: home.note.noteVersionId });
      invoke("open-notebook");
      return;
    }
    if (feature.id === "all-notes") {
      invoke("open-notes");
      return;
    }
    if (feature.id === "sources") {
      setActiveSourceId(null);
      invoke("open-sources");
      return;
    }
    if (feature.id === "global-search") {
      invoke("search");
      return;
    }
    if (feature.id === "understanding-graph") {
      invoke("graph");
      return;
    }
    if (feature.id === "settings") {
      invoke("open-settings");
      return;
    }
    openFeatureNotice(feature.id);
  }, [home.note, invoke, openFeatureNotice, setActiveNoteRef, setActiveSourceId]);

  useEffect(() => {
    if (!surface) return;
    setSelectedFeatureId(null);
    featureTriggerRef.current = null;
    // 离开书房去页面时，已聚焦的区域也要一起退：功能说明都在这里收，
    // 唯独漏了区域，于是回到书房还挂着一条区域功能签条——既像残留，又压住
    // 左下角承载「阅读起点」的任务岛。
    exitRegion();
  }, [exitRegion, surface]);

  useEffect(() => {
    const runRequestedFeature = (event: Event) => {
      const featureId = (event as CustomEvent<{ featureId?: unknown }>).detail?.featureId;
      if (isHomeFeatureId(featureId)) runFeature(featureId);
    };
    const showUnavailable = (event: Event) => {
      const featureId = (event as CustomEvent<{ featureId?: unknown }>).detail?.featureId;
      if (isHomeFeatureId(featureId)) openFeatureNotice(featureId);
    };
    const focusZone = (event: Event) => {
      const requested = (event as CustomEvent<{ zone?: HomeV2Zone }>).detail?.zone;
      if (requested && requested in HOME_V2_CAMERA_PRESETS) setZone(requested);
    };
    window.addEventListener("astella:home-v2-run-feature", runRequestedFeature);
    window.addEventListener("astella:home-unavailable", showUnavailable);
    window.addEventListener("astella:home-v2-focus-zone", focusZone);
    return () => {
      window.removeEventListener("astella:home-v2-run-feature", runRequestedFeature);
      window.removeEventListener("astella:home-unavailable", showUnavailable);
      window.removeEventListener("astella:home-v2-focus-zone", focusZone);
    };
  }, [openFeatureNotice, runFeature, setZone]);

  useEffect(() => {
    const leaveFocusedRegion = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || selectedFeatureId || zoneRef.current === "wide") return;
      event.preventDefault();
      exitRegion();
    };
    window.addEventListener("keydown", leaveFocusedRegion);
    return () => window.removeEventListener("keydown", leaveFocusedRegion);
  }, [exitRegion, selectedFeatureId]);

  useEffect(() => {
    setZone(zoneRef.current);
  }, [setZone]);

  const value = useMemo(() => ({
    zone,
    sceneTime,
    modalOpen,
    focusRegion,
    exitRegion,
    setZone,
    replayIntro,
    runFeature,
    featurePresentation,
  }), [exitRegion, featurePresentation, focusRegion, modalOpen, replayIntro, runFeature, sceneTime, setZone, zone]);

  return (
    <HomeV2Context.Provider value={value}>
      {children}
      <HomeV2AudioController />
      <HomeFeatureNoticeDialog featureId={selectedFeatureId} onClose={closeFeatureNotice} />
    </HomeV2Context.Provider>
  );
}

/**
 * 「新版页面尚未接入」的诚实落点。
 *
 * 当前注册表里 11 条功能全部已接线，所以这个弹窗**今天不会被任何入口打开**——
 * 留着是为了将来真有未接入功能时不必临时编一套说辞（守卫
 * `home-feature-wiring-guard` 双向核对着这件事）。
 * 它曾经还有一颗「查看全部功能」通往魔法目录；目录删掉后那颗按钮一起去掉，
 * 不留一颗按下去无处可去的按钮。
 */
function HomeFeatureNoticeDialog({ featureId, onClose }: { readonly featureId: HomeFeatureId | null; readonly onClose: (restoreFocus?: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { featurePresentation } = useHomeV2();
  const feature = featureId ? featurePresentation(featureId) : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (feature && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    } else if (!feature && dialog.open) dialog.close();
  }, [feature]);

  return (
    <dialog ref={dialogRef} className="home-v2-feature-notice" aria-labelledby="home-v2-feature-notice-title" aria-describedby="home-v2-feature-notice-detail" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={() => { if (featureId) onClose(); }}>
      {feature ? (
        <div className="home-v2-feature-notice__sheet">
          <span className="home-v2-feature-notice__status"><CircleAlert size={15} aria-hidden="true" />新版页面尚未接入</span>
          <h2 id="home-v2-feature-notice-title">{feature.title}</h2>
          <p id="home-v2-feature-notice-detail">{feature.definition.pendingDetail ?? feature.detail}</p>
          <div className="home-v2-feature-notice__actions">
            <button ref={closeRef} type="button" className="home-v2-feature-notice__primary" onClick={() => onClose()}>知道了</button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
