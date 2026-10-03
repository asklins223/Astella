import { cardSpringAtRest, stepCardSpring, type CardSpring } from "../../motion/card-spring";

export type CardSceneMode = "full" | "lite" | "off";
export type CandidateSceneController = {
  setBack(back: boolean): void;
  setMode(mode: CardSceneMode): void;
  arrive(): void;
  tilt(x: number, y: number, dragging?: boolean): void;
  resetTilt(): void;
  depart(decision: "keep" | "reject", target: DOMRect | undefined): void;
  destroy(): void;
};

/** DOM paper stays at readable CSS size. Springs own its pose, never its content. */
export function createCandidateCardSpring(host: HTMLElement): CandidateSceneController {
  const tracks: CardSpring[] = [0, 0, 0, 0].map(position => ({ position, velocity: 0 }));
  const targets = [0, 0, 0, 0]; // flip, tilt X, tilt Y, arrival lift
  let mode: CardSceneMode = "full", frame = 0, lastTime = 0, disposed = false;
  const paint = () => {
    host.style.setProperty("--candidate-flip-turn", `${mode === "full" ? tracks[0].position : 0}deg`);
    host.style.setProperty("--candidate-tilt-x", `${mode === "full" ? tracks[1].position : 0}deg`);
    host.style.setProperty("--candidate-tilt-y", `${mode === "full" ? tracks[2].position : 0}deg`);
    host.style.setProperty("--candidate-lift", `${mode === "full" ? tracks[3].position : 0}px`);
    host.style.setProperty("--candidate-paper-opacity", String(mode === "lite" ? Math.max(.3, 1 - Math.abs(tracks[3].position) / 40) : 1));
  };
  const tick = (time: number) => {
    frame = 0;
    if (disposed) return;
    const dt = Math.min(.032, Math.max(.001, (time - lastTime) / 1000)); lastTime = time;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i] = stepCardSpring(tracks[i], targets[i], dt, i === 0 ? 370 : 460, i === 0 ? 29 : 26);
      if (cardSpringAtRest(tracks[i], targets[i])) tracks[i] = { position: targets[i], velocity: 0 };
    }
    paint();
    if (tracks.some((track, i) => !cardSpringAtRest(track, targets[i]))) requestDraw();
  };
  function requestDraw() {
    if (disposed) return;
    if (mode === "off") { targets.forEach((position, i) => { tracks[i] = { position, velocity: 0 }; }); paint(); return; }
    if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(tick); }
  }
  return {
    setBack(back) { targets[0] = back ? 180 : 0; if (mode === "lite") tracks[3].position = 8; requestDraw(); },
    setMode(next) {
      mode = next;
      if (next !== "full") targets[1] = targets[2] = targets[3] = 0;
      if (next === "off") { cancelAnimationFrame(frame); frame = 0; }
      requestDraw();
    },
    arrive() { if (mode !== "off") tracks[3] = { position: mode === "full" ? 18 : 8, velocity: tracks[3].velocity }; requestDraw(); },
    tilt(x, y) { if (mode === "full") { targets[1] = (y - .5) * -2.2; targets[2] = (x - .5) * 3; requestDraw(); } },
    resetTilt() { targets[1] = targets[2] = 0; requestDraw(); },
    depart(decision) { if (mode !== "off") { tracks[3].velocity += decision === "keep" ? -130 : 90; requestDraw(); } },
    destroy() {
      disposed = true; cancelAnimationFrame(frame);
      for (const name of ["flip-turn", "tilt-x", "tilt-y", "lift", "paper-opacity"]) host.style.removeProperty(`--candidate-${name}`);
    },
  };
}
