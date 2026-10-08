/**
 * renderer 的「类名索引」：一次扫描，供多个静态守卫复用。
 *
 * ## 为什么要单独一个模块
 *
 * 2026-09-29 之前，「谁发出了类名」「谁接手了类名」这两件事在每个守卫里各写一遍
 * 正则：`renderer-style-closure-guard` 抓「发出去没人接」，新加的
 * `renderer-style-dead-style-guard` 抓「接了没人发」。两份实现对
 * 模板插值（`block--${x}`）和 `@media` 嵌套的处理**不一样**——一份把三元的判断主语
 * 当成输出值，逼人补了两条死 CSS；另一份压根读不到 `@media` 里的规则。
 * 同一件事两套判据，迟早得出两个矛盾的结论。
 *
 * 所以抽出这一份，两边共用，判据只有一处。
 *
 * ## 三档分类
 *
 * | 档 | 含义 | 能不能静态证明 |
 * |---|---|---|
 * | `hard` | `className="a b"` 里的静态字面量 | **能**——必然上屏 |
 * | `modifier` | 模板里**前缀以 `-` / `__` 收尾**的插值（`round-notice--${x}`） | **能**——这是 BEM 修饰符，名字唯一 |
 * | `dynamic` | 其余表达式字面量（`clsx(c && "x")`、`a ${c ? "b" : "c"}`） | **不能**——字面量可能是完整类名、也可能只是某段文本 |
 *
 * `dynamic` 这一档是关键：把猜不准的东西写成会红的断言，守卫就会天天假红，
 * 然后所有人开始忽略它。`hard` 与 `modifier` 才配判红。
 *
 * ## 为什么解析 CSS 要按「每个深度」各记一条
 *
 * `components/hud/hud-pages.css` 是 199 行装 571 条规则的压缩块（多个规则挤同一行），
 * `components/hud/hud-surface.css` 是 6565 行的正常展开。早期版本只在深度 0 记规则，
 * 于是 `@media` 里那整段（紧凑视图的全部覆写都在里面）一条都没读出来——判据空转。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const RENDERER_ROOT = "src/renderer/src";

/** 与既有守卫一致的读法：cwd 可能是 apps/desktop-client，也可能是仓库根。 */
export const resolve = (relative: string): string | null => {
  for (const base of [relative, `apps/desktop-client/${relative}`]) {
    if (existsSync(base)) return base;
  }
  return null;
};

export const read = (relative: string): string => {
  const path = resolve(relative);
  if (path === null) throw new Error(`找不到 ${relative}（cwd=${process.cwd()}）`);
  return readFileSync(path, "utf8");
};

export const walk = (root: string, extension: RegExp): string[] => {
  const out: string[] = [];
  const visit = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) visit(child);
      else if (extension.test(entry)) out.push(child);
    }
  };
  visit(root);
  return out;
};

export const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 真实类名的唯一形状。没有它，成员访问与分隔符都会被当成类名。 */
const CLASS_SHAPE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** BEM 块名后面等着被插值补全的前缀（`approved-surface--${x}` 的 `approved-surface--`）。 */
const BEM_PREFIX_TAIL = /[-_]+$/;

const splitClasses = (text: string): string[] => text.split(/\s+/).filter((c) => CLASS_SHAPE.test(c));

/**
 * 表达式里的字符串字面量，**先把比较子句摘掉**。
 *
 * `is-${kind === "objective" ? "card" : …}` 里的 `"objective"` 是三元的判断主语，
 * 永远到不了 DOM；只有 `?` 与 `:` 之后的分支才是输出。不摘掉的话守卫会要求
 * `is-objective` 有一条规则，而正确做法是一条都不加。
 */
const stringLiterals = (expression: string): string[] => {
  const branchesOnly = expression
    .replace(/(?:[A-Za-z_$][\w$.[\]?]*\s*[!=]==?\s*|["'][^"']*["']\s*[!=]==?\s*[A-Za-z_$][\w$.[\]?]*)(["'][^"'\n]*["'])/g, " ")
    .replace(/\bcase\s+["'][^"'\n]*["']\s*:/g, " ");
  return [...branchesOnly.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((m) => m[1] ?? m[2] ?? "");
};

/** `className={...}` 的取值；`direct` 区分属性字符串与花括号表达式。 */
const classNameValues = (source: string): { text: string; direct: boolean }[] => {
  const values: { text: string; direct: boolean }[] = [];
  for (const hit of source.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g)) {
    if (hit[1] !== undefined || hit[2] !== undefined) {
      values.push({ text: hit[1] ?? hit[2] ?? "", direct: true });
      continue;
    }
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

export type Emitted = { hard: Set<string>; modifier: Set<string>; dynamic: Set<string> };

/**
 * **不可判定的前缀**：`` `task-surface--${renderedSurface}` `` 这种写法。
 *
 * 表达式是个裸标识符，取值域是运行时枚举（`RoomSurface` 有 10 个值），
 * 静态取不到任何一个类名——但它们**一定**会上屏。`TaskSurface.tsx:381` 就是这个形状。
 *
 * 所以：凡是「前缀以分隔符收尾、而插值表达式里一个字面量都没有」的模板，
 * 它的整个前缀族都判不了。拿它去判「死 CSS」会**误删活规则**——
 * 症状是某个 surface 的版式在运行时塌掉，而且只在真窗口里看得见。
 *
 * 这不是个别情况：`` `page-${n}` ``、`` `is-${status}` ``、`` `note-state-tag--${stage}` ``
 * 都是同一形状。所以做成通用的「不可判定前缀」机制，而不是逐个前缀打补丁。
 */
export type EmittedWithOpaque = Emitted & { opaquePrefixes: Set<string> };

const add = (tier: Set<string>, text: string, raw: boolean) => {
  for (const c of splitClasses(text)) tier.add(c);
  void raw;
};

/** 抽一个源码文件里发出的类名，分三档，并额外报出不可判定的前缀族。 */
export const classesEmitted = (source: string): EmittedWithOpaque => {
  const hard = new Set<string>();
  const modifier = new Set<string>();
  const dynamic = new Set<string>();
  const opaquePrefixes = new Set<string>();

  // ProseMirror decorations emit class attributes as object properties rather
  // than JSX. Treat literal branches as dynamic emitters, not missing styles.
  for (const property of source.matchAll(/\bclass\s*:\s*([^}\n]+)/g)) {
    for (const literal of property[1]!.matchAll(/(["'])([^"']*)\1/g)) add(dynamic, literal[2]!, false);
  }

  for (const { text, direct } of classNameValues(source)) {
    const trimmed = text.trim();

    if (direct) {
      for (const c of splitClasses(trimmed)) hard.add(c);
      continue;
    }

    const plain = /^(["'])([\s\S]*)\1$/.exec(trimmed);
    if (plain) {
      for (const c of splitClasses(plain[2])) hard.add(c);
      continue;
    }

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

      for (const c of splitClasses(parts.map((p) => p.text).join(" "))) {
        if (!BEM_PREFIX_TAIL.test(c)) hard.add(c);
      }

      parts.forEach((part, index) => {
        if (!part.expr) return;
        const prefix = part.text;
        const after = parts[index + 1]?.text ?? "";
        const literals = stringLiterals(part.expr);
        if (BEM_PREFIX_TAIL.test(prefix)) {
          if (literals.length === 0) {
            // 前缀以分隔符收尾、却没有一个字面量 → 整族不可判定（见 opaquePrefixes 的说明）。
            // 取**最后一个 token**：`task-surface task-surface--spatial task-surface--${x}`
            // 的静态块是三个 token，真正被粘上插值结果的只有 `task-surface--`。
            const lastToken = prefix.trim().split(/\s+/).pop() ?? "";
            if (BEM_PREFIX_TAIL.test(lastToken)) opaquePrefixes.add(lastToken);
          }
          for (const literal of literals) {
            for (const c of splitClasses(`${prefix}${literal}${after}`)) modifier.add(c);
          }
        } else {
          for (const c of splitClasses(`${prefix} ${literals.join(" ")} ${after}`)) dynamic.add(c);
          for (const literal of literals) for (const c of splitClasses(literal)) dynamic.add(c);
        }
      });
      continue;
    }

    for (const literal of stringLiterals(trimmed)) {
      for (const c of splitClasses(literal)) dynamic.add(c);
    }
  }

  /**
   * `classList` 与 `className =` 也是发射口。
   *
   * 漏掉它们的后果不是「少报几条死类」，而是**误删活类**：`use-hud-page.ts:50-56`
   * 用 `classList.add/toggle` 挂 `comp-left`／`no-comp`／`space-first`／`space-returning`，
   * `note-markdown-editor.ts:210,235` 用它挂 `note-image-zoomable`／`note-image-unavailable`，
   * `AuthAmbientCanvas.tsx:565` 用 `className =` 挂 `…-ambient-canvas-element`。
   * 只扫 `className="…"` 会把这些全判成死类，然后被一次「清理」删掉——
   * 症状是**版面在运行时塌掉**，而且只在真窗口里看得见。
   */
  for (const hit of source.matchAll(/classList\.(?:add|toggle|replace)\(([^)]*)\)/g)) {
    for (const arg of hit[1].split(",")) {
      const literal = /^(["'])([\s\S]*)\1$/.exec(arg.trim());
      if (literal) add(hard, literal[2], true);
      else for (const c of stringLiterals(arg)) add(dynamic, c, false);
    }
  }
  for (const hit of source.matchAll(/\.className\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
    add(hard, hit[1].slice(1, -1), true);
  }

  /**
   * 不可判定前缀的**全文件**兜底扫描。
   *
   * 有些类名是「先赋给变量、再交给 classList」，压根不写在 `className=` 上：
   * `use-hud-page.ts:48` 是 `const pageClass = \`page-${definition.number}\`;`
   * 然后 `:50` 才 `app.classList.add(pageClass)`。只看 className 会漏掉整个 `page-*` 族。
   *
   * 所以这里把文件里**所有**模板字面量都过一遍。多豁免几个前缀的代价是
   * 「少判几条死类」；少豁免的代价是「误删活规则、版式在运行时塌掉」——
   * 后者严重得多。方向要选对。
   */
  for (const template of source.matchAll(/`([^`]*)`/g)) {
    opaquePrefixesOfTemplate(template[1]).forEach((p) => opaquePrefixes.add(p));
  }

  return { hard, modifier, dynamic, opaquePrefixes };
};

/**
 * 从一个模板字面量的静态块里，取出「后面跟着插值、而插值里没有字面量」的
 * 那一段，作为不可判定前缀。`page-${n}` → `page-`；`a-${x} b-${y}` → `a-` 与 `b-`。
 */
const opaquePrefixesOfTemplate = (body: string): Set<string> => {
  const found = new Set<string>();
  for (const chunk of body.split("${")) {
    const lastToken = chunk.trim().split(/\s+/).pop() ?? "";
    if (BEM_PREFIX_TAIL.test(lastToken) && lastToken.length > 1) found.add(lastToken);
  }
  return found;
};

export type CssRule = { file: string; line: number; selector: string; body: string };

/**
 * 单趟栈扫描，按**每个深度**各记一条规则。注释按等量空格替换以保住行号。
 *
 * 选择器是「上一条规则结束」到**这一个开括号**之间那一段——切到闭括号会把整段
 * 声明体算进选择器，那样任何 `.foo` 锚点都匹配不上。
 */
export const collectCssRules = (file: string): CssRule[] => {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const rules: CssRule[] = [];
  const stack: { selFrom: number; selLine: number; braceAt: number }[] = [];
  let boundaryIndex = 0;
  let boundaryLine = 1;
  let line = 1;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "\n") line += 1;
    else if (ch === "{") {
      stack.push({ selFrom: boundaryIndex, selLine: boundaryLine, braceAt: i });
      boundaryIndex = i + 1;
      boundaryLine = line;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top) {
        const selector = css.slice(top.selFrom, top.braceAt).trim();
        // `@import "…/wght.css"` / `@charset` / `@namespace` 的前言是 URL 与字符串，
        // **不是选择器**。记进去会把 `.css` 当成一个类名——`styles.css:1-2` 那两行
        // 于是凭空多出一个「死类 css」。它们也没有声明块，整条跳过。
        const isUrlPrelude = /^@(?:import|charset|namespace)\b/i.test(selector);
        if (!isUrlPrelude) {
          rules.push({ file, line: top.selLine, selector, body: css.slice(top.selFrom, i + 1) });
        }
      }
      boundaryIndex = i + 1;
      boundaryLine = line;
    }
  }
  return rules;
};

/** 样式表里真正有规则接手的类名。 */
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
    } else if (ch === "}") buffer = "";
    else buffer += ch;
  }
  return found;
};

export type Index = {
  cssFiles: string[];
  tsFiles: string[];
  /** 样式表里有规则的类名 */
  styled: Set<string>;
  /** ts/tsx 发出的类名，三档 + 不可判定前缀族 */
  emitted: Map<string, EmittedWithOpaque>;
  /**
   * 全部不可判定前缀族（`` `task-surface--${x}` `` 这种）。
   * **凡是落在这个族里的类名都判不了生死**——拿它们去判「死 CSS」会误删活规则。
   */
  opaquePrefixes: Set<string>;
  /** 全部 CSS 规则（带文件与行号） */
  rules: CssRule[];
  /** 规则里出现过的全部类名（不管有没有人发） */
  declared: Map<string, CssRule[]>;
};

let cached: Index | null = null;

/** 扫一次全 renderer 并缓存。多个守卫共用一份扫描结果。 */
export const buildIndex = (): Index => {
  if (cached) return cached;
  const root = resolve(RENDERER_ROOT);
  if (root === null) throw new Error(`找不到 ${RENDERER_ROOT}（cwd=${process.cwd()}）`);

  const all = walk(root, /\.(ts|tsx|css)$/);
  const cssFiles = all.filter((f) => f.endsWith(".css"));
  const tsFiles = all.filter(
    (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !/\.(test|spec)\.[tj]sx?$/.test(f) && !f.includes("__tests__"),
  );

  const rules = cssFiles.flatMap(collectCssRules);
  const declared = new Map<string, CssRule[]>();
  for (const rule of rules) {
    for (const name of rule.selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
      const list = declared.get(name[1]) ?? [];
      list.push(rule);
      declared.set(name[1], list);
    }
  }

  const styled = new Set(declared.keys());
  const emitted = new Map<string, EmittedWithOpaque>();
  const opaquePrefixes = new Set<string>();
  for (const file of tsFiles) {
    const e = classesEmitted(readFileSync(file, "utf8"));
    emitted.set(file, e);
    for (const p of e.opaquePrefixes) opaquePrefixes.add(p);
  }

  // The notebook imports Milkdown's CodeMirror component. Its Vue TSX owns the
  // runtime classes styled in note-editor-blocks.css; verify those actual emitters
  // instead of recording a growing list of third-party exemptions.
  const codeBlockRoot = resolve("node_modules/@milkdown/components/src/code-block");
  if (codeBlockRoot) for (const file of walk(codeBlockRoot, /\.(ts|tsx)$/)) {
    const source = readFileSync(file, "utf8").replace(/\bclass\s*=/g, "className=");
    emitted.set(file, classesEmitted(source));
  }

  cached = { cssFiles, tsFiles, styled, emitted, opaquePrefixes, rules, declared };
  return cached;
};

/** 测试之间会改文件时用得上：丢掉缓存，下次重新扫。 */
export const resetIndex = (): void => {
  cached = null;
};

/** 相对 renderer 根的短路径，报错里点得进去。 */
export const shortPath = (file: string): string => {
  const root = resolve(RENDERER_ROOT) as string;
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
};
