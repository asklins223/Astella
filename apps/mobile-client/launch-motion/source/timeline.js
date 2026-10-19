export const clamp = value => Math.max(0, Math.min(1, value));

function bezier(x1, y1, x2, y2) {
  const sample = (t, a, b) => 3 * (1-t)**2 * t * a + 3 * (1-t) * t*t * b + t**3;
  return progress => {
    const x = clamp(progress);
    if (x === 0 || x === 1) return x;
    let low = 0, high = 1, t = x;
    for (let i = 0; i < 18; i++) {
      t = (low + high) / 2;
      if (sample(t, x1, x2) < x) low = t; else high = t;
    }
    return sample(t, y1, y2);
  };
}

export const fade = bezier(.23, 1, .32, 1);
export const travel = bezier(.77, 0, .175, 1);

// Readiness comes only from the native session flow. There is no showcase timer.
export class LaunchClock {
  time = 0;
  last = null;
  active = true;
  reduced = false;
  ready = false;
  exitAt = null;
  exitDuration = null;
  seeded = false;

  configure({ active = this.active, reduced = this.reduced, ready = this.ready, elapsed }) {
    if (!this.seeded && Number.isFinite(elapsed)) {
      this.time = Math.max(0, elapsed);
      this.seeded = true;
    }
    if (active !== this.active) this.last = null;
    this.active = active;
    this.reduced = reduced;
    this.ready = ready;
    if (reduced && this.exitDuration !== null) this.exitDuration = .18;
  }

  tick(now, painted = true) {
    const dt = this.last === null ? 0 : Math.max(0, Math.min(.05, (now - this.last) / 1000));
    this.last = now;
    if (this.active) {
      this.time += dt;
      if (this.ready && painted && this.exitAt === null) {
        this.exitAt = this.time;
        this.exitDuration = this.reduced ? .18 : .72;
      }
    }
    const progress = this.exitAt === null ? 0 : clamp((this.time - this.exitAt) / this.exitDuration);
    return { time: this.time, progress, exit: this.reduced ? fade(progress) : travel(progress) };
  }
}
