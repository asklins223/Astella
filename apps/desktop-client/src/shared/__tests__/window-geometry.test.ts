import { describe, expect, it } from "vitest";
import {
  HOME_WINDOW_INITIAL_CONTENT_SIZE,
  HOME_WINDOW_MINIMUM_SIZE,
  homeWindowSizeProblems,
} from ".././window-geometry";

describe("Home window geometry", () => {
  it("keeps the initial size above the native minimum", () => {
    expect(homeWindowSizeProblems(HOME_WINDOW_INITIAL_CONTENT_SIZE.width, HOME_WINDOW_INITIAL_CONTENT_SIZE.height))
      .toEqual([]);
  });

  it("keeps the native minimum itself reachable", () => {
    expect(homeWindowSizeProblems(HOME_WINDOW_MINIMUM_SIZE.width, HOME_WINDOW_MINIMUM_SIZE.height))
      .toEqual([]);
  });

  it("no longer rejects sizes that only break the retired ratio lock", () => {
    // These two used to fail for being off-ratio. With `setAspectRatio` gone the
    // renderer cover-fits the backplate, so a tall or a wide window is a normal
    // composition rather than a defect.
    expect(homeWindowSizeProblems(1024, 700)).toHaveLength(1);
    expect(homeWindowSizeProblems(1024, 700)[0]).toContain("1280x720");
    expect(homeWindowSizeProblems(1600, 1200)).toEqual([]);
    expect(homeWindowSizeProblems(2560, 1080)).toEqual([]);
  });

  it("rejects sizes below the minimum in either axis", () => {
    expect(homeWindowSizeProblems(1279, 810)).toHaveLength(1);
    expect(homeWindowSizeProblems(1440, 719)).toHaveLength(1);
    expect(homeWindowSizeProblems(720, 480)).toHaveLength(1);
  });

  it("rejects sizes that are not positive finite numbers", () => {
    expect(homeWindowSizeProblems(Number.NaN, 810)).toHaveLength(1);
    expect(homeWindowSizeProblems(1440, 0)).toHaveLength(1);
  });
});