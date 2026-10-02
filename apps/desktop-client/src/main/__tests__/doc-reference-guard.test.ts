/**
 * 文档里对源码的「文件:行号」引用不许指向不存在的地方。
 *
 * ## 为什么要有这一条
 *
 * 2026-09-29 勘察 `DESIGN.md` 时发现：全文只有 6 处 `文件:行号` 形式的源码引用，
 * **其中 2 处是错的**——
 *
 * - `DESIGN.md:198` 说母本 `.button` 的 `:hover` / `:active` 在 `hud-pages.css:159` / `:160`，
 *   实测在 **`:162` / `:163`**；那两行里根本没有 `transform`。
 * - `DESIGN.md:153` 宣称「V2 切角已清完，全站 0 处」，而 `hud-pages.css` 里
 *   `.book-cover{border-radius:3px 13px 3px 3px}` **至今没有任何后续规则覆盖它**。
 *
 * 同一天我删掉了母本 455 条死规则，那份 199 行的压缩文件缩到 154 行——**所有行号引用当场失效**。
 * 文档里的行号是**会腐烂的指针**：删一次代码，引用就指向别人，且没有任何东西会报。
 *
 * ## 判据
 *
 * 1. 被引用的文件必须存在。
 * 2. 行号必须落在文件范围内，且那一行**不能是空行**——指向空行基本等于指向了别处。
 * 文档可以不包含行号引用；解析器用独立样本检验。
 *
 * 本守卫**不判断那一行「对不对」**——那需要知道文档想说什么。这条只保证指针不悬空；
 * 内容对不对由写文档的人负责，但至少烂掉的指针会被当场看见。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCS = ["AGENTS.md", "DESIGN.md", "PRODUCT.md"];

/** 文档里引用到的源码目录（相对仓库根）。 */
const SOURCE_ROOTS = [
  "apps/desktop-client/src/renderer/src",
  "apps/desktop-client/src/renderer",
  "apps/desktop-client/src/main",
  "apps/desktop-client/scripts",
  "apps/api/src",
  "packages/shared/src",
];


const resolve = (relative: string): string | null => {
  // 这三份文档在**仓库根**，而守卫跑在 `apps/desktop-client` 下（vitest 的 cwd）。
  // 既有守卫的 `resolve` 假设文件在包内，所以这里要额外向上找两级。
  for (const base of [
    relative,
    `apps/desktop-client/${relative}`,
    `../../${relative}`,
    `../../../${relative}`,
  ]) {
    if (existsSync(base)) return base;
  }
  return null;
};

/** 在 SOURCE_ROOTS 里找到 `hud-pages.css` 这样的短名。 */
const findSource = (shortName: string): string | null => {
  for (const root of SOURCE_ROOTS) {
    const abs = resolve(root);
    if (!abs) continue;
    for (const dir of [abs, `${abs}/components`, `${abs}/components/hud`, `${abs}/components/surfaces`, `${abs}/components/companion`, `${abs}/components/hud/hud`]) {
      const candidate = `${dir}/${shortName}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
};

type Reference = { doc: string; spec: string; line: number };
function collectReferences(doc: string, source: string): Reference[] {
  return [...source.matchAll(/([A-Za-z0-9_./-]+\.(?:css|ts|tsx|mjs|js)):(\d+)(?:-(\d+))?/g)]
    .map(hit => ({ doc, spec: hit[1], line: Number.parseInt(hit[2], 10) }));
}

const references = DOCS.flatMap(doc => {
  const path = resolve(doc);
  expect(path, `找不到 ${doc}`).not.toBeNull();
  const source = readFileSync(path as string, "utf8");
  expect(source.trim(), `${doc} 内容为空`).not.toBe("");
  return collectReferences(doc, source);
});

describe("文档的源码引用不许悬空", () => {
  it("读取了文档，并允许文档没有行号引用", () => {
    expect(DOCS.every((d) => resolve(d) !== null), "有文档没找到").toBe(true);
    expect(collectReferences("probe.md", "使用控件名称与路径说明结构")).toEqual([]);
  });

  it("自检：有行号引用时确实能读出文件、范围起点与行号", () => {
    expect(collectReferences("probe.md", "`hud-pages.css:1-2` 与 `components/example.tsx:42`"))
      .toEqual([
        { doc: "probe.md", spec: "hud-pages.css", line: 1 },
        { doc: "probe.md", spec: "components/example.tsx", line: 42 },
      ]);
  });

  it("被引用的文件都存在", () => {
    const missing = references
      .filter((r) => findSource(r.spec.split("/").pop() as string) === null)
      .map((r) => `  ${r.doc}  →  ${r.spec}:${r.line}`);
    expect(missing, `这些引用指向的文件不存在：\n${missing.join("\n")}`).toEqual([]);
  });

  it("行号落在文件范围内，且那一行不是空的", () => {
    const dangling: string[] = [];
    for (const reference of references) {
      const file = findSource(reference.spec.split("/").pop() as string);
      if (file === null) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      if (reference.line > lines.length) {
        dangling.push(`  ${reference.doc} → ${reference.spec}:${reference.line}  （文件只有 ${lines.length} 行）`);
        continue;
      }
      const text = lines[reference.line - 1] ?? "";
      if (text.trim() === "") {
        dangling.push(`  ${reference.doc} → ${reference.spec}:${reference.line}  （指向空行，多半已经漂移）`);
      }
    }
    expect(
      dangling,
      `这些引用已经漂移。**以类名为准、以行号为辅**：母本是压缩块，删一次就全失效。\n${dangling.join("\n")}`,
    ).toEqual([]);
  });

  it("自检：引用一个不存在的文件，判据必须报出来", () => {
    expect(findSource("definitely-not-a-real-file.css")).toBeNull();
    expect(findSource("hud-pages.css"), "hud-pages.css 必须能被找到").not.toBeNull();
  });
});
