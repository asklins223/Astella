import { describe, expect, it } from "vitest";
import { companionControlsBounds, live2DHeadDrawableIndices, projectVisibleLive2DBounds } from "../companion-visible-bounds";

describe("visible model geometry", () => {
  it("projects y-down drawable pixels and includes props beyond the body", () => {
    const model = { width: 1000, height: 1000, scale: .2, x: 100, y: 100 };
    const body = { x: 200, y: 200, width: 500, height: 600 };
    const cup = { x: 80, y: 650, width: 150, height: 200 };
    expect(projectVisibleLive2DBounds([body], model, { width: 200, height: 200 }))
      .toEqual({ left: 40, right: 140, top: 40, bottom: 160 });
    expect(projectVisibleLive2DBounds([body, cup], model, { width: 200, height: 200 }))
      .toEqual({ left: 16, right: 140, top: 40, bottom: 170 });
  });
  it("clips the visible bust and keeps controls beyond the supplied protected edges on either side", () => {
    const role = projectVisibleLive2DBounds([{ x: 80, y: 100, width: 800, height: 1100 }],
      { width: 1000, height: 1000, scale: .25, x: 100, y: 140 }, { width: 200, height: 200 })!;
    expect(role.bottom).toBe(200);
    const leftSeat = companionControlsBounds(role, { width: 800, height: 450 }, { width: 44, height: 179 });
    expect(leftSeat.side).toBe("right");
    expect(leftSeat.left).toBe(role.right + 8);
    const moved = { ...role, left: role.left + 580, right: role.right + 580 };
    const rightSeat = companionControlsBounds(moved, { width: 800, height: 450 }, { width: 44, height: 179 });
    expect(rightSeat.side).toBe("left");
    expect(rightSeat.right).toBe(moved.left - 8);
  });

  it("protects hair descendants while excluding tail and desk parts", () => {
    const model = {
      parts: { ids: ["Head", "HairMesh", "Tail", "TailFin", "Desk"], parentIndices: [-1, 0, -1, 2, -1] },
      drawables: { parentPartIndices: [1, 0, 3, 4] },
    };
    expect([...live2DHeadDrawableIndices(model, ["Head"])]).toEqual([0, 1]);
    expect([...live2DHeadDrawableIndices(model, ["Tail"])]).toEqual([2]);
    expect([...live2DHeadDrawableIndices(undefined, ["Head"])]).toEqual([]);
  });
});
