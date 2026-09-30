/**
 * 回忆页的**等待态与主动暴露**（39d W5-4；PRD §7.1、§16.24）。
 *
 * ## 这一份在挡什么
 *
 * §7.1 那一段是这个产品里最容易被"顺手做掉"的一条：
 *
 * > 进入回忆模式后，准备题目或等待生成时默认只展示不泄露答案的标题、提取线索与
 * > 进度状态，不自动展示原文、正确结构或上次答案。用户仍可主动选择「先看笔记」，
 * > 系统随后如实按本次暴露条件处理。**初学等待时可以直接阅读相关材料；独立回忆等待
 * > 只能给安全线索。**
 *
 * 落成三件必须分开的东西：
 *
 *  1. **等待态的内容由服务端签发**（`recallWaitingCueV1`），不是一个布尔值
 *     `isWaiting`。布尔值会让"等待"与"正在揭示"变成同一件事，而那正是泄露的入口。
 *  2. **两种等待不能共用会提前揭示答案的内容**（§7.1 末句）。所以合同里
 *     `kind` 是**必填**且两档的 `clues` 语义不同：初学那一档可以带 `mayReadSource: true`，
 *     独立回忆那一档恒为 `false`——**由服务端判，不由界面判**。
 *  3. **「先看笔记」是一次真实的暴露**（`recordRecallSourceRevealV2`），不是一次导航。
 *     §7.1「系统随后如实按本次暴露条件处理」——不记账就等于没有"随后"，
 *     而 §14.1.1 的界是**回答锁定先后**：先看笔记再作答，这一次就不该算独立。
 *
 * ## 为什么不复用 run 那条揭示通道
 *
 * `POST /v2/learning-runs/:runId/reveal` 要 runId，而**等待态这一段还没有 run**
 * （题目还在生成）。所以这里是**独立的一条命令**：它在等待态里就成立，
 * 落一行 `answer_reveal` 暴露账，之后那一场 run 的规划期闸
 * （`target-snapshot-adapter.ts` 的 `RECENT_REVEAL_WINDOW_MS`）会如实把它读成
 * `practice_only`——**那道闸是既有的、已验过的**，这里不新造第二套。
 */
import { z } from "zod";

/**
 * 等待态的**两档**。§7.1 末句那句话的直译：
 * 「初学等待时可以直接阅读相关材料；独立回忆等待只能给安全线索。」
 *
 * 压成一个布尔（`isRecall: boolean`）会丢掉"这是哪一种等待"这个**必须由服务端说**
 * 的事实——而它决定了界面上那一句能不能出现、那颗「先看笔记」在不在。
 */
export const recallWaitingKindV1Schema = z.enum(["first_learning", "independent_recall"]);
export type RecallWaitingKindV1 = z.infer<typeof recallWaitingKindV1Schema>;

/**
 * 等待态上**可以摆**的那几条线索。
 *
 * 三条硬约束，都写进合同而不是靠界面自觉：
 *  - `title` 是**标题**，不是题面，更不是标准答案（§7.1「不泄露答案的标题」）。
 *  - `clues` 是**提取线索**：指向"去哪儿想"，不指向"答案是什么"。所以它只能是
 *    知识形态、来源、长度这类**结构事实**——任何一句复述都会变成半个答案。
 *  - **没有任何一格带原文、正确结构或上次答案**。合同里根本没有那几格，
 *    所以它们进不来（`strictObject`）。
 */
export const recallWaitingCueV1Schema = z.strictObject({
  version: z.literal(1),
  kind: recallWaitingKindV1Schema,
  /** 进度状态（§7.1「进度状态」）：说清此刻在等什么，不说"马上好"。 */
  progressLabel: z.string().min(1).max(80),
  /** 标题：目标的显示名。**可以摆**，因为 §7.1 明确允许。 */
  title: z.string().min(1).max(200).nullable(),
  /** 提取线索，零到三条。空数组是真的"这一条没有可给的线索"，不是"忘了给"。 */
  clues: z.array(z.string().min(1).max(120)).max(3),
  /**
   * 能不能在这一档里直接读材料。
   *
   * **`independent_recall` 恒为 `false`**，由服务端判（§7.1 末句）。
   * 界面上那颗「先看笔记」在它为 `false` 时**仍然在**——§7.1「用户仍可主动选择
   * 「先看笔记」」是这一档的用户出口，藏起来就等于没有这个出口。
   */
  mayReadSource: z.boolean(),
});
export type RecallWaitingCueV1 = z.infer<typeof recallWaitingCueV1Schema>;

/**
 * 「先看笔记」那一发的**请求**。
 *
 * 只交 `objectiveId` 与**哪一次等待**（`waitingKind`）。**不带**任何"我看过多少"
 * 的自报——§14.1.1「不靠自报未看过自动补签」是同一条纪律的另一面：
 * 自报"我没看"不能加签，自报"我看了"也不该由客户端来定性，
 * 真正的定性是**这一发命令本身**（它发生了就是发生了）。
 */
export const recordRecallSourceRevealRequestV1Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  waitingKind: recallWaitingKindV1Schema,
  /** 幂等键：同一次等待里重复点那颗按钮只记一笔。 */
  idempotencyKey: z.string().min(1).max(120),
});
export type RecordRecallSourceRevealRequestV1 = z.infer<
  typeof recordRecallSourceRevealRequestV1Schema
>;

/**
 * 「先看笔记」的**回执**。三格都是必填，因为屏上要说的正是这三件事：
 * 记上了没有、记的是哪一档、这一档之后怎么算。
 *
 * `conditionsAfter` 用的是 §14.1.1 那一族词（`practice_only` / …）——
 * 屏上要念的是"这一次的作答按已经看过材料来算"，而那正是这句话的事实来源。
 */
export const recordRecallSourceRevealResultV1Schema = z.strictObject({
  version: z.literal(1),
  exposureId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  /** 这一次暴露的账上时刻（ISO）。 */
  exposedAt: z.string().datetime({ offset: true }),
  /** 重复点同一颗按钮时回**既有那笔**的 id（不是报冲突，也不是编一个新 id）。 */
  alreadyRecorded: z.boolean(),
  /**
   * 这一档之后的能力条件上限。**只有 `practice_only` 一档**，且它是**上限**不是判决：
   * 这一次到底算不算独立由 §14.1.1 的界（回答锁定先后）在评估期判，
   * 这里只如实说"看过材料这件事已经记下了"。
   */
  conditionsAfter: z.literal("practice_only"),
  /** 屏上那句话。**唯一一处**说这件事的地方（§7.1「如实按本次暴露条件处理」）。 */
  userFacingLabel: z.string().min(1).max(200),
});
export type RecordRecallSourceRevealResultV1 = z.infer<
  typeof recordRecallSourceRevealResultV1Schema
>;

/** §16.24：打开通知与部分学习**不默认**关闭提醒——三件事分开记，各自有自己的那一句。 */
export const RECALL_REVEAL_COPY_V1 = {
  /** 「先看笔记」那颗按钮上的字。 */
  readNoteFirst: "先看笔记",
  /** 点过之后的那一句（回执那格同源，不在渲染层另写一遍）。 */
  recorded: (kind: RecallWaitingKindV1) => (kind === "first_learning"
    ? "已经记下了：这一次的作答按看过材料来算。"
    : "已经记下了：这一次回忆的作答按看过材料来算，不会算成独立提取。"),
  /** 等待态里那句「为什么现在只有线索」。 */
  waiting: (kind: RecallWaitingKindV1) => (kind === "first_learning"
    ? "正在准备这一节。材料就在旁边，可以边读边等。"
    : "正在准备这一道题。先从记忆里找一找，题面好了会叫你。"),
  /** 没有线索可给时也要有一句（§13.4：空与失败是不同的话）。 */
  noClue: "这一道暂时没给出线索。",
} as const;
