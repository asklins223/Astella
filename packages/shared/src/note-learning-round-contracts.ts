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
import { noteReflectionTeachingSnapshotV1Schema } from "./note-learning-reflection-contracts.ts";
import { learningRunOutcomeSchema, learningRunPhaseSchema } from "./learning-run-contracts.ts";
import {
  objectiveNoteChangeImpactV1Schema,
  objectiveRunStartV3Schema,
} from "./learning-objective-surface-contracts.ts";

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
  /**
   * 这一轮当初冻结的那一版正文，与这一篇**现在已保存的那一版**不是同一版。
   *
   * PRD §4.3 那一行（"未完旅程遇到修改 ⇒ 提供「继续当时内容」或「按当前内容新开一轮」"）
   * 要的就是这个事实；D3 §5.1 把它的**时机**拍在"打开这一篇读那一轮时"与"恢复那一发"，
   * 所以它由读侧现算，不存成一列——存了就成第二个事实源，而且笔记再改一次它不会自己跟上。
   *
   * 两个边界写清楚，别让这句话说过头：
   * ① 判的是**已保存的版本**。自动保存只改当前版本的块行、不刷 `note_versions.content_hash`
   * （`note/document-state.ts:186-191` 明写不碰），所以"编辑框里改了但没保存"不在此列——
   * 那一维归 W4-4 的"开始前一致性"，两句话不许合成一句（D3 §5.1 后果②）。
   * ② 这一篇读不到当前版本时是 `false`：说不出新旧就不报消息，与 `checkSourceOutdated`
   * 同口径（D3 §3.3）。
  */
  contentMoved: z.boolean(),
  /** 这一轮当前绑定目标所引用的笔记依据变化；读侧现算，与正文版本提示分开。 */
  noteChangeImpact: objectiveNoteChangeImpactV1Schema.nullable(),
});
export type NoteLearningRoundViewV1 = z.infer<typeof noteLearningRoundViewV1Schema>;

/**
 * 那一版比较本身（纯函数，也是读侧唯一的判据）。比的是**内容哈希**而不是版本 id：
 * `checkpointNote` 遇到与已有版本逐字相同的内容会**复用那一版**（`note/service.ts:611-625`），
 * 所以"版本号变了"不等于"内容变了"；§4.3 要提醒的是后者。
 */
export function noteRoundContentMovedV1(input: {
  /** 这一轮冻结时记下的正文哈希（`note_learning_rounds.source_content_hash`）。 */
  frozenSourceContentHash: string;
  /** 这一篇当前版本的正文哈希；`null`＝读不到当前版本（没指针，或这篇不可见）。 */
  currentSourceContentHash: string | null;
}): boolean {
  if (input.currentSourceContentHash === null) return false;
  return input.currentSourceContentHash !== input.frozenSourceContentHash;
}

export const createNoteLearningRoundRequestV1Schema = z.strictObject({
  noteId: z.string().uuid(),
  /** Omission accepts the server suggestion from the saved note; blank input is invalid. */
  drivingQuestion: z.string().trim().min(1).max(500).optional(),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema.default("suggested"),
});
export type CreateNoteLearningRoundRequestV1 = z.infer<
  typeof createNoteLearningRoundRequestV1Schema
>;

/**
 * 「按当前内容新开一轮」那一发的请求体。只要一把 CAS 钥匙：本轮问题、正文那一版、
 * 预算都由服务端自己取（客户端不交任何内容字段，也就没有任何一格可被伪造）。
 */
export const reopenNoteLearningRoundRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
});
export type ReopenNoteLearningRoundRequestV1 = z.infer<
  typeof reopenNoteLearningRoundRequestV1Schema
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
 *  3. "实际方式"与"系统不确定项"两格（39d W4-8 刀一补上）是**从发生过的事实派生**的，
 *     不是客户端能算的：讲解过 = 这一轮有教学产物行，练过 = 有以这一轮为锚的 run，
 *     不确定 = 那一轮里有一笔判定是我们**判不了**（`not_assessable`）。三者都由服务端
 *     在同一份 RLS 上下文里数出来，界面不重算（同一句话只准一个来源）。
 *     仍未落点的是"表达方式按知识形态选的那一档"（动态／对照／表格／结构，W4-6 名下）——
 *     那一格今天只有"有没有动态版"这一个真实值，等分档真的建起来再进这一行，不提前占位。
 *
 * 分页走**游标**（`before` = 上一页最后一条的 id），不走 offset：这一张表按"新的在前"排，
 * 中间插入一条新轮次就会让 offset 页整体错位，第 11 条被跳过或重复出现——那种错在读的人
 * 那里看不出来，只会变成「我的记录少了」。
 */
export const ROUND_HISTORY_DEFAULT_LIMIT_V1 = 10;
export const ROUND_HISTORY_MAX_LIMIT_V1 = 20;

/**
 * §10.3 那一行的「实际方式」：这一轮**真的**发生过什么。空数组是诚实的一种状态——
 * 只开了个头、既没讲也没练，不是"数据没读到"。
 */
export const roundHistoryModeV1Schema = z.enum(["explained", "practiced"]);
export type RoundHistoryModeV1 = z.infer<typeof roundHistoryModeV1Schema>;

export const noteLearningRoundHistoryItemV1Schema = z.strictObject({
  roundId: z.string().uuid(),
  phase: roundPhaseV1Schema,
  outcome: roundOutcomeV1Schema.nullable(),
  drivingQuestion: z.string().min(1).max(500),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
  drivingQuestionRevision: z.number().int().min(1),
  /** 集合语义，不重复也不排序成"看起来有序"：由服务端按发生与否给。 */
  actualModes: z.array(roundHistoryModeV1Schema).max(2),
  /**
   * 「系统不确定项」：这一轮里有一笔 **`not_assessable`** 的判定。
   * 与 §3.2 那条同一口径——`not_assessable` 不是她的缺口，是我们的判不了；
   * 所以这一格不许被复用成"表现不好"，也不许把 `declared_unable`（她明说不会）算进来。
   */
  systemUncertain: z.boolean(),
  /**
   * 「后续确认」那一格（§10.3：迟到判定和更正以**带时间**的补充记录展示，区分
   * "当时的结算"与"后续确认"）。取这一轮的练习 run 里**晚于本轮 `closedAt`** 的
   * 最后一笔结算时刻；没有就是 null。
   *
   * 三个不是null也不行、是null也不行的边界，都在这一格的语义里：
   *  - 轮次还开着（`closedAt` 为 null）⇒ 这一格必为 null：还没"当时"，谈不上"后来"；
   *  - run 自己还在跑（没结算）⇒ null，不能把"没判完"说成"后来没判出来"；
   *  - 收尾之后 run 被显式放弃 ⇒ 那一发不产生结算事件，也就不会假报"后来确认过"。
   * 必填（不给 `.optional()`）与 `totalCount` 同一条理由：缺格会被读成"这次没查到"。
   */
  followUpSettledAt: z.string().datetime({ offset: true }).nullable(),
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
/**
 * 分页回执的两条一致性判据。**两个级别共用这同一份**：写两遍就会有一天只改一边，
 * 而这两条挡的恰好是"服务端发得出、界面上是坏按钮/坏总数"那两种形状。
 */
const historyCursorCoherentV1 = (page: { hasMore: boolean; nextCursor: string | null }) =>
  !page.hasMore || page.nextCursor !== null;
const historyCountsCoherentV1 = (page: { shownCount: number; totalCount: number }) =>
  page.totalCount >= page.shownCount;

export const noteLearningRoundHistoryPageV1Schema = noteLearningRoundHistoryV1Schema
  // 「更早的还有」与「这一屏列了几轮」是两件事：前者说本页之外的世界，后者说这一屏。
  // 没有这一格，翻过一页之后屏幕上那句总数就只能拿"已加载条数"去冒充"总数"——
  // 而那正是这一刀要拦的形状（见上面 `historyLead` 那条判据）。由服务端报数。
  .extend({
    shownCount: z.number().int().min(0),
    /**
     * 这一篇**一共**开过几轮（与游标无关，翻到第几页都是这一个数）。
     * 加它的理由：没有这一格，"练过几轮"这个总数要**翻到最后一页**才知道——
     * 而 §16.16 后半那句判据（"在推荐页就取消 ⇒ 不增加学习轮数")要的是一个
     * 当场可读的数。屏上那句在 `hasMore` 时只报"列到这里 M 轮"，不替整篇报数，
     * 所以总数不是新造的第二个来源：它一直在那儿，只是没人算。
     */
    totalCount: z.number().int().min(0),
  })
  .refine(historyCursorCoherentV1, {
    message: "hasMore 为真时必须给出 nextCursor",
    path: ["nextCursor"],
  })
  // 总数比列出来的还少 ⇒ 某一侧数错了。让服务端**发不出**这一份，
  // 比让每一处读者各自躲它可靠（与上面那条同向判据同一个办法）。
  .refine(historyCountsCoherentV1, {
    message: "总数不许小于本页列出的轮数",
    path: ["totalCount"],
  });
export type NoteLearningRoundHistoryV1 = z.infer<
  typeof noteLearningRoundHistoryPageV1Schema
>;

/**
 * §10.3 那三级的第二级：**本人**（跨笔记）。39d W4-8 刀二。
 *
 * 与按笔记那一级的三点差别，都写在这份合同里而不是靠调用方记：
 *  1. 每一行必须带**是哪一篇**（`noteId` + `noteTitle`）：这一级没有"眼前这篇"的上下文，
 *     只有问题句子的那一行读不出是谁家的哪一篇。
 *  2. 页上没有 `noteId`——它属于"我"，不属于某一篇。
 *  3. 权限遮蔽那一档（§10.3 末段"失去笔记权限后只保留允许展示的非内容元数据"）
 *     **不在这一级里现造**：那需要 D6 那一份权限投影（W5-6 名下）。这一版的读法是
 *     "只列我此刻读得到的那一篇"（软删的不列），也就是**整行不出现**而不是换了标签——
 *     造一个自命的"遮蔽"谓词会立刻变成第二个权限来源，那比少列几行更糟。已登记为欠。
 */
export const noteLearningRoundPersonalHistoryItemV1Schema =
  noteLearningRoundHistoryItemV1Schema.extend({
    noteId: z.string().uuid(),
    noteTitle: z.string().min(1).max(500),
  });
export type NoteLearningRoundPersonalHistoryItemV1 = z.infer<
  typeof noteLearningRoundPersonalHistoryItemV1Schema
>;

export const noteLearningRoundPersonalHistoryPageV1Schema = z
  .strictObject({
    version: z.literal(1),
    items: z.array(noteLearningRoundPersonalHistoryItemV1Schema).max(ROUND_HISTORY_MAX_LIMIT_V1),
    hasMore: z.boolean(),
    nextCursor: z.string().uuid().nullable(),
    shownCount: z.number().int().min(0),
    /** 我在这个空间里**一共**开过几轮（与游标无关；同一句理由见上面那格）。 */
    totalCount: z.number().int().min(0),
  })
  .refine(historyCursorCoherentV1, {
    message: "hasMore 为真时必须给出 nextCursor",
    path: ["nextCursor"],
  })
  .refine(historyCountsCoherentV1, {
    message: "总数不许小于本页列出的轮数",
    path: ["totalCount"],
  });
export type NoteLearningRoundPersonalHistoryV1 = z.infer<
  typeof noteLearningRoundPersonalHistoryPageV1Schema
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

export const roundPlanViewV1Schema = z.strictObject({
  version: z.literal(1), round: noteLearningRoundV1Schema,
  plans: z.array(roundPlanRevisionV1Schema),
});

// ─── 轮次里的教学产物（39d W4-6 刀一；表 0284，服务 round-service）───

/** 今天只有"解释"一档。压成布尔位会把将来按知识形态选的表达方式（§6.1）挤掉。 */
export const roundTeachingKindV1Schema = z.enum(["explanation"]);
export type RoundTeachingKindV1 = z.infer<typeof roundTeachingKindV1Schema>;

/** A likely-factual issue worth a learner's review; it is not a claim that the note is wrong. */
export const roundSuspectClaimV1Schema = z.strictObject({
  unitIds: z.array(z.string().min(1).max(160)).min(1).max(6),
  sourceBlockOrdinal: z.number().int().positive().nullable(),
  sourceQuote: z.string().min(4).max(2_000).nullable(),
  reason: z.string().trim().min(1).max(1_000),
  /** True when the source slice changed but this claim still lacks an accepted recheck. */
  sourceChanged: z.boolean().optional(),
}).refine((claim) => (claim.sourceBlockOrdinal === null) === (claim.sourceQuote === null), {
  message: "claim source location and quote must both be present or both be null",
});
export type RoundSuspectClaimV1 = z.infer<typeof roundSuspectClaimV1Schema>;

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
  /** Retained with the immutable teaching row so the review warning survives reloads. */
  suspectClaims: z.array(roundSuspectClaimV1Schema).max(6).optional(),
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
  /** Private understanding explicitly chosen by the learner for this explanation. */
  personalSources: z.array(noteReflectionTeachingSnapshotV1Schema).max(3).optional(),
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
  /**
   * 「换一种解释」（PRD §5.3 的四选一之一；§6 的"换解释才产生新版本"）。
   * 默认 `false` = 同快照同问题已有就回既有那条（不重付）；`true` 时**跳过复用**，
   * 在同一问题下再落一条（轮内序号 +1）——旧那条留着，历史不覆盖。
   */
  regenerate: z.boolean().optional(),
  /** At most three private notes, selected by the user for this one teaching request. */
  personalReflectionIds: z.array(z.string().uuid()).max(3).default([])
    .refine((ids) => new Set(ids).size === ids.length, "private source ids must be unique"),
});
export type CreateRoundTeachingRequestV1 = z.infer<typeof createRoundTeachingRequestV1Schema>;

/**
 * 这一轮里练过的那一道（W4-6 刀三）。四格都来自 run 行本身：
 * `phase` 是它走到哪一步，`outcome` 是结算之后的结论（没结算是 `null`），
 * `startedAt` 是它什么时候开的。**不带详情链接**：run 的路由与结果页已经各有自己的读，
 * 这里只回答"这一轮练过几次、各自怎么样了"。
 */
export const roundPracticeV1Schema = z.strictObject({
  runId: z.string().uuid(),
  phase: learningRunPhaseSchema,
  outcome: learningRunOutcomeSchema.nullable(),
  startedAt: z.string().datetime({ offset: true }),
});
export type RoundPracticeV1 = z.infer<typeof roundPracticeV1Schema>;

/**
 * 缺口帮助停止那件事的读数（W4-6 刀四；PRD §5.3）。
 *
 * 判据（连续两次帮助后仍没有改善）在服务端算出，客户端**只呈现**：它是"这一轮要不要
 * 继续自动加题"的决定，不是界面上的一次布局选择。带 `consecutiveHelpCount` 与
 * `threshold` 是为了让那一句话能如实说"帮了几次、按几次算停"，而不是编一句量词。
 */
export const roundGapHelpV1Schema = z.strictObject({
  stopped: z.boolean(),
  consecutiveHelpCount: z.number().int().min(0),
  threshold: z.number().int().min(1),
});
export type RoundGapHelpV1 = z.infer<typeof roundGapHelpV1Schema>;

/**
 * 「补一节前置」那件事的读数（W4-6 刀四·正面要求那一档；PRD §16.3、§5.3、§4.3）。
 *
 * 这一格是 §16.3 验收那句「系统提出**可能**缺少一个前置定义，并**说明新增学习量**」的
 * 落点——停下来的那四档里 `add_prerequisite` 之前只有一个说明文字，是因为这三样都算不出来：
 * 缺哪个、依据是哪几段、要补多少。
 *
 * 两条形状上的硬约束：
 *  - **`kind` 判别而不是三个可空字段**：没有提案与"有一个提案但依据为空"是两句不同的话，
 *    用可空字段表达就会有一段代码要靠"两个都空"反推，而那种反推迟早漏一档。
 *  - **`reason` 两档分开**（材料里挑不出来 / 挑得出来但都已讲过）：§5.3 规定前者不许编造
 *    过程，后者说明"这一轮没有更前面可补的了"——那不是系统的失败，是这轮的情况。
 *
 * **它不含"补出来的内容"**：补是另一次教学产物（W4-6 刀五往后），这一格只给"缺哪儿、
 * 依据、多少"，好让界面摆得出"现在补／留到以后"（§4.3）。把它说成"已经补好了"是本
 * 合同明确不表达的意思。
 */
const roundPrerequisiteNoneV1Schema = z.strictObject({
    kind: z.literal("none"),
    reason: z.enum(["no_usable_material", "nothing_beyond_current"]),
  });
const roundPrerequisiteCandidateV1Schema = z.strictObject({
    kind: z.literal("candidate"),
    /** 措辞是"可能缺"而不是"你缺"：模型推测只能给建议，不能给诊断（§5.3、D3）。 */
    label: z.string().min(1).max(300),
    /** 依据的本轮快照块序号，界面要点得开、用户要核得对。 */
    evidenceBlockOrdinals: z.array(z.number().int().positive()).min(1).max(3),
    /** 新增学习量＝要读几段（§16.3 要"说明"的那一个数）。 */
    estimatedSteps: z.number().int().positive(),
    /** §5.3「较大分支交给用户选择」：超过冻结阈值就要她选"现在补／留到以后"。 */
    largeBranch: z.boolean(),
  });
export const roundPrerequisiteV1Schema = z.discriminatedUnion("kind", [
  roundPrerequisiteNoneV1Schema,
  roundPrerequisiteCandidateV1Schema,
]);
export type RoundPrerequisiteV1 = z.infer<typeof roundPrerequisiteV1Schema>;

/** 提案 + 判定它的那个缺口 + 冻结阈值（§18.4 冻结项，界面据此说明"较大"的界线从哪来）。 */
const roundPrerequisiteViewContextV1Schema = {
  gap: z.strictObject({ objectiveId: z.string().uuid(), intent: z.string().nullable() }).nullable(),
  largeBranchThreshold: z.number().int().min(0),
};
export const roundPrerequisiteViewV1Schema = z.discriminatedUnion("kind", [
  roundPrerequisiteNoneV1Schema.extend(roundPrerequisiteViewContextV1Schema),
  roundPrerequisiteCandidateV1Schema.extend(roundPrerequisiteViewContextV1Schema),
]);
export type RoundPrerequisiteViewV1 = z.infer<typeof roundPrerequisiteViewV1Schema>;

/**
 * 动态产物**失败**的那一次（W4-6 刀五·失败侧；§16.4「动态交付失败记录保留」）。
 *
 * 它与同一格里那个 `artifact`（成功时的引用）是**两件不同的事**：
 *  - `artifact: null` 是**状态**："这一条没有动态版本"（D4 §6.2）——可能从没请求过；
 *  - `artifactFailure: {...}` 是**事件**："试过，没成，原因是这个"。
 *
 * 合成一个可空字段（`artifact: { ref?, failure? }`）看着更整齐，但会让"没请求过"与
 * "请求了但失败了"共用一条分支，而 §6.2 恰恰要求界面对这两句说不同的话。
 *
 * `stage × reason` 穷举（与迁移 0298 的 CHECK 同一组），`detail` 是人读的那一句、
 * 上界 500；`teachingId` 可空 = 产物构建时教学行还没落库。
 */
export const roundArtifactFailureV1Schema = z.discriminatedUnion("stage", [
  z.strictObject({
    stage: z.literal("build"),
    reason: z.enum(["empty", "over_quota"]),
    detail: z.string().max(500),
    teachingId: z.string().uuid().nullable(),
    snapshotHash: z.string().min(8).max(128),
    at: z.string().datetime({ offset: true }),
  }),
  z.strictObject({
    stage: z.literal("persist"),
    reason: z.literal("persist_failed"),
    detail: z.string().max(500),
    teachingId: z.string().uuid().nullable(),
    snapshotHash: z.string().min(8).max(128),
    at: z.string().datetime({ offset: true }),
  }),
]);
export type RoundArtifactFailureV1 = z.infer<typeof roundArtifactFailureV1Schema>;

/**
 * 动态产物（W4-6 刀五；D4 §8 的隔离展示面）：一条教学产物带的整份 HTML。
 *
 * 三条形状上的硬约束：
 *  - **这一格只带引用**（id／kind／时间），**HTML 不在这里**：它由 main 按 id 去
 *    `GET /v2/note-learning-round-artifacts/:artifactId` 取整份（D4 §8：超配额是
 *    "整份拒绝"，任何半份 HTML 在 frame 里只会画成怪东西）。渲染层拿不到 HTML，
 *    也就不存在"渲染层顺手改一改再落盘"这条路；
 *  - `artifactId` 是**文件名的唯一来源**（`<userData>/artifacts/<id>.html`），
 *    桌面端拿它去 main 那一侧"确保落盘"，frame 的 URL 也由它算出来；
 *  - `html` 过了 IPC 与文件两层，但**不是**信任边界：边界在 frame 的 sandbox 与 CSP
 *    （host 组件与 `artifact-surface.ts` 那两层），这里只做大小与类型的形状校验。
 */
export const roundTeachingArtifactRefV1Schema = z.strictObject({
  version: z.literal(1),
  artifactId: z.string().uuid(),
  /** 今天只有"动态讲解"一档；按知识形态选表达方式（§6.1）是后续刀。 */
  kind: z.enum(["dynamic_explanation"]),
  createdAt: z.string().datetime({ offset: true }),
});
export type RoundTeachingArtifactRefV1 = z.infer<typeof roundTeachingArtifactRefV1Schema>;

/** 「练一道」的起点：哪一条目标、以及那一发请求本体（形状与主行动共用）。 */
export const roundPracticeStartV1Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  start: objectiveRunStartV3Schema,
});
export type RoundPracticeStartV1 = z.infer<typeof roundPracticeStartV1Schema>;

/**
 * 教学产物的回信（生成与读取同一份形状）：**轮次与产物一起回**。
 * "解释是按哪一版问题、哪一版正文生成的"只能由服务端说，客户端拿两发去拼
 * 迟早会拼出一次错配；顺带，生成那一发也会让屏幕上那一行轮次刷新到最新 revision。
 */
export const roundTeachingViewV1Schema = z.strictObject({
  version: z.literal(1),
  round: noteLearningRoundV1Schema,
  plans: z.array(roundPlanRevisionV1Schema),
  /** 还没有生成过就是 `null`（打开教学面但还没点"开始"），不是"读失败"。 */
  teaching: roundTeachingV1Schema.nullable(),
  /**
   * 这一轮里开出去的练习（W4-6 刀三；经 `learning_runs.origin ->> 'roundId'` 反查）。
   * 这是 W4-5 那笔「轮次 ↔ LearningRun 连接」的**读侧**：在那之前，"这一轮里做过一次
   * 练习"在任何屏上都读不出来。空数组是真的"还没练过"，不是读失败。
   */
  practices: z.array(roundPracticeV1Schema).max(50),
  /**
   * 「练一道」那一发的起点。**服务端签发**：`goal` / `requestedTimeBudgetSeconds` /
   * `responsePreference` 三个值与目标的主行动**同一份来源**（`startPayloadForOrigin`），
   * 这里只把锚点换成这一轮（`originV2.kind = note_round`）——客户端不拼这些参数。
   *
   * 没有 active 目标 ⇒ `null`（无目标的轮次不出现「练一道」：练习只在目标存在时开 run）；
   * 目标此刻的主行动不是"开一场新的"（例如已有一场开着要走 `resume_run`）⇒ 也 `null`，
   * 因为再开一场会撞上"同一目标同时两场进行中"这件不该发生的事。
   */
  practiceStart: roundPracticeStartV1Schema.nullable(),
  /** 缺口帮助停止那一格（W4-6 刀四）：停没停、帮了几次、按几次算停。 */
  gapHelp: roundGapHelpV1Schema,
  /** 前置候选与其缺口依据（W4-6 刀四·正面要求；为空也必须明确给出判定原因）。 */
  prerequisite: roundPrerequisiteViewV1Schema,
  /** 动态产物最近一次失败（与 artifact=null 代表的“未成功产物”状态分开）。 */
  artifactFailure: roundArtifactFailureV1Schema.nullable(),
  /**
   * 这一条解释的动态产物（W4-6 刀五）。`null` = 这一条没有动态版本——
   * **那不是失败**：文字解释照旧在 `teaching.content` 里，界面照旧要能读能练
   * （"动态失败不冒充教学失败"）。
   */
  artifact: roundTeachingArtifactRefV1Schema.nullable(),
});
export type RoundTeachingViewV1 = z.infer<typeof roundTeachingViewV1Schema>;
