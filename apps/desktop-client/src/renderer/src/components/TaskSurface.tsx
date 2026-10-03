import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useRoomStore } from "../app/room-store";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { GraphSurface } from "./surfaces/space/graph-surface.tsx";
import { ReviewSurface } from "./surfaces/review/ReviewSurface.tsx";
import { StudySurface } from "./surfaces/study/StudySurface.tsx";
import { ResumableSurface } from "./surfaces/library/ResumableSurface.tsx";
import { ValidationSurface } from "./surfaces/run/validation-surface";
import { SurfaceReturnControl } from "./surfaces/study/SurfaceReturnControl.tsx";
import {
  ObjectiveDetailSurface,
  ObjectiveLibrarySurface,
} from "./surfaces/library/WorkspaceLibrarySurface.tsx";
import { CompanionCenterSurface } from "./surfaces/companion/companion-center-surface.tsx";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { NoteLibrarySurface } from "./surfaces/notebook/note-library-surface.tsx";
import { NotebookSurface } from "./surfaces/notebook/notebook-surface.tsx";
import { SearchSurface } from "./surfaces/study/search-surface.tsx";
import { SettingsSurface } from "./surfaces/settings/settings-surface.tsx";
import { SourceDetailSurface } from "./surfaces/source/source-detail-surface.tsx";
import { SourceLibrarySurface } from "./surfaces/source/source-library-surface.tsx";
import { resolveSceneMotionMode, sceneMotionDuration } from "../scene/scene-motion";

type ResolvedMotionMode = "full" | "lite" | "off";

function useResolvedMotionMode(): ResolvedMotionMode {
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  return resolveSceneMotionMode(motionPreference, reducedMotion);
}

function fallbackIntentForSurface(surface: NonNullable<ReturnType<typeof useRoomStore.getState>["surface"]>) {
  if (surface === "review") return "review";
  if (surface === "search") return "search";
  if (surface === "graph") return "graph";
  if (surface === "source-library" || surface === "source-detail") return "open-sources";
  if (surface === "note-library") return "open-notes";
  if (surface === "objective-library" || surface === "objective-detail") return "open-objectives";
  if (surface === "companion-center") return "open-companion-center";
  if (surface === "settings") return "open-settings";
  return "continue";
}

export function TaskSurface() {
  const surface = useRoomStore((state) => state.surface);
  const scenePhase = useRoomStore((state) => state.scenePhase);
  const motionMode = useResolvedMotionMode();
  const [renderedSurface, setRenderedSurface] = useState(surface);
  const [transition, setTransition] = useState<"entering" | "entered" | "leaving">(surface ? "entering" : "entered");
  const surfaceRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<{ element: HTMLElement; fallbackSelector: string } | null>(null);
  const lastSurfaceRef = useRef(surface);
  /**
   * 过渡的有界兜底（审计 F26）。
   *
   * 进/退场都由 GSAP 时间线的 `onComplete` 推进状态，而那条线靠 rAF 走帧——窗口失焦、
   * 被遮挡或后台时 Chromium 会把 rAF 停掉，`onComplete` 就永远不来：任务区停在
   * `leaving`（`aria-hidden` + `inert`），屏上只剩一个空容器，超时也不会自己好
   * （现场：>15 秒没有题目、加载态或可用退出控件，而 run 详情接口是 200）。
   * 完成本来就是个有界动作，所以补一条墙钟：到点谁先到谁推进状态，幂等。
   */
  const transitionDeadlineRef = useRef<number | null>(null);
  const clearTransitionDeadline = useCallback(() => {
    if (transitionDeadlineRef.current !== null) {
      window.clearTimeout(transitionDeadlineRef.current);
      transitionDeadlineRef.current = null;
    }
  }, []);
  const armTransitionDeadline = useCallback((delayMs: number, finish: () => void) => {
    clearTransitionDeadline();
    transitionDeadlineRef.current = window.setTimeout(() => {
      transitionDeadlineRef.current = null;
      finish();
    }, delayMs);
  }, [clearTransitionDeadline]);
  useEffect(() => clearTransitionDeadline, [clearTransitionDeadline]);

  useLayoutEffect(() => {
    // Start the destination's reads in this commit. Exit choreography must not
    // keep its loading, focus and controls waiting behind the previous page.
    if (surface && surface !== renderedSurface) {
      clearTransitionDeadline();
      setRenderedSurface(surface);
      setTransition("entering");
    }
  }, [clearTransitionDeadline, renderedSurface, surface]);

  useEffect(() => {
    if (surface) {
      lastSurfaceRef.current = surface;
      if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
        const element = document.activeElement;
        const fallbackIntent = fallbackIntentForSurface(surface);
        returnFocusRef.current = {
          element,
          fallbackSelector: `[data-focus-return="${element.dataset.focusReturn ?? fallbackIntent}"]`,
        };
      }
    }
  }, [surface]);

  useEffect(() => {
    if (renderedSurface) {
      if (renderedSurface !== surface) return;
      const frame = window.requestAnimationFrame(() => {
        const selector = renderedSurface === "search"
          ? "[data-search-query], .search-field input"
          : renderedSurface === "review"
            ? "[data-review-return-focus='true'], [data-surface-initial-focus], .surface-close"
            : "[data-surface-initial-focus], .surface-close";
        // The shared "return to study" pill is the close control of every HUD
        // page and lives outside the surface element, so the surface is searched
        // first and the document is the fallback — without it a page opened from
        // the rail kept focus on the rail chip and the surface was never entered.
        const target = surfaceRef.current?.querySelector<HTMLElement>(selector)
          ?? document.querySelector<HTMLElement>(selector);
        target?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const lastSurface = lastSurfaceRef.current;
    if (!lastSurface) return;
    const returnFocus = returnFocusRef.current;
    const fallbackSelector = returnFocus?.fallbackSelector ?? `[data-focus-return="${fallbackIntentForSurface(lastSurface)}"]`;
    returnFocusRef.current = null;
    lastSurfaceRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const element = returnFocus?.element;
      const canRestoreElement = element
        && element.isConnected
        && element !== document.body
        && element !== document.documentElement
        && !element.closest("[inert], [aria-hidden='true']");
      const target = canRestoreElement ? element : document.querySelector<HTMLElement>(fallbackSelector);
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renderedSurface, surface]);

  useLayoutEffect(
    () => {
      const root = surfaceRef.current;
      if (!root || !renderedSurface) return;
      if (surface && surface !== renderedSurface) return;

      const content = root.querySelector<HTMLElement>(".content") ?? root.querySelector<HTMLElement>(".surface-content");
      const header = root.querySelector<HTMLElement>(".task-artifact--header, .task-title");
      const artifacts = root.querySelectorAll<HTMLElement>(".task-artifact:not(.task-artifact--header)");
      const allAnimated = [content, header, ...artifacts].filter((target): target is HTMLElement => Boolean(target));
      const lite = motionMode === "lite";
      const surfaceEnterDuration = sceneMotionDuration(motionMode, "surfaceEnter");
      const surfaceExitDuration = sceneMotionDuration(motionMode, "surfaceExit");
      const isObjectSurface = renderedSurface === "study" || renderedSurface === "review" || renderedSurface === "search";

      if (surface !== renderedSurface) {
        setTransition("leaving");
        const settleExit = () => {
          setRenderedSurface(surface);
          setTransition(surface ? "entering" : "entered");
        };
        const finishExit = () => {
          clearTransitionDeadline();
          settleExit();
        };

        if (motionMode === "off") {
          gsap.set(allAnimated, { autoAlpha: 0 });
          finishExit();
          return;
        }

        const exitTimeline = gsap.timeline({
          defaults: {
            duration: surfaceExitDuration,
            ease: "power2.out",
          },
          onComplete: finishExit,
        });
        // 墙钟兜底：给足时间线本身的时长 + 余量；正常情况 onComplete 先到。
        armTransitionDeadline(surfaceExitDuration * 1000 + 400, settleExit);
        if (artifacts.length) {
          exitTimeline.to(
            artifacts,
            {
              autoAlpha: 0,
              y: lite ? 4 : 13,
              scale: lite ? 1 : 0.99,
              stagger: lite ? 0 : { each: 0.025, from: "end" },
            },
            0,
          );
        }
        if (header) {
          exitTimeline.to(header, { autoAlpha: 0, y: lite ? -3 : -9 }, 0);
        }
        if (content) {
          exitTimeline.to(content, { autoAlpha: 0, scale: lite ? 1 : 0.992 }, lite ? 0.04 : 0.1);
        }
        return () => { exitTimeline.kill(); clearTransitionDeadline(); };
      }

      setTransition("entering");
      const settleEnter = () => {
        gsap.set(allAnimated, { autoAlpha: 1, clearProps: "transform,opacity,visibility,clipPath" });
        setTransition("entered");
      };
      const finishEnter = () => {
        clearTransitionDeadline();
        settleEnter();
      };
      if (motionMode === "off") {
        gsap.set(allAnimated, { autoAlpha: 1, clearProps: "transform" });
        finishEnter();
        return;
      }

      const enterTimeline = gsap.timeline({
        defaults: {
          duration: surfaceEnterDuration,
          ease: "power3.out",
        },
        onComplete: finishEnter,
      });
      armTransitionDeadline(surfaceEnterDuration * 1000 + 400, () => {
        enterTimeline.kill();
        finishEnter();
      });
      enterTimeline.addLabel("artifact-rise", 0);
      if (content) {
        enterTimeline.fromTo(
          content,
          { autoAlpha: 0, y: lite ? 5 : 18, scale: lite ? 1 : 0.988 },
          { autoAlpha: 1, y: 0, scale: 1 },
          "artifact-rise",
        );
      }
      if (header) {
        enterTimeline.fromTo(
          header,
          { autoAlpha: 0, y: lite ? -4 : -12 },
          { autoAlpha: 1, y: 0, duration: lite ? 0.16 : 0.34 },
          "artifact-rise",
        );
      }
      if (artifacts.length && isObjectSurface) {
        const studyEntrance = renderedSurface === "study";
        enterTimeline.fromTo(
          artifacts,
          studyEntrance
            ? {
                autoAlpha: 0,
                y: lite ? 6 : 26,
                scale: lite ? 1 : 0.955,
                rotateX: lite ? 0 : -3.2,
                transformOrigin: "50% 100%",
              }
            : {
                autoAlpha: 0,
                x: lite ? -5 : -22,
                y: lite ? 5 : 18,
                scale: lite ? 1 : 0.97,
                rotateZ: lite ? 0 : -1.2,
                transformOrigin: "20% 100%",
              },
          {
            autoAlpha: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotateX: 0,
            rotateZ: 0,
            duration: surfaceEnterDuration * (lite ? 0.82 : studyEntrance ? 1 : 0.91),
          },
          lite ? "artifact-rise" : "artifact-rise+=0.05",
        );
      } else if (artifacts.length) {
        enterTimeline.fromTo(
          artifacts,
          { autoAlpha: 0, y: lite ? 6 : 22, scale: lite ? 1 : 0.982 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: surfaceEnterDuration * (lite ? 0.82 : 0.91),
            stagger: lite ? 0 : { amount: 0.12 },
          },
          lite ? "artifact-rise" : "artifact-rise+=0.08",
        );
      }
      // Kill only the superseded animation, retaining its presentation values
      // for an interrupted return. Context.revert previously jumped to the
      // authored start before the next transition could pick it up.
      return () => { enterTimeline.kill(); clearTransitionDeadline(); };
    },
    [motionMode, renderedSurface, surface, armTransitionDeadline, clearTransitionDeadline],
  );

  if (!renderedSurface) return null;

  return (
    <section
      ref={surfaceRef}
      className={`task-surface task-surface--spatial task-surface--${renderedSurface}`}
      data-surface={renderedSurface}
      data-transition={transition}
      data-scene-phase={scenePhase}
      data-motion-mode={motionMode}
      role="region"
      aria-label="当前学习任务"
      aria-hidden={transition === "leaving" || undefined}
      inert={transition === "leaving" || undefined}
      tabIndex={-1}
    >
      <div className="surface-content task-surface__spatial-layer" key={renderedSurface}>
        {/* 页面级兜底：一张纸坏掉不该带走整个书房。`key` 已经跟着 surface 变化，
            换页会重挂这一层，错误状态自然清掉，不需要额外的重置逻辑。 */}
        <RenderErrorBoundary label="这个页面">
          {renderedSurface === "study" ? <StudySurface /> : null}
          {renderedSurface === "resumable" ? <ResumableSurface /> : null}
          {renderedSurface === "notebook" ? <NotebookSurface /> : null}
          {renderedSurface === "card-generation" ? <CardGenerationSurface /> : null}
          {renderedSurface === "review" ? <ReviewSurface /> : null}
          {renderedSurface === "search" ? <SearchSurface /> : null}
          {renderedSurface === "graph" ? <GraphSurface /> : null}
          {renderedSurface === "validation" ? <ValidationSurface /> : null}
          {renderedSurface === "source-library" ? <SourceLibrarySurface /> : null}
          {renderedSurface === "source-detail" ? <SourceDetailSurface /> : null}
          {renderedSurface === "note-library" ? <NoteLibrarySurface /> : null}
          {renderedSurface === "objective-library" ? <ObjectiveLibrarySurface /> : null}
          {renderedSurface === "objective-detail" ? <ObjectiveDetailSurface /> : null}
          {renderedSurface === "companion-center" ? <CompanionCenterSurface /> : null}
          {renderedSurface === "settings" ? <SettingsSurface /> : null}
        </RenderErrorBoundary>
      </div>
    </section>
  );
}
