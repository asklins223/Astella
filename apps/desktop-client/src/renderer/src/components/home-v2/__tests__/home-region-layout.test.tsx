// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { SceneReferenceFrame } from "../../../scene/SceneReferenceFrame";
import { HomeV2ObjectLayer } from "../HomeV2ObjectLayer";
import { LIGHTHOUSE_HOME_SCENE_PROFILE } from "../home-scene-profile";

const rendererRoot = existsSync("src/renderer/src/styles.css")
  ? "src/renderer/src"
  : "apps/desktop-client/src/renderer/src";
const baseCss = readFileSync(`${rendererRoot}/styles.css`, "utf8");
const homeCss = readFileSync(`${rendererRoot}/components/home-v2/home-v2.css`, "utf8");

let stylesheet: HTMLStyleElement;

beforeEach(() => {
  useRoomStore.setState({ surface: null, onboardingOpen: false, viewPreset: "room" });
  stylesheet = document.createElement("style");
  stylesheet.textContent = `${baseCss}\n${homeCss}`;
  document.head.append(stylesheet);
});

afterEach(() => {
  cleanup();
  stylesheet.remove();
});

function renderRoom() {
  return render(
    <div className="desktop-app" data-home-scene-variant="v2">
      <div className="scene-stage">
        <SceneReferenceFrame className="room-reference-frame">
          <HomeV2ObjectLayer />
        </SceneReferenceFrame>
      </div>
    </div>,
  );
}

describe("首页实物与鼠标热区的样式接线", () => {
  it("场景组件实际带上维持参考画幅的定位样式", () => {
    const { container } = renderRoom();
    const frame = container.querySelector<HTMLElement>(".room-reference-frame")!;
    const style = getComputedStyle(frame);
    expect(style.position).toBe("absolute");
    expect(style.top).toBe("50%");
    expect(style.left).toBe("50%");
    expect(style.transform).toBe("translate(-50%, -50%)");
  });

  it("四个真实按钮都有独立的百分比热区，且覆盖各自的画面物件", () => {
    const { container } = renderRoom();
    const objects = container.querySelectorAll<HTMLElement>(".home-v2-object");
    expect(objects).toHaveLength(4);
    for (const object of objects) {
      const style = getComputedStyle(object);
      const readPercent = (property: string) => {
        const value = style.getPropertyValue(property);
        expect(value, `${object.dataset.zone} 的 ${property} 没有接上区域几何`).toMatch(/^[\d.]+%$/);
        return Number.parseFloat(value) / 100;
      };
      const x = readPercent("left");
      const y = readPercent("top");
      const width = readPercent("width");
      const height = readPercent("height");
      expect(width).toBeGreaterThan(0.1);
      expect(height).toBeGreaterThan(0.1);
      expect(style.pointerEvents).toBe("auto");
      const [anchorX, anchorY] = LIGHTHOUSE_HOME_SCENE_PROFILE.objectAnchors[object.dataset.roomObject!];
      expect(anchorX / LIGHTHOUSE_HOME_SCENE_PROFILE.world.width).toBeGreaterThanOrEqual(x);
      expect(anchorX / LIGHTHOUSE_HOME_SCENE_PROFILE.world.width).toBeLessThanOrEqual(x + width);
      expect(anchorY / LIGHTHOUSE_HOME_SCENE_PROFILE.world.height).toBeGreaterThanOrEqual(y);
      expect(anchorY / LIGHTHOUSE_HOME_SCENE_PROFILE.world.height).toBeLessThanOrEqual(y + height);
    }
  });
});
