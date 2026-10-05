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
import { useCompanionHomeProjection } from "../../app/companion-home-projection";
import { useHomeProjection } from "../../app/home-projection";
import { useHomeNextStepProjection } from "../surfaces/library/home-next-step-projection.ts";
import { homePresentation } from "../../app/home-presentation";
import { useRoomStore } from "../../app/room-store";
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
  "today-review",
  "current-notebook",
  "current-target",
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
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
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
    window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "footstep" } }));
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

  /**
   * 「今日下一步」的**真实读数**（§12.1）。
   *
   * 服务端/IPC/preload 早就有 `readHomeSuggestion`，这里拿它给书桌上那一条填**理由**：
   * 没有建议时那句「今天没有到期的事 / 今天的位置暂时读不到」也出自这份读数，而不是
   * `homePresentation` 那句"标题"。
   * 读不到时**不用旧投影顶替**：那会把"读不到"说成"今天没有事"。
   *
   * 2026-10-05 用户决定：随魔法目录一起删掉 §12.1 那张独立便签（理由 / 换一个 /
   * 暂不处理）。这份读数只留在书桌条目上，不再单独占一块。
   */
  const homeNextStep = useHomeNextStepProjection();

  const featurePresentation = useCallback((featureId: HomeFeatureId): HomeFeatureRuntimeV1 => {
    const definition = getHomeFeature(featureId);
    let detail = definition.purpose;
    let meta = definition.availability === "native" ? "小屋可用" : "新版页面尚未接入";
    let state: HomeFeatureRuntimeV1["state"] = definition.availability === "native" ? "ready" : "pending";

    switch (featureId) {
      case "continue":
        // 有真实读数就用它（它带理由，且理由是必填非空的那一份）。
        const wire = homeNextStep.kind === "wire" ? homeNextStep.suggestion : null;
        if (wire?.kind === "suggested") {
          detail = wire.headline;
          // 理由整句放得下；截断要保留出处，不另写一句短的。
          meta = wire.reasonLine;
        } else if (wire?.kind === "nothing_due") {
          detail = "今天没有到期的事";
          meta = "可以新建笔记、从资料写一篇，或接着读最近那篇";
        } else {
          detail = home.title;
          meta = homeNextStep.kind === "loading" ? "正在看今天的位置…" : "今天的位置暂时读不到";
        }
        break;
      case "today-review":
        detail = home.reviewLabel;
        // 同一条（审计 F25）：读不到时不要用"数量 —"冒充加载态——它在同步和读失败之间
        // 长得一样。两种状态各说各的。
        meta = home.dueCount !== null
          ? `${home.dueCount} 项待复习`
          : home.reviewState === "syncing" ? "正在读取…" : "暂时读不到";
        break;
      case "current-notebook":
        detail = home.note?.title ?? "还没有存好的研究册";
        // 审计 F25：投影不含全量总数（`noteCount` 恒为 null），此前卡片附注写"数量 —"，
        // 读起来像"还没加载完"。这一格要说的是"点进去能做什么"，不是全库有多少。
        meta = home.note ? "继续阅读" : "从一份材料开始";
        break;
      case "current-target":
        detail = home.hasFocus ? "今天的主目标已经定下" : "还没定下今天的主目标";
        meta = home.hasFocus ? "查看这个目标" : "从一篇笔记开始学习";
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
    window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "page" } }));
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
    if (feature.id === "today-review") {
      invoke("review");
      return;
    }
    if (feature.id === "continue") {
      // 审计 F24：这张卡的附注写着「N 项可恢复」，那点击就必须到那 N 项上——
      // 恰好一条时直达那条 run；两条以上时进「未完成的学习」清单；读不到时
      // 才退回原来的今日学习（那是历史日志，不是待办清单）。
      if (home.soleActiveRun) {
        setActiveRunId(home.soleActiveRun.runId);
        invoke("validate");
        return;
      }
      if ((home.activeRunCount ?? 0) > 1) {
        invoke("open-resumable");
        return;
      }
      invoke("continue");
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
    if (feature.id === "current-target") {
      const objectiveId = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data.objective.objectiveId : null;
      if (objectiveId) {
        setActiveObjectiveId(objectiveId);
        invoke("open-objective");
      } else {
        invoke("open-objectives");
      }
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
  }, [home.note, home.soleActiveRun, invoke, openFeatureNotice, projection, setActiveNoteRef, setActiveObjectiveId, setActiveRunId, setActiveSourceId]);

  useEffect(() => {
    if (!surface) return;
    setSelectedFeatureId(null);
    featureTriggerRef.current = null;
    // 离开书房去页面时，已聚焦的区域也要一起退：功能说明都在这里收，
    // 唯独漏了区域，于是回到书房还挂着一条区域功能签条——既像残留，又压住
    // 左下角承载「今日下一步」的任务岛。
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
    window.addEventListener("ailearn:home-v2-run-feature", runRequestedFeature);
    window.addEventListener("ailearn:home-unavailable", showUnavailable);
    window.addEventListener("ailearn:home-v2-focus-zone", focusZone);
    return () => {
      window.removeEventListener("ailearn:home-v2-run-feature", runRequestedFeature);
      window.removeEventListener("ailearn:home-unavailable", showUnavailable);
      window.removeEventListener("ailearn:home-v2-focus-zone", focusZone);
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
