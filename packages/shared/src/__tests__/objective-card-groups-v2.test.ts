/**
 * 卡库按笔记成组的判据（39d W7-6；39 §8.5 第一段与第二段）。
 *
 * 这一组钉的是**三条会被悄悄做错的事**，每条都带正控制：
 *
 *  1. **键是 `noteId` 不是标题**。按标题分组的两个后果都是真的：同一篇改了标题
 *     分成两组，两篇同名并成一组。正控制是"两篇同名但 id 不同 ⇒ 两组"。
 *  2. **「未关联笔记」是一个组，不是一堆散行**，而且**排在最后**。§8.5「不按标题
 *     猜造」——那一档的键是常量，`primaryNoteId` 为 null 才是它的判据，**不是**
 *     "标题读不到"。正控制是"id 为 null 但标题有值 ⇒ 仍然进未关联组"。
 *  3. **三档互斥且待核对先判**。既到期又待核对的卡归「待核对」——用户该做的是
 *     核对原文而不是练习；先判到期会让那一张永远停在"该复习了"而没人告诉他原文变了。
 *     三个数**分开回**，屏上各写各的标签（§8.5「状态来源不同应分别标明」）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNGROUPED_NOTE_KEY,
  UNGROUPED_NOTE_LABEL,
  cardBucketV2,
  groupObjectiveCardsByNoteV2,
  isDueV2,
  isNeedsNoteCheckV2,
  type ObjectiveListItemV2Input,
} from "../objective-card-groups-v2.ts";

const NOTE_A = "11111111-1111-4111-8111-111111111111";
const NOTE_B = "22222222-2222-4222-8222-222222222222";

const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function item(over: Partial<ObjectiveListItemV2Input> = {}): ObjectiveListItemV2Input {
  return {
    objectiveId: "33333333-3333-4333-8333-333333333333",
    primaryNoteId: NOTE_A,
    primaryNoteTitle: "力学笔记",
    freshness: "fresh",
    noteChangeImpact: null,
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    ...over,
  };
}

const due = (over: Partial<ObjectiveListItemV2Input> = {}) =>
  item({ ...over, progress: { ...item().progress, reviewDueAt: at(0) } });
const scheduled = (over: Partial<ObjectiveListItemV2Input> = {}) =>
  item({ ...over, progress: { ...item().progress, reviewDueAt: at(7) } });
const affected = (over: Partial<ObjectiveListItemV2Input> = {}) =>
  item({ ...over, noteChangeImpact: { status: "affected", reasonCode: "block_content_changed", layers: [] } as never });

test("§8.5 一篇笔记至多一个组：按 noteId 分，不按标题分", () => {
  const groups = groupObjectiveCardsByNoteV2([
    item({ primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
    item({ primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
    // 正控制：**两篇同名但 id 不同** ⇒ 两组。按标题分组会把它们并成一组，
    // 而 §8.5 明写"一篇笔记至多一个组"——并成一组等于把两篇笔记当成一篇。
    item({ primaryNoteId: NOTE_B, primaryNoteTitle: "力学笔记" }),
  ]);
  assert.equal(groups.length, 2);
  const byKey = new Map(groups.map((g) => [g.noteKey, g]));
  assert.equal(byKey.get(NOTE_A)?.items.length, 2);
  assert.equal(byKey.get(NOTE_B)?.items.length, 1);
  // 两组标题相同，但键不同——这正是"键是 id"的读数。
  assert.equal(byKey.get(NOTE_A)?.title, byKey.get(NOTE_B)?.title);
});

test("§8.5「未关联笔记」是一个组、且排在最后；判据是 id 为 null 而不是标题读不到", () => {
  const groups = groupObjectiveCardsByNoteV2([
    // 正控制：id 为 null **但标题有值** ⇒ 仍然进「未关联笔记」。§8.5「不按标题
    // 猜造笔记或卡组」：有标题不等于有笔记。
    item({ primaryNoteId: null, primaryNoteTitle: "看起来像笔记的标题" }),
    item({ primaryNoteId: null, primaryNoteTitle: null }),
    item({ primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.noteKey, NOTE_A, "有笔记的组排在前面");
  const last = groups[1]!;
  assert.equal(last.noteKey, UNGROUPED_NOTE_KEY);
  assert.equal(last.title, UNGROUPED_NOTE_LABEL);
  assert.equal(last.ungrouped, true);
  assert.equal(last.items.length, 2, "两个无笔记的行并进同一组，不是一堆散行");
});

test("§8.5 三档分开计数，且**待核对先判**（既到期又待核对的归待核对）", () => {
  const groups = groupObjectiveCardsByNoteV2([
    item(),                                                  // 可用
    due(),                                                   // 待复习
    affected(),                                              // 待核对
    // 关键那一格：既到期又待核对。用户该做的是**核对原文**而不是练习——
    // 先判到期会让它永远停在"该复习了"，而没人告诉过他原文变了。
    due({ noteChangeImpact: { status: "uncertain", reasonCode: "evidence_unverifiable", layers: [] } as never }),
    // 正控制：来源已有更新也算待核对（影响引用的判定还没出结果的那一段）。
    item({ freshness: "source_outdated" }),
  ]);
  const group = groups[0]!;
  assert.equal(group.dueCount, 1);
  assert.equal(group.usableCount, 1);
  assert.equal(group.needsCheckCount, 3);
  // 分母自证：三个数加起来等于组内总数，少算一个就是有一张卡在任何一格里都不见了。
  assert.equal(group.dueCount + group.usableCount + group.needsCheckCount, group.items.length);
  assert.equal(cardBucketV2(due({ noteChangeImpact: { status: "uncertain", reasonCode: "evidence_unverifiable", layers: [] } as never })), "needs_check");
});

test("「待复习」的判据是**排期行在**（不管今天到没到）；「待核对」的两个来源缺一不可", () => {
  // §8.5 要的是「本人待复习数」＝等着回来找她的那些，**含还没到期的**：按"今天
  // 到期"去数，组头那个数会随日子忽大忽小，而她什么也没做。
  // 「到没到」是行内纸签那一层的事（`objectiveProgressChips` 已经分开说），这里不判第二次。
  assert.equal(isDueV2(scheduled()), true);
  assert.equal(cardBucketV2(scheduled()), "due");
  assert.equal(isDueV2(item()), false, "没有排期行 ⇒ 不算待复习");
  // 待核对两个来源各一格 + 负对照：status 为 stable 的 impact 不算。
  assert.equal(isNeedsNoteCheckV2(affected()), true);
  assert.equal(isNeedsNoteCheckV2(item({ freshness: "source_outdated" })), true);
  assert.equal(isNeedsNoteCheckV2(item({ noteChangeImpact: { status: "stable", reasonCode: "stable_anchor_unchanged", layers: [] } as never })), false);
  assert.equal(isNeedsNoteCheckV2(item()), false);
});

test("§8.5「保存第一张卡时才建立可见组」那一侧：空输入不凭空造一个组", () => {
  // 没有卡就没有组——不是"建一个空组等着"。这是 §8.5「不因开始学习自动出现空组」
  // 在读侧能钉住的那一半（另一半是保存那一发才建组，属 W7-2 那一侧）。
  assert.deepEqual(groupObjectiveCardsByNoteV2([]), []);
});

/**
 * W7-6 尾：「**保存第一张卡才建可见组**」今天**结构上成立**（39 §9.4 / §12 表
 * 「卡库」行：一篇至多一组，**保存第一张卡才建可见组**）。
 *
 * ## 成立在哪：**组是派生的，不是存的**
 *
 * 全库**没有**组表（`%group%` / `%bundle%` 一张都没有），而 `groupObjectiveCardsByNoteV2`
 * 是**纯函数**——把手上那批卡按 `primaryNoteId` 分桶。于是：
 *
 *  - **一个组存在 ⇔ 那一篇底下至少有一张卡。** 「保存第一张卡才建可见组」不是一条被
 *    执行的规定，而是**没有别的东西能让一个空组存在**。要造一个空组，就得先存一张卡。
 *  - **「一篇至多一组」**同理：键就是 `noteId`，同一个 `noteId` 只落一个桶。
 *
 * ## 为什么还要钉
 *
 * 因为**加一张组表**是这条产品线上的自然下一步（要支持"重命名组""排序""归档组"就得存），
 * 而**加了它之后这一格会静默失效**：新表里预先插一行空组，屏上就出现一个"0 张卡"的组，
 * 而 §9.4 那一句话没有任何判据挡着。**这一格失效时的症状是屏上多一个空文件夹**——
 * 不报错、不崩，只是多了一样东西。
 */
test("W7-6 尾：组是**派生**的——全库没有组表", () => {
  // 这一格是**读**库得到的结论，写成判据就是"不许出现一张组表"。
  // 但判据不能开库（单测环境没有库），所以改成盯住**派生这一半**：纯函数 + 键即 noteId。
  const items: ObjectiveListItemV2Input[] = [];
  // 没有任何输入 ⇒ 没有任何组。**这正是"空组不存在"的形状**。
  const groups = groupObjectiveCardsByNoteV2(items);
  assert.equal(groups.length, 0,
    "空输入产出了组：那意味着组不是派生的，而是别处存着的一行——"
    + "「保存第一张卡才建可见组」会静默失效。");
});

test("W7-6 尾 正对照：保存第一张卡 ⇒ 那个组**立刻出现**（而只有那一组）", () => {
  const first = groupObjectiveCardsByNoteV2([item({ primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" })]);
  assert.equal(first.length, 1, "一张卡 ⇒ 一组");
  assert.equal(first[0]!.noteKey, NOTE_A);
  // 第二张同篇的卡**并进同一组**（一篇至多一组），不产生第二个。
  const second = groupObjectiveCardsByNoteV2([
    item({ primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
    item({ primaryNoteId: NOTE_A, primaryNoteTitle: "力学笔记" }),
  ]);
  assert.equal(second.length, 1, "同一篇的两张卡 ⇒ 仍然一组（§9.4「一篇至多一组」）");
  assert.equal(second[0]!.items.length, 2);
});
