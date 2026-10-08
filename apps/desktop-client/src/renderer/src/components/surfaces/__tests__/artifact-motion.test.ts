import { expect, test } from "vitest";
import { resolveArtifactMotion } from "../source/artifact-motion";

test("轻量书房保留教学动画，Off 和系统减少动态停止自动动效", () => {
  expect(resolveArtifactMotion("full", false)).toBe("full");
  expect(resolveArtifactMotion("lite", false)).toBe("full");
  expect(resolveArtifactMotion("off", false)).toBe("reduced");
  for (const mode of ["full", "lite", "off"] as const) {
    expect(resolveArtifactMotion(mode, true)).toBe("reduced");
  }
});
