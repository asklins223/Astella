/**
 * 「类发出去没人接」的全 renderer 守卫。
 *
 * ## 为什么要有这一条
 *
 * 2026-09-29 的全量勘察给出了三个反复发生的失败，其中「一点样式都不加，裸在那里」
 * 是唯一有纯机械成因、也最容易机械拦截的一个：
 *
 * - `notebook-surface.tsx:4080` 与 `:4731` 的页面级顶层容器类 `.notebook-leaf-page`，
 *   在全部 24 个样式表里 **0 条规则**（ID 选择器也没有兜底），于是正文页与学习记录页
 *   整页没有纸、没有边、没有呼吸位。
 * - `.task-slip--working` 在 `note-hud.css` 里只定义了 `--failed`，`--working` 缺失。
 * - `round-notice--blocked` / `--failed` 两个变体都无定义。
 *
 * 这类失败在旧体系里能一路绿灯合入，是因为**没有任何一道门会看它**：
 * 全仓 565 个测试里 `getComputedStyle` 出现 1 次（在草稿文件里）、`toHaveStyle` 0 次、
 * `toHaveClass` 0 次；`tsc` 只看类型；项目里没有 eslint / stylelint。
 *
 * 本文件把那种「没人接」变成一次红，并把它从 `settings-surface.tsx` 一个文件
 * 推广到**整个 renderer**——`settings-surface-css-guard.test.ts:51-73` 已经证明这条
 * 判据成立（它当场抓到过 `.settings-ledger__dissolve` 把面板挤进行右侧那一列的缺陷），
 * 当时只是范围只圈了一个文件。
 *
 * ## 与既有守卫的关系
 *
 * `settings-surface-css-guard.test.ts` 保留：它除了孤儿类，还钉着解散面板的两条
 * 具体几何判据（`grid-column: 1 / -1`、入口按钮与「退出」同档），那是那次的回归钉，
 * 语义独立于「类名闭合」这条更一般的判据。
 *
 * ## 放在 main 侧的理由
 *
 * 读文件要用 `node:fs`，而 `tsconfig.web.json` 的编译图里没有 Node 类型。
 * 与 `hud-substrate-guard.test.ts`、`objective-flow-css-guard.test.ts` 同理。
 *
 * ## 判据形态
 *
 * 双向闭合：
 * 1. **发出去的都要被接住**（本文件的主判据）——ts/tsx 里出现的类名，全仓样式表
 *    必须有规则接手。这是防止「裸着」。
 * 2. **接住的不一定有人发**（`renderer-style-dead-classes.test.ts`）——反向差集单独
 *    一条守卫，因为它的处置方式不同：死类要删，而孤儿类要补。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";

/** 与既有守卫一致的读法：cwd 可能是 apps/desktop-client，也可能是仓库根。 */
const resolve = (relative: string): string | null => {
  for (const base of [relative, `apps/desktop-client/${relative}`]) {
    if (existsSync(base)) return base;
  }
  return null;
};

const read = (relative: string): string => {
  const path = resolve(relative);
  // 读不到就必须喊：静默跳过等于一条永远绿的空守卫。
  expect(path, `找不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
};

const walk = (root: string): string[] => {
  const out: string[] = [];
  const visit = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) visit(child);
      else out.push(child);
    }
  };
  visit(root);
  return out;
};

const RENDERER_ABS = resolve(RENDERER_ROOT) as string;
const ALL_FILES = walk(RENDERER_ABS);
const CSS_FILES = ALL_FILES.filter((f) => f.endsWith(".css"));
const TSX_FILES = ALL_FILES.filter(
  (f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !/\.(test|spec)\.[tj]sx?$/.test(f) && !f.includes("__tests__"),
);

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 抽出样式表里**真正有规则接手**的类名。
 *
 * 用单趟括号深度扫描而不是正则剥壳，原因有两个：
 *
 * 1. `/([^{}]*)\{[^{}]*\}/g` 遇到 `@media { .a { } }` 时会把 `.a` 吃成外层 at-rule
 *    的选择器，**内层规则整块丢失**。本项目 24 个样式表里有 15 个 `@media` 块
 *    （含紧凑视图那一整段），用单条正则会漏掉其中所有规则，进而把「已经被接住」的类
 *    误报成孤儿。
 * 2. 反复「剥一层再剥一层」是平方复杂度，在 24K 行样式上直接 `Invalid string length`。
 *
 * at-rule 前言（`@media (…)`、`@keyframes …`）自身不带类名，扫到时跳过即可；
 * 嵌套在里面的规则因为 buffer 在 `{` / `}` 处清空，会被独立收走。
 */
export const classesWithRules = (css: string): Set<string> => {
  const found = new Set<string>();
  let buffer = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      if (!buffer.trimStart().startsWith("@")) {
        for (const name of buffer.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) found.add(name[1]);
      }
      buffer = "";
    } else if (ch === "}") {
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return found;
};

/**
 * `className={...}` 的取值。
 *
 * `direct` 区分两种来源，它们的后续解析路径不同：
 * - `className="a b"`   → 捕获组里**已经没有引号**，直接按空白切
 * - `className={"a b"}` → 捕获的是带引号的表达式，仍要走 `plain` 判定
 */
const classNameValues = (source: string): { text: string; direct: boolean }[] => {
  const values: { text: string; direct: boolean }[] = [];
  for (const hit of source.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g)) {
    if (hit[1] !== undefined || hit[2] !== undefined) {
      values.push({ text: hit[1] ?? hit[2] ?? "", direct: true });
      continue;
    }
    // 从 `{` 开始做括号配平，取出整个表达式
    let depth = 0;
    let end = hit.index + hit[0].length - 1;
    for (let i = end; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    values.push({ text: source.slice(hit.index + hit[0].length, end), direct: false });
  }
  return values;
};

/**
 * 真实类名的唯一形状。
 *
 * 这一条是判据的准确率来源。没有它，`clsx(item.value, invite.status, null)` 里的
 * 成员访问、`["a","b"].join(" ")` 里的分隔符、`className={rootClassName}` 里的变量名
 * 都会被当成「发出去的类名」，报出一堆与视觉毫无关系的假孤儿。
 */
const CLASS_SHAPE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** BEM 块名后面等着被插值补全的前缀（`approved-surface--${x}` 的 `approved-surface--`）。 */
const BEM_PREFIX_TAIL = /[-_]+$/;

const splitClasses = (text: string): string[] =>
  text.split(/\s+/).filter((c) => CLASS_SHAPE.test(c));

/**
 * 模板字面量里的字符串字面量：`${a ? "x" : "y"}` → ["x", "y"]。
 *
 * **先把比较子句摘掉**再取字面量，这是这条判据准确率的关键：
 * `is-${kind === "objective" ? "card" : kind === "evidence" ? "key_point" : kind}`
 * 里的 `"objective"` / `"evidence"` 是三元的**判断主语**，永远到不了 DOM；只有 `?` 与
 * `:` 之后的分支才是输出。不摘掉的话守卫会要求 `is-objective` / `is-evidence` 各有一条
 * 规则——于是人会去补两条**死 CSS** 来买一次绿，而这正是这条守卫要防的污染。
 * （2026-09-29 实测：graph-surface.tsx:1065 就是这个形状。）
 */
const stringLiterals = (expression: string): string[] => {
  const branchesOnly = expression
    // `x === "a"` / `x !== "a"` / `"a" === x` —— 判断主语，不是输出
    .replace(/(?:[A-Za-z_$][\w$.[\]?]*\s*[!=]==?\s*|["'][^"']*["']\s*[!=]==?\s*[A-Za-z_$][\w$.[\]?]*)(["'][^"'\n]*["'])/g, " ")
    // `case "a":` —— 同样不是输出
    .replace(/\bcase\s+["'][^"'\n]*["']\s*:/g, " ");
  return [...branchesOnly.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((m) => m[1] ?? m[2] ?? "");
};

/**
 * 抽 ts/tsx 里发出的类名。
 *
 * 分三档，因为处置方式和判据强度都不同：
 *
 * - `hard`     静态字面量（`className="a b"`）。确定会进 DOM，必须有人接。**红。**
 * - `modifier` 模板里 **前缀以 `-` 或 `__` 结尾** 的插值（`round-notice--${x}`）。
 *               这种写法在语义上就是 BEM 修饰符——前缀不可能独立成类，所以展开出来的
 *               名字**必然**会进 DOM。**红。**
 * - `dynamic`  其余一切表达式字面量（`clsx(cond && "primary")`、`a ${cond ? "b" : "c"}`）。
 *               这里的字面量既可能是完整类名、也可能是某个更长类名的一段，静态无法判定。
 *               **只报告、不判红**——把猜不准的东西写成会红的断言，就是一条制造假红的守卫。
 */
export const classesEmitted = (source: string): {
  hard: Set<string>;
  modifier: Set<string>;
  dynamic: Set<string>;
} => {
  const hard = new Set<string>();
  const modifier = new Set<string>();
  const dynamic = new Set<string>();

  for (const { text, direct } of classNameValues(source)) {
    const trimmed = text.trim();

    // `className="a b"`：捕获组已无引号，直接切
    if (direct) {
      for (const c of splitClasses(trimmed)) hard.add(c);
      continue;
    }

    // `className={"a b"}`：表达式本身就是一个字符串字面量
    const plain = /^(["'])([\s\S]*)\1$/.exec(trimmed);
    if (plain) {
      for (const c of splitClasses(plain[2])) hard.add(c);
      continue;
    }

    // 模板字面量：`className={`a ${x} b`}`
    if (trimmed.startsWith("`") && trimmed.includes("${")) {
      const body = trimmed.slice(1, trimmed.lastIndexOf("`"));
      const parts: { text: string; expr?: string }[] = [];
      let cursor = 0;
      for (let i = 0; i < body.length; i += 1) {
        if (body[i] === "$" && body[i + 1] === "{") {
          let depth = 0;
          let j = i + 1;
          for (; j < body.length; j += 1) {
            if (body[j] === "{") depth += 1;
            else if (body[j] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          parts.push({ text: body.slice(cursor, i), expr: body.slice(i + 2, j) });
          cursor = j + 1;
          i = j;
        }
      }
      parts.push({ text: body.slice(cursor) });

      // 静态块：整块里不带插值的 token 是完整类名
      for (const c of splitClasses(parts.map((p) => p.text).join(" "))) {
        // 尾部是分隔符的（`approved-surface--`）不是完整类名，等插值补全
        if (!BEM_PREFIX_TAIL.test(c)) hard.add(c);
      }

      // 展开块：前缀 + 分支字面量 + 后缀
      parts.forEach((part, index) => {
        if (!part.expr) return;
        // 同一个 part 里同时存着「插值之前的文本」和「插值表达式」，
        // 所以前缀取本 part 的 text，后缀取下一 part 的 text。
        const prefix = part.text;
        const after = parts[index + 1]?.text ?? "";
        for (const literal of stringLiterals(part.expr)) {
          if (BEM_PREFIX_TAIL.test(prefix)) {
            // 前缀以分隔符收尾 → 这就是 BEM 修饰符，名字唯一且必然上屏
            for (const c of splitClasses(`${prefix}${literal}${after}`)) modifier.add(c);
          } else {
            // 前缀带空格或为空 → 字面量要么是完整类名、要么只是某段文本，分不清
            for (const c of splitClasses(`${prefix} ${literal} ${after}`)) dynamic.add(c);
            for (const c of splitClasses(literal)) dynamic.add(c);
          }
        }
      });
      continue;
    }

    // `className={clsx("a", cond && "b", { c: d })}` 这类：**只认字符串字面量**。
    // 裸标识符、成员访问、调用结果都不是类名。
    for (const literal of stringLiterals(trimmed)) {
      for (const c of splitClasses(literal)) dynamic.add(c);
    }
  }
  return { hard, modifier, dynamic };
};

const CSS_ALL = CSS_FILES.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
const STYLED = classesWithRules(CSS_ALL);

const EMITTED = TSX_FILES.map((f) => {
  const { hard, modifier, dynamic } = classesEmitted(readFileSync(f, "utf8"));
  return { file: f, hard, modifier, dynamic };
});

/** 孤儿类 → 它出现在哪些文件（取前 3 处）。 */
const orphanLocations = (name: string) =>
  EMITTED.filter((e) => e.hard.has(name) || e.modifier.has(name) || e.dynamic.has(name))
    .map((e) => e.file.replace(`${RENDERER_ABS}/`, ""))
    .slice(0, 3);

const HARD_ORPHANS = [...new Set(EMITTED.flatMap((e) => [...e.hard]))]
  .filter((name) => !STYLED.has(name))
  .sort();

/** BEM 修饰符缺口：静态可证，判红。 */
const MODIFIER_ORPHANS = [...new Set(EMITTED.flatMap((e) => [...e.modifier]))]
  .filter((name) => !STYLED.has(name) && !HARD_ORPHANS.includes(name))
  .sort();

/** 表达式字面量：静态判不准，只登记不判红。 */
const DYNAMIC_UNSTYLED = [...new Set(EMITTED.flatMap((e) => [...e.dynamic]))]
  .filter((name) => !STYLED.has(name) && !HARD_ORPHANS.includes(name) && !MODIFIER_ORPHANS.includes(name))
  .sort();

describe("renderer 类名闭合：发出去的都要被 CSS 接住", () => {
  it("两边都真的读到了东西（否则这条守卫是空的）", () => {
    expect(CSS_FILES.length, "没扫到样式表").toBeGreaterThanOrEqual(20);
    expect(TSX_FILES.length, "没扫到组件文件").toBeGreaterThanOrEqual(150);
    // 阈值随死 CSS 清理而下调：2026-09-29 清掉 455 条永不匹配���规则之后，
    // 声明类名从 1,556 降到 1,458。下限定在 1,200——再低就说明解析器坏了，
    // 而不是「项目变干净了」。
    expect(STYLED.size, "样式表里解析出的类名过少，解析算法可能坏了").toBeGreaterThan(1200);
    expect(EMITTED.reduce((n, e) => n + e.hard.size, 0), "组件里解析出的类名过少").toBeGreaterThan(1000);
  });

  it("@media 里的规则也要被算进去（剥壳算法自检）", () => {
    // 紧凑视图那一整段在 @media 内，类名极长且带 em dash 以外的字符
    expect(STYLED.has("hud-surface")).toBe(true);
    expect(STYLED.has("resumable-index__head")).toBe(true);
    expect(STYLED.has("resumable-index__note")).toBe(true);
  });

  /**
   * 「类名存在」不等于「元素能匹配上」。
   *
   * 2026-09-29 实测到的活 bug：`companion-center-panels.tsx` 有 8 颗按钮写的是
   * `className="primary"`（**没有** `button`）。样式表里 `primary` 确实有声明——
   * 但全部形如 `.hud-surface .button.primary`，**裸 `.primary` 一条规则都没有**。
   * 于是这 8 颗按钮匹配不上任何规则，渲染成原生裸按钮：没有底色、没有圆角、没有阴影。
   * 而本文件的主判据只看「这个名字有没有被声明过」，所以**放过了它**。
   *
   * 这就是「类名存在 ≠ 元素能匹配」的缺口：判据必须问「有没有哪条规则的某个**复合段**
   * 恰好只有这一个类」，否则「只在复合选择器里出现过的类」会被误认为已接住。
   */
  it("只在复合选择器里出现过的类，不许被单独用（否则那颗按钮其实是裸的）", () => {
    const standalone = new Set<string>();
    for (const css of CSS_FILES.map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))) {
      for (const rule of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
        for (const part of rule[1].split(",")) {
          // 按后代 / 子代 / 相邻 / 通用兄弟切开，得到一个个「复合段」
          for (const compound of part.split(/[\s>+~]+/)) {
            const names = [...compound.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]);
            if (names.length === 1) standalone.add(names[0]);
          }
        }
      }
    }
    // 只看**单独成 token** 使用过的类。`className="button primary"` 里的 primary
    // 与 button 同现，永远匹配得上 `.button.primary`；只有 `className="primary"`
    // 单独挂上去才会落空。那 52 处合规主按钮不能算进来。
    //
    // 值必须只含类名字符：`className={`…${x ? " a" : ""}`}` 这种模板里也会出现
    // `className="` 之后的引号，不设这道闸，正则会从别处的 `className="` 一路
    // 吃到模板内部，把 `settings-boundary__node` 与 `allowed` 各记成一次「单 token 使用」。
    const singletonUse = new Set<string>();
    for (const file of TSX_FILES) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of source.matchAll(/className="([A-Za-z0-9_ -]*)"/g)) {
        const tokens = match[1].split(/\s+/).filter(Boolean);
        if (tokens.length === 1) singletonUse.add(tokens[0]);
      }
    }
    const singles = [...singletonUse].filter((name) => STYLED.has(name) && !standalone.has(name)).sort();
    expect(
      singles,
      `这些类只在复合选择器里出现过（例如 .button.primary），单独挂到元素上匹配不到任何规则——\n`
      + `渲染出来就是一颗没有任何样式的原生按钮。补上它必须同现的那个类：\n`
      + singles.map((n) => `  ${n}  ← ${orphanLocations(n).join(", ")}`).join("\n"),
    ).toEqual([]);
  });

  it("自检：这条判据必须能看出「`.button.primary` 里 primary 不能单独用」", () => {
    const css = ".hud-surface .button.primary{color:red}.hud-surface .button{color:blue}";
    const standalone = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const part of rule[1].split(",")) {
        for (const compound of part.split(/[\s>+~]+/)) {
          const names = [...compound.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]);
          if (names.length === 1) standalone.add(names[0]);
        }
      }
    }
    expect(standalone.has("button")).toBe(true);
    expect(standalone.has("primary")).toBe(false);
  });

  it("没有哪个类是发出去没人接的", () => {
    const detail = HARD_ORPHANS.map((n) => `  ${n}  ← ${orphanLocations(n).join(", ")}`).join("\n");
    expect(
      HARD_ORPHANS,
      `这些 className 在全仓样式表里没有任何规则接手（元素会裸着）：\n${detail}`,
    ).toEqual([]);
  });

  it("BEM 修饰符变体都要被接住（`block--${x}` 这种写法的每个分支都必然上屏）", () => {
    const detail = MODIFIER_ORPHANS.map((n) => `  ${n}  ← ${orphanLocations(n).join(", ")}`).join("\n");
    expect(
      MODIFIER_ORPHANS,
      `这些类名由 className 模板插值拼出（前缀以 - / __ 收尾），但样式表里没有对应规则：\n${detail}`,
    ).toEqual([]);
  });

  /**
   * 登记项，不判红。
   *
   * `clsx(cond && "primary")`、`a ${cond ? "b" : "c"}` 这类写法里，字面量究竟是
   * 一个完整类名还是某个更长类名的一段，静态判不出来。把猜不准的东西写成会红的断言，
   * 只会制造一条天天假红的守卫，然后所有人开始忽略它。
   *
   * 这一档的处置方式是**人工核对**：每条要么是确实缺规则（那就补 CSS），要么是提取
   * 碎片（那就忽略）。数量应该随重构下降，不设硬门槛，但下面这条防空转断言守着它。
   */
  it("动态字面量登记表：数量被读到（否则就是解析器坏了，不是真的干净）", () => {
    expect(EMITTED.reduce((n, e) => n + e.dynamic.size, 0), "表达式里一个字符串字面量都没读到").toBeGreaterThan(50);
    // eslint-disable-next-line no-console
    console.log(
      `\n[renderer-style-closure-guard] 动态字面量未接住 ${DYNAMIC_UNSTYLED.length} 条（登记，不判红）：\n`
      + DYNAMIC_UNSTYLED.map((n) => `  ${n}  ← ${orphanLocations(n).join(", ")}`).join("\n"),
    );
  });

  it("自检：随便编一个类名，判据必须报它没人接", () => {
    expect(STYLED.has("renderer-closure-guard__definitely-not-styled")).toBe(false);
    const probe = classesEmitted('const x = <div className="renderer-closure-guard__nope" />');
    expect(probe.hard.has("renderer-closure-guard__nope")).toBe(true);
  });

  it("自检：模板插值的 BEM 修饰符必须进 modifier 档（而不是混进 dynamic）", () => {
    const probe = classesEmitted(
      'const x = <div className={`round-notice--${blocked ? "blocked" : "failed"}`} />',
    );
    expect(probe.modifier.has("round-notice--blocked")).toBe(true);
    expect(probe.modifier.has("round-notice--failed")).toBe(true);
    expect(probe.dynamic.has("round-notice--blocked")).toBe(false);

    // 前缀不带分隔符的写法必须落到 dynamic 档——那一档不判红，所以这条判据的
    // 分档正确性直接决定守卫会不会假红。
    const alt = classesEmitted('const x = <div className={`nav-chip ${active ? "a" : "b"}`} />');
    expect(alt.modifier.size).toBe(0);
    expect(alt.dynamic.has("nav-chip")).toBe(true);
  });

  /**
   * 判据的准确率自检：三元里的**判断主语**不能被当成输出。
   *
   * 这不是理论担忧——`graph-surface.tsx:1065` 就是这个形状：
   * `is-${kind === "objective" ? "card" : kind === "evidence" ? "key_point" : kind}`。
   * 若不摘掉比较子句，守卫会要求 `is-objective` / `is-evidence` 各有一条规则，而正确
   * 的做法是**一条都不加**（那两个字面量到不了 DOM）。守卫一旦逼人去补死 CSS，它自己
   * 就变成了它要防的那种污染。
   */
  it("自检：三元的判断主语不得混进输出（否则守卫会逼人补死 CSS）", () => {
    const probe = classesEmitted(
      'const x = <i className={`is-${kind === "objective" ? "card" : kind === "evidence" ? "key_point" : kind}`} />',
    );
    expect([...probe.modifier].sort()).toEqual(["is-card", "is-key_point"]);
    expect(probe.modifier.has("is-objective")).toBe(false);
    expect(probe.modifier.has("is-evidence")).toBe(false);
  });
});
