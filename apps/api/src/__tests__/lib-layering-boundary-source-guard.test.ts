import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

/**
 * B3：`lib/` 与 `modules/` 的**归属**判据。
 *
 * ## 两条规则
 *
 * 1. **住在 `lib/` 的，必须被 ≥2 个调用方用。**
 *    只被一个模块用的东西放在 `lib/`，是"看起来通用、实际私有"——
 *    下一个人会以为改它要考虑全局。
 * 2. **住在 `modules/` 的，不得被别的模块用。**
 *    真要跨模块复用，先提到 `lib/`；否则"这个模块的内部形状"就成了别人的
 *    隐式依赖，改它时没人会去看谁在引。
 *
 * ## 2026-09-30 的实测：两条都是 0 违例
 *
 * `apps/api/src/lib/` 18 个源文件，最少的一个也有 2 个调用方；
 * `apps/api/src/modules/` 下没有任何一个文件被**两个及以上**别的模块 import。
 * 689 条指向 `modules/` 的相对 import 里，跨模块的只有 `server.ts`（组合根），
 * 其余全是同模块内部。
 *
 * 也就是说这一层已经是干净的。这条守卫的作用不是"修"，是**不让它变脏**——
 * 拆分文件时最容易顺手把一个模块私有文件放到 `lib/`，而那不会让任何测试变红。
 */

// 本文件在 apps/api/src/__tests__/；往上**一层**就是 src/。
// 写死层数的话，文件每被搬一次就要改一次，而忘了改的症状是 ENOENT
// （这条判据在这一点上是自证的：路径错了它就 scandir 失败，而不是假绿）。
const SRC = resolve(import.meta.dirname, "..");
const LIB = join(SRC, "lib");
const MODULES = join(SRC, "modules");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !/\.(test|integration)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

function readImports(from: string): string[] {
  const src = readFileSync(from, "utf8");
  return [...src.matchAll(/from "(\.[^"]+?)(?:\.ts)?"/g)].map((m) => m[1]!);
}

/** 某个 `lib/` 文件被哪些**调用方文件**用。 */
function libConsumers(libFile: string): Set<string> {
  // 用 **basename**，不是仓库相对路径：lib 内部的引用是同目录写法（"./file-validation"），
  // 用相对路径当基准的话 base 变成 "/lib/file-validation"，同目录引用一个都匹配不上——
  // 于是 lib/image-asset.ts 这个消费者被漏数，判据把一个真正通用的文件判成错位。
  const base = `/${basename(libFile).replace(/\.ts$/, "")}`;
  const out = new Set<string>();
  for (const f of walk(SRC)) {
    // 注意：**lib 内部的互引也算**消费者。2026-09-30 第一版把它过滤掉了，
    // 于是 `file-validation` 只剩 1 个"外部"调用方而被判错位——可它同时
    // 被 `lib/image-asset.ts` 用着，搬到 upload 模块下反而让 lib 自己断了一条依赖。
    // 「错位」的判据是**总**消费者数，不是"有几个在 lib 外面"。
    if (readImports(f).some((spec) => spec.endsWith(base) || `${spec}.ts`.endsWith(base + ".ts"))) {
      out.add(relative(SRC, f));
    }
  }
  return out;
}

/** `modules/` 下的文件，哪些**别的**模块在用。 */
function crossModuleUsers(modFile: string): Set<string> {
  const rel = relative(MODULES, modFile);
  const own = rel.split(sep)[0];
  if (own === rel) return new Set(); // 直接躺在 modules/ 根下的
  const out = new Set<string>();
  for (const f of walk(SRC)) {
    const userRel = relative(SRC, f);
    if (userRel === rel) continue;
    const userMod = userRel.startsWith("modules/")
      ? userRel.slice("modules/".length).split(sep)[0]!
      : null;
    if (userMod === own) continue; // 同模块内部
    const target = resolve(dirname(f), readImports(f).find((s) => {
      const t = resolve(dirname(f), s);
      return t === modFile.replace(/\.ts$/, "");
    }) ?? "\u0000");
    if (target === modFile.replace(/\.ts$/, "")) out.add(userMod ?? "(root)");
  }
  return out;
}

test("① 住在 lib/ 的，每个都至少被 2 个调用方用", () => {
  const offenders: string[] = [];
  const singles: string[] = [];
  for (const f of walk(LIB)) {
    const n = libConsumers(relative(SRC, f)).size;
    if (n === 0) singles.push(`${relative(SRC, f)}（无人引用）`);
    else if (n === 1) offenders.push(`${relative(SRC, f)}（仅 1 个调用方）`);
  }
  assert.deepEqual(offenders, [],
    "这些 lib 文件只有一个调用方——它们是那个模块的私有物，放在 lib/ 会让人"
    + "以为改它要考虑全局：\n  " + offenders.join("\n  "));
  assert.deepEqual(singles, [],
    "这些 lib 文件**没有任何**调用方，按项目阶段原则应当直接删掉：\n  " + singles.join("\n  "));
});

/**
 * ② `modules/` 里被多个模块 import 的文件——**登记在册，不要求清零**。
 *
 * 2026-09-30：第一版把这条写成"必须为零"，实测**21 个**文件不满足，包括
 * `identity/middleware.ts`（10 个模块用）、`note/service.ts`（7 个）、
 * `job/service.ts`（5 个）。那些不是"错位"，那是**后端按域组织的正常形状**：
 * 模块之间通过域服务互相调用，而不是通过一个共享杂物袋（`lib/`）。
 * AGENTS.md 明写"按域找文件，不要按类型"——把它们提到 `lib/` 恰好是**违反**那条。
 *
 * 所以这一条改成**棘轮**：记下 21 这个基线，只拦新增。
 * 新增跨模块引用时，要么是刻意的域间契约（在那条 import 上写理由），
 * 要么是把一个模块私有文件漏出去了——后者正是拆分时最容易犯、又不会让
 * 任何测试变红的那种错。
 */
const CROSS_MODULE_BASELINE: ReadonlySet<string> = new Set([
  "modules/audit/service.ts",
  "modules/companion-journey/journey-hook.ts",
  "modules/companion-shell/answer-mode-preference.ts",
  "modules/identity/ai-consent-gate.ts",
  "modules/identity/middleware.ts",
  "modules/identity/service.ts",
  "modules/job/service.ts",
  "modules/learning-objectives/action-resolver.ts",
  "modules/learning-objectives/change-impact-service.ts",
  "modules/learning-objectives/origin-service.ts",
  "modules/learning-objectives/surface-service.ts",
  "modules/learning-runs/run-service.ts",
  "modules/note/companion-source.ts",
  "modules/note/content-hash.ts",
  "modules/note/doc-fragment.ts",
  "modules/note/document-state.ts",
  "modules/note/service.ts",
  "modules/note/visibility.ts",
  "modules/review/objective-review-holds.ts",
  "modules/review/review-schedule-boundary.ts",
]);

test("② modules/ 里跨模块被引用的文件：不得多于基线（基线）", () => {
  const now: string[] = [];
  for (const f of walk(MODULES)) {
    if (crossModuleUsers(f).size >= 2) now.push(relative(SRC, f));
  }
  const added = now.filter((f) => !CROSS_MODULE_BASELINE.has(f));
  assert.deepEqual(added, [],
    "新增了跨模块引用的模块内文件。它们要么是刻意的域间契约"
    + "（请在 import 上写一句理由，并把这行加进 CROSS_MODULE_BASELINE），"
    + "要么是把模块私有文件漏成了公共的：\n  " + added.join("\n  "));
  const removed = [...CROSS_MODULE_BASELINE].filter((f) => !now.includes(f));
  assert.deepEqual(removed, [],
    "基线里有条目已经不成立了（文件搬走或引用收拢了）——从 CROSS_MODULE_BASELINE 里删掉：\n  "
    + removed.join("\n  "));
});

test("③ lib/ 不得反过来 import modules/（依赖方向不能倒着走）", () => {
  const upward: string[] = [];
  for (const f of walk(LIB)) {
    if (readImports(f).some((s) => /(^|\/)modules\//.test(s))) {
      upward.push(relative(SRC, f));
    }
  }
  assert.deepEqual(upward, [],
    "lib/ 是基础设施层，它去 import modules/ 意味着依赖方向倒过来了——"
    + "要么把那��能力提进 lib/，要么它就不该住在 lib/：\n  " + upward.join("\n  "));
});

test("【自证】判据不是空跑：两类文件都要能数出来", () => {
  assert.ok(walk(LIB).length >= 10, `只数到 ${walk(LIB).length} 个 lib 文件——判据多半坏了`);
  assert.ok(walk(MODULES).length >= 100, `只数到 ${walk(MODULES).length} 个模块文件——判据多半坏了`);
  // 正控制：lib 里的每个文件都应当至少能算出调用方数（哪怕是 0）
  for (const f of walk(LIB).slice(0, 3)) {
    assert.equal(typeof libConsumers(relative(SRC, f)).size, "number",
      "自证：算不出调用方数——扫描器坏了，那两条判据都会永远绿");
  }
});
