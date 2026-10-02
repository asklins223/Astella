import { describe, expect, it } from "vitest";
import { directorySpring } from "../directory-rail-motion";

describe("directory spring", () => {
  it("Full has a small rebound and settles; Lite approaches without overshooting", () => {
    const full = Array.from({ length: 73 }, (_, frame) => directorySpring({ position: 0, velocity: 0 }, 1, frame / 100, "full"));
    expect(Math.max(...full.map(state => state.position))).toBeGreaterThan(1.03);
    expect(Math.max(...full.map(state => state.position))).toBeLessThan(1.08);
    expect(full.at(-1)!.position).toBeCloseTo(1, 3);
    const lite = Array.from({ length: 49 }, (_, frame) => directorySpring({ position: 0, velocity: 0 }, 1, frame / 100, "lite"));
    expect(lite.every(state => state.position >= 0 && state.position <= 1)).toBe(true);
    expect(lite.at(-1)!.position).toBeGreaterThan(0.98);
  });

  it("a reversal keeps both position and velocity, then turns smoothly to the new target", () => {
    const moving = directorySpring({ position: 0, velocity: 0 }, 1, 0.12, "full");
    expect(moving.velocity).toBeGreaterThan(0);
    const reversed = directorySpring(moving, 0, 0, "full");
    expect(reversed.position).toBeCloseTo(moving.position, 12);
    expect(reversed.velocity).toBeCloseTo(moving.velocity, 12);
    expect(directorySpring(moving, 0, 0.008, "full").position).toBeGreaterThan(moving.position);
    expect(directorySpring(moving, 0, 0.72, "full").position).toBeCloseTo(0, 3);
  });
});
