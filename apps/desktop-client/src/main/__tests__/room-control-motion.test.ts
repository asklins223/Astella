/**
 * 灵动岛的 CSS 减少动态覆盖与位移归属。
 * 导航是否即时响应由 HudRoomControl 的组件测试检验，不再固定等待动画的时长。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = "src/renderer/src/components/hud/hud-surface.css";

function read(relative: string): string {
  const fromCwd = relative;
  const fromRoot = `apps/desktop-client/${relative}`;
  const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
  expect(path, `读不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
}

/** 只取 B0 那一段：文件有 6000 多行，别在整张表里瞎找。 */
function b0Section(css: string): string {
  const start = css.indexOf("B0 右上灵动岛");
  expect(start, "hud-surface.css 里找不到 B0 段（marker 被改名字了？）").toBeGreaterThan(-1);
  return css.slice(start);
}

describe("顶栏灵动岛的折叠时序", () => {
  it("reduced-motion 那段排在宽度规则之后", () => {
    const section = b0Section(read(CSS));
    const reduce = section.indexOf("@media (prefers-reduced-motion");
    expect(reduce, "B0 段里没有 reduced-motion 覆盖").toBeGreaterThan(-1);
    // 同特异度下靠源码顺序决胜：挪到前面，reduce 下岛就照样滑，而且没有任何运行时报错。
    expect(reduce, "reduced-motion 块被挪到了折叠规则之前，reduce 下宽度动画会赢回来")
      .toBeGreaterThan(section.indexOf(".hud-surface .room-control > button:not("));
  });

  it("胶囊自己不带 transform 过渡——位移只能由布局产生", () => {
    const section = b0Section(read(CSS));
    const at = section.lastIndexOf(".hud-surface .room-control > button.room-control-space {");
    expect(at, "找不到胶囊规则").toBeGreaterThan(-1);
    const rule = section.slice(at, section.indexOf("}", at));
    const transition = rule.match(/transition:\s*([^;]+);/)?.[1] ?? "";
    expect(transition, "胶囊带了 transform 过渡，会和岛的位移抢时间轴").not.toContain("transform");
  });
});
