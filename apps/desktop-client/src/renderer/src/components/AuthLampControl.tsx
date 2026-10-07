import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Clock3, LampDesk, MoonStar, Sun, Sunset } from "lucide-react";
import { sceneMotionDuration, type SceneMotionMode } from "../scene/scene-motion";
import { AUTH_SCENE_OPTIONS, authSceneLabel, type AuthScenePreference, type AuthSceneTime } from "./auth-scene-time";
gsap.registerPlugin(useGSAP);

export type LampTransitionDirection = `to-${AuthSceneTime}`;
type LampTransitionPhase = "idle" | "dimming" | "lamp-on" | "brightening" | "lamp-off" | "settling";
type LampFrameCaptureController = {
  seek: (time: number) => void;
  finish: () => void;
  timing: () => { duration: number; labels: Record<string, number> };
};

const lampFrameCaptureStorageKey = "astella:auth-lamp-frame-capture";

function lampFrameCaptureWindow(): Window & { __astellaAuthLampCapture?: LampFrameCaptureController } {
  return window as Window & { __astellaAuthLampCapture?: LampFrameCaptureController };
}

function isLampFrameCaptureEnabled(): boolean {
  return window.localStorage.getItem(lampFrameCaptureStorageKey) === "paused";
}

function clearLampFrameCapture(controller?: LampFrameCaptureController | null): void {
  const captureWindow = lampFrameCaptureWindow();
  if (!controller || captureWindow.__astellaAuthLampCapture === controller) {
    delete captureWindow.__astellaAuthLampCapture;
  }
}

function SceneTimeIcon({ scene }: { scene: AuthSceneTime }) {
  if (scene === "day") return <Sun size={14} aria-hidden="true" />;
  if (scene === "dusk") return <Sunset size={14} aria-hidden="true" />;
  return <MoonStar size={14} aria-hidden="true" />;
}

export function AuthLampControl({
  scene,
  targetScene,
  preference,
  systemScene,
  systemTimeLabel,
  motionMode,
  onSceneChange,
  onPreferenceChange,
  onLampCue,
}: {
  scene: AuthSceneTime;
  targetScene: AuthSceneTime;
  preference: AuthScenePreference;
  systemScene: AuthSceneTime;
  systemTimeLabel: string;
  motionMode: SceneMotionMode;
  onSceneChange: (scene: AuthSceneTime) => void;
  onPreferenceChange: (preference: AuthScenePreference) => void;
  onLampCue?: (direction: LampTransitionDirection) => void;
}) {
  const controlRef = useRef<HTMLDivElement>(null);
  const daySceneRef = useRef<HTMLSpanElement>(null);
  const duskSceneRef = useRef<HTMLSpanElement>(null);
  const nightSceneRef = useRef<HTMLSpanElement>(null);
  const dayScrimRef = useRef<HTMLSpanElement>(null);
  const nightScrimRef = useRef<HTMLSpanElement>(null);
  const pulseRef = useRef<HTMLSpanElement>(null);
  const pinRef = useRef<HTMLSpanElement>(null);
  const timeMenuRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const [transitionDirection, setTransitionDirection] = useState<LampTransitionDirection | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<LampTransitionPhase>("idle");
  const [timeMenuOpen, setTimeMenuOpen] = useState(false);
  const { contextSafe } = useGSAP({ scope: controlRef });

  const clearTransition = useCallback(() => {
    const elements = [daySceneRef.current, duskSceneRef.current, nightSceneRef.current, dayScrimRef.current, nightScrimRef.current, pulseRef.current, pinRef.current]
      .filter((element): element is HTMLElement => element instanceof HTMLElement);
    if (elements.length) {
      gsap.set(elements, { clearProps: "opacity,visibility,transform,willChange,backgroundColor,boxShadow" });
    }
  }, []);

  useEffect(() => () => {
    timelineRef.current?.kill();
    clearLampFrameCapture();
  }, []);

  useEffect(() => {
    if (motionMode !== "off" || !timelineRef.current) return;
    timelineRef.current.kill();
    timelineRef.current = null;
    clearTransition();
    clearLampFrameCapture();
    setTransitionDirection(null);
    setTransitionPhase("idle");
  }, [clearTransition, motionMode]);

  useGSAP(() => {
    const menu = timeMenuRef.current;
    if (!timeMenuOpen || !menu) return undefined;
    return gsap.fromTo(
      menu,
      { autoAlpha: 0, y: 8, scale: 0.96, transformOrigin: "left center" },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: sceneMotionDuration(motionMode, "surfaceEnter") > 0 ? 0.18 : 0,
        ease: "power3.out",
        clearProps: "transform,opacity,visibility",
      },
    );
  }, {
    scope: controlRef,
    dependencies: [motionMode, timeMenuOpen],
    revertOnUpdate: true,
  });

  useEffect(() => {
    if (!timeMenuOpen) return undefined;
    const closeWhenLeaving = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) {
        setTimeMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTimeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenLeaving, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenLeaving, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [timeMenuOpen]);

  const runSceneTransition = contextSafe((nextScene: AuthSceneTime) => {
    const dayScene = daySceneRef.current;
    const duskScene = duskSceneRef.current;
    const nightScene = nightSceneRef.current;
    const dayScrim = dayScrimRef.current;
    const nightScrim = nightScrimRef.current;
    const pulse = pulseRef.current;
    const pin = pinRef.current;
    if (!dayScene || !duskScene || !nightScene || !dayScrim || !nightScrim || !pulse || !pin || timelineRef.current) return;

    if (sceneMotionDuration(motionMode, "camera") <= 0) {
      onSceneChange(nextScene);
      return;
    }

    const direction: LampTransitionDirection = `to-${nextScene}`;
    const fullMotion = motionMode === "full";
    const sourceIsAdjacentToTarget = Math.abs(
      ["day", "dusk", "night"].indexOf(scene) - ["day", "dusk", "night"].indexOf(nextScene),
    ) === 1;
    const transitionDuration = sourceIsAdjacentToTarget
      ? fullMotion ? 0.28 : 0.2
      : fullMotion ? 0.38 : 0.25;
    const initialSceneDuration = sourceIsAdjacentToTarget
      ? transitionDuration
      : fullMotion ? 0.17 : 0.11;
    const finalSceneDuration = transitionDuration - (sourceIsAdjacentToTarget ? 0 : initialSceneDuration);
    const handoffAt = sourceIsAdjacentToTarget ? transitionDuration * 0.52 : initialSceneDuration + finalSceneDuration * 0.18;
    const pressDuration = fullMotion ? 0.09 : 0.07;
    const releaseDuration = fullMotion ? 0.16 : 0.12;
    const frameCaptureEnabled = isLampFrameCaptureEnabled();
    onLampCue?.(direction);
    setTransitionDirection(direction);
    const sourceRank = ["day", "dusk", "night"].indexOf(scene);
    const targetRank = ["day", "dusk", "night"].indexOf(nextScene);
    const sceneIsDimming = targetRank > sourceRank;
    setTransitionPhase(sceneIsDimming ? "dimming" : "brightening");
    const supportsIntermediateScene = !sourceIsAdjacentToTarget;
    gsap.killTweensOf([dayScene, duskScene, nightScene, dayScrim, nightScrim, pulse, pin]);
    const sceneNodes: Record<AuthSceneTime, HTMLSpanElement> = {
      day: dayScene,
      dusk: duskScene,
      night: nightScene,
    };
    for (const [sceneName, node] of Object.entries(sceneNodes) as [AuthSceneTime, HTMLSpanElement][]) {
      gsap.set(node, { autoAlpha: sceneName === scene ? 1 : 0, willChange: "opacity" });
    }
    gsap.set([dayScrim, nightScrim], { autoAlpha: 0, willChange: "opacity" });
    gsap.set(pulse, { autoAlpha: 0, scale: 0.42, willChange: "transform,opacity" });
    gsap.set(pin, { willChange: "transform,background-color,box-shadow" });

    let captureController: LampFrameCaptureController | null = null;
    const timeline = gsap.timeline({
      paused: frameCaptureEnabled,
      onComplete: () => {
        timelineRef.current = null;
        setTransitionDirection(null);
        setTransitionPhase("idle");
        clearTransition();
        clearLampFrameCapture(captureController);
      },
    });
    timelineRef.current = timeline;

    const startPhase = sceneIsDimming ? "dimming" : "brightening";
    const focalPhase = sceneIsDimming ? "lamp-on" : "lamp-off";

    timeline.addLabel(startPhase, 0);
    if (supportsIntermediateScene) {
      const sourceScene = sceneNodes[scene];
      const targetSceneNode = sceneNodes[nextScene];
      // A long jump still passes through the purpose-made dusk exposure. It is
      // a scene handoff, never a blanket dimmer over the interface.
      timeline
        .to(sourceScene, { autoAlpha: 0, duration: initialSceneDuration, ease: "sine.inOut" }, startPhase)
        .to(duskScene, { autoAlpha: 1, duration: initialSceneDuration, ease: "sine.inOut" }, startPhase)
        .to(duskScene, { autoAlpha: 0, duration: finalSceneDuration, ease: "sine.inOut" }, `${startPhase}+=${initialSceneDuration}`)
        .to(targetSceneNode, { autoAlpha: 1, duration: finalSceneDuration, ease: "sine.inOut" }, `${startPhase}+=${initialSceneDuration}`);
    } else {
      const sourceScene = sceneNodes[scene];
      const targetSceneNode = sceneNodes[nextScene];
      timeline
        .to(sourceScene, { autoAlpha: 0, duration: transitionDuration, ease: "sine.inOut" }, startPhase)
        .to(targetSceneNode, { autoAlpha: 1, duration: transitionDuration, ease: "sine.inOut" }, startPhase);
    }

    timeline
      .to(pulse, { autoAlpha: 0.88, scale: 0.96, duration: 0.075, ease: "power3.out" }, startPhase)
      .to(pulse, { autoAlpha: 0, scale: 1.44, duration: 0.22, ease: "power2.out" }, `${startPhase}+=0.065`)
      .to(pin, {
        scale: 0.9,
        backgroundColor: "rgba(118, 55, 27, 0.94)",
        boxShadow: "0 4px 10px rgba(35, 21, 13, 0.25), 0 0 0 6px rgba(255, 211, 132, 0.22)",
        duration: pressDuration,
        ease: "power2.out",
      }, startPhase)
      .to(pin, {
        scale: 1.045,
        backgroundColor: "rgba(161, 82, 31, 0.92)",
        boxShadow: "0 8px 20px rgba(35, 21, 13, 0.28), 0 0 0 10px rgba(255, 201, 113, 0.28)",
        duration: 0.1,
        ease: "power3.out",
      }, `${startPhase}+=0.065`)
      .to(pin, { scale: 1, duration: releaseDuration, ease: "power2.out" }, `${startPhase}+=0.16`)
      .addLabel(focalPhase, handoffAt)
      .call(() => setTransitionPhase(focalPhase), [], focalPhase)
      .call(() => onSceneChange(nextScene), [], focalPhase)
      .addLabel("settling", transitionDuration)
      .call(() => setTransitionPhase("settling"), [], "settling");

    if (frameCaptureEnabled) {
      captureController = {
        seek: (time) => {
          timeline.pause();
          timeline.time(gsap.utils.clamp(0, timeline.duration(), time), false);
        },
        finish: () => timeline.play(),
        timing: () => ({ duration: timeline.duration(), labels: { ...timeline.labels } }),
      };
      lampFrameCaptureWindow().__astellaAuthLampCapture = captureController;
    }
  });

  useEffect(() => {
    if (targetScene === scene || timelineRef.current) return;
    runSceneTransition(targetScene);
  }, [motionMode, scene, targetScene]);

  const handleLampPress = contextSafe(() => {
    if (timelineRef.current) return;
    const pulse = pulseRef.current;
    const pin = pinRef.current;
    if (sceneMotionDuration(motionMode, "camera") > 0 && pulse && pin) {
      gsap.killTweensOf([pulse, pin]);
      gsap.set(pulse, { autoAlpha: 0.58, scale: 0.5, willChange: "transform,opacity" });
      gsap.to(pulse, { autoAlpha: 0, scale: 1.14, duration: 0.24, ease: "power2.out", clearProps: "transform,opacity,willChange" });
      gsap.fromTo(pin, { scale: 0.94 }, { scale: 1, duration: 0.18, ease: "power3.out", clearProps: "transform" });
    }
    setTimeMenuOpen((open) => !open);
  });

  const handlePreferenceSelect = contextSafe((nextPreference: AuthScenePreference) => {
    if (timelineRef.current) return;
    setTimeMenuOpen(false);
    onPreferenceChange(nextPreference);
  });

  const isNight = scene === "night";
  const actionLabel = "调整场景时间";
  const systemDescription = `${systemTimeLabel} · ${authSceneLabel(systemScene)}`;

  return (
    <div
      ref={controlRef}
      className="desktop-access-gate__lamp-switch"
      data-transition-direction={transitionDirection ?? "idle"}
      data-transition-phase={transitionPhase}
    >
      <div className="desktop-access-gate__backdrop-stack" aria-hidden="true">
        <span ref={daySceneRef} className="desktop-access-gate__backdrop-layer desktop-access-gate__backdrop-layer--day" />
        <span ref={duskSceneRef} className="desktop-access-gate__backdrop-layer desktop-access-gate__backdrop-layer--dusk" />
        <span ref={nightSceneRef} className="desktop-access-gate__backdrop-layer desktop-access-gate__backdrop-layer--night" />
        <span ref={dayScrimRef} className="desktop-access-gate__backdrop-scrim desktop-access-gate__backdrop-scrim--day" />
        <span ref={nightScrimRef} className="desktop-access-gate__backdrop-scrim desktop-access-gate__backdrop-scrim--night" />
      </div>
      <button
        className="desktop-access-gate__lamp-control"
        type="button"
        disabled={transitionDirection !== null}
        data-lamp-lit={isNight}
        aria-label={actionLabel}
        aria-expanded={timeMenuOpen}
        aria-controls="desktop-gate-time-menu"
        title={actionLabel}
        onClick={handleLampPress}
      >
        <span ref={pulseRef} className="desktop-access-gate__lamp-control-pulse" aria-hidden="true" />
        <span ref={pinRef} className="desktop-access-gate__lamp-control-pin" aria-hidden="true">
          <LampDesk size={15} strokeWidth={1.8} />
        </span>
        <span className="desktop-access-gate__lamp-control-label" aria-hidden="true">时段</span>
      </button>
      {timeMenuOpen ? (
        <div ref={timeMenuRef} id="desktop-gate-time-menu" className="desktop-access-gate__time-menu" role="group" aria-label="选择场景时间">
          <button
            type="button"
            className="desktop-access-gate__time-option desktop-access-gate__time-option--system"
            data-scene-choice="system"
            data-selected={preference === "system"}
            aria-pressed={preference === "system"}
            onClick={() => handlePreferenceSelect("system")}
          >
            <Clock3 size={14} aria-hidden="true" />
            <span>跟随现在</span>
            <small>{systemDescription}</small>
          </button>
          <div className="desktop-access-gate__time-option-grid">
            {AUTH_SCENE_OPTIONS.map((option) => (
              <button
                key={option.scene}
                type="button"
                className="desktop-access-gate__time-option"
                data-scene-choice={option.scene}
                data-selected={preference === option.scene}
                aria-pressed={preference === option.scene}
                onClick={() => handlePreferenceSelect(option.scene)}
              >
                <SceneTimeIcon scene={option.scene} />
                <span>{option.label}</span>
                <small>{option.representativeTime}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
