// @vitest-environment jsdom

/**
 * 魔法目录已删除（2026-10-05 用户决定）。
 *
 * 这条测试守着三件事，因为它们都是**只有真窗口里才会发现**的形状：
 *  1. 没有主目标时，HUD 主按钮写的是「看看今天」，按下去把镜头走到**书桌**——
 *     不是把人带去另一张页面；
 *  2. 房间里任何位置都不再挂得出那张全屏清单，也没有指向它的控件；
 *  3. 书桌区域的四条入口还在——删掉目录不能顺手删掉唯一的导航。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../app/home-projection", () => ({
  useHomeProjection: () => ({ projection: null, loading: false, failure: null, reload: () => {} }),
  useHomeProjectionInvalidation: () => ({ workspaceEpoch: 1 }),
}));

import { HomeV2Provider } from "../HomeV2Experience";
import { HomeV2ObjectLayer } from "../HomeV2ObjectLayer";
import { useRoomStore } from "../../../app/room-store";

beforeEach(() => {
  useRoomStore.setState({ surface: null, onboardingOpen: false, viewPreset: "room" });
});

afterEach(cleanup);

function renderRoom() {
  return render(
    <div className="desktop-app">
      <HomeV2Provider>
        <HomeV2ObjectLayer />
      </HomeV2Provider>
    </div>,
  );
}

describe("魔法目录删除后 · 房间是唯一的导航", () => {
  it("没有主目标时主按钮写「看看今天」，按下去走到书桌", () => {
    const { container } = renderRoom();

    fireEvent.click(screen.getByRole("button", { name: /展开今日下一步/ }));
    const primary = screen.getByRole("button", { name: "看看今天" });
    fireEvent.click(primary);

    const objects = container.querySelector(".home-v2-objects")!;
    expect(objects.getAttribute("data-active-zone")).toBe("desk");
    expect(container.querySelector(".home-v2-region-menu")?.getAttribute("data-region")).toBe("desk");
  });

  it("房间里不再有那张全屏清单，也没有任何控件指向它", () => {
    const { container } = renderRoom();

    // 展开 HUD、按主按钮、再把四个区域都点一遍——旧入口每一条都在这半句里。
    fireEvent.click(screen.getByRole("button", { name: /展开今日下一步/ }));
    fireEvent.click(screen.getByRole("button", { name: "看看今天" }));
    fireEvent.keyDown(window, { key: "Escape" });
    for (const object of container.querySelectorAll<HTMLElement>(".home-v2-object")) {
      fireEvent.click(object);
      fireEvent.keyDown(window, { key: "Escape" });
    }

    expect(document.querySelector(".home-v2-catalog")).toBeNull();
    expect(document.querySelector(".home-v2-collection")).toBeNull();
    expect(screen.queryByLabelText("打开魔法目录")).toBeNull();
    expect(screen.queryByText("魔法目录")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看全部功能" })).toBeNull();
  });

  it("书桌区域仍然摆着今天那几件东西", () => {
    const { container } = renderRoom();
    fireEvent.click(container.querySelector<HTMLElement>('[data-room-object="desk-book"]')!);

    const menu = container.querySelector('.home-v2-region-menu[data-region="desk"]')!;
    const features = [...menu.querySelectorAll("[data-feature]")].map((node) => node.getAttribute("data-feature"));
    expect(features).toEqual(["continue", "today-review"]);
  });
});
