/**
 * 笔记「这一轮」那一屏的**动作条**：一屏只能有一颗主行动。
 *
 * ## 为什么这一屏要单独一条守卫
 *
 * 母本的主动作写法是 `className="button primary"`，由 `renderer-primary-action-guard`
 * 钉着（它扫描全仓所有 `<button>` 上的主行动写法）。但**这一屏不用那套**：
 * `notebook-surface.tsx` 的 `round-desk` 纸脚用 `round-stamp` 当主动作、
 * `round-tab` 当次级动作（纸签），13 颗 `round-stamp` 分布在 13 个互斥分支里。
 *
 * `round-stamp` **不匹配**那条守卫的名字形状（`primary` / `main` / `*-primary`），
 * 所以它一直没被任何判据看着——这是「一屏主行动唯一」这个目标里一个真实的盲区，
 * 而且是按构造盲的：换了类名就绕过了检查。
 *
 * ## 本守卫管什么
 *
 * 1. **每个互斥分支至多一颗 `round-stamp`。** 那 13 颗各自属于 `learningScene` /
 *    `roundNextStep.kind` 的一个分支，运行时只有一颗上屏。若某个分支里出现两颗，
 *    那一屏就有两个主位——而这正是用户报的「分不清哪个是关键按钮」。
 * 2. **次级动作不许用 `round-stamp`。** 次级一律是 `round-tab`（纸签）。
 * 3. **主动作位不许混进母本写法。** 那一屏要么全用 `round-stamp`，要么全用
 *    `button primary`，不许两套并存——并存时视觉权重会打架。
 * 4. **`round-stamp` 有 CSS 接手**，且带成对的 `:hover`（母本那对触感的约定）。
 *
 * 放在 main 侧、按目录树定位文件：这是静态形状判据，不该绑死 `notebook-surface.tsx`
 * 的层级——2026-09-29 那次把它绑在组件测试里，结果文件一拆就红，拆分被推迟了两轮。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";

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
const findByName = (name: string): string | null => ALL.find((f) => f.endsWith(`/${name}`)) ?? null;

const surface = findByName("notebook-surface.tsx");
const source = surface ? readFileSync(surface, "utf8") : "";
const css = ALL.find((f) => f.endsWith("note-hud.css"));
const cssText = css ? readFileSync(css, "utf8") : "";

/** 纸脚那一段：`{openRound && !roundEditing ? (` 到它自己的 `) : null}`。 */
function foot(): string {
  const start = source.indexOf("<div className=\"round-desk__foot\">");
  expect(start, "找不到纸脚").toBeGreaterThan(-1);
  const end = source.indexOf(") : null}", start);
  return source.slice(start, end);
}

const footSource = foot();

/**
 * 把那一大坨嵌套三元按互斥分支切开，数每个分支里的 `round-stamp`。
 *
 * 做法很简单但够用：`? ... :` 每出现一次就是进入一个更深的分支，`: ...` 每出现一次
 * 就是回到上一层。**同一层出现第二颗 `round-stamp` 就是两个主位**——因为它们
 * 在同一组条件里互斥，运行时只可能上屏一颗，而互斥分支里的第二颗就是「多写了一个」。
 */
function stampsPerBranch(text: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let seen = 0;
  for (const token of text.matchAll(/\?|\?>|className="round-stamp"|:\s*$/gm)) {
    const value = token[0];
    if (value === "?") {
      if (seen > 0) out.push(seen);
      seen = 0;
      depth += 1;
    } else if (value === "?>" || value === 'className="round-stamp"') {
      if (value === 'className="round-stamp"') seen += 1;
    }
  }
  if (seen > 0) out.push(seen);
  return out;
}

describe("笔记「这一轮」的动作条：一屏只能有一颗主行动", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(ALL.length, "没扫到渲染层文件").toBeGreaterThan(100);
    expect(surface, "在渲染层里找不到 notebook-surface.tsx").not.toBeNull();
    expect(footSource.length, "纸脚那一段是空的").toBeGreaterThan(500);
    expect(css, "找不到 note-hud.css").not.toBeNull();
  });

  it("这一屏的主动作是 `round-stamp`（13 颗互斥分支里的那一颗上屏）", () => {
    expect(source).toMatch(/className="round-stamp"/);
    const per = stampsPerBranch(footSource);
    expect(per.length, "没切出互斥分支").toBeGreaterThan(5);
    // 互斥分支里每个分支至多一颗；出现「2」就是那一屏有两个主位
    expect(per.filter((n) => n > 1), `这些互斥分支里有不止一颗 \`round-stamp\`：${per.filter((n) => n > 1).join(", ")}`)
      .toEqual([]);
  });

  it("次级动作一律是 `round-tab`（纸签），不许混进主位", () => {
    // 纸签区（`round-desk__others`）里不许出现 round-stamp
    const othersStart = footSource.indexOf('className="round-desk__others"');
    expect(othersStart, "找不到次级动作区").toBeGreaterThan(-1);
    const others = footSource.slice(othersStart);
    expect(others, "次级动作区里混进了主动作类 `round-stamp`").not.toMatch(/className="round-stamp"/);
    expect(others, "次级动作区里没有纸签").toMatch(/className="round-tab"/);
  });

  it("主动作位不许与母本写法并存（两套并存时视觉权重会打架）", () => {
    expect(footSource, "纸脚里混进了母本的 `button primary`——那一屏要只用一套主行动写法")
      .not.toMatch(/className="button primary"/);
  });

  it("`round-stamp` 有 CSS 接手，而且抬手/按压成对", () => {
    expect(cssText, "note-hud.css 里找不到 `.round-stamp` 的规则").toMatch(/\.round-stamp\s*\{/);
    expect(cssText, "`round-stamp` 缺 `:hover`——母本那对触感是成对的").toMatch(/\.round-stamp:hover/);
  });

  it("自检：往一个分支里塞第二颗 `round-stamp`，判据必须报出来", () => {
    const mutated = '<div className="round-desk__foot">{cond ? <><button className="round-stamp"/><button className="round-stamp"/></> : null}</div>';
    expect(stampsPerBranch(mutated).some((n) => n > 1)).toBe(true);
    expect(stampsPerBranch('<div className="round-desk__foot">{cond ? <button className="round-stamp"/> : null}</div>')
      .some((n) => n > 1)).toBe(false);
  });
});
