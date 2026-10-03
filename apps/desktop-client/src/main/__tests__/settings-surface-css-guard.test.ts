/**
 * 「类发出去了，全仓没有一条 CSS 接手」的静态守卫（2026-09-23 解散空间确认面板）。
 *
 * 为什么要有这一条：确认面板的 `.settings-ledger__dissolve` 与 `label.field` 在
 * 整个 renderer 的样式表里**一条规则都没有**，于是它按默认的行内布局挤进
 * `.settings-ledger__item` 的 `auto` 列，把那一列撑成一句完整警告的宽度、把空间行
 * 自己压成 0px，空间名和印章叠在面板下面。当时 53 条用例全绿——它们断言的是
 * "点得动、发得出去"，不是"有人给它画了皮"。
 *
 * 这条守卫把那种"没人接"变成一次红。它不量几何（jsdom 没有布局），几何那半在
 * /tmp 的 fixture + 真 Chromium 里量：改前 tracks=`0px 321px`、rowW=22、
 * 面板与行重叠 1856px²；改后 tracks=`321px 0px`、rowW=321、重叠 0。
 *
 * 放在 main 侧的理由和 objective-flow-css-guard.test.ts 一样：读文件要用 `node:fs`，
 * 而 `tsconfig.web.json` 的编译图里没有 Node 类型。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => {
  const fromCwd = relative;
  const fromRoot = `apps/desktop-client/${relative}`;
  const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
  // 读不到就必须喊：静默跳过等于一条永远绿的空守卫。
  expect(path, `找不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
};

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const SURFACES_DIR = "src/renderer/src/components/surfaces";
const RENDERER_CSS = "src/renderer/src";

/** 只取选择器里的 `.类名`：声明块里的 `url(x.css)` 之类不算"有规则接手"。 */
const classesWithRules = (css: string) => {
  const found = new Set<string>();
  for (const rule of stripComments(css).matchAll(/([^{}]*)\{[^{}]*\}/g)) {
    for (const name of rule[1].matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) found.add(name[1]);
  }
  return found;
};

/** JSX 里写死的 className；带 `${}` 的动态类名不在这一层的射程内。 */
const classesEmittedBy = (tsx: string) => {
  const found = new Set<string>();
  for (const match of tsx.matchAll(/className="([^"{}]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name && !name.includes("$")) found.add(name);
  }
  return found;
};

describe("设置中心的每一个 className 都必须有 CSS 接手", () => {
  /**
   * 扫**整个 settings 一族**，不是只有 `settings-surface.tsx`。
   *
   * 2026-09-29：设置中心的页面被拆成 8 个模块（voice / workspace / companion / account /
   * export / data-boundary / theme / primitives），而这条守卫只读主体那一个。
   * 拆分让主体的 className 从 51 掉到 49，**阈值当场跌破**——守卫红了，但它红的理由
   * 与它要抓的东西（有没有裸着的元素）毫无关系。
   *
   * 判据的对象是**设置中心**这个页面，不是某一个文件；所以扫描范围要跟着拆分走。
   */
  const source = readdirSync(SURFACES_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /settings.*\.tsx?$/.test(entry) && !/\.test\./.test(entry))
    .map((entry) => read(`${SURFACES_DIR}/${entry}`))
    .join("\n");
  const emitted = classesEmittedBy(source);
  const styled = classesWithRules(
    readdirSync(RENDERER_CSS, { recursive: true })
      .filter((entry) => String(entry).endsWith(".css"))
      .map((entry) => read(`${RENDERER_CSS}/${entry}`))
      .join("\n"),
  );

  it("两边都真的读到了东西（否则这条守卫是空的）", () => {
    expect(emitted.size).toBeGreaterThan(50);
    expect(styled.size).toBeGreaterThan(500);
  });

  it("没有哪个类是发出去没人接的", () => {
    const orphans = [...emitted].filter((name) => !styled.has(name)).sort();
    expect(orphans, `这些 className 在全仓样式表里没有任何规则接手: ${orphans.join(", ")}`).toEqual([]);
  });

  it("自检：随便编一个类名，判据必须报它没人接", () => {
    expect(styled.has("settings-ledger__definitely-not-styled")).toBe(false);
  });
});

describe("解散确认面板必须落在行下面，而不是挤进行右侧那一列", () => {
  const css = stripComments(read("src/renderer/src/components/surfaces/settings/settings-book.css"));

  const ruleBody = (selector: string) => {
    const match = new RegExp(`\\.hud-surface\\s+\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    expect(match, `.hud-surface ${selector} 这条规则不存在`).not.toBeNull();
    return match![1];
  };

  it("面板跨满整行（`grid-column: 1 / -1`），与 .settings-invite-receipt 同一个解法", () => {
    expect(ruleBody(".settings-ledger__dissolve-panel")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it("退出与解散使用同一档可点击尺寸；确认动作仍跨满整行", () => {
    expect(css).toMatch(/\.settings-ledger__leave\s*,\s*\.hud-surface\s+\.settings-ledger__dissolve-trigger\s*\{[^}]*min-height:\s*34px/);
  });
});
