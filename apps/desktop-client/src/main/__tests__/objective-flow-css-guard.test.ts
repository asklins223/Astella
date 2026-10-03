/**
 * 结算页 outcome 视觉契约的静态守卫（31 号文档 P2/P32，批次 B2）。
 *
 * 为什么要有这一条：`data-outcome` 与 `data-tone` 从 JSX 发出去、全仓**没有任何一条
 * CSS 接手**，于是「已理解」和「无法评估」是像素级相同的一张纸，而所有单元测试照样
 * 全绿——因为它们断言的是文字，不是"有没有人接"。这种"属性发出去了没人接"的毛病，
 * 靠实机截图能发现，但发现成本太高；这里用静态扫描把它变成一条会红的测试。
 *
 * 放在 main 侧的理由和 renderer-copy-guard.test.ts 一样：读文件要用 `node:fs`，
 * 而 `tsconfig.web.json` 的编译图里没有 Node 类型。
 */
import { existsSync, readFileSync } from "node:fs";
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

describe("结算页的 outcome 必须真的驱动视觉", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));
  const outcomes = ["demonstrated", "partial", "practice_completed", "not_assessable", "needs_repair", "skipped", "declared_unable"];

  it("data-outcome 有 CSS 接手，而且不是一条通吃", () => {
    const selectors = [...css.matchAll(/[^{}]*\[data-outcome="([a-z_]+)"\][^{}]*\{/g)]
      .map((match) => match[1]);
    expect(selectors.length).toBeGreaterThanOrEqual(3);
    // 成立 / 练习 / 不成立 至少各占一档；只写一条 `.learning-run-result-board` 不算驱动视觉。
    const tiers = new Set(selectors);
    expect(tiers.has("demonstrated")).toBe(true);
    expect(tiers.has("practice_completed")).toBe(true);
    expect([...tiers].some((outcome) => ["not_assessable", "needs_repair", "skipped", "declared_unable"].includes(outcome))).toBe(true);
  });

  it("每个 outcome 的印章文案都还在表里——分档不许把谁漏成空白", () => {
    // 结算页那一族已于 2026-09-29 拆成 `learning-run-surface.tsx`（组件）
    // 与 `learning-run-copy.tsx`（文案表与纯函数）。**印章文案表住在后者**，
    // 所以这里要两个文件一起读——判据的对象是「结算页的 outcome 必须驱动视觉」，
    // 不是某一个文件。
    const source = [
      read("src/renderer/src/components/surfaces/run/learning-run-surface.tsx"),
      read("src/renderer/src/components/surfaces/run/learning-run-copy.tsx"),
    ].join("\n");
    const sealBlock = source.slice(
      source.indexOf("const outcomeSeal"),
      source.indexOf("const outcomeHeadline"),
    );
    for (const outcome of outcomes) {
      expect(sealBlock, `outcomeSeal 少了 ${outcome}`).toContain(`${outcome}:`);
    }
  });

  it("跳过与「暂时不会」被列进不渲染印章的那张表（DESIGN.md:152）", () => {
    // 结算页那一族已于 2026-09-29 拆成 `learning-run-surface.tsx`（组件）
    // 与 `learning-run-copy.tsx`（文案表与纯函数）。**印章文案表住在后者**，
    // 所以这里要两个文件一起读——判据的对象是「结算页的 outcome 必须驱动视觉」，
    // 不是某一个文件。
    const source = [
      read("src/renderer/src/components/surfaces/run/learning-run-surface.tsx"),
      read("src/renderer/src/components/surfaces/run/learning-run-copy.tsx"),
    ].join("\n");
    expect(source).toMatch(/SEALLESS_OUTCOMES[^;]*"skipped"[^;]*"declared_unable"/s);
  });
});

describe("夜间结算纸面的可读性", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  it("浅色反馈卡与对照卡使用深色墨迹，深色明细保留浅色文字", () => {
    for (const selector of [
      "learning-run-arrival-evidence p",
      "learning-run-arrival-evidence span",
      "learning-run-result-evidence > div",
      "learning-run-result-comparison p",
    ]) {
      expect(css, `${selector} 缺少夜间文字覆盖`).toMatch(
        new RegExp(`data-theme="night"\\] \\.${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    }
    expect(css).toMatch(/data-theme="night"\] \.learning-run-arrival-evidence p,[\s\S]*?\{ color: #44382f; \}/);
    expect(css).toMatch(/data-theme="night"\] \.learning-run-result-rubric li\[data-verdict="missing"\][\s\S]*?\{ color: #9b472f; \}/);
  });
});

describe("学习卡收藏与查找", () => {
  const css = stripComments(read("src/renderer/src/components/surfaces/review/card-experience.css") + read("src/renderer/src/components/surfaces/library/card-packs.css"));
  const source = read("src/renderer/src/components/surfaces/library/WorkspaceLibrarySurface.tsx");
  const desk = read("src/renderer/src/components/surfaces/library/card-collection.tsx");

  it("收藏内容独立滚动，合上的筛选菜单立即退出焦点路径", () => {
    expect(desk).toContain('aria-label="学习卡收藏内容"');
    expect(desk).toContain('inert={!props.filterMenuOpen}');
    expect(css).toMatch(/\.card-collection__content\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toContain('grid-template-rows: auto auto minmax(0,1fr)');
  });

  it("长标题换行，装饰图标不承载文字或学习状态", () => {
    expect(css).toMatch(/\.card-collection__card-body > strong\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(desk).toContain('className="card-collection__emblem" aria-hidden="true"');
    expect(css).toContain('[data-theme="night"]');
  });

  it("原文与学习足迹按需展开，摘要与标题相同时不重复", () => {
    expect(source).toContain('<details className="objective-brief__progress">');
    expect(source).toContain('className="objective-brief__postcard"');
    expect(source).toContain("content.publicSummary !== content.conceptLabel");
    expect(read("src/renderer/src/components/surfaces/library/card-pack-object.tsx")).toContain("summary !== title");
  });
});

describe("一次性压印的动效预算", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  it("印章压印只动 transform 与 opacity（DESIGN.md:148）", () => {
    const keyframe = css.match(/@keyframes objective-seal-press\s*\{([\s\S]*?)\n\}/);
    expect(keyframe, "@keyframes objective-seal-press 找不到了").not.toBeNull();
    const properties = [...(keyframe as RegExpMatchArray)[1].matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
    expect(properties.length).toBeGreaterThan(0);
    expect(new Set(properties)).toEqual(new Set(["opacity", "transform"]));
  });

  it("动效挂在 data-acknowledgement 上，不是挂在 outcome 上——否则回看历史结果会再庆祝一次", () => {
    const rule = css.match(/\.learning-run-result-board\[data-acknowledgement="active"\][^{]*\{[^}]*animation:/);
    expect(rule, "压印动画必须由 data-acknowledgement 触发").not.toBeNull();
    expect(css).not.toMatch(/\[data-outcome="demonstrated"\][^{]*\{[^}]*animation:/);
  });

  it("off 档与 prefers-reduced-motion 都把它关掉", () => {
    expect(css).toMatch(/data-motion-mode="off"[^{]*\{[^}]*animation:\s*none/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/animation:\s*none/);
  });
});

describe("修正层的加载顺序", () => {
  it("objective-flow.css 排在 hud-surface.css 之后——它覆盖的是同文件更早处的规则", () => {
    // 顺序清单从 `main.tsx` 搬到了 `styles.ts`（2026-09-29）：那张单子要覆盖全部
    // 24 份样式表，挂在 main.tsx 上会让入口文件变成一堵墙。
    const main = read("src/renderer/src/styles.ts");
    const imports = [...main.matchAll(/import\s+"([^"]*\.css)"/g)].map((match) => match[1]);
    const flow = imports.findIndex((spec) => spec.includes("objective-flow.css"));
    const hud = imports.findIndex((spec) => spec.includes("hud-surface.css"));
    expect(flow, "styles.ts 里没有引入 objective-flow.css").toBeGreaterThan(-1);
    expect(flow).toBeGreaterThan(hud);
  });
});

describe("卡片进展说真实事实", () => {
  const source = read("src/renderer/src/components/surfaces/library/card-collection.tsx");
  it("收藏要点复用服务端进展文案，不另外捏造次数或日期", () => {
    expect(source.match(/objectiveProgressChips\(card.progress\)/g)).toHaveLength(1);
  });
});

describe("详情页主行动块（P15）", () => {
  const css = stripComments(read("src/renderer/src/components/surfaces/library/card-detail.css"));

  it("两个紧凑档都不许再给这块降字号", () => {
    // 实机就是在这里量到动词 9px：那条档按**高度**生效，而 B4 的地板清单是按
    // :181-254 那段无条件规则挑的，紧凑档没照着列——于是 strong 整个漏在外面。
    // 现在整块自己就是按钮，字号只写在无条件那一处。
    const mediaBodies = [...css.matchAll(/@media[^{]*\{([\s\S]*?\n\})/g)].map((match) => match[1]);
    const shrinkers = mediaBodies
      .flatMap((body) => body.split("\n"))
      .filter((line) => /\.objective-brief__launch/.test(line) && /font-size/.test(line));
    expect(shrinkers, `紧凑档还在降主行动块的字号：\n${shrinkers.join("\n")}`).toEqual([]);
  });

  it("无条件那一处给动词与说明各自定了字号", () => {
    const verb = css.match(/\.objective-brief__launch strong\s*\{([^}]*)\}/);
    expect(verb, "动词没有规则接手").not.toBeNull();
    expect(Number(/([0-9.]+)px/.exec(verb?.[1] ?? "")?.[1]), "动词字号读不出来").toBeGreaterThanOrEqual(14);
    const why = css.match(/\.objective-brief__launchpad small\s*\{([^}]*)\}/);
    expect(Number(/font-size:\s*([0-9.]+)px/.exec(why?.[1] ?? "")?.[1])).toBeGreaterThanOrEqual(12);
  });
});

describe("复习队列的成句文字有地板", () => {
  const css = stripComments(read("src/renderer/src/components/surfaces/review/review-queue.css"));

  // 守卫跟随真实承载文件与新侧袋结构，避免只检查已经没人使用的旧选择器。
  for (const sel of ["deck-foot__hint", "review-queue__why p", "review-queue__rest p"]) {
    it(`.${sel} 有 ≥11px 的接手规则`, () => {
      const needle = sel.replace(/\s+/g, " ");
      const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((rule) => {
        const selectors = (rule[1] as string).split(",").map((s) => s.replace(/\s+/g, " ").trim());
        return selectors.some((s) => s.endsWith(needle) || s === `.hud-surface .${needle}`);
      });
      expect(blocks.length, `没有规则接手 .${sel}`).toBeGreaterThan(0);
      const size = Number(/font-size:\s*([0-9.]+)px/.exec(blocks[0]?.[2] ?? "")?.[1]);
      expect(size, `.${sel} 的接手规则没写 font-size`).toBeGreaterThanOrEqual(11);
    });
  }
});

describe("作答页题面的字号层级", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  // 组件测试钉的是"哪句话进 h2"，这里钉的是"进了 h2 的那句到底大不大"。
  // 两边各缺一半：JSX 换回来那边不红，CSS 掉档这边不红。
  const largestPx = (selector: string) => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((rule) =>
      (rule[1] as string).split(",").some((s) => s.trim() === selector));
    expect(blocks.length, `没有规则接手 ${selector}`).toBeGreaterThan(0);
    const body = blocks[blocks.length - 1]![2];
    const decl = /(?:^|;)\s*(?:font-size|font):\s*([^;]+)/.exec(body);
    expect(decl, `${selector} 的接手规则没写 font/font-size`).not.toBeNull();
    const px = [...decl![1].matchAll(/([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(px.length, `${selector} 的 font 声明里量不到 px：${decl![1]}`).toBeGreaterThan(0);
    return Math.max(...px);
  };

  const heading = largestPx(".hud-surface .learning-run-paper__question h2");
  const instruction = largestPx(".hud-surface .learning-run-paper__question p");
  const railTopic = largestPx(".hud-surface .learning-run-focus__target strong");

  it("题面主位至少是副行的两倍——36:14 那种倒挂不许回来", () => {
    expect(heading).toBeGreaterThanOrEqual(instruction * 2);
  });

  it("绿栏那句重复的主题，得比题面副行还小", () => {
    // 它和题面主位是同一句话（rail 与题面都取 publicSummary），
    // 两处都做大字号等于同一屏把标题读两遍。
    expect(railTopic).toBeLessThan(instruction);
  });
});
