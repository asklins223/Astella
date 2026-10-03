export type PaperSpring = { value: number; velocity: number };

/** Exact damped oscillator: a new destination retains the current position and velocity. */
export function stepPaperSpring(state: PaperSpring, target: number, seconds: number, stiffness = 440, damping = 27): PaperSpring {
  const offset = state.value - target;
  const half = damping / 2;
  const frequency = Math.sqrt(stiffness - half * half);
  const b = (state.velocity + half * offset) / frequency;
  const sin = Math.sin(frequency * seconds), cos = Math.cos(frequency * seconds);
  const decay = Math.exp(-half * seconds);
  const wave = offset * cos + b * sin;
  return {
    value: target + decay * wave,
    velocity: decay * (-half * wave - offset * frequency * sin + b * frequency * cos),
  };
}

export const paperSpringAtRest = (state: PaperSpring, target: number, precision = .001) =>
  Math.abs(state.value - target) < precision && Math.abs(state.velocity) < precision * 10;
