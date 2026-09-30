/**
 * 「主强调色只有一个主人」的守卫。
 *
 * ## 为什么要有这一条
 *
 * 2026-09-29 的全量勘察发现，「关键按钮不加重点色」不是 agent 忘了选色，而是**项目
 * 本身对「主强调色是谁」没有唯一答案**。实测同时存在三套：
 *
 * | 来源 | 值 | 消费者 |
 * |---|---|---|
 * | `hud-pages.css` `.button.primary` | `--hud-peach #e89568` + 深墨字 | 全站母本 |
 * | `objective-flow.css` `.learning-run-dock__row--act > .button.primary` | `--quest-clay #d56d48` | 覆写了母本 |
 * | `styles.css` `.surface-primary` | `linear-gradient(#b85328,#933b1f)` + 白字 | 2 处 |
 *
 * 而 `--quest-clay` 同时被 7 处**非按钮**元素占用（进度条、选中记号、拖拽把手…），
 * 于是「主按钮的红」和「选中态的红」在语义上搅成一团。`.button` 本身还有三段级联
 * （`hud-pages.css:84 / :151 / :182`），`:85` 的陶土阴影因特异性 (0,3,0) 高于 `:152`
 * 的 (0,2,0) 而存活在桃色底上——**同一颗按钮同时带着两代配色的残骸**。
 *
 * 2026-09-29 已把这三处收敛为母本一处（见 `styles.css` 与 `objective-flow.css` 的
 * 注释）。本守卫的作用是**不让它再分叉**。
 *
 * ## 判据
 *
 * 1. 全仓**恰好一条**规则给 `.button.primary` 写 `background`。
 * 2. 没有任何**祖先/后代限定**的 `.button.primary` 规则再改它的 `background`
 *    （夜间与紧凑档除外——那两档调的是 `color` 与尺寸，本来就该放行）。
 * 3. `.surface-primary` 这个名字不许再出现（它是那套已废的深橙渐变主按钮）。
 * 4. 登记档：把「在非 `.button.primary` 元素上刷主强调色」的位置列出来。
 *    **只登记不判红**——其中一部分是正当的（tag、进度条、印章、选中态），
 *    一部分是「本该用 `.button.primary` 却自己刷了一层」的债。人工核对，数字应随重构下降。
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

const read = (relative: string): string => {
  const path = resolve(relative);
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
const CSS_FILES = walk(RENDERER_ABS).filter((f) => f.endsWith(".css"));

type Rule = { file: string; line: number; selector: string; body: string };

/**
 * 单趟栈扫描，按**每个深度**各记一条规则。
 *
 * 两种形状都必须处理：`hud-pages.css` 是 199 行装 571 条规则的压缩块（多个规则挤在
 * 同一行），`hud-surface.css` 是 6565 行的正常展开。早期版本只在深度 0 记规则，
 * 于是 `@media` 里那整段（紧凑视图的按钮覆写全在里面）一条都没读出来——判据直接空转。
 * 注释按等量空格替换，保住行号，报错才能点进去。
 */
const collectRules = (file: string): Rule[] => {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const rules: Rule[] = [];
  const stack: { selFrom: number; selLine: number; braceAt: number }[] = [];
  let boundaryIndex = 0;
  let boundaryLine = 1;
  let line = 1;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "\n") line += 1;
    else if (ch === "{") {
      // 选择器是「上一条规则结束」到**这一个开括号**之间那一段。切到闭括号会把整段
      // 声明体算进选择器——那样 `.hud-surface .button.primary` 就再也匹配不上任何锚点。
      stack.push({ selFrom: boundaryIndex, selLine: boundaryLine, braceAt: i });
      boundaryIndex = i + 1;
      boundaryLine = line;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top) {
        rules.push({
          file,
          line: top.selLine,
          selector: css.slice(top.selFrom, top.braceAt).trim(),
          body: css.slice(top.selFrom, i + 1),
        });
      }
      boundaryIndex = i + 1;
      boundaryLine = line;
    }
  }
  return rules;
};

const ALL_RULES = CSS_FILES.flatMap(collectRules);

/** 夜间档与紧凑档：这两处本来就可以改主按钮的观感，不算分叉。 */
const isThemeOrCompact = (rule: Rule) =>
  /\[data-theme\s*=\s*"(night|dark)"\]/.test(rule.selector) || /@media/.test(rule.selector);

const setsBackground = (body: string) => /(^|[;{\s])background(-color)?\s*:/.test(body);

const describeRule = (rule: Rule) => `${rule.file.replace(`${RENDERER_ABS}/`, "")}:${rule.line}  ${rule.selector.slice(0, 90)}`;

describe("主强调色只有一个主人", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(CSS_FILES.length, "没扫到样式表").toBeGreaterThanOrEqual(20);
    expect(ALL_RULES.length, "没解析出规则").toBeGreaterThan(2000);
  });

  it("全仓恰好一处给 .button.primary 写底色", () => {
    const owners = ALL_RULES.filter(
      (rule) => /\.button\.primary(?![-\w])/.test(rule.selector) && setsBackground(rule.body) && !isThemeOrCompact(rule),
    );
    expect(
      owners.map(describeRule),
      `主按钮的底色应当只有母本一处管；多出来的每一处都是「同一个主按钮有两种红」的来源：\n${
        owners.map((r) => `  ${describeRule(r)}`).join("\n")
      }`,
    ).toHaveLength(1);
    // 顺带钉住它必须是母本那一处，不是某个功能页
    expect(owners[0]?.file).toContain("hud/hud-pages.css");
  });

  it("没有任何后代限定规则再覆写主按钮的底色", () => {
    // 形如 `.foo .button.primary { ... }`（母本那条是 `.hud-surface .button.primary`，不带功能前缀）
    const overrides = ALL_RULES.filter(
      (rule) =>
        /\.button\.primary(?![-\w])/.test(rule.selector) &&
        setsBackground(rule.body) &&
        !isThemeOrCompact(rule) &&
        !/^\.hud-surface\s+\.button\.primary$/.test(rule.selector),
    );
    expect(
      overrides.map(describeRule),
      `这些规则在母本之外又给主按钮上了底色：\n${overrides.map((r) => `  ${describeRule(r)}`).join("\n")}`,
    ).toEqual([]);
  });

  it("`.surface-primary` 不许再回来（那套已废的深橙渐变主按钮）", () => {
    const resurrected = ALL_RULES.filter((rule) => /\.surface-primary(?![-\w])/.test(rule.selector));
    expect(
      resurrected.map(describeRule),
      `主按钮的名字只能有一个。要改配色就改母本 .button.primary，别另起一套：\n${
        resurrected.map((r) => `  ${describeRule(r)}`).join("\n")
      }`,
    ).toEqual([]);
  });

  it("主按钮带的是深墨字，不是白字（奶白字压在桃底上读不清）", () => {
    const owner = ALL_RULES.find((r) => /^\.hud-surface\s+\.button\.primary$/.test(r.selector));
    expect(owner, "母本 .button.primary 不在了").toBeDefined();
    expect(owner!.body).toMatch(/color:\s*#3e2d22/);
  });

  /**
   * 登记档，只列不判红。
   *
   * 「在别的元素上刷主强调色」本身不一定是错的——tag、进度条、印章、选中态都要用它。
   * 真正的问题是其中一部分**本该用 `.button.primary` 却自己刷了一层**，于是那颗按钮
   * 绕过了母本（换主题时不会跟着走、圆角与阴影也不成套）。这一档让人工核对，数字应下降。
   */
  it("登记档：非 .button.primary 元素上的主强调色用在哪", () => {
    const hits = ALL_RULES.filter(
      (rule) =>
        !isThemeOrCompact(rule) &&
        setsBackground(rule.body) &&
        /var\(--hud-peach\)/.test(rule.body) &&
        !/\.button\.primary/.test(rule.selector),
    );
    // 防空转：真的读到了，才说明这一档有意义
    expect(ALL_RULES.filter((r) => /var\(--hud-peach\)/.test(r.body)).length).toBeGreaterThan(5);
    // eslint-disable-next-line no-console
    console.log(
      `\n[renderer-accent-guard] 非 .button.primary 元素上的主强调色 ${hits.length} 处（登记，人工核对）：\n`
        + hits.map((r) => `  ${describeRule(r)}`).join("\n"),
    );
  });

  it("自检：多写一处主按钮底色，判据必须报出来", () => {
    const probe: Rule[] = [
      { file: "probe.css", line: 1, selector: ".hud-surface .button.primary", body: "background: var(--hud-peach);" },
      { file: "probe.css", line: 2, selector: ".some-feature .button.primary", body: "background: var(--quest-clay);" },
    ];
    const owners = probe.filter((r) => /\.button\.primary(?![-\w])/.test(r.selector) && setsBackground(r.body) && !isThemeOrCompact(r));
    expect(owners).toHaveLength(2); // 两条都算主人 → 判据会红
    const resurrected = probe.filter((r) => /\.surface-primary(?![-\w])/.test(r.selector));
    expect(resurrected).toEqual([]); // 正对照：没写 surface-primary 就不该报
  });
});
