export type UiSpring = { position: number; velocity: number };
export type UiMotionMode = "full" | "lite" | "off";

/** Closed-form spring: changing a destination retains the current position and velocity. */
export function stepUiSpring(state: UiSpring, target: number, seconds: number, mode: UiMotionMode): UiSpring {
  if (mode === "off") return { position: target, velocity: 0 };
  const stiffness = 420;
  const halfDamping = mode === "lite" ? 22 : 15;
  const displacement = state.position - target;
  if (halfDamping * halfDamping >= stiffness) {
    const root = Math.sqrt(halfDamping * halfDamping - stiffness);
    const slow = -halfDamping + root;
    const fast = -halfDamping - root;
    const a = (state.velocity - fast * displacement) / (slow - fast);
    const b = displacement - a;
    return {
      position: target + a * Math.exp(slow * seconds) + b * Math.exp(fast * seconds),
      velocity: a * slow * Math.exp(slow * seconds) + b * fast * Math.exp(fast * seconds),
    };
  }
  const frequency = Math.sqrt(stiffness - halfDamping * halfDamping);
  const b = (state.velocity + halfDamping * displacement) / frequency;
  const sin = Math.sin(frequency * seconds);
  const cos = Math.cos(frequency * seconds);
  const decay = Math.exp(-halfDamping * seconds);
  const value = displacement * cos + b * sin;
  return {
    position: target + decay * value,
    velocity: decay * (-halfDamping * value - displacement * frequency * sin + b * frequency * cos),
  };
}
