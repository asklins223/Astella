import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CandidateReviewMotion } from "./use-candidate-review-motion";
import { createCandidateCardSpring } from "./candidate-card-spring";

/** WebGL paper thickness and lighting; semantic DOM keeps text selectable and readable. */
export function CandidateCardSpace({ motion, candidateKey, front, back, locked }: {
  readonly motion: CandidateReviewMotion;
  readonly candidateKey: string;
  readonly front: ReactNode;
  readonly back: ReactNode;
  readonly locked: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLDivElement>(null), backRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const current = useRef({ mode: motion.mode, back: motion.pane !== "front" });
  current.current = { mode: motion.mode, back: motion.pane !== "front" };
  const dragging = useRef(false);
  useEffect(() => {
    let disposed = false;
    const host = motion.stageRef.current;
    if (!host) return;
    const fallback = () => {
      if (disposed) return;
      motion.sceneRef.current?.destroy();
      const controller = createCandidateCardSpring(host);
      motion.sceneRef.current = controller;
      controller.setMode(current.current.mode); controller.setBack(current.current.back);
      setState("unavailable");
    };
    if (typeof WebGL2RenderingContext === "undefined" || typeof ResizeObserver === "undefined") fallback();
    else void import("./candidate-card-scene").then(({ createCandidateCardScene }) => {
      if (disposed || !canvasRef.current || !frontRef.current || !backRef.current) return;
      try {
        const controller = createCandidateCardScene(host, canvasRef.current, frontRef.current, backRef.current, fallback);
        motion.sceneRef.current = controller;
        controller.setMode(current.current.mode); controller.setBack(current.current.back); controller.arrive();
        setState("ready");
      } catch { fallback(); }
    }).catch(fallback);
    return () => { disposed = true; motion.sceneRef.current?.destroy(); motion.sceneRef.current = null; };
  }, [motion.sceneRef, motion.stageRef]);
  useLayoutEffect(() => { motion.sceneRef.current?.setMode(motion.mode); }, [motion.mode, motion.sceneRef]);
  useLayoutEffect(() => { motion.sceneRef.current?.setBack(motion.pane !== "front"); }, [motion.pane, motion.sceneRef]);
  useLayoutEffect(() => {
    motion.sceneRef.current?.arrive();
    motion.stageRef.current?.querySelectorAll(".candidate-card__body").forEach(node => { node.scrollTop = 0; });
  }, [candidateKey, motion.sceneRef, motion.stageRef]);
  const pointerEnd = () => { dragging.current = false; motion.resetTilt(); };
  return <div className="candidate-flip-stage" ref={motion.stageRef} data-card-3d={state} data-motion={motion.mode}
    onPointerDown={event => {
      if (locked || motion.mode !== "full" || event.button !== 0 || !(event.target instanceof Element) || !event.target.closest(".candidate-card__header") || event.target.closest("button, a, input")) return;
      event.preventDefault(); dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={event => motion.tilt(event, dragging.current)} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
    onPointerLeave={() => { if (!dragging.current) motion.resetTilt(); }}
    onDoubleClick={event => {
      if (locked || !(event.target instanceof Element) || event.target.closest("button, a, input, textarea") || window.getSelection()?.toString()) return;
      motion.resetTilt(); motion.setPane(motion.pane === "front" ? "dossier" : "front");
    }}>
    <canvas className="candidate-card__canvas" ref={canvasRef} aria-hidden="true" />
    <div className={`candidate-flip-card${motion.pane !== "front" ? " is-flipped" : ""}`}>
      <div className="candidate-flip-face candidate-flip-face--front" ref={frontRef} aria-hidden={motion.pane !== "front"} inert={motion.pane !== "front"}>{front}</div>
      <div className="candidate-flip-face candidate-flip-face--back" ref={backRef} aria-hidden={motion.pane === "front"} inert={motion.pane === "front"}>{back}</div>
    </div>
    {state === "unavailable" ? <span className="candidate-card__render-notice" role="status">3D 暂不可用，题面和审核操作仍可使用</span> : null}
  </div>;
}
