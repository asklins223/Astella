/**
 * 「接了没人发」——死 CSS 的守卫。
 *
 * ## 为什么要有这一条
 *
 * 这是 `renderer-style-closure-guard` 的反面。那条抓「tsx 发了类名、CSS 没人接」
 * （元素会裸着）；这条抓「CSS 定义了类名、没有任何 tsx 发过」（样式在腐化）。
 *
 * 2026-09-29 的实测：`components/hud/hud-pages.css` 里 192 个类有 **58 个是死的**，
 * 全是 V1/V2 时代的旧 HUD 舞台类（`.goal-folder` 独占 16 条规则、`.home-next` 12 条、
 * `.speech` 11 条…）。它们让人以为「项目里有 22 屏 HUD 舞台」，而现在只有 1 屏。
 * **一个 agent 打开母本，看到 192 个类，自然会以为都能用——这比没有文档更糟。**
 *
 * 全仓另有 `v3-goal-row__marker--repair` / `--stable` 这类旧变体：
 * `objectiveStateTone()` 重构后只返回 `calm/progress/attention/neutral`，这两个名字
 * 已经到不了 DOM。同一条曲线上还有 `surface-close`——被 `TaskSurface.tsx` 的
 * `querySelector` 读取，却**全仓没有任何地方给它加过这个 class**，那条查询永远返回 null。
 *
 * ## 判据形态
 *
 * 1. **死类清单必须逐条显式列出**（`KNOWN_DEAD`），并且每条都能说出「为什么它还活着
 *    在磁盘上」——是第三方的 DOM 类、是运行时拼的、还是真的欠着一条清理。
 *    守卫断言「实际死集 == 清单」，所以**新长出来的死 CSS 会立刻变红**。
 * 2. 清单里每一条都带一句理由，删掉一条要连理由一起删——不允许无声消失。
 *
 * 这比「直接删干净」更重要：删完之后这条守卫守住的是一个**上限**，而不是一片空白。
 */
import { describe, expect, it } from "vitest";
import { buildIndex, shortPath, type CssRule } from "../renderer-class-index";

/**
 * 明确豁免的类名 → 理由。
 *
 * 键是类名，值是**它为什么还会被写进样式表**。新增豁免必须在这里写清理由，
 * 不接受「先放着」这种没有归因的条目。
 */
const EXEMPT: Readonly<Record<string, string>> = {
  "cm-editor": "CodeMirror 运行时生成的源码编辑器根节点",
  "cm-scroller": "CodeMirror 运行时生成的文字排版容器，滚动由册页接管",
  "cm-content": "CodeMirror 运行时生成的可编辑文字区域",
  "cm-line": "CodeMirror 运行时生成的源码行",
  "cm-gutters": "CodeMirror 运行时生成的行号区域",
  "cm-cursor": "CodeMirror 运行时生成的插入光标",
  "cm-selectionBackground": "CodeMirror 运行时生成的选区背景",
  "cm-panels": "CodeMirror 运行时生成的查找工具容器",
  "cm-search": "CodeMirror 查找插件运行时生成的搜索与替换面板",
  // 第三方编辑器（Milkdown / ProseMirror）自己生成的 DOM 类，tsx 里永远不会有 className。
  // 这几个是 ProseMirror 在运行时按自己的插件挂上去的：我们只能 import 它的样式，
  // 拿不到它往 DOM 上加类的代码路径。
  "ProseMirror": "Milkdown/ProseMirror 运行时生成的编辑器根节点",
  "ProseMirror-focused": "同上，焦点态",
  "ProseMirror-gapcursor": "同上，插入符占位",
  "ProseMirror-hideselection": "同上，选区被 iframe 占用时的替身",
  "ProseMirror-trailingBreak": "同上，段尾零宽位的占位",
  "ProseMirror-selectednode": "同上，NodeSelection 命中时的标记",
  "ProseMirror-separator": "同上，node 与 leaf 之间的结构分隔",
  "tableWrapper": "同上，表格外层包裹",
  "is-editor-empty": "同上，空文档判定",
  "is-empty": "同上，空文档判定",
  "placeholder": "ProseMirror 插件的占位符钩子",

  /**
   * **扫描器跟不过去的发射口，不是死 CSS。**
   *
   * 2026-10-02：`.universe-canvas-root` 被这条守卫判成死类——它的规则在样式表里
   * （`understanding-universe.css`），而扫描器在组件里找不到任何 `className="…"`
   * 会发出它。真实发射口是
   * `understanding-universe.tsx:2519` 的
   * ``const classNames = ["universe-canvas-root", className].filter(Boolean).join(" ")``
   * 再 `className={classNames}`：**按名字转交，属性上没有任何字面量**。
   *
   * 这不是「无害的漏报」。2026-10-02 的空白星图就是照着这条守卫的结论走的：
   * 看见「接了没人发」→ 当成死 CSS 删掉 → 画布根塌成 0 高 → 整张星图被画进一条
   * 1px 高的画布再拉满全屏。**判「死」的那一侧没有代价，判错的代价是整屏消失。**
   *
   * 真正的修法是让 `renderer-class-index` 解析局部变量别名（`className={标识符}`
   * → 找它的 `const` 声明），那样本类就不必豁免。之所以先豁免：全 renderer 只有
   * 3 处这种写法，另两处（`companion-bubble` / `window-live2d`）**确实**没有规则，
   * 打开别名解析会让它们同时变成闭合守卫的红——那是本次修复之前就存在的、
   * 与星图无关的样式缺口，不该由这次修复把它变成挡路的红。
   *
   * 尺寸契约本身由 `universe-canvas-sizing-guard.test.ts` 钉住（它会实打实检查
   * 那条规则在不在、是不是 `absolute` + `inset: 0`）。
   */
  "universe-canvas-root": "画布根：活类，扫描器跟不过 `classNames` 这个局部变量（见上）；尺寸契约由 universe-canvas-sizing-guard 钉住",

  /**
   * **编辑器装饰类**（2026-10-02，41 §1.4 两种编辑态的批注记号）。
   *
   * 与上面那批 `cm-*` / `ProseMirror*` 同一族，但原因不同：那些是**第三方运行时**
   * 往 DOM 上加的类，这两个是**本项目自己**发的——只是发射口是
   * `Decoration.node({ class: "note-annotation-block" })` 与
   * `Decoration.mark({ class: "note-annotation-source" })`
   * （`note-markdown-editor.ts` 的 `annotationPlugin` /
   * `note-source-editor.ts` 的 `annotationDecorations`）。
   *
   * 扫描器跟不过去是**形状**问题：这两个是对象字面量的属性值，既不是
   * `className="…"` 也不是 `classList.add(…)`，三条发射规则一条都不匹配。
   * 它们与 `universe-canvas-root` 那条一样属于「按名字转交、属性上没有字面量」，
   * 所以同样先豁免、并把发射点写在这里——豁免条目的意义正是「说清它为什么
   * 还会被发出」，而这一条说得清。
   */
  "note-annotation-block": "Milkdown 装饰类：可编辑预览里那一块的批注记号（发射点 note-markdown-editor.ts 的 annotationPlugin）",
  "note-annotation-source": "CodeMirror 装饰类：纯编辑里那一行的批注记号（发射点 note-source-editor.ts 的 annotationDecorations）",
};

/** 已知死类 → 欠它的清理说明。断言「实际死集 == 清单」，所以新死类会立刻红。 */
const KNOWN_DEAD: Readonly<Record<string, string>> = {};

const where = (rules: CssRule[]): string =>
  rules
    .slice(0, 2)
    .map((r) => `${shortPath(r.file)}:${r.line}`)
    .join(", ");

/**
 * 死 = 没人发、**且不落在不可判定前缀族里**。
 *
 * 不可判定前缀这一条是 2026-09-29 实测出来的真陷阱：`TaskSurface.tsx:381` 写的是
 * `` `task-surface--${renderedSurface}` ``，插值是个裸标识符，静态取不到任何一个值，
 * 于是 `task-surface--validation` / `--notebook` / `--graph` 会被判成死类。
 * 而它们在运行时**一定**会上屏——`RoomSurface` 有 10 个值，TaskSurface 逐个挂上去。
 * 按那个名单去删规则，删掉的是「某个 surface 的整段版式」，而且**只在真窗口里看得见**。
 */
const opaqueOf = (index: ReturnType<typeof buildIndex>, name: string): string | undefined =>
  [...index.opaquePrefixes].find((p) => p.length > 0 && name.startsWith(p));

describe("死 CSS：接了没人发", () => {
  const index = buildIndex();
  const isUndecidable = (name: string): boolean => opaqueOf(index, name) !== undefined;

  const emitted = new Set<string>();
  for (const { hard, modifier, dynamic } of index.emitted.values()) {
    for (const c of hard) emitted.add(c);
    for (const c of modifier) emitted.add(c);
    for (const c of dynamic) emitted.add(c);
  }

  // 「本该死」的候选：没人发、且不落在不可判定前缀族里。豁免名单在这之前算。
  const candidates = [...index.declared.keys()].filter(
    (name) => !emitted.has(name) && !isUndecidable(name),
  );

  // 死 = 候选里再扣掉有正当理由的豁免
  const dead = [...index.declared.entries()]
    .filter(([name]) => !emitted.has(name) && !(name in EXEMPT) && !isUndecidable(name))
    .map(([name, rules]) => ({ name, where: where(rules) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  it("读到了东西（否则这条守卫是空的）", () => {
    expect(index.cssFiles.length, "没扫到样式表").toBeGreaterThanOrEqual(20);
    expect(index.tsFiles.length, "没扫到组件文件").toBeGreaterThanOrEqual(150);
    expect(index.declared.size, "样式表里解析出的类名过少").toBeGreaterThan(1200);
    expect(emitted.size, "组件里解析出的类名过少").toBeGreaterThan(1000);
    expect(index.opaquePrefixes.size, "一个不可判定前缀都没扫到，机制多半坏了").toBeGreaterThan(0);
    // 防空转看的是**候选数**而不是死类数：死类清到 0 是这件工作的目标，
    // 拿它当「扫描器还活着」的证据就等于要求工作永远做不完。
    expect(candidates.length, "一个候选都没扫到，扫描器多半坏了").toBeGreaterThan(0);
  });

  it("动态前缀族不许被当成死类（`block--${enum}` 的每个值都一定会上屏）", () => {
    // 这几条是 TaskSurface.tsx:381 / use-hud-page.ts:48 的运行时产物
    for (const name of ["task-surface--validation", "task-surface--notebook", "task-surface--graph", "page-17"]) {
      expect(isUndecidable(name), `${name} 落在不可判定前缀族里，不该被判死`).toBe(true);
      expect(dead.map((d) => d.name)).not.toContain(name);
    }
  });

  it("豁免名单里的每一条都写清了理由", () => {
    const bare = Object.keys(EXEMPT).filter((name) => !EXEMPT[name] || EXEMPT[name].trim().length < 6);
    expect(bare, `这些豁免没有写理由：${bare.join(", ")}`).toEqual([]);
  });

  it("死类清单与实际一致：多出来的每一条都是新长出来的死 CSS", () => {
    const detail = dead
      .map((d) => `  ${d.name}  ← ${d.where}`)
      .join("\n");
    expect(
      dead.map((d) => d.name),
      `这些类名在样式表里有规则，但全仓没有任何 tsx 会发出它们。\n`
      + `要删就删干净并把 ${"KNOWN_DEAD"} 里对应条目一并删掉；\n`
      + `要留就在 ${"EXEMPT"} 里写清「它为什么还会被发出」的理由。\n${detail}`,
    ).toEqual(Object.keys(KNOWN_DEAD).sort());
  });

  it("自检：凭空多一个死类，判据必须报出来", () => {
    const probe = [...index.declared.keys(), "renderer-dead-guard__definitely-dead"];
    const found = probe.filter((name) => !emitted.has(name) && !(name in EXEMPT));
    expect(found).toContain("renderer-dead-guard__definitely-dead");
  });
});
