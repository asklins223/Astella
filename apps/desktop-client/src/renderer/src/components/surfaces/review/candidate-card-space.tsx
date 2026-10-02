import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CandidateReviewMotion } from "./use-candidate-review-motion";

/** WebGL owns the physical card; semantic DOM is projected onto its two faces. */
export function CandidateCardSpace({ motion, candidateKey, front, back, locked }: {
  readonly motion: CandidateReviewMotion;
  readonly candidateKey: string;
  readonly front: ReactNode;
  readonly back: ReactNode;
  readonly locked: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const current = useRef({ mode: motion.mode, back: motion.pane !== "front" });
  current.current = { mode: motion.mode, back: motion.pane !== "front" };
  const drag = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fail = () => { if (!cancelled) { setState("unavailable"); motion.sceneRef.current?.destroy(); motion.sceneRef.current = null; } };
    if (typeof WebGL2RenderingContext === "undefined" || typeof ResizeObserver === "undefined") { fail(); return; }
    void import("./candidate-card-scene").then(({ createCandidateCardScene }) => {
      if (cancelled || !canvasRef.current || !frontRef.current || !backRef.current || !motion.stageRef.current) return;
      try {
        const controller = createCandidateCardScene(motion.stageRef.current, canvasRef.current, frontRef.current, backRef.current, fail);
        motion.sceneRef.current = controller;
        controller.setMode(current.current.mode); controller.setBack(current.current.back); setState("ready");
      } catch { fail(); }
    }).catch(fail);
    return () => { cancelled = true; motion.sceneRef.current?.destroy(); motion.sceneRef.current = null; };
  }, [motion.sceneRef, motion.stageRef]);

  useEffect(() => { motion.sceneRef.current?.setBack(motion.pane !== "front"); }, [motion.pane, motion.sceneRef]);
  useEffect(() => { motion.sceneRef.current?.setMode(motion.mode); }, [motion.mode, motion.sceneRef]);
  useEffect(() => { motion.sceneRef.current?.arrive(); }, [candidateKey, motion.sceneRef]);

  const pointerEnd = () => { drag.current = false; motion.resetTilt(); };
  return <div className="candidate-flip-stage" data-card-3d={state} ref={motion.stageRef}
    onPointerDown={(event) => {
      if (motion.mode !== "full" || event.button !== 0 || (event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      drag.current = true; event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={(event) => motion.tilt(event, drag.current)} onPointerUp={pointerEnd}
    onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onPointerLeave={() => { if (!drag.current) motion.resetTilt(); }}
    onDoubleClick={(event) => { if (!locked && !(event.target as HTMLElement).closest("button, a, input")) { motion.resetTilt(); motion.setPane(motion.pane === "front" ? "dossier" : "front"); } }}>
    <canvas className="candidate-card__canvas" ref={canvasRef} aria-hidden="true" />
    <div className={`candidate-flip-card${motion.pane !== "front" ? " is-flipped" : ""}`}>
      <div className="candidate-flip-face candidate-flip-face--front" ref={frontRef} aria-hidden={motion.pane !== "front"} inert={motion.pane !== "front"}>{front}</div>
      <div className="candidate-flip-face candidate-flip-face--back" ref={backRef} aria-hidden={motion.pane === "front"} inert={motion.pane === "front"}>{back}</div>
    </div>
    {state === "unavailable" ? <span className="candidate-card__render-notice" role="status">3D 暂不可用，完整题面仍可审核</span> : null}
  </div>;
}
