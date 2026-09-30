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
 * 3. 引用总数设一个上限：行号引用越少越不容易腐烂。超过上限就要改成用类名。
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

/** 引用总数上限。超过就说明文档在靠行号讲结构，而行号会随删除漂移。 */
const REFERENCE_BUDGET = 12;

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
const references: Reference[] = [];

for (const doc of DOCS) {
  const path = resolve(doc);
  expect(path, `找不到 ${doc}`).not.toBeNull();
  const source = readFileSync(path as string, "utf8");
  for (const hit of source.matchAll(/([A-Za-z0-9_./-]+\.(?:css|ts|tsx|mjs|js)):(\d+)(?:-(\d+))?/g)) {
    references.push({
      doc,
      spec: hit[1],
      line: Number.parseInt(hit[2], 10),
    });
  }
}

describe("文档的源码引用不许悬空", () => {
  it("扫到了东西（否则这条守卫是空的）", () => {
    expect(references.length, "一份 `文件:行号` 引用都没扫到").toBeGreaterThan(0);
    expect(DOCS.every((d) => resolve(d) !== null), "有文档没找到").toBe(true);
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

  it("行号引用总数在预算内（越少越不容易腐烂；要讲结构就用类名）", () => {
    const byDoc = DOCS.map((doc) => {
      const n = references.filter((r) => r.doc === doc).length;
      return n > 0 ? `${doc} ${n} 处` : null;
    }).filter(Boolean);
    // eslint-disable-next-line no-console
    console.log(`\n[doc-reference-guard] 源码行号引用共 ${references.length} 处（上限 ${REFERENCE_BUDGET}）：\n  ${byDoc.join("\n  ")}`);
    expect(references.length, `行号引用过多，改用类名：\n  ${byDoc.join("\n  ")}`).toBeLessThanOrEqual(REFERENCE_BUDGET);
  });

  it("自检：引用一个不存在的文件，判据必须报出来", () => {
    expect(findSource("definitely-not-a-real-file.css")).toBeNull();
    expect(findSource("hud-pages.css"), "hud-pages.css 必须能被找到").not.toBeNull();
  });
});
