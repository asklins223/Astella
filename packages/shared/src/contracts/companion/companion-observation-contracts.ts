/**
 * 观察投影的最小合同（方案 50 §6.1）。
 *
 * ## 这里统的是**合同与路由**，不是把事件搬进一张新表
 *
 * 每条观察都只是**引用**一条已经存在的权威记录（这一次是 `companion_tts_outcomes`
 * 的播放回执），不复制事件库、不自建第二份状态。权威行没了，观察也就没了——
 * 这比"我们自己留了一份"要诚实：留着的副本没法回答"它还是不是真的"。
 *
 * ## 为什么这些字段一个都不能省
 *
 * `producer` 与 `trust` 分开：播放回执是设备上报的事实，不是用户的说法，也不是她的判断。
 * 把三者混成一个"上下文"，下一轮她就会把设备行为当成用户意图来回应。
 * `occurredAt`（发生）与 `observedAt`（被读进这一次装配）也分开：隔了很久才看到的旧回执
 * 不能冒充"刚刚发生"。`purpose` 决定这条走哪条路——`current_context_clue` 只作线索，
 * 不推进话题、不唤醒模型；将来"用户明确发送"那类才推进当前交流。
 *
 * ## 首批只接一种
 *
 * `delivery`：朗读实际播到哪、有没有播完。其余用途（后台任务结果、主动表达机会、
 * 反思线索）等各自的权威行有需求时再按同一形状加，不先造空壳。
 */
import { z } from "zod";

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime();

/** 这条观察要被拿去干什么。首批只投到"当前上下文线索"这一档。 */
export const companionObservationPurposeV1Schema = z.enum([
  "current_exchange_input",
  "current_context_clue",
  "task_dependency",
  "standalone_notice",
  "reflection_lead",
]);
export type CompanionObservationPurposeV1 = z.infer<typeof companionObservationPurposeV1Schema>;

/** 信任边界：谁产生的、能不能当作用户的话或既成事实来回应。 */
export const companionObservationTrustV1Schema = z.enum([
  "user_stated",
  "device_recorded",
  "domain_committed",
  "model_derived",
]);
export type CompanionObservationTrustV1 = z.infer<typeof companionObservationTrustV1Schema>;

export const companionObservationScopeV1Schema = z.object({
  workspaceId: uuidSchema,
  userId: uuidSchema,
  conversationId: uuidSchema.nullable(),
  runId: uuidSchema.nullable(),
  /** 引用的是哪一版权威记录；没有版本概念时为空串，不填假版本。 */
  referencedVersion: z.string().max(80),
}).strict();
export type CompanionObservationScopeV1 = z.infer<typeof companionObservationScopeV1Schema>;

/**
 * 一条观察的公共形状。`kind` 决定 `payload` 用哪一个 schema，
 * 而身份、范围、时刻、信任与用途对所有 kind 都必须在场。
 */
export const companionObservationV1Schema = z.object({
  version: z.literal(1),
  /** 指向权威行自己的身份（不是我们另发的一个号）。 */
  sourceId: z.string().min(1).max(160),
  kind: z.enum(["delivery"]),
  producer: z.enum(["user", "companion", "device", "maintenance"]),
  scope: companionObservationScopeV1Schema,
  occurredAt: isoTimestampSchema,
  observedAt: isoTimestampSchema,
  trust: companionObservationTrustV1Schema,
  purpose: companionObservationPurposeV1Schema,
  /** 撤回/过期条件：什么情况下这一条不该再被带上，以及它什么时候不再算数。 */
  withdrawal: z.object({
    /** 权威行被删或换版时，观察自动失效（下一次装配读不出来就是 null）。 */
    invalidatedWhenSourceChanges: z.boolean(),
    expiresAt: isoTimestampSchema.nullable(),
  }).strict(),
}).strict();
export type CompanionObservationV1 = z.infer<typeof companionObservationV1Schema>;

/**
 * 朗读交付的回执（§10.2）。
 *
 * 只说**能证实的那部分**：每段播没播成、总共几段、最后一条回执的时刻。
 * 段内播到第几个字这类中间位置没有可靠来源，合同里就没有这个字段——
 * 有了它就会被人填成猜的。
 */
export const companionDeliveryObservationV1Schema = z.object({
  segmentsPlayed: z.number().int().nonnegative(),
  segmentsPrepared: z.number().int().nonnegative(),
  /** 有段落尝试过但没播成（引擎失败、取段超时）。 */
  failedSegmentCount: z.number().int().nonnegative(),
  /**
   * 有段落真尝试过、但没播完——用户插话、关掉窗口、网络断在这儿都算在同一条里。
   * 名字不写成"被打断"：那只是其中一种成因，而她要下结论的只有一件事——
   * **不能假定对方听到了**。
   */
  unfinishedPlayback: z.boolean(),
  lastOutcomeAt: isoTimestampSchema.nullable(),
}).strict();
export type CompanionDeliveryObservationV1 = z.infer<typeof companionDeliveryObservationV1Schema>;

/** 一条投给下一轮的交付观察：公共形状 + `delivery` 的载荷。 */
export const companionDeliveryObservationEntryV1Schema = companionObservationV1Schema
  .extend({ kind: z.literal("delivery"), payload: companionDeliveryObservationV1Schema })
  .strict();
export type CompanionDeliveryObservationEntryV1 = z.infer<
  typeof companionDeliveryObservationEntryV1Schema
>;

/**
 * 有界的观察集合：一条回合最多带这么几份，超出的按 `droppedCount` 计入诊断。
 *
 * 上限放在合同里而不是散在读写两侧——§12.2 要能分辨"被容量挡掉"与"本来就没有"。
 */
export const COMPANION_OBSERVATION_MAX_PER_TURN = 4;
export const companionObservationSetV1Schema = z.object({
  version: z.literal(1),
  observations: z.array(companionDeliveryObservationEntryV1Schema).max(COMPANION_OBSERVATION_MAX_PER_TURN),
  droppedCount: z.number().int().nonnegative(),
}).strict();
export type CompanionObservationSetV1 = z.infer<typeof companionObservationSetV1Schema>;
