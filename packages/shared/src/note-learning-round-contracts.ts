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
 * 分页走**游标**（`before` = 上一页最后一条的 id），不走 offset：这一张表按"新的在前"排，
 * 中间插入一条新轮次就会让 offset 页整体错位，第 11 条被跳过或重复出现——那种错在读的人
 * 那里看不出来，只会变成「我的记录少了」。
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
  /** 还有没有更早的。它与 `nextCursor` 必须同向——见那一格的注释。 */
  hasMore: z.boolean(),
  /**
   * 下一页的游标（本页最后一条的 id）。**`hasMore === true` 时它不许是 null**：
   * 界面据此决定"看更早的"那颗还在不在，一个"还有但给不出指针"的回执会让那一块
   * 永远停在第一页而嘴上还说"更早的还能看"。
   */
  nextCursor: z.string().uuid().nullable(),
});
/**
 * `hasMore` 与 `nextCursor` 必须同向，写在合同里而不是靠渲染层防：
 * "还有更早的，但指针是 null"这种回执到了界面上就是一颗点不动的按钮，
 * 或者一句"更早的还能看"配一个永远翻不过去的面。让服务端**发不出**这一份，
 * 比让每一处读者各自躲它可靠。
 */
export const noteLearningRoundHistoryPageV1Schema = noteLearningRoundHistoryV1Schema
  // 「更早的还有」与「这一屏列了几轮」是两件事：前者说本页之外的世界，后者说这一屏。
  // 没有这一格，翻过一页之后屏幕上那句总数就只能拿"已加载条数"去冒充"总数"——
  // 而那正是这一刀要拦的形状（见上面 `historyLead` 那条判据）。由服务端报数。
  .extend({ shownCount: z.number().int().min(0) })
  .refine(
    (page) => !page.hasMore || page.nextCursor !== null,
    { message: "hasMore 为真时必须给出 nextCursor", path: ["nextCursor"] },
  );
export type NoteLearningRoundHistoryV1 = z.infer<
  typeof noteLearningRoundHistoryPageV1Schema
>;

/**
 * 记录那一条的查询参数（放在最后：它引用上面那一对常量，声明顺序不能倒）。
 * 游标是**上一页最后一条的 id**，不是页码——按"新的在前"排的一张表，
 * 中间插入一条就会让页码整体错位（第 11 条被跳过或重复），而读的人只看到"我的记录少了"。
 */
export const noteLearningRoundHistoryQueryV1Schema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(ROUND_HISTORY_MAX_LIMIT_V1).default(ROUND_HISTORY_DEFAULT_LIMIT_V1),
  before: z.string().uuid().optional(),
});

// ─── 轮次计划的追加式修订（39d W4-5 第三刀；表 0283，服务 round-service）───

/**
 * 一版计划的本体（D3 §5 / PRD §4.3）。**本轮问题不在这里**——它在轮次行的
 * `drivingQuestion` 上，计划只是"怎么走"：几个要点步骤、预计量级、结束条件。
 * §4.3 那句「试用默认可从 2–4 个相关要点起步」是产品初始参数，合同只定
 * 1..8 的硬边界；起点值归 §18.4 的试用前冻结，不在这里替它编数。
 */
export const roundPlanStepV1Schema = z.strictObject({
  text: z.string().trim().min(1).max(500),
});
export type RoundPlanStepV1 = z.infer<typeof roundPlanStepV1Schema>;

export const roundPlanV1Schema = z.strictObject({
  version: z.literal(1),
  steps: z.array(roundPlanStepV1Schema).min(1).max(8),
  /** 预计量级（一句话；§4.3「计划说明…预计量级」）。 */
  expectedScale: z.string().trim().max(200).optional(),
  /** 结束条件（一句话；到什么程度这一轮可以收）。 */
  endCondition: z.string().trim().max(200).optional(),
});
export type RoundPlanV1 = z.infer<typeof roundPlanV1Schema>;

/**
 * 追加一版计划的请求。`expectedRevision` 必填（与 pause/resume/改写同一纪律：
 * 写动作都带着它读过的那一版，§16.39 两个窗口的后到者必须失败）。
 * `reason` 必填——D3 §5 的原话是"每次调整记一条：理由、时间、变更前后"，
 * 没有理由的计划修订不落库。
 */
export const appendRoundPlanRevisionRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  plan: roundPlanV1Schema,
  reason: z.string().trim().min(1).max(500),
});
export type AppendRoundPlanRevisionRequestV1 = z.infer<
  typeof appendRoundPlanRevisionRequestV1Schema
>;

/** 一条已落库的计划修订（读侧形状；按 `planOrdinal` 升序就是「最初 → 现在」）。 */
export const roundPlanRevisionV1Schema = z.strictObject({
  version: z.literal(1),
  planOrdinal: z.number().int().min(1),
  /** 写入时轮次的共享 revision（状态与计划共用那一个，D1 §6.3）。 */
  roundRevision: z.number().int().min(1),
  plan: roundPlanV1Schema,
  reason: z.string().min(1).max(500),
  recordedAt: z.string().datetime({ offset: true }),
});
export type RoundPlanRevisionV1 = z.infer<typeof roundPlanRevisionV1Schema>;

// ─── 轮次里的教学产物（39d W4-6 刀一；表 0284，服务 round-service）───

/** 今天只有"解释"一档。压成布尔位会把将来按知识形态选的表达方式（§6.1）挤掉。 */
export const roundTeachingKindV1Schema = z.enum(["explanation"]);
export type RoundTeachingKindV1 = z.infer<typeof roundTeachingKindV1Schema>;

/**
 * 一条教学产物的正文（结构化，不是一段裸文本）：
 *  - `explanation`：这一节在说什么；
 *  - `example`：可选的一句例子（确定性 provider 只从材料里取，不自己编）；
 *  - 依据（引用了哪些块）**不在正文里**，走 `sourceBlockOrdinals` 单独一格——
 *    依据要能点开定位到那一块，塞进正文就只剩一句"根据笔记"。
 *
 * 上限 4000 字是形状上的界，不是产品的目标长度；真正的长度受表达方式控制（后续刀）。
 */
export const roundTeachingContentV1Schema = z.strictObject({
  explanation: z.string().trim().min(1).max(4_000),
  example: z.string().trim().min(1).max(4_000).optional(),
});
export type RoundTeachingContentV1 = z.infer<typeof roundTeachingContentV1Schema>;

/**
 * 一条已落库的教学产物（读侧形状）。
 *
 * **不带 `snapshotHash` / `drivingQuestionRevision`**：它们是服务端"要不要复用旧产物"的
 * 凭据（D3 §5），发给客户端不会多说明一件事——沿用轮次记录那一刀的同一条判据
 * （屏幕上用不着的格子不进合同）。
 */
export const roundTeachingV1Schema = z.strictObject({
  version: z.literal(1),
  teachingId: z.string().uuid(),
  roundId: z.string().uuid(),
  /** 这一轮的第几条教学产物（1 起）。 */
  ordinal: z.number().int().min(1),
  kind: roundTeachingKindV1Schema,
  content: roundTeachingContentV1Schema,
  /** 依据块在快照里的序号（点开依据时按它定位）。 */
  sourceBlockOrdinals: z.array(z.number().int().min(1)).max(200),
  createdAt: z.string().datetime({ offset: true }),
});
export type RoundTeachingV1 = z.infer<typeof roundTeachingV1Schema>;

/**
 * 生成一条教学产物的请求。`expectedRevision` 必填，与 pause/resume/改写/计划修订
 * 同一纪律：**带着你读过的那一版来**——用户在两发之间改了本轮问题或收了尾，
 * 后到的那一发必须失败，而不是给一个已经不对的版本生成一条新的解释。
 */
export const createRoundTeachingRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
});
export type CreateRoundTeachingRequestV1 = z.infer<typeof createRoundTeachingRequestV1Schema>;

/**
 * 教学产物的回信（生成与读取同一份形状）：**轮次与产物一起回**。
 * "解释是按哪一版问题、哪一版正文生成的"只能由服务端说，客户端拿两发去拼
 * 迟早会拼出一次错配；顺带，生成那一发也会让屏幕上那一行轮次刷新到最新 revision。
 */
export const roundTeachingViewV1Schema = z.strictObject({
  version: z.literal(1),
  round: noteLearningRoundV1Schema,
  /** 还没有生成过就是 `null`（打开教学面但还没点"开始"），不是"读失败"。 */
  teaching: roundTeachingV1Schema.nullable(),
});
export type RoundTeachingViewV1 = z.infer<typeof roundTeachingViewV1Schema>;
