export type StarSpring = { position: number; velocity: number };
export type StarMotionMode = "full" | "lite" | "off";
export const STAR_PAN_DECAY_MS = 160;

/** A short drag earns a short coast; a paused hand has already stopped. */
export function starPanRelease(velocityX: number, velocityY: number, distance: number, idleMs: number, mode: StarMotionMode) {
  const speed = Math.hypot(velocityX, velocityY);
  if (mode !== "full" || speed === 0) return null;
  const travel = Math.min(120, Math.max(0, distance) * .45);
  const scale = Math.min(1, travel / STAR_PAN_DECAY_MS / speed) * Math.exp(-Math.max(0, idleMs) / 80);
  return speed * scale > .035 ? { velocityX: velocityX * scale, velocityY: velocityY * scale } : null;
}

/** Analytic spring: retargeting keeps the visible position and its velocity. */
export function stepStarSpring(state: StarSpring, target: number, seconds: number, mode: StarMotionMode = "full", response = .32): StarSpring {
  if (mode === "off") return { position: target, velocity: 0 };
  const frequency = 2 * Math.PI / response;
  const damping = mode === "lite" ? 1 : .73;
  const displacement = state.position - target;
  const decay = Math.exp(-damping * frequency * seconds);
  if (damping === 1) {
    const b = state.velocity + frequency * displacement;
    return {
      position: target + (displacement + b * seconds) * decay,
      velocity: (state.velocity - frequency * b * seconds) * decay,
    };
  }
  const oscillation = frequency * Math.sqrt(1 - damping * damping);
  const b = (state.velocity + damping * frequency * displacement) / oscillation;
  const sin = Math.sin(oscillation * seconds), cos = Math.cos(oscillation * seconds);
  const value = displacement * cos + b * sin;
  return {
    position: target + value * decay,
    velocity: decay * (-damping * frequency * value - displacement * oscillation * sin + b * oscillation * cos),
  };
}
