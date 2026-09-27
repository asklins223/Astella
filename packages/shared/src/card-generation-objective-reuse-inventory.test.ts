/**
 * 目标复用台账（39d W7-3 刀四建立）。
 *
 * 这份守卫盯的是 **§16.38「新卡不能绕过目标排除」今天为什么还关不上**，以及
 * "关掉它"这件事落在哪几处。它现在**记录一个已知缺口**，不是通过。
 *
 * ## 缺口是怎么量的（2026-09-27 实读，不是推测）
 *
 * §16.38 的输入前提是「**同目标**有笔记和卡片两种授权……用户将目标暂不安排，
 * 后又生成新卡」，要发生的是「新卡不能绕过目标排除」。也就是说这一格预设了
 * "新卡落在**同一个目标**上"。今天它结构上落不到：
 *
 * 1. 审核台把 `intent` 写死成 `{ kind: "create_new" }`
 *    （`CardGenerationSurface.tsx`），**全仓没有任何一处生产调用方发别的档**。
 * 2. `create_new` 那一支第一件事就是 `const objectiveId = randomUUID()`
 *    （`activation-service.ts`），所以排期闸 `ensurePendingReviewScheduleV2`
 *    拿着一个刚 mint 出来的 id 去问 `objective_review_holds_v2` —— 永远问不到。
 *    那道闸本身是对的（`held` 那一支在同文件里处理得很干净），它只是**看不见**。
 * 3. 简化链把已有目标喂给了模型（`cardGenerateV3TaskInput.existingObjectives`，
 *    提示词里会列出来），但**产出侧没有任何复用信号**：
 *    `objectiveProposals` 只有 `objectiveLocalId` 与内容，`plan-assembly.ts` 的
 *    `existingActions` 恒为 `[]`。模型"决定复用"这件事今天**落在地上**。
 * 4. 服务端已经有一条**可验证**的复用路径（`target_equivalent_update`：
 *    客户端声明等价、服务端重算 `equivalenceReportHash` 并在漂移时拒），
 *    它返回既有 objectiveId，闸对它生效——只是没有入口去选它。
 *
 * ## 为什么这里不直接补一个"同篇同块就算同目标"的匹配
 *
 * §4.2 写死的是「系统无法确定一个主张是否与历史相同时**保留差异**，不按标题相似
 * 自动继承能力证据」，而 §9.1 行 2 的排除**故意**只按 objectiveId 执法
 * （0295 与 `evidence.ts` 的注释都明写"按笔记匹配会误停其他目标"）。
 * 所以"新卡落在同目标上"要靠**可确认的复用**，不是靠相似度——
 * 这正是 W7-5「同目标复用与去重」那句「首期只复用完全相同目标与明确覆盖维度」
 * 要建的东西。在它之前另起一份弱匹配，就是同一件事的第二套实现。
 *
 * ## 台账只许变长
 *
 * 复用落地时下面三格会变（复用信号出现、意图不再写死、闸看得见）。
 * **哪一格变了却没把这份台账改掉 ⇒ 红**，因为留着旧数字的台账在替缺口说"还差这些"。
 * 反过来，某天有人删了这条缺口但没改台账，同样红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const REVIEW_SURFACE = "apps/desktop-client/src/renderer/src/components/CardGenerationSurface.tsx";
const ACTIVATION_SERVICE = "apps/api/src/modules/card-generation-v2/activation-service.ts";
const V2_CONTRACTS = "packages/shared/src/card-generation-v2-contracts.ts";
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
    id: "review-surface-not-hardcoded-create-new",
    file: REVIEW_SURFACE,
    present: /intent:\s*\{\s*kind:\s*"(target_equivalent_update|update_existing)"/,
    label: "审核台不再把 intent 写死成 create_new",
  },
  {
    id: "create-new-can-reach-an-existing-objective",
    file: ACTIVATION_SERVICE,
    /** `create_new` 那一支第一件事是 mint；复用落地后它必须先问一次"这篇有没有适用目标"。 */
    present: /existingObjectivesInNote|matchExistingObjective|resolveReusableObjective/,
    label: "create_new 先匹配同篇既有目标再决定新建",
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
      "plan-assembly-emits-existing-actions",
      "review-surface-not-hardcoded-create-new",
      "create-new-can-reach-an-existing-objective",
    ],
    `目标复用的台账变了：现在**已落地** ${present.length} 件（`
    + `${present.map((l) => l.label).join("、") || "无"}），**还差** ${missing.length} 件（`
    + `${missing.map((l) => l.label).join("、") || "无"}）。`
    + "如果剩下的也做完了，请把这一格改成正向断言并把 §16.38 记成已通过；"
    + "如果已落地的那几件变了位置，请改本台账指向的文件与模式——"
    + "指向错的台账比没有台账更坏：它会让人重做已经做完的事。",
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
