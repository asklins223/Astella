/**
 * 轮次（`note_learning_rounds`）的**线上合同**（39d W4-5 第三刀；表是 0282，
 * 服务是 `round-service.ts`，转移判据是 `round-reducer.ts`）。
 *
 * 两份合同只管两件事，别混：
 *  - `round-reducer.ts` 里那份是**内部**状态形状（Date 对象、DB 行直读）；
 *  - 这一份是**跨进程**的形状（时间是 ISO 字符串、每个字段都过 zod）。
 *    两边字段名一致是刻意的：加一列时这里不跟着改，`route-contract` 那类对账会红。
 *
 * 三条"客户端说了不算"的形状，写在这里而不是散在路由里：
 *  1. **创建请求里没有 `noteVersionId` / `sourceContentHash`**。PRD §3.4 要求"系统必须
 *     取得一致的已提交正文和可用出处，再创建本轮快照"——那一份内容由服务端读
 *     `getNoteWithVersion` 拿（它带 `visibleNotesCondition` 与"未软删"两道判据）。
 *     让客户端点名版本，等于把"按哪一版开始"交给那个可能正显示着旧屏的进程。
 *  2. **创建请求里没有三项预算**。§18.4 把起点值列为试用前冻结项，那是服务端的一份
 *     常量（`round-budgets.ts`），不是一个可以由调用方抬高的旋钮。
 *  3. `expectedRevision` 是**必填**：每一次写都要带着它读过的那一版（§16.39 两个窗口
 *     恢复同一轮时，后到的那一份草稿必须失败，而不是覆盖）。
 */
import { z } from "zod";

export const roundPhaseV1Schema = z.enum(["active", "paused", "closed"]);
export type RoundPhaseV1Wire = z.infer<typeof roundPhaseV1Schema>;

export const roundOutcomeV1Schema = z.enum([
  "completed",
  "partial",
  "superseded",
  "system_failure",
]);
export type RoundOutcomeV1Wire = z.infer<typeof roundOutcomeV1Schema>;

export const roundDrivingQuestionSourceV1Schema = z.enum([
  "suggested",
  "user_rewritten",
  "user_authored",
]);

export const noteLearningRoundBudgetsV1Schema = z.strictObject({
  maxModelCalls: z.number().int().min(0),
  maxWallClockSeconds: z.number().int().min(0),
  maxTasks: z.number().int().min(0),
});

export const noteLearningRoundV1Schema = z.strictObject({
  version: z.literal(1),
  roundId: z.string().uuid(),
  noteId: z.string().uuid(),
  phase: roundPhaseV1Schema,
  /** 只有 `closed` 那一档有；与 `phase` 的双向关系由 0282 的 CHECK 保证。 */
  outcome: roundOutcomeV1Schema.nullable(),
  drivingQuestion: z.string().min(1).max(500),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
  drivingQuestionRevision: z.number().int().min(1),
  noteVersionId: z.string().uuid(),
  /**
   * 整篇那一层的哈希，值来自 `note_versions.content_hash`。
   * **不是** sha256 专用格：那列今天的主形状是 32 位 md5（`note/content-hash.ts:25-28`，
   * 实测 dev 库 1045 条），另有 10～40 位的历史值。合同与 0282 的 CHECK 同宽（8～128），
   * 两边不一致就会出现在"合同收得下、库收不下"或反之的分裂。
   */
  sourceContentHash: z.string().min(8).max(128),
  evidenceSnapshotIds: z.array(z.string().uuid()).max(200),
  budgets: noteLearningRoundBudgetsV1Schema,
  /** 状态与计划修订共用的那一个计数器（D1 §6.3）；每一次写都要带回它。 */
  revision: z.number().int().min(1),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  resumedAt: z.string().datetime({ offset: true }).nullable(),
  closedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type NoteLearningRoundV1Wire = z.infer<typeof noteLearningRoundV1Schema>;

/**
 * 路由的回信信封（`{ version, round }`）。单独成一个 schema 而不是让调用方
 * 各自 `body.round`：网关、主进程出口 schema 与集测三处都要拆这一层，
 * 各写一遍就会有一处忘了拆（症状是"合同解析不过"，报出来却像服务端返回坏了）。
 */
export const noteLearningRoundViewV1Schema = z.strictObject({
  version: z.literal(1),
  round: noteLearningRoundV1Schema,
});
export type NoteLearningRoundViewV1 = z.infer<typeof noteLearningRoundViewV1Schema>;

export const createNoteLearningRoundRequestV1Schema = z.strictObject({
  noteId: z.string().uuid(),
  /**
   * 必填。§3.3 那条"系统先提出一句、用户可以改写"里的**提议**这一步还没实现
   * （W4-3 的下一件，第一版按台账定的做法是确定性取笔记结构里第一处可教的判断，
   * 不先花一次模型调用）——所以这里宁可要调用方显式给一句话，
   * **不装成"服务端会自己想办法提一句"**。
   */
  drivingQuestion: z.string().trim().min(1).max(500),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema.default("suggested"),
});
export type CreateNoteLearningRoundRequestV1 = z.infer<
  typeof createNoteLearningRoundRequestV1Schema
>;

export const advanceNoteLearningRoundRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pause") }),
    z.strictObject({ kind: z.literal("resume") }),
    z.strictObject({ kind: z.literal("close"), outcome: roundOutcomeV1Schema }),
  ]),
});
export type AdvanceNoteLearningRoundRequestV1 = z.infer<
  typeof advanceNoteLearningRoundRequestV1Schema
>;

export const reviseDrivingQuestionRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  drivingQuestion: z.string().trim().min(1).max(500),
  /**
   * 谁改的要说得出：`user_rewritten` = 在系统建议那句上改的，`user_authored` = 整句自己写的
   * （§3.3「允许从完整结构另选一个问题，或直接输入想弄懂的事」）。压成布尔就分不开这两件事，
   * 而它们后面要参与"这一轮的问题是谁定的"那句用户可见的话。
   */
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
});

/**
 * 这一篇的轮次记录（PRD §10.3「按笔记、本人和工作区提供完整分页历史，显示日期、
 * 本轮问题、…、完成／部分完成／中断」）。39d W4-5 第四刀先只做**读**这一半。
 *
 * 三条刻意的形状：
 *  1. **只带屏幕上那一行用得着的六格**：`budgets` / `sourceContentHash` /
 *     `evidenceSnapshotIds` / `noteVersionId` 都是服务端内部的依据与配额，
 *     历史记录把它们发给客户端不会多说明一件事，只会让"哪一格是合同"变模糊。
 *  2. `startedAt` 就是 `created_at`——但**换个名字**：那一行给用户看的是"哪一天"，
 *     把 DB 列名直接端出去，以后"记录按什么时间排"一改，客户端就跟着一起错。
 *  3. "实际方式"那一格今天只有 `drivingQuestionSource`（这句话是谁定的）能对上，
 *     §10.3 原文里还包括"这一轮实际怎么走的"——那还没有落点，所以这里**不装**：
 *     台账里登记为欠，而不是先给一个语义不符的键。
 *
 * 分页这一版**没做**：只按"最近 N 条"回，`hasMore` 老老实实说还有。
 */
export const ROUND_HISTORY_DEFAULT_LIMIT_V1 = 10;
export const ROUND_HISTORY_MAX_LIMIT_V1 = 20;

export const noteLearningRoundHistoryItemV1Schema = z.strictObject({
  roundId: z.string().uuid(),
  phase: roundPhaseV1Schema,
  outcome: roundOutcomeV1Schema.nullable(),
  drivingQuestion: z.string().min(1).max(500),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
  drivingQuestionRevision: z.number().int().min(1),
  startedAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).nullable(),
});
export type NoteLearningRoundHistoryItemV1 = z.infer<
  typeof noteLearningRoundHistoryItemV1Schema
>;

export const noteLearningRoundHistoryV1Schema = z.strictObject({
  version: z.literal(1),
  noteId: z.string().uuid(),
  /** 新的在前；空数组是真的"这一篇还没有过轮次"，不是"读失败"。 */
  items: z.array(noteLearningRoundHistoryItemV1Schema).max(ROUND_HISTORY_MAX_LIMIT_V1),
  /** 还有没有更早的（今天没有翻页游标，所以这一格只说"有/没有"）。 */
  hasMore: z.boolean(),
});
export type NoteLearningRoundHistoryV1 = z.infer<
  typeof noteLearningRoundHistoryV1Schema
>;
