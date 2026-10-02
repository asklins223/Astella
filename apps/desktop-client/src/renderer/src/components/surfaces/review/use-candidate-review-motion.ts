import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { CardGenerationCandidateV1 } from "@ailearn/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../app/room-store";
import { resolveSceneMotionMode } from "../../../scene/scene-motion";
import type { CandidateSceneController } from "./candidate-card-scene";

export type CandidatePane = "front" | "dossier" | "answers" | "reject" | "stack";

export function useCandidateReviewMotion(candidateKey: string | null) {
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

  const resetTilt = () => {
    sceneRef.current?.resetTilt();
  };

  useLayoutEffect(() => {
    setPane("front"); resetTilt();
    if (previousKey.current && previousKey.current !== candidateKey) decisionRef.current?.focus({ preventScroll: true });
    previousKey.current = candidateKey;
  }, [candidateKey]);

  useEffect(() => { if (mode !== "full") resetTilt(); }, [mode]);

  const tilt = (event: PointerEvent<HTMLDivElement>, dragging = false) => {
    if (mode !== "full" || event.pointerType === "touch") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    sceneRef.current?.tilt(x, y, dragging);
  };

  const fly = (_candidate: CardGenerationCandidateV1, decision: "keep" | "reject") => {
    if (mode === "off") return;
    sceneRef.current?.depart(decision, boxRef.current?.getBoundingClientRect());
  };

  return { pane, setPane, deskRef, stageRef, boxRef, decisionRef, sceneRef, tilt, resetTilt, fly, mode };
}

export type CandidateReviewMotion = ReturnType<typeof useCandidateReviewMotion>;
