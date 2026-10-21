import { describe, expect, it } from "vitest";
import { homeV2ShortcutFeature, shouldIgnoreGlobalShortcut } from "../App.tsx";

const allowed = {
  defaultPrevented: false,
  isComposing: false,
  keyCode: 71,
  onboardingOpen: false,
  typingTarget: false,
  modalOpen: false,
};

describe("desktop global shortcut policy", () => {
  it("honors a focused object's consumed shortcut before the window handler", () => {
    expect(shouldIgnoreGlobalShortcut({ ...allowed, defaultPrevented: true })).toBe(true);
  });

  it("does not steal keys from text entry, IME, onboarding, or modal surfaces", () => {
    expect(shouldIgnoreGlobalShortcut({ ...allowed, typingTarget: true })).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ ...allowed, isComposing: true })).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ ...allowed, keyCode: 229 })).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ ...allowed, onboardingOpen: true })).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ ...allowed, modalOpen: true })).toBe(true);
  });

  it("leaves an unconsumed room shortcut available", () => {
    expect(shouldIgnoreGlobalShortcut(allowed)).toBe(false);
  });
});

describe("Home V2 shortcut registry routing", () => {
  const plain = { metaKey: false, ctrlKey: false, altKey: false };

  it("maps each shortcut to its specific feature instead of a generic notice", () => {
    expect(homeV2ShortcutFeature({ ...plain, key: "k", ctrlKey: true })).toBe("global-search");
    expect(homeV2ShortcutFeature({ ...plain, key: "g" })).toBe("understanding-graph");
    // Plan 57：复习/今日两屏连同它们的快捷键一起退役，按 r 不再带走任何一屏。
    expect(homeV2ShortcutFeature({ ...plain, key: "r" })).toBeNull();
  });

  it("does not claim unrelated or modified room keys", () => {
    expect(homeV2ShortcutFeature({ ...plain, key: "x" })).toBeNull();
    expect(homeV2ShortcutFeature({ ...plain, key: "g", altKey: true })).toBeNull();
  });
});
