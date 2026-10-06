import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { CardGenerationCandidateV1 } from "@astella/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../app/room-store";
import { resolveSceneMotionMode } from "../../../scene/scene-motion";
import type { CandidateSceneController } from "./candidate-card-spring";
import { createCardObjectSpring } from "../../motion/card-object-spring";

export type CandidatePane = "front" | "dossier" | "answers" | "reject" | "stack";

export function useCandidateReviewMotion(candidateKey: string | null, locked = false) {
  const preference = useRoomStore((state) => state.motionMode);
  const reduced = useRoomStore((state) => state.reducedMotion);
  const mode = resolveSceneMotionMode(preference, reduced);
  const [pane, setPane] = useState<CandidatePane>("front");
  const deskRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLButtonElement>(null);
  const decisionRef = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<CandidateSceneController | null>(null);
  const previousKey = useRef(candidateKey);
  const focusNextDecision = useRef(false);
  const flights = useRef(new Map<HTMLElement, ReturnType<typeof createCardObjectSpring>>());

  const resetTilt = () => {
    sceneRef.current?.resetTilt();
  };

  useLayoutEffect(() => {
    if (previousKey.current !== candidateKey) {
      setPane("front"); resetTilt();
      if (previousKey.current) focusNextDecision.current = true;
    }
    previousKey.current = candidateKey;
    if (!locked && focusNextDecision.current && decisionRef.current && !decisionRef.current.disabled) {
      decisionRef.current.focus({ preventScroll: true });
      focusNextDecision.current = false;
    }
  }, [candidateKey, locked]);

  useEffect(() => { if (mode !== "full") resetTilt(); }, [mode]);
  useEffect(() => {
    for (const [element, object] of flights.current) {
      if (mode === "off") { object.destroy(); element.remove(); }
      else object.mode(mode);
    }
    if (mode === "off") flights.current.clear();
  }, [mode]);
  useEffect(() => () => {
    for (const [element, object] of flights.current) { object.destroy(); element.remove(); }
    flights.current.clear();
  }, []);

  const tilt = (event: PointerEvent<HTMLDivElement>, dragging = false) => {
    if (mode !== "full" || event.pointerType === "touch") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    sceneRef.current?.tilt(x, y, dragging);
  };

  const fly = (candidate: CardGenerationCandidateV1, decision: "keep" | "reject", from?: DOMRect) => {
    if (mode === "off" || !from || !deskRef.current) return;
    const to = boxRef.current?.getBoundingClientRect();
    if (!to) return;
    // The acknowledgement moves a public paper echo. Live content and keyboard focus
    // already belong to the next candidate; answers are never copied into the echo.
    const element = document.createElement("div");
    element.className = "candidate-paper-flight";
    element.setAttribute("aria-hidden", "true"); element.inert = true;
    element.textContent = candidate.objective.publicSummary;
    Object.assign(element.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(element);
    const object = createCardObjectSpring(element);
    flights.current.set(element, object);
    object.mode(mode);
    object.target({ x: decision === "keep" ? to.left + to.width / 2 - from.left - from.width / 2 : -from.width * .55, y: decision === "keep" ? to.top + to.height / 2 - from.top - from.height / 2 : from.height * .6, rotate: decision === "keep" ? 13 : -24, scale: .12, open: 0 });
    object.kick({ y: -260, rotate: decision === "keep" ? 55 : -65 });
    object.settled(() => { object.destroy(); element.remove(); flights.current.delete(element); });
    sceneRef.current?.depart(decision, to);
  };

  return { pane, setPane, deskRef, stageRef, boxRef, decisionRef, sceneRef, tilt, resetTilt, fly, mode };
}

export type CandidateReviewMotion = ReturnType<typeof useCandidateReviewMotion>;
