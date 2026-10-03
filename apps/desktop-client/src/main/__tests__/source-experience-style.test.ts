import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const renderer = new URL("../../renderer/src/components/", import.meta.url);
const experience = postcss.parse(readFileSync(fileURLToPath(new URL("surfaces/source/source-experience.css", renderer)), "utf8"));
const intake = postcss.parse(readFileSync(fileURLToPath(new URL("source-intake.css", renderer)), "utf8"));

function rule(selector: string): Rule {
  const found = experience.nodes.find(node => node.type === "rule" && node.selector === selector);
  expect(found, `Missing rule: ${selector}`).toBeDefined();
  return found as Rule;
}

function properties(target: Rule): Record<string, string> {
  const result: Record<string, string> = {};
  target.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  return result;
}

describe("Source experience style contracts", () => {
  it("shared tactile styles do not turn a native dialog or fixed drop overlay into a full-height page", () => {
    const root = properties(rule(".hud-surface .source-experience"));
    expect(root).not.toHaveProperty("position");
    expect(root).not.toHaveProperty("height");
    for (const page of ["source-desk", "source-reader"]) {
      expect(properties(rule(`.hud-surface .${page}.source-experience`))).toMatchObject({ position: "relative", height: "100%" });
    }
    intake.walkRules(".source-intake-drop", drop => {
      expect(properties(drop)).toMatchObject({ position: "fixed", inset: "0" });
    });
  });

  it("Lite drop arrival uses an opacity-only keyframe", () => {
    const lite = properties(rule('.hud-surface .source-experience[data-source-motion="lite"] .source-intake-drop__card'));
    expect(lite.animation).toContain("source-intake-drop-veil");
    intake.walkAtRules("keyframes", keyframes => {
      if (keyframes.params !== "source-intake-drop-veil") return;
      keyframes.walkDecls(declaration => { expect(declaration.prop).toBe("opacity"); });
    });
  });

  it("Off and system reduced motion also disable the overlay root animation", () => {
    let off = false;
    let reduced = false;
    experience.walkRules(target => {
      if (target.selectors.includes('.hud-surface .source-experience[data-source-motion="off"]')) {
        expect(properties(target)).toMatchObject({ animation: "none", transition: "none" });
        off = true;
      }
      if (target.parent?.type === "atrule" && target.parent.params === "(prefers-reduced-motion: reduce)") {
        expect(target.selectors).toContain(".hud-surface .source-experience");
        expect(properties(target)).toMatchObject({ animation: "none", transition: "none" });
        reduced = true;
      }
    });
    expect(off && reduced).toBe(true);
  });
});
