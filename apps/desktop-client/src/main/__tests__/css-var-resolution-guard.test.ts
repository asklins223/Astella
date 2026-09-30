/**
 * `var(--x)` 必须有声明或 fallback，否则整条声明在**计算值时失效**。
 *
 * ## 为什么要有这一条
 *
 * 这是最安静的一类 CSS 缺陷：代码读起来完全正常，测试全绿，class 名闭合守卫也说
 * 「有人接手」，但那一条属性在浏览器里**根本没生效**。
 *
 * 2026-09-29 实测到两个活 bug：
 *
 * - `note-hud.css` 的两处 `box-shadow: var(--hud-shadow-card)` —— 这个 token
 *   **从未被声明过**。按 CSS 变量规则，未声明的 `var()` 会让整条声明 invalid at
 *   computed-value time，`box-shadow` 于是取初始值 `none`：**那几张笔记纸卡是平的，
 *   没有影**。屏幕上只表现为"这页看着有点平"，没有任何报错。
 * - `note-hud.css` 的 `border-left: 4px solid var(--hud-mint-strong)` —— 同样未声明。
 *   这里更糟：失效的是**整条 `border-left` 简写**，所以那条 4px 的青绿左标
 *   **整个不渲染**，纸签直接少一根识别标。
 *
 * 两条都写得很合理（跟着邻居抄的），都没有任何机制拦下它们。
 *
 * ## 判据
 *
 * 对每个 `var(--x)`：
 * 1. 要么 `--x` 在某处**声明**过；
 * 2. 要么这次引用**带了 fallback**（`var(--x, 值)`）；
 * 3. 要么它**由 JS 注入**（`style={{"--x": …}}`）——这是合法的运行时通道。
 * 三者都不满足 ⇒ 这条声明在运行时是死的。
 *
 * 放在 main 侧的理由：读文件要用 `node:fs`，`tsconfig.web.json` 的编译图里没有 Node 类型。
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
const CSS_FILES = walk(root, /\.css$/);
const TS_FILES = walk(root, /\.(ts|tsx)$/).filter((f) => !/\.(test|spec)\.[tj]sx?$/.test(f));

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*/g, "");

const allCss = CSS_FILES.map((f) => strip(readFileSync(f, "utf8"))).join("\n");
const allTs = TS_FILES.map((f) => readFileSync(f, "utf8")).join("\n");

/** 被声明过的自定义属性。 */
const declared = new Set([...allCss.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
/** 由 JS 以 style={{"--x": …}} 注入的——合法的运行时通道。 */
const jsInjected = new Set([...allTs.matchAll(/["'`](--[a-zA-Z0-9_-]+)["'`]\s*:/g)].map((m) => m[1]));

type Dead = { token: string; file: string; line: number };
type Ref = { token: string; fallback: boolean };
const allRefs: Ref[] = [];
const dead: Dead[] = [];

for (const file of CSS_FILES) {
  const lines = strip(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const hit of line.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g)) {
      const token = hit[1];
      const hasFallback = hit[2] === ",";
      allRefs.push({ token, fallback: hasFallback });
      if (hasFallback) continue;                // 有 fallback
      if (declared.has(token)) continue;        // 有声明
      if (jsInjected.has(token)) continue;      // JS 注入
      dead.push({ token, file: file.slice(root.length + 1), line: index + 1 });
    }
  });
}

const uniq = [...new Set(dead.map((d) => d.token))].sort();

describe("var() 要么有声明，要么有 fallback，要么由 JS 注入", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(CSS_FILES.length, "没扫到样式表").toBeGreaterThanOrEqual(20);
    expect(declared.size, "没扫到自定义属性声明").toBeGreaterThan(20);
    // 防空转看的是**扫到了多少个 var() 引用**，不是「有没有缺陷」——
    // 把 0 修干净正是这件工作的目标，拿它当证据就等于要求工作永远做不完。
    expect(allRefs.length, "一个 var() 引用都没扫到，扫描器多半坏了").toBeGreaterThan(1000);
    expect(allRefs.some((r) => r.fallback), "带 fallback 的写法一个都没扫到，解析器多半坏了").toBe(true);
  });

  it("没有哪个 var() 指向一个既没声明、也没 fallback、也没 JS 注入的变量", () => {
    const detail = dead.map((d) => `  ${d.token}  ← ${d.file}:${d.line}`).join("\n");
    expect(
      uniq,
      `这些 var() 指向的变量从未被声明、这次引用也没有 fallback、也没有 JS 注入。\n`
      + `按 CSS 规则，**整条声明在计算值时失效**——box-shadow 变 none、border 简写整个不渲染。\n`
      + `要么在样式表里声明它，要么给这次引用补一个 fallback。\n${detail}`,
    ).toEqual([]);
  });

  it("自检：一个既没声明也没 fallback 的 var() 必须被报出来，带 fallback 的必须放行", () => {
    const classify = (probe: string) => {
      const hit = /var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/.exec(probe);
      if (!hit) return null;
      const token = hit[1];
      if (hit[2] === ",") return "fallback";
      if (declared.has(token)) return "declared";
      if (jsInjected.has(token)) return "js";
      return "dead";
    };
    expect(classify("box-shadow:var(--renderer-var-guard__nope);")).toBe("dead");
    expect(classify("color:var(--renderer-var-guard__nope, #fff);")).toBe("fallback");
    expect(classify("color:var(--hud-ink);")).toBe("declared");
  });
});
