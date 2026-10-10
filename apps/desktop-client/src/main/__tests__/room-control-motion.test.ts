/**
 * 灵动岛的 CSS 减少动态覆盖与位移归属。
 * 导航是否即时响应由 HudRoomControl 的组件测试检验，不再固定等待动画的时长。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = "src/renderer/src/components/hud/hud-surface.css";
const STYLES = "src/renderer/src/styles.css";
const FULLSCREEN_CSS = "src/renderer/src/components/surfaces/notebook/notebook-fullscreen.css";
const NOTE_LIST_CSS = "src/renderer/src/components/surfaces/notebook/notebook-note-list.css";

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

/** 2026-10-09 用户裁决：Windows/Linux 不再把岛往左让位，改为贴右缘、沉到原生标题带下面。 */
describe("原生标题带下的贴右落位", () => {
  const platformRule = (css: string, selector: string) => {
    const at = css.indexOf(selector);
    expect(at, `找不到 ${selector}`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("岛只改 top，right 交回基线，不整体往左挪", () => {
    const rule = platformRule(read(CSS),
      '.desktop-app.hud-surface:is([data-platform="win32"], [data-platform="linux"]) .room-control');
    expect(rule, "岛又改回 right 了——往左让位会把岛从右上角摘下来").not.toMatch(/(^|[^-])\bright\s*:/);
    expect(rule, "岛的起算线没有走 --native-caption-band").toContain("var(--native-caption-band");
  });

  it("灵动岛与笔记全屏折签共用同一条起算线", () => {
    const styles = read(STYLES);
    expect(styles.match(/--native-caption-band:/g), "起算线应当只在 styles.css 声明一次")
      .toHaveLength(1);
    const rule = platformRule(read(FULLSCREEN_CSS),
      '.desktop-app.hud-surface[data-notebook-fullscreen]:is([data-platform="win32"], [data-platform="linux"])');
    expect(rule, "折签自己又写了一遍标题带高度").toContain("var(--native-caption-band");
    // 标题带一旦有两个源，调岛的高度就会和折签、笔记列表纸签错开成两行。
    for (const file of [FULLSCREEN_CSS, NOTE_LIST_CSS]) {
      expect(read(file), `${file} 又直接读 env(titlebar-area-height) 了`).not.toContain("env(titlebar-area-height");
    }
  });
});
