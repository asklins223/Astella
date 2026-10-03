export type CardSpring = { position: number; velocity: number };

/** Exact damped spring step: a new target keeps the visible position and velocity. */
export function stepCardSpring(state: CardSpring, target: number, seconds: number, stiffness = 460, damping = 27): CardSpring {
  const half = damping / 2;
  const frequency = Math.sqrt(stiffness - half * half);
  const displacement = state.position - target;
  const b = (state.velocity + half * displacement) / frequency;
  const decay = Math.exp(-half * seconds);
  const sin = Math.sin(frequency * seconds), cos = Math.cos(frequency * seconds);
  const value = displacement * cos + b * sin;
  return {
    position: target + decay * value,
    velocity: decay * (-half * value - displacement * frequency * sin + b * frequency * cos),
  };
}

export const cardSpringAtRest = (state: CardSpring, target: number) => Math.abs(state.position - target) < .001 && Math.abs(state.velocity) < .01;
