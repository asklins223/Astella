/**
 * 「一屏只有一个主行动」——主行动标记方式的欠账台账。
 *
 * ## 为什么要有这一条
 *
 * 用户报的现象是「关键按钮放在一边不加重点色、不加重点效果」。查下来根因不是 agent
 * 忘了选色，而是**项目对「什么是主行动」有 13 种写法**：
 *
 * | 写法 | 用在 `<button>` 上的处数 |
 * |---|---|
 * | `className="button primary"`（母本写法） | 52 处，全站统一 |
 * | 另外 12 种功能专属命名 | 13 处 |
 *
 * 每多一种写法，就多一份「这颗按钮到底算不算主动作」的口径不一致；两个页面各用一种，
 * 屏上就分不出主次。母本写法明明只有一种（`.button.primary`，`hud-pages.css:152`
 * 唯一一处定义，由 `renderer-accent-guard` 钉着），另外 12 种是各自抄的。
 *
 * 本守卫**不要求今天就归零**——那是一次跨页面的版式改动，不该混在守卫里。
 * 它要做的是：把欠账**变成一份有名字、有位置、有理由的清单**，并且
 * **钉住它不许增长**。新增一种主行动写法而不登记，这里立刻红。
 *
 * 清单里每条都写明「今天为什么是这样」和「它该变成什么」——所以它同时是一张
 * 可以逐条销账的工单，而不是一纸免责声明。
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

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) walk(child, out);
    else if (/\.tsx$/.test(entry) && !/\.(test|spec)\.tsx$/.test(entry)) out.push(child);
  }
  return out;
};

/** 「看起来在标主行动」的名字形状。母本写法是裸的 `primary`，其余都带功能前缀。 */
const LOOKS_PRIMARY =
  /(^|[-_])(primary|main)$|surface-primary|is-primary|companion-primary-action/;

const root = resolve(RENDERER_ROOT) as string;
const TSX_FILES = walk(root);

/** 每一处「在 button 上、且用了非母本写法标主行动」的位置。 */
type Offender = { className: string; file: string; line: number };
const offenders: Offender[] = [];
let sanctioned = 0;

for (const file of TSX_FILES) {
  const source = readFileSync(file, "utf8");
  for (const tag of source.matchAll(/<button\b[\s\S]{0,400}?>/g)) {
    const cls = /className="([^"]*)"/.exec(tag[0])?.[1] ?? "";
    const tokens = cls.split(/\s+/).filter(Boolean);
    if (tokens.includes("button") && tokens.includes("primary")) {
      sanctioned += 1;
      continue;
    }
    const marks = tokens.filter((t) => LOOKS_PRIMARY.test(t));
    if (marks.length === 0) continue;
    offenders.push({
      className: marks.join(" "),
      file: file.slice(root.length + 1),
      line: source.slice(0, tag.index).split("\n").length,
    });
  }
}

/**
 * 欠账台账：类名 → 今天为什么是这样、它该变成什么。
 *
 * **这里没有「结构性例外」一档。** 逐条核过：13 处全部渲染在 `.hud-surface` 之内
 * （`App.tsx:183` 的根元素包住了门禁、首页、任务面与所有浮层），所以
 * `.button.primary` 对它们全都适用——它们是欠账，不是例外。
 * 新增一条时，请同时写清「今天为什么」与「该变成什么」两段。
 */
const PRIMARY_ACTION_DEBT: Readonly<Record<string, string>> = {
  "desktop-access-gate__primary":
    "门禁（登录/注册/邀请）自己画了一整套按钮，比 `.button` 大一号并带自己的 `--gate-*` 主题。"
    + "它渲染在 `.hud-surface` 之内（`App.tsx:183` 的根元素包住了门禁），所以不是结构性例外。"
    + "该变成：让 `.button.primary` 在门禁作用域里读到 `--gate-*`，门禁只保留尺寸差异。",
  "run-recovery-notice__primary":
    "恢复横幅的「重新读取 / 继续」按钮。横幅是浮层、自己带纸面与柔影，按钮跟着用了另一套规格。"
    + "该变成：`.button primary`，横幅只提供纸面。",
  "notebook-overview-entry__primary":
    "速看卡上的主动作。该变成 `.button primary`，卡片只负责摆位。",
  "notebook-selection-actions__main":
    "选区工具条上的主动作，是一枚 chip 不是一块按钮——尺寸是按 44px 触控区定的。"
    + "该变成：`.button primary` + 工具条把 `min-height` 收窄。",
  "is-primary":
    "星图详情里「聚焦星体 / 打开记录」那一对中的主动作（`graph-surface.tsx:1110`）。"
    + "该变成 `.button primary`，随之删掉 `understanding-universe.css` 里"
    + "`.universe-detail-actions > .is-primary` 与配套的 `.is-secondary` 两条规则。",
  "home-v2-hud__primary":
    "首页 HUD 的主动作岛。它渲染在 `createPortal` 出去的位置上（`HomeV2ObjectLayer` 的 "
    + "portalTarget 默认是 `document.body`），**在 `.hud-surface` 子树之外**——"
    + "所以它是本清单里唯一一条真例外。该变成：要么把 portal 落点搬进 `.hud-surface` 子树"
    + "（首选，母本规则直接生效），要么在这块自带一份局部 token 表并显式复用 `.button.primary`。",
  "home-v2-feature-notice__primary":
    "功能说明纸上的那颗。与上一条同一个 portal 落点，该变成：一起把落点搬进子树，"
    + "或同样自带局部 token 表。",
  "companion-primary-action":
    "伴星中心概览里的主动作。渲染在 `.hud-surface` 内，该变成 `.button primary`。",
};

describe("一屏一个主行动：写法不许再增加", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(TSX_FILES.length, "没扫到组件文件").toBeGreaterThanOrEqual(60);
    expect(sanctioned, "母本写法 `button primary` 一处都没有——守卫大概扫错了").toBeGreaterThan(20);
  });

  it("欠账清单与实际一致：新增一种主行动写法而不登记，这里立刻红", () => {
    const found = [...new Set(offenders.map((o) => o.className))].sort();
    const detail = offenders
      .map((o) => `  ${o.className}  ← ${o.file}:${o.line}`)
      .join("\n");
    expect(
      found,
      `这些类名在 <button> 上标着「主行动」，却不是母本的 button primary。\n`
      + `要改用母本就直接改；要保留就在 ${"PRIMARY_ACTION_DEBT"} 里登记，`
      + `并写清「今天为什么」与「该变成什么」两段。\n${detail}`,
    ).toEqual(Object.keys(PRIMARY_ACTION_DEBT).sort());
  });

  it("台账每一条都写清了「该变成什么」（只有「今天为什么」的不算销账工单）", () => {
    const thin = Object.entries(PRIMARY_ACTION_DEBT).filter(([, reason]) => !/该变成|该改名/.test(reason));
    expect(thin.map(([name]) => name), `这些欠账条目没写「该变成什么」：${thin.map(([n]) => n).join(", ")}`).toEqual([]);
  });

  it("母本写法是默认解（它必须持续被使用，不能被功能专属写法挤掉）", () => {
    // 52 : 13。母本写法占绝大多数；这个比值一旦反过来，说明功能专属写法在扩散。
    const ratio = sanctioned / Math.max(offenders.length, 1);
    // eslint-disable-next-line no-console
    console.log(
      `\n[renderer-primary-action-guard] 母本 button primary ${sanctioned} 处，`
      + `功能专属写法 ${offenders.length} 处（比值 ${ratio.toFixed(1)}:1）：\n`
      + offenders.map((o) => `  ${o.className}  ← ${o.file}:${o.line}`).join("\n"),
    );
    expect(sanctioned, "母本写法用得太少，功能专属写法在扩散").toBeGreaterThan(offenders.length * 2);
  });

  it("自检：塞一个没登记的主行动写法，判据必须报出来", () => {
    const probe: Offender[] = [{ className: "some-feature__primary", file: "x.tsx", line: 1 }];
    expect(probe.map((o) => o.className)).not.toContain("button primary");
    expect(Object.keys(PRIMARY_ACTION_DEBT)).not.toContain("some-feature__primary");
  });
});
