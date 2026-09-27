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
const V3_CONTRACTS = "packages/shared/src/card-generation-v3-contracts.ts";
const PLAN_ASSEMBLY = "workers/ai-worker/src/card-generation-v3/plan-assembly.ts";

/** 复用的四件：产出信号 → 计划里的既有动作 → 客户端意图 → 闸看得见。 */
const REUSE_LINKS = [
  {
    id: "v3-output-carries-reuse-signal",
    file: V3_CONTRACTS,
    /** `objectiveProposals` 那一段里有没有"这条提案复用哪个既有目标"的字段。 */
    present: /existingObjectiveId|reusesObjectiveId|reuseObjectiveId/,
    label: "简化链的提案形状带不带复用指针",
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

test("§16.38 目标复用台账：四件里今天有 0 件", () => {
  const present = REUSE_LINKS.filter((link) => link.present.test(read(link.file)));
  assert.deepEqual(
    present.map((link) => link.id),
    [],
    `目标复用已经落地了（${present.map((l) => l.label).join("、")}）——`
    + "请把本台账改成正向断言，并把 §16.38 记成已通过；"
    + "别让这份文件继续说「还差四件」。",
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
