/**
 * 窗口标题按钮与登录门的层序守卫。
 *
 * 判据只有一条：`.window-caption` 必须压在 `.desktop-access-gate` 之上，同时仍低于带路浮层。
 * 登录门是不透明的整页纸（`background: #f3e7cf`、`inset: 0`），一旦它跑到前面，Windows 上
 * 右上角三颗自绘按钮既看不见也点不动——无边框窗口没有系统标题栏，这唯一一个关窗出口就在
 * 门禁页上被吃掉。真实回归发生在 1.6.0：门禁 80 > 标题按钮 60，进首页（门禁卸载）后按钮又回来。
 *
 * 放在 main 侧的理由与 `hud-substrate-guard.test.ts` 相同：读样式表要用 `node:fs`。
 * 静态守卫天生是绿的，所以每条判据都配一份故意违规的正对照。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => {
  const fromRoot = `apps/desktop-client/${relative}`;
  try {
    readFileSync(relative, "utf8");
    return readFileSync(relative, "utf8");
  } catch {
    return readFileSync(fromRoot, "utf8");
  }
};

const CAPTION = "src/renderer/src/components/hud/window-caption.css";
const GATE = "src/renderer/src/components/desktop-access-gate.css";
const GUIDANCE = "src/renderer/src/components/companion/guidance/companion-guidance.css";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取裸单类规则（不带后代、属性选择器或状态后缀）里的 z-index。 */
const zIndexOf = (css: string, selector: string) => {
  const rule = stripComments(css).match(new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"));
  const value = rule?.[1].match(/z-index:\s*(-?\d+)/);
  return value ? Number(value[1]) : null;
};

/** 违例：标题按钮没压过登录门，或高过了第一层整屏浮层。 */
const violationsFor = (caption: number | null, gate: number | null, overlay: number | null) => {
  const bad: string[] = [];
  if (caption === null) bad.push("标题按钮没有 z-index");
  if (gate === null) bad.push("登录门没有 z-index");
  if (overlay === null) bad.push("整屏浮层没有 z-index");
  if (caption !== null && gate !== null && caption <= gate) bad.push(`标题按钮 ${caption} 没压过登录门 ${gate}`);
  if (caption !== null && overlay !== null && caption >= overlay) bad.push(`标题按钮 ${caption} 顶到了整屏浮层 ${overlay}`);
  return bad;
};

describe("Windows 标题按钮的层序", () => {
  it("真实样式表里按钮压在登录门之上、整屏浮层之下", () => {
    const caption = zIndexOf(read(CAPTION), ".window-caption");
    const gate = zIndexOf(read(GATE), ".desktop-access-gate");
    const guidance = [".guidance-stage", ".guide-consent"].map((selector) => zIndexOf(read(GUIDANCE), selector));
    const overlay = Math.min(...(guidance.filter((value): value is number => value !== null) as number[]));

    expect(caption).not.toBeNull();
    expect(gate).not.toBeNull();
    expect(Number.isFinite(overlay)).toBe(true);
    expect(violationsFor(caption, gate, overlay)).toEqual([]);
  });

  it("正对照：1.6.0 那次的 60 会被报出来", () => {
    expect(violationsFor(60, 80, 91)).toContain("标题按钮 60 没压过登录门 80");
    expect(violationsFor(200, 80, 91)).toContain("标题按钮 200 顶到了整屏浮层 91");
    expect(violationsFor(null, 80, 91)).toContain("标题按钮没有 z-index");
  });

  it("正对照：故意把门调高到按钮之上，同一份判据必须变红", () => {
    const caption = zIndexOf(read(CAPTION), ".window-caption");
    const fakeGate = read(GATE).replace(/(\.desktop-access-gate\s*\{[^}]*?)z-index:\s*80/, "$1z-index: 999");
    const gate = zIndexOf(fakeGate, ".desktop-access-gate");

    expect(gate).toBe(999);
    expect(violationsFor(caption, zIndexOf(read(GATE), ".desktop-access-gate"), 91)).toEqual([]);
    expect(violationsFor(caption, gate, 1088)).toContain(`标题按钮 ${caption} 没压过登录门 999`);
  });
});
