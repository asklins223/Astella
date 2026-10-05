import { describe, expect, it } from "vitest";
import { companionFloatingPlacement, companionHistoryPlacement } from "../companion-interaction-placement";
import type { Rect } from "../companion-home-placement";

const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("conversation book placement", () => {
  it.each([340, 760])("keeps a %ipx settings paper or book clear of the task tab and controls", (width) => {
    const role = { left: 1150, right: 1410, top: 530, bottom: 790 };
    const controls = [{ left: 1098, right: 1142, top: 600, bottom: 780 },
      { left: 1030, right: 1160, top: 510, bottom: 550 }];
    const paper = companionHistoryPlacement(role, 1440, width, controls);
    expect(paper.width).toBe(width);
    expect(paper.left + paper.width).toBeLessThanOrEqual(controls[1].left - 16);
  });
  it.each([
    { width: 1440, role: { left: 100, right: 390, top: 530, bottom: 790 }, side: "right" },
    { width: 1440, role: { left: 1130, right: 1420, top: 530, bottom: 790 }, side: "left" },
    { width: 1280, role: { left: 100, right: 390, top: 480, bottom: 700 }, side: "right" },
    { width: 853, role: { left: 55, right: 245, top: 300, bottom: 470 }, side: "right" },
    { width: 853, role: { left: 635, right: 835, top: 300, bottom: 470 }, side: "left" },
    { width: 720, role: { left: 260, right: 460, top: 220, bottom: 390 }, side: "left" },
  ])("keeps the complete model visible at $width CSS pixels", ({ width, role, side }) => {
    const original = { ...role };
    const book = companionHistoryPlacement(role, width);
    expect(book.side).toBe(side);
    expect(book.width).toBeGreaterThan(200);
    expect(book.width).toBeLessThanOrEqual(760);
    expect(book.left).toBeGreaterThanOrEqual(18);
    expect(book.left + book.width).toBeLessThanOrEqual(width - 18);
    if (side === "left") expect(book.left + book.width).toBeLessThanOrEqual(role.left - 16);
    else expect(book.left).toBeGreaterThanOrEqual(role.right + 16);
    expect(role).toEqual(original);
  });
});

describe("floating companion placement", () => {
  it.each([124, 220, 380, 680])("keeps %ipx floating content and rich papers outside either interaction seat", (headHeight) => {
    for (const viewport of [{ width: 1440, height: 810 }, { width: 720, height: 405 }]) {
      for (const side of ["left", "right"] as const) {
        const role = { left: viewport.width - 240, right: viewport.width - 20, top: viewport.height - 240, bottom: viewport.height - 20 };
        const controls = [
          { left: role.left - 60, right: role.left - 8, top: viewport.height - 185, bottom: viewport.height - 12 },
          { left: role.left - 115, right: role.left + 15, top: viewport.height - 260, bottom: viewport.height - 220 },
        ];
        const mirror = (box: Rect): Rect => side === "left" ? box : { ...box, left: viewport.width - box.right, right: viewport.width - box.left };
        const protectedRole = mirror(role), protectedControls = controls.map(mirror);
        const layout = companionFloatingPlacement({ role: protectedRole, controls: protectedControls, viewport, headHeight, hasPapers: true });
        for (const box of [layout.head, layout.papers]) {
          expect(box.width).toBeGreaterThanOrEqual(180);
          expect(box.height).toBeGreaterThan(0);
          expect(box.left).toBeGreaterThanOrEqual(14);
          expect(box.right).toBeLessThanOrEqual(viewport.width - 14);
          expect(box.top).toBeGreaterThanOrEqual(48);
          expect(box.bottom).toBeLessThanOrEqual(viewport.height - 14);
          for (const control of [protectedRole, ...protectedControls]) expect(overlaps(box, control)).toBe(false);
        }
        expect(overlaps(layout.head, layout.papers)).toBe(false);
      }
    }
  });
  it.each([
    { role: { left: 100, right: 390, top: 530, bottom: 790 }, viewport: { width: 1440, height: 810 }, dock: "above" },
    { role: { left: 496, right: 704, top: 150, bottom: 390 }, viewport: { width: 720, height: 405 }, dock: "left" },
    { role: { left: 16, right: 224, top: 155, bottom: 390 }, viewport: { width: 720, height: 405 }, dock: "right" },
    { role: { left: 100, right: 650, top: 80, bottom: 150 }, viewport: { width: 720, height: 405 }, dock: "below" },
  ])("points the bubble toward the actual role from $dock", ({ role, viewport, dock }) => {
    const layout = companionFloatingPlacement({ role, viewport, headWidth: 280, headHeight: 124 });
    expect(layout.headDock).toBe(dock);
    expect(overlaps(layout.head, role)).toBe(false);
  });
  it("does not move a compact input to make room for papers that are not present", () => {
    const layout = companionFloatingPlacement({ role: { left: 496, right: 704, top: 150, bottom: 390 },
      viewport: { width: 720, height: 405 }, headWidth: 280, headHeight: 124 });
    expect(layout.head).toMatchObject({ left: 200, top: 150, width: 280, height: 124 });
    expect(layout.headDock).toBe("left");
  });
  it("reserves a readable paper below a central role when neither side has room", () => {
    const role = { left: 100, right: 650, top: 80, bottom: 150 };
    const layout = companionFloatingPlacement({ role, viewport: { width: 720, height: 405 },
      headHeight: 220, hasPapers: true });
    expect(layout.head.height).toBeGreaterThan(80);
    expect(layout.papers.height).toBeGreaterThanOrEqual(100);
    expect(layout.papers.width).toBe(360);
    expect(overlaps(layout.head, role)).toBe(false);
    expect(overlaps(layout.papers, role)).toBe(false);
    expect(overlaps(layout.papers, layout.head)).toBe(false);
  });
  it.each([
    { width: 1440, height: 810, role: { left: 1180, right: 1415, top: 545, bottom: 790 }, side: "left" },
    { width: 1440, height: 810, role: { left: 24, right: 258, top: 520, bottom: 790 }, side: "right" },
    { width: 1060, height: 700, role: { left: 798, right: 1034, top: 370, bottom: 676 }, side: "left" },
    { width: 720, height: 405, role: { left: 496, right: 704, top: 150, bottom: 390 }, side: "left" },
    { width: 720, height: 405, role: { left: 16, right: 224, top: 155, bottom: 390 }, side: "right" },
    { width: 1280, height: 720, role: { left: 680, right: 900, top: 90, bottom: 385 }, side: "left" },
  ])("uses the body-facing side at $width × $height without moving the role", ({ width, height, role, side }) => {
    const original = { ...role };
    const layout = companionFloatingPlacement({ role, viewport: { width, height }, headHeight: 220, hasPapers: true });
    expect(layout.side).toBe(side);
    expect(role).toEqual(original);
    expect(overlaps(layout.head, role)).toBe(false);
    expect(overlaps(layout.papers, role)).toBe(false);
    expect(overlaps(layout.head, layout.papers)).toBe(false);
    for (const box of [layout.head, layout.papers]) {
      expect(box.left).toBeGreaterThanOrEqual(14);
      expect(box.right).toBeLessThanOrEqual(width - 14);
      expect(box.top).toBeGreaterThanOrEqual(48);
      expect(box.bottom).toBeLessThanOrEqual(height - 14);
    }
    expect(layout.papers.height).toBeGreaterThan(80);
  });
});
