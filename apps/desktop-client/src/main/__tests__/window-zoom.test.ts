import { describe, expect, it } from "vitest";
import { zoomShortcutFactor } from "../window-zoom";

const command = { type: "keyDown", key: "=", control: false, meta: true, alt: false, isComposing: false };
describe("native page zoom", () => {
  it("uses actual 125%, 150% and 200% factors and can return to the original scale", () => {
    expect(zoomShortcutFactor(1, command, "darwin")).toBe(1.25);
    expect(zoomShortcutFactor(1.25, command, "darwin")).toBe(1.5);
    expect(zoomShortcutFactor(1.75, command, "darwin")).toBe(2);
    expect(zoomShortcutFactor(2, { ...command, key: "-" }, "darwin")).toBe(1.75);
    expect(zoomShortcutFactor(2, { ...command, key: "0" }, "darwin")).toBe(1);
    expect(zoomShortcutFactor(3, command, "darwin")).toBe(3);
  });
  it("respects the platform modifier and leaves composing, ordinary keys and key-up alone", () => {
    expect(zoomShortcutFactor(1, command, "win32")).toBeNull();
    expect(zoomShortcutFactor(1, { ...command, meta: false, control: true }, "win32")).toBe(1.25);
    expect(zoomShortcutFactor(1, { ...command, meta: false }, "darwin")).toBeNull();
    expect(zoomShortcutFactor(1, { ...command, isComposing: true }, "darwin")).toBeNull();
    expect(zoomShortcutFactor(1, { ...command, type: "keyUp" }, "darwin")).toBeNull();
    expect(zoomShortcutFactor(1, { ...command, key: "s" }, "darwin")).toBeNull();
  });
});
