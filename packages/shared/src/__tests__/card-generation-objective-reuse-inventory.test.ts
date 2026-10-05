/**
 * §16.38 目标复用台账的**守卫**（四条断言）。
 *
 * ## 为什么叙述不在这里
 *
 * 2026-09-29 之前，这个文件的前五十行是两千字的背景叙述，后面才是断言。
 * 那种放法让读者打开一份"失败列表"时先读到背景，分不清哪句是契约、哪句是说明；
 * 而真正会红的四条断言被埋在最后，review 时看不见。
 *
 * 叙述搬到 `docs/todo-card-generation-objective-reuse.md` 了。
 * **断言一条没删**——它们仍然是活的守卫。
 *
 * ## 读法
 *
 * 想知道"§16.38 今天为什么还关不上、差在哪几件" → 读那份文档。
 * 想让台账红 → 改本文件里的 `REUSE_LINKS` 期望值或它指向的文件/模式。
 *
 * ⚠️ 台账指向错文件时照样会红，**这正是它存在的意义**：
 * 指向错的台账比没有台账更坏——它会让人重做已经做完的事。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

// 2026-10-05：审核台重构后 `CardGenerationSurface.tsx` 只剩摆位，构造 intent 的
// 逻辑下沉到了它调用的 session hook 里。这条反向断言**没有失效**——审核台仍然发
// `create_new`——失效的是**指针**：它还盯着那个已经不含 `intent` 字样的文件。
// 按本文件开头的规矩（指向错的台账比没有台账更坏），改的是指针，不是断言。
// 调用关系仍可复核：`CardGenerationSurface.tsx` 第 8 行导入、第 23 行调用本 hook。
const REVIEW_SURFACE = "apps/desktop-client/src/renderer/src/components/surfaces/review/use-card-generation-session.ts";
const ACTIVATION_SERVICE = "apps/api/src/modules/card-generation-v2/activation-service.ts";
const V2_CONTRACTS = "packages/shared/src/contracts/card-generation-v2-contracts.ts";
const PLAN_ASSEMBLY = "workers/ai-worker/src/card-generation-v3/plan-assembly.ts";

/** 复用的四件：产出信号 → 计划里的既有动作 → 客户端意图 → 闸看得见。 */
const REUSE_LINKS = [
  {
    id: "plan-change-context-carries-reuse-signal",
    // 刀三落地时把这一条从 V3 的提案形状挪到了 **V2 的计划合同**上：复用指针是
    // `plannedObjectiveV2Schema.changeContext` 的第四档，而 `objectiveProposals`
    // 只是提案（§4.2「不按标题相似自动继承」⇒ 不问模型"这条我见过"）。
    // 指向错的文件会让这条台账永远读成"还没做"——而它其实已经做了。
    file: V2_CONTRACTS,
    present: /kind: z\.literal\("reuse_existing_objective"\)/,
    label: "计划合同的 changeContext 带不带复用那一档",
  },
  {
    id: "plan-assembly-emits-existing-actions",
    file: PLAN_ASSEMBLY,
    // 这一格是"负着写"的：缺口的样子**就是** `existingActions: []`。
    // 所以判据是"后面跟的不是空数组"——写成 `existingActions:\s*(?!\[\])`
    // 会被 `\s*` 回溯到零宽而恒真（第一版正是这么写错的，当场红在自己身上）。
    // `\s*\[\]` 先吃掉空白再看，于是回溯无处可去，缺口形状下不匹配。
    present: /existingActions:\s*(?!(\[\]))\S/,
    label: "计划装配不再恒发 `existingActions: []`",
  },
  {
    // 这一条原写成「审核台不再把 intent 写死成 create_new」，**方向是错的**：
    // 复用是**计划里已经做完的判断**（带 `planHash`），让客户端再发一次 intent 等于
    // 让它复述一个无从复核的结论——可能拿着旧计划、可能对着错误的候选。改成查
    // **服务端那一侧重定向**是否在位，而审核台**仍然**发 `create_new`。
    id: "activation-redirects-create-new-to-reuse",
    file: ACTIVATION_SERVICE,
    present: /if \(intent\.kind === "create_new"\) \{\s*const reuse = resolveReuseFromPlanV2\(/,
    label: "激活那一侧把 create_new 重定向到复用（裁决留在服务端）",
  },
  {
    // 这一条**不再是"create_new 先匹配"**——刀四之后重定向发生在服务端，而复用那一支
    // 根本不插新目标。所以要钉的是后者：那才是"复用真的发生了"的形状。
    id: "reuse-branch-does-not-create-a-new-objective",
    file: ACTIVATION_SERVICE,
    present: /case "reuse_existing_objective"[\s\S]{0,4000}?tx\.insert\(learningCardsV2\)/,
    label: "复用那一支只铸新卡、不插新目标（§4.2「复用只搬身份」）",
  },
] as const;

test("§16.38 目标复用台账：还差哪几件，说清楚是哪几件", () => {
  const present = REUSE_LINKS.filter((link) => link.present.test(read(link.file)));
  const missing = REUSE_LINKS.filter((link) => !link.present.test(read(link.file)));
  // 台账**报告剩下的**，而不是恒报"还差四件"：刀三落地之后剩下的是激活那一侧，
  // 继续说"还差四件"会让人以为刀三没做，从而重做一遍。
  assert.deepEqual(
    missing.map((link) => link.id),
    [
      // 2026-09-30：台账新增了 `reuse-branch-does-not-create-a-new-objective` 这一格，
      // 但这一处「还差」的硬编码清单没跟着加，于是判据报的是
      // 「台账变了」而��实是**清单**落下了。
      //
      // 实测：case "reuse_existing_objective" 之后 4000 字内**没有**
      // `tx.insert(learningCardsV2)`（最近的一处在它**前面** 1854 字），
      // 所以这一格确实**还没落地**——该改的是清单，不是把它判成已落地。
      "plan-assembly-emits-existing-actions",
      "reuse-branch-does-not-create-a-new-objective",
    ],
    `目标复用的台账变了：现在**已落地** ${present.length} 件（`
    + `${present.map((l) => l.label).join("、") || "无"}），**还差** ${missing.length} 件（`
    + `${missing.map((l) => l.label).join("、") || "无"}）。`
    + "如果剩下的也做完了，请把这一格改成正向断言并把 §16.38 记成已通过；"
    + "如果已落地的那几件变了位置，请改本台账指向的文件与模式——"
    + "指向错的台账比没有台账更坏：它会让人重做已经做完的事。",
  );
});

test("设计决定：审核台**仍然**发 create_new——复用是服务端照计划重定向的结果", () => {
  // 反向的一格。台账原来把「审核台不再写死 create_new」当成一环，那方向是错的：
  // 复用是**计划里已经做完的判断**（带 `planHash`），让客户端再发一次 intent 等于让它
  // 复述一个它无从复核的结论——可能拿着旧计划、可能对着错误的候选。裁决留在一处。
  assert.match(
    read(REVIEW_SURFACE),
    /intent:\s*\{\s*kind:\s*"create_new"\s*\}/,
    "审核台开始自己发复用意图了：那一档是服务端照计划重定向的结果。",
  );
});

test("排除闸本身仍然在位：它只是看不见，不许因为这个缺口把它删掉", () => {
  const source = read(ACTIVATION_SERVICE);
  // `ensurePendingReviewScheduleV2` 与它对 `held` 的那一支是**已经正确**的部分：
  // 目标 id 一旦是真的，它立刻生效。缺口在 id 造不出来，不在闸。
  assert.match(source, /ensurePendingReviewScheduleV2/);
  assert.match(source, /held/);
});

test("create_new 确实还在 mint 新 id（台账的前提，改之前先确认）", () => {
  const source = read(ACTIVATION_SERVICE);
  assert.match(
    source,
    /case "create_new":[\s\S]{0,400}?const objectiveId = randomUUID\(\)/,
    "create_new 那一支的开头变了：它现在可能已经有别的取 id 方式。"
    + "那说明 §16.38 的缺口形状变了，本台账要按新形状重写。",
  );
});
