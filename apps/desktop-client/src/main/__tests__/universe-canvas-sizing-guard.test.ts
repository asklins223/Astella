/**
 * 理解星图画布的**尺寸契约**：`.universe-canvas-root` 的盒子必须由 CSS 给。
 *
 * ## 这条守卫为什么存在
 *
 * 2026-10-02 实测到的真缺陷：一次「结构债清完」（`faa0e547`）把
 * `understanding-universe.css` 里的 `.universe-canvas-root` 那一整块连同
 * `:focus-visible` 一起当成死 CSS 删了，**组件却还在渲染这个类名**。
 *
 * 后果不是「少了个圆角」，是**整张星图一片空白**，而页面上其余一切正常：
 *
 * 1. 画布根只装绝对定位的子节点（canvas / 悬停卡 / 视野控件 / 两条读屏文本），
 *    所以它的尺寸**只能**来自自己的 `position: absolute` + `inset: 0`。
 *    规则一没，它退回普通流里的静态块，高度塌成 0。
 * 2. `understanding-universe.tsx` 量的是 `root.offsetWidth/offsetHeight`
 *    （有意绕开外壳那段 `scale(.96)` 入场动画，见那里的注释），0 被
 *    `Math.max(1, …)` 兜成 1。
 * 3. `canvas.width/height` 跟着变成 2 个设备像素——**整张图被画进一条 2px 高的
 *    画布，再拉满全屏**。控件、图例、筛选计数全是好的（它们是 DOM），只有画布空白。
 *
 * Chromium 实测（1365×768 宿主、dpr 2）：
 * 规则缺失时 `root.offsetHeight = 0`、backing store `2730×2`；放回去后
 * `768` 与 `2730×1536`。
 *
 * ## 为什么它没被已有的守卫抓住
 *
 * `renderer-style-closure-guard.test.ts`（类名闭合）只看 `className=…` 属性，
 * 而这里是 `const classNames = ["universe-canvas-root", className].filter(Boolean)
 * .join(" ")` 再 `className={classNames}` —— **按名字转交，属性上什么字面量都没有**，
 * 守卫连这个类名都没看见。
 *
 * 那条守卫的缺口是真实的（全 renderer 只有 3 处这种写法，另两处
 * `companion-bubble` / `window-live2d` 确实没有规则，是**本次修复之前就存在**的
 * 样式缺口，不在这次任务范围内）。但把整个闭合守卫改成会做别名解析，会让这 3 条
 * 一起变红、挡住别人的构建。所以这里只钉**星图画布这一处**，判据精确到那条规则本身。
 *
 * ## 放在 main 侧的理由
 *
 * 读文件要用 `node:fs`，而 `tsconfig.web.json` 的编译图里没有 Node 类型。
 * 与 `renderer-style-closure-guard.test.ts`、`graph-surface-shape-guard.test.ts` 同理。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";

/** 与既有守卫一致的读法：cwd 可能是 apps/desktop-client，也可能是仓库根。 */
const resolve = (relative: string): string | null => {
  for (const base of [relative, `apps/desktop-client/${relative}`]) {
    if (existsSync(base)) return base;
  }
  return null;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
};

const root = resolve(RENDERER_ROOT) as string;
const ALL = walk(root);
const byName = (name: string): string | null => ALL.find((f) => f.endsWith(`/${name}`)) ?? null;

const COMPONENT = byName("understanding-universe.tsx");
const STYLESHEET = ALL.find((f) => f.endsWith("/understanding-universe.css")) ?? null;
const source = COMPONENT ? readFileSync(COMPONENT, "utf8") : "";
const css = STYLESHEET ? readFileSync(STYLESHEET, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") : "";

/**
 * 抽出**所有**提到 `.cls` 的规则块（括号配平，不是正则剥壳——声明里有嵌套的 `color-mix`）。
 *
 * 返回全部而不是第一条：同一个类经常有多条规则（`understanding-universe.css` 里
 * `.universe-canvas-surface` 既有 `image-rendering` 那条共享规则、又有自己那条
 * `position: absolute`），断言问的是「**有没有**一条这样声明」，不是「第一条是不是」。
 */
function rulesFor(className: string): string[] {
  const needle = `.${className}`;
  const found: string[] = [];
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] !== "." || css.slice(i, i + needle.length) !== needle) continue;
    // 类名后面必须是边界，否则 `.canvas-surface` 会命中 `.universe-canvas-surface`。
    const after = css[i + needle.length];
    if (after && /[\w-]/.test(after)) continue;
    // 往前找块首：上一个 `}` 或 `}`/`{` 之后的分隔符，拿到完整选择器而不是半截。
    let start = css.lastIndexOf("}", i);
    const boundary = Math.max(css.lastIndexOf("{", i), css.lastIndexOf(";", i));
    if (boundary > start) start = boundary;
    const open = css.indexOf("{", i);
    if (open < 0) continue;
    let depth = 0;
    for (let j = open; j < css.length; j += 1) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(css.slice(start + 1, j + 1));
          break;
        }
      }
    }
  }
  return found;
}

/** `value` 这一条是否被**某一条**提到 `cls` 的规则声明成 `prop: value`。 */
const declares = (className: string, property: string, value?: RegExp): boolean =>
  rulesFor(className).some(
    (rule) => new RegExp(`(?:^|[;{\\s])${property}\\s*:`).test(rule)
      && (value === undefined || new RegExp(`${property}\\s*:\\s*${value.source}`).test(rule)),
  );

/** 承担布局的那一条（声明 `position` 的那条）；用来做「删掉它」的真变异。 */
const layoutRuleOf = (className: string): string | null =>
  rulesFor(className).find((rule) => /(?:^|[;{\s])position\s*:/.test(rule)) ?? null;

const ROOT_CLASS = "universe-canvas-root";
/** 根的每个直接子节点。它们**全都**是绝对定位或读屏专用隐藏，所以根的盒子是唯一的尺寸来源。 */
const OUT_OF_FLOW_CHILDREN = [
  "universe-canvas-surface",
  "universe-canvas-tooltip",
  "universe-canvas-controls",
  "universe-canvas-a11y-summary",
  "universe-canvas-a11y-live",
];

describe("理解星图画布的尺寸契约", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(ALL.length, "没扫到渲染层文件").toBeGreaterThan(100);
    expect(COMPONENT, "在渲染层里找不到 understanding-universe.tsx").not.toBeNull();
    expect(STYLESHEET, "在渲染层里找不到 understanding-universe.css").not.toBeNull();
    expect(source.length, "understanding-universe.tsx 是空的").toBeGreaterThan(1000);
    expect(css.length, "understanding-universe.css 是空的").toBeGreaterThan(1000);
  });

  it("画布的像素缓冲是从根节点的实测盒子算出来的——所以根塌成 0 就是一张空白画布", () => {
    // 这条链子（量 root → 写 canvas.width/height）是本守卫的前提。哪天改成了
    // 用容器尺寸或 ResizeObserverEntry，根的盒子就不再是唯一尺寸来源，这条守卫要重写。
    expect(source, "不再量 root.offsetWidth 了").toMatch(/root\.offsetWidth/);
    expect(source, "不再量 root.offsetHeight 了").toMatch(/root\.offsetHeight/);
    expect(source, "不再用实测宽度给 canvas.width").toMatch(/canvas\.width\s*=\s*Math\.ceil\(width \* dpr\)/);
    expect(source, "不再用实测高度给 canvas.height").toMatch(/canvas\.height\s*=\s*Math\.ceil\(height \* dpr\)/);
    // 兜底是 `Math.max(1, …)`：0 不会炸，只会让画布变成 1px 高然后被拉满——
    // 也就是说这条失败路径**静默**，没有任何报错会替你说这件事。
    expect(source, "高度兜底不见了，塌成 0 会直接量到 0").toMatch(/Math\.max\(1, root\.offsetHeight\)/);
  });

  it(`${ROOT_CLASS} 必须自带盒子（position: absolute + inset: 0）`, () => {
    expect(
      rulesFor(ROOT_CLASS).length,
      `.${ROOT_CLASS} 在 understanding-universe.css 里没有规则了——画布根会塌成 0 高，整张星图变成一张 1px 的空白画布`,
    ).toBeGreaterThan(0);
    expect(declares(ROOT_CLASS, "position", /absolute/), "画布根必须 absolute").toBe(true);
    expect(declares(ROOT_CLASS, "inset"), "画布根必须靠 inset: 0 铺满 .universe-page").toBe(true);
    expect(declares(ROOT_CLASS, "overflow"), "画布根要裁掉溢出，否则拖出去的星体糊在窗口外").toBe(true);
    // 拖拽与双指缩放要靠它；少了它触控板/触屏上会先被浏览器滚走。
    expect(declares(ROOT_CLASS, "touch-action", /none/), "画布根丢了 touch-action，拖拽与双指缩放会被浏览器抢走").toBe(true);
  });

  it("根的子节点仍然全是脱流的：一旦多一个在流里的子节点，上面那条 inset: 0 就是唯一尺寸来源", () => {
    for (const child of OUT_OF_FLOW_CHILDREN) {
      expect(rulesFor(child).length, `.${child} 没有规则了`).toBeGreaterThan(0);
      expect(
        declares(child, "position", /absolute/),
        `.${child} 必须在流之外（absolute）。它一旦回到文档流，${ROOT_CLASS} 的高度就由子节点决定，`
        + `而 ${ROOT_CLASS} 自己也 absolute + inset: 0——两者互相掩盖，塌陷就不再是显性的。`,
      ).toBe(true);
    }
  });

  it("自检：把根的布局规则整段删掉，这条守卫必须立刻报它", () => {
    // 真变异：guard 挂在「那条规则在不在」上，所以必须证明它看得见「不在」。
    const layoutRule = layoutRuleOf(ROOT_CLASS);
    expect(layoutRule, "原文件里布局规则就不在了（否则上面的断言没有意义）").not.toBeNull();
    const mutated = css.replace(layoutRule as string, "");
    expect(mutated, "删掉之后仍然声明着 position —— 变异无效，这条自检是空的").not.toMatch(
      new RegExp(`\\.${ROOT_CLASS}[^}]*\\{[^}]*position\\s*:`),
    );
    expect(css, "原文件里这条规则本来就该在").toMatch(
      new RegExp(`\\.${ROOT_CLASS}[^}]*\\{[^}]*position\\s*:`),
    );
  });
});
