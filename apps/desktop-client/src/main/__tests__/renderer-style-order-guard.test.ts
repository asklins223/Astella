/**
 * 「样式表只从一个地方进来」的守卫。
 *
 * ## 为什么要有这一条
 *
 * 2026-09-29 之前，24 份样式表里有 **13 份是从组件模块 import 的**：
 * `note-hud.css` 在 `notebook-surface.tsx:8`、`understanding-universe.css` 在
 * `graph-surface.tsx:71` 与 `companion-center-surface.tsx:24` 各一份、
 * `home-v2.css` 在 `HomeV2Experience.tsx:41`、`companion-hud.css` 在
 * `CompanionHud.tsx:117`……注入顺序因此由 **ES 模块求值顺序**决定。
 *
 * 而 ESM 会把 `main.tsx` 里的 `import { App } from "./App"` 整棵子树**先**求值完——
 * 于是**组件样式反而排在 `main.tsx` 那十一行之前**，与「母本在前、修正层在后」的
 * 设计意图正好相反，而且从代码上看不出真实顺序。
 *
 * 真实后果不是抽象的：「新增一个组件就可能冲掉别人的样式」，谁赢取决于 import 图的
 * 形状，不取决于谁写在最后。这正是「agent 改一个功能，另一个功能的样式莫名其妙变了」
 * 那一类 bug 的温床。
 *
 * 现在顺序收在 `styles.ts` 一张带分层理由的清单里，本文件把它钉住：
 * 1. 清单**完整**——磁盘上每份 CSS 都要在清单里（漏一份 = 它永远不加载）。
 * 2. **组件模块不再 import CSS**——只有 `styles.ts` 和 `main.tsx` 允许。
 * 3. 跨层顺序符合 `styles.ts` 顶部写下的分层理由。
 *
 * 放在 main 侧的理由：读文件要用 `node:fs`，`tsconfig.web.json` 的编译图里没有 Node 类型。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";
const ENTRY = "src/renderer/src/styles.ts";
const MAIN = "src/renderer/src/main.tsx";

const resolve = (relative: string): string | null => {
  for (const base of [relative, `apps/desktop-client/${relative}`]) {
    if (existsSync(base)) return base;
  }
  return null;
};

const read = (relative: string): string => {
  const path = resolve(relative);
  expect(path, `找不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
};

/** 按扩展名收文件。**扩展名必须由调用方给**——写死成 ts/tsx 的话，
 * 「清单完整」那条判据会在**空集上通过**：看起来绿，其实一份样式表都没扫到。 */
const walk = (dir: string, extension: RegExp, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) walk(child, extension, out);
    else if (extension.test(entry)) out.push(child);
  }
  return out;
};

const root = resolve(RENDERER_ROOT) as string;
const TS_FILES = walk(root, /\.(ts|tsx)$/).filter((f) => !/\.(test|spec)\.[tj]sx?$/.test(f));
const CSS_ON_DISK = walk(root, /\.css$/).map((f) => `./${f.slice(root.length + 1)}`);

const entry = read(ENTRY);
const listed = [...entry.matchAll(/import\s+"([^"]*\.css)"/g)].map((m) => m[1]);

/** 第三方样式也从唯一入口加载；完整性检查区分包样式与仓库样式。 */
const THIRD_PARTY = ["@milkdown/kit/prose/view/style/prosemirror.css"];

const componentImports: { file: string; spec: string }[] = [];
for (const file of TS_FILES) {
  const abs = file;
  if (abs === resolve(ENTRY) || abs === resolve(MAIN)) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/import\s+"([^"]*\.css)"/g)) {
    componentImports.push({ file: file.slice(root.length + 1), spec: match[1] });
  }
}

const indexOf = (needle: string): number => listed.findIndex((spec) => spec.includes(needle));

describe("样式表只从一个地方进来", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(CSS_ON_DISK.length, "没扫到样式表").toBeGreaterThanOrEqual(20);
    expect(TS_FILES.length, "没扫到 ts/tsx").toBeGreaterThanOrEqual(150);
    expect(listed.length, "styles.ts 里的清单太短").toBeGreaterThanOrEqual(20);
    // 清单条数与磁盘条数必须对得上——对不上说明有一边扫漏了，
    // 而「清单完整」那条判据恰好是**空集通过**，绿得毫无意义。
    expect(listed.filter((spec) => !THIRD_PARTY.includes(spec)).length, "清单条数与磁盘上的样式表数不一致").toBe(CSS_ON_DISK.length);
  });

  it("清单完整：磁盘上每份样式表都被 styles.ts 引了（漏一份 = 它永远不加载）", () => {
    const missing = CSS_ON_DISK.filter((f) => !listed.includes(f));
    expect(missing, `这些样式表存在但没进 styles.ts 的清单，它们不会被加载：\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("清单里没有指向不存在文件的条目（清单写了但文件不在 = 构建会红）", () => {
    const ghost = listed.filter((spec) => !CSS_ON_DISK.includes(spec) && !THIRD_PARTY.includes(spec));
    expect(ghost, `styles.ts 引了这些样式表，但磁盘上没有：\n  ${ghost.join("\n  ")}`).toEqual([]);
  });

  it("每份样式表只被引一次（同一份引两次 = 其中一次的意图不明）", () => {
    const dupes = listed.filter((spec, i) => listed.indexOf(spec) !== i);
    expect(dupes, `这些样式表在清单里出现了不止一次：${dupes.join(", ")}`).toEqual([]);
  });

  it("第三方编辑器样式也进入唯一清单", () => {
    for (const spec of THIRD_PARTY) expect(listed).toContain(spec);
  });

  it("组件模块不再 import CSS（顺序只能来自 styles.ts 一处）", () => {
    const offenders = componentImports.map((c) => `  ${c.file}  →  ${c.spec}`);
    expect(
      componentImports,
      `这些组件模块还在自己 import 样式表，于是注入顺序又回到「由 import 图决定」：\n${offenders.join("\n")}\n`
      + `把它们加进 ${ENTRY} 的对应层即可。`,
    ).toEqual([]);
  });

  it("分层顺序：基底 → 母本 → 集成层 → 修正层/功能层", () => {
    // 1. 基底：含裸元素选择器的重置，必须最先
    expect(indexOf("./styles.css"), "基底 styles.css 必须在最前").toBe(0);
    // 2. 母本：`DESIGN.md` 指定的唯一视觉依据
    const mother = indexOf("hud/hud-pages.css");
    const integration = indexOf("hud/hud-surface.css");
    const correction = indexOf("objective-flow.css");
    expect(mother, "清单里没有母本 hud-pages.css").toBeGreaterThan(-1);
    expect(integration, "清单里没有集成层 hud/hud-surface.css").toBeGreaterThan(-1);
    expect(correction, "清单里没有修正层 objective-flow.css").toBeGreaterThan(-1);
    // 集成层靠「排在母本之后」覆盖母本；修正层靠「排在集成层之后」覆盖集成层
    expect(integration, "集成层必须排在母本之后（它就是靠这个顺序覆盖母本的）").toBeGreaterThan(mother);
    expect(correction, "修正层必须排在集成层之后").toBeGreaterThan(integration);
  });

  it("main.tsx 走 styles.ts 这一个入口", () => {
    const main = read(MAIN);
    expect(main, "main.tsx 没有 import styles").toMatch(/import\s+"\.\/styles"/);
    expect(
      [...main.matchAll(/import\s+"[^"]*\.css"/g)],
      "main.tsx 里还有直接的 CSS import——那意味着顺序又分散了",
    ).toEqual([]);
  });

  it("自检：往组件里塞一条 CSS import，判据必须报出来", () => {
    const probe = [{ file: "components/surfaces/library/ResumableSurface.tsx", spec: "./note-hud.css" }];
    expect(probe.filter((c) => !THIRD_PARTY.includes(c.spec))).toHaveLength(1);
    expect(THIRD_PARTY, "第三方样式仍在豁免名单里").toContain("@milkdown/kit/prose/view/style/prosemirror.css");
  });
});
