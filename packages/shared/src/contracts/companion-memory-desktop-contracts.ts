/**
 * 伴星中心（桌面页 20）读取合同。
 *
 * 服务端早已提供记忆、记忆星图、日记与人格档案（`/companion/memory`、
 * `/companion/memory/star-map`、`/companion/daily`、`/companion/pet-profile`），
 * 但桌面客户端此前没有对应的 typed IPC。本模块把这几条只读响应的 wire shape
 * 固化下来，让 main 进程在把结果交给渲染层之前先 fail-closed 校验一遍。
 *
 * 写操作（确认 / 忽略 / 固定 / 归档 / 删除）复用 `companionMemoryItemV1Schema`
 * 作为返回体——服务端这些端点返回的就是同一条记忆。
 *
 * 所有 schema 都是 strict：服务端多出任何 main-only 字段都会在这里被拒绝，
 * 而不是原样漏给渲染进程。
 */

import { z } from "zod";
import {
  companionContentBlockV1Schema,
  companionImageBlockV1Schema,
  companionQuoteBlockV1Schema,
  companionSelectionV1Schema,
  companionTextBlockV1Schema,
} from "./companion-conversation-contracts.ts";

// ─── 记忆条目（§3.3 memory-routes.ts 的 MemoryItemV2）────────────────────

export const companionMemoryKindV1Schema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
  /**
   * 判断记录：她对一件**已发生片段**的解释或表达选择（40 §4.5.4–4.5.5）。
   *
   * 它不是「关于用户的事实」，所以界面上必须与前五种分区显示
   * （§4.5.8「关于你的」与「她的看法」分开）。判断永远不是用户自述，
   * 由 0347 的 `assistant_memory_judgment_shape_check` 在库侧强制。
   */
  "judgment",
]);
export type CompanionMemoryKindV1 = z.infer<typeof companionMemoryKindV1Schema>;

export const companionMemoryScopeV1Schema = z.enum(["global", "workspace", "task"]);
export type CompanionMemoryScopeV1 = z.infer<typeof companionMemoryScopeV1Schema>;

export const companionMemoryBudgetTierV1Schema = z.enum(["resident", "active", "archived"]);
export type CompanionMemoryBudgetTierV1 = z.infer<typeof companionMemoryBudgetTierV1Schema>;

export const companionMemorySourceTypeV1Schema = z.enum([
  "user_stated",
  "model_inferred",
  "confirmed",
  "summary",
]);

/**
 * §4.6.8：author/updated_by 区分 user、extractor、companion、maintenance。
 *
 * `extractor` 是抽取任务从原始事件提出的事实记忆，`maintenance` 是后台整理
 * 与摘要写下的结论，`companion` 是她自己的判断与表达选择——三者写出来的
 * 行在库里**必须**能分开，否则「谁写的」就退化成了「不是用户写的」。
 * 词表与 0360 的 CHECK 一致。
 */
export const companionMemoryAuthorTypeV1Schema = z.enum([
  "user",
  "extractor",
  "companion",
  "maintenance",
]);
/** §4.5.4：认识状态另标有据、暂定、争议或已被替代。 */
export const companionMemoryEpistemicStatusV1Schema = z.enum([
  "supported",
  "tentative",
  "disputed",
  "superseded",
]);
/** 说话者：她引用自己的判断时是 `companion`，不是把用户的话记成她的话。 */
export const companionMemorySourceSpeakerV1Schema = z.enum(["user", "assistant", "companion"]);
/**
 * 依据性质：用户直说 / 从用户那句话推出来 / **她自己的解释**。
 *
 * 第三个值是判断记录存在的理由——§4.5.4「来源性质区分用户自述、可观察事件
 * 和模型推断」。它与 `userStated` 独立：判断永远不是用户自述。
 */
export const companionMemorySourceBasisV1Schema = z.enum([
  "direct_statement",
  "inferred_from_statement",
  "companion_interpretation",
]);
export type CompanionMemorySourceTypeV1 = z.infer<typeof companionMemorySourceTypeV1Schema>;

export const companionMemoryEmbeddingStatusV1Schema = z.enum(["none", "pending", "ready", "failed"]);
export type CompanionMemoryEmbeddingStatusV1 = z.infer<
  typeof companionMemoryEmbeddingStatusV1Schema
>;

const isoTimestampSchema = z.string().datetime({ offset: true });

/** 写入端统一限制 ≤200 字（memory-routes §9.4/§25），读取侧照抄同一上限。 */
export const companionMemoryContentMaxLength = 200;

export const companionMemoryItemV1Schema = z.strictObject({
  memoryItemId: z.string().uuid(),
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  sourceEventId: z.string().max(240).nullable(),
  sourceSessionId: z.string().uuid().nullable(),
  sourceSpeaker: companionMemorySourceSpeakerV1Schema.nullable(),
  sourceBasis: companionMemorySourceBasisV1Schema.nullable(),
  appliesWhen: z.string().max(200).nullable(),
  validFrom: isoTimestampSchema.nullable(),
  validUntil: isoTimestampSchema.nullable(),
  userStated: z.boolean(),
  userConfirmed: z.boolean(),
  /** true = 候选记忆：尚未写入长期记忆，等用户在伴星中心裁决。 */
  candidate: z.boolean(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  scope: companionMemoryScopeV1Schema,
  budgetTier: companionMemoryBudgetTierV1Schema,
  pinned: z.boolean(),
  archived: z.boolean(),
  dismissedAt: isoTimestampSchema.nullable(),
  conflictGroup: z.string().uuid().nullable(),
  embeddingStatus: companionMemoryEmbeddingStatusV1Schema,
  sourceType: companionMemorySourceTypeV1Schema,
  revision: z.number().int().min(1),
  authorType: companionMemoryAuthorTypeV1Schema,
  authorId: z.string().uuid().nullable(),
  epistemicStatus: companionMemoryEpistemicStatusV1Schema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type CompanionMemoryItemV1 = z.infer<typeof companionMemoryItemV1Schema>;

export const companionMemoryRevisionV1Schema = z.strictObject({
  revision: z.number().int().min(1),
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  sourceEventId: z.string().max(240).nullable(),
  sourceSessionId: z.string().uuid().nullable(),
  sourceSpeaker: companionMemorySourceSpeakerV1Schema.nullable(),
  sourceBasis: companionMemorySourceBasisV1Schema.nullable(),
  appliesWhen: z.string().max(200).nullable(),
  validFrom: isoTimestampSchema.nullable(),
  validUntil: isoTimestampSchema.nullable(),
  userStated: z.boolean(),
  userConfirmed: z.boolean(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  scope: companionMemoryScopeV1Schema,
  sourceType: companionMemorySourceTypeV1Schema,
  authorType: companionMemoryAuthorTypeV1Schema,
  authorId: z.string().uuid().nullable(),
  epistemicStatus: companionMemoryEpistemicStatusV1Schema,
  supersededAt: isoTimestampSchema,
});
export type CompanionMemoryRevisionV1 = z.infer<typeof companionMemoryRevisionV1Schema>;
export const companionMemoryRevisionListV1Schema = z.strictObject({
  version: z.literal(1),
  memoryItemId: z.string().uuid(),
  items: z.array(companionMemoryRevisionV1Schema).max(200),
});
export type CompanionMemoryRevisionListV1 = z.infer<typeof companionMemoryRevisionListV1Schema>;

/** `GET /companion/memory`；服务端一次最多返回 200 条。 */
export const companionMemoryListV1Schema = z.strictObject({
  version: z.literal(2),
  items: z.array(companionMemoryItemV1Schema).max(200),
});
export type CompanionMemoryListV1 = z.infer<typeof companionMemoryListV1Schema>;

// ─── 记忆星图（§2.6 memory-star-map.ts）──────────────────────────────────

export const companionMemoryEntityTypeV2Schema = z.enum([
  "note",
  "source",
  "card",
  "key_point",
  "learning_run",
]);
export type CompanionMemoryEntityTypeV2 = z.infer<typeof companionMemoryEntityTypeV2Schema>;

export const companionMemoryEntityTargetV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("objective"), objectiveId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("understanding"), objectiveId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid() }),
]);
export type CompanionMemoryEntityTargetV2 = z.infer<typeof companionMemoryEntityTargetV2Schema>;

const companionMemoryEntityLinkV2Schema = z.strictObject({
  entityType: companionMemoryEntityTypeV2Schema,
  entityId: z.string().uuid(),
  /** 服务端解析后的可读名称；失效实体也必须返回稳定的说明，禁止显示裸 UUID。 */
  label: z.string().min(1).max(240),
  target: companionMemoryEntityTargetV2Schema.nullable(),
  /** true = 关联的学习实体已删除；此时必须不可导航。 */
  orphaned: z.boolean(),
}).superRefine((link, context) => {
  if (link.orphaned && link.target !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "orphaned memory links cannot be navigable" });
  }
  if (!link.orphaned && link.target === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "live memory links require a navigation target" });
  }
});

export const companionMemoryStarNodeV2Schema = z.strictObject({
  memoryId: z.string().uuid(),
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  state: z.enum(["active", "pinned"]),
  importance: z.number().min(0).max(1),
  updatedAt: isoTimestampSchema,
  entityLinks: z.array(companionMemoryEntityLinkV2Schema).max(200),
});
export type CompanionMemoryStarNodeV2 = z.infer<typeof companionMemoryStarNodeV2Schema>;

export const companionMemoryStarMapV2Schema = z.strictObject({
  version: z.literal(2),
  nodes: z.array(companionMemoryStarNodeV2Schema).max(500),
  cursor: z.null(),
});
export type CompanionMemoryStarMapV2 = z.infer<typeof companionMemoryStarMapV2Schema>;

// ─── 桌宠日记（§15.3 daily-summary-routes.ts）───────────────────────────

/**
 * 日记只有她自己写的那一段话。当天计数（`companion_daily_summaries.facts`）**不再上线**：
 * 用户 2026-09-21 的裁决是"这跟系统统计数据有什么区别"，而 facts 仍要写进 DB，
 * 因为 `companion-thought.ts` 靠 `learningRunsCreated/Completed` 算连续学习天数。
 */
export const companionDailyFailureReasonV1Schema = z.enum([
  "consent_required",
  "model_unavailable",
  "diary_output_invalid",
]);
export type CompanionDailyFailureReasonV1 = z.infer<typeof companionDailyFailureReasonV1Schema>;

/** 日记日期用用户本地日历日（YYYY-MM-DD），不是 UTC 时间戳。 */
export const companionDailyDateV1Schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 日记正文的块（0252）。成员 schema 直接引用对话那三个，不抄第二份。
 *
 * 只收 `text`/`quote`/`image`：日记是"她写的那一天"，不是操作流，
 * 所以 `nav`/`action_ref`/`card` 这些带对话语义的块不进这一页。
 * 以后放开音频/视频时，在这里加一个成员就接得上——渲染层按 type 分发。
 *
 * `text.emotion`（驱动 Live2D 表情那个字段）对日记无意义，但**不在此处剔除**：
 * 剔除就等于复制一份 text schema，两份会在长度上限变化时分叉。生成器从不写它。
 */
export const companionDailyBlockV1Schema = z.discriminatedUnion("type", [
  companionTextBlockV1Schema,
  companionQuoteBlockV1Schema,
  companionImageBlockV1Schema,
]);
export type CompanionDailyBlockV1 = z.infer<typeof companionDailyBlockV1Schema>;

export const companionDailySummaryV1Schema = z.strictObject({
  version: z.literal(1),
  /** null = 尚未生成过任何一天；status 会是 not_generated。 */
  date: companionDailyDateV1Schema.nullable(),
  status: z.enum(["generated", "not_generated", "failed"]),
  generatedAt: isoTimestampSchema.nullable(),
  /** Short reason for choosing this diary moment; null on blank/legacy days. */
  selectionReason: z.string().max(240).nullable(),
  /**
   * 候选 id：这一篇是从哪一段成稿的（0353）。
   *
   * 有了它，「正文与选中 ID 一致」才是一条事后能核对的断言，而不是一句
   * 要靠再问她一次的话。`null` 有三种含义，**都要保留为 null 而不是补成空串**：
   * 她明确选了 null（§5.7.5 允许）、这一行早于 0353、以及这一天没有成稿。
   * 带 default 是因为这一列是后加的：老服务端与老夹具不带这个键，
   * 缺键按 null 读，而不是让 strictObject 把整个响应判成非法。
   */
  selectedId: z.string().max(80).nullable().default(null),
  /**
   * 当前这一篇的版本（40 §6「聊聊这篇」需要它）。
   *
   * §5.5 保证「同一用户、空间、本地日期只呈现一个当前版本」，且已发布成稿
   * 不因后台重跑静默替换——所以「用户看到的那一版」是稳定的，伴星读回时必须
   * 带上它，版本对不上就说清楚，而不是悄悄拿新版顶上。
   *
   * 带 default 与 selectedId 同理：这一列对老服务端与老夹具是新增的，
   * 缺键按 1 读（0001 起算的第一版），而不是让 strictObject 判非法。
   */
  revision: z.number().int().min(1).default(1),
  /** status=failed 的成因；generated / not_generated 恒为 null。 */
  failureReason: companionDailyFailureReasonV1Schema.nullable(),
  /**
   * 正文块序列。0252 之前的历史行 DB 里 `blocks='[]'`，只读路由把它投影成
   * 单个 text 块（内容来自当时的 `summary`），所以这里永远非空——
   * 渲染层不需要为"旧日子没有块"写分支。
   */
  blocks: z.array(companionDailyBlockV1Schema).max(24),
  /** 该日日记派生出的记忆条目（可能是候选，等确认）。 */
  memory: z.strictObject({
    memoryItemId: z.string().uuid(),
    candidate: z.boolean(),
  }).nullable(),
  /**
   * 「隐藏日记」（40 §10）：从列表与主动推荐里移除，用户可从管理入口恢复。
   *
   * **隐藏 ≠ 删除**：删除的篇目根本不会出现在这个响应里（读路径按
   * `deleted_at IS NULL` 过滤），界面因此只需要处理"活着但被藏起来"这一种。
   */
  hidden: z.boolean().default(false),
  hiddenAt: isoTimestampSchema.nullable().default(null),
});
export type CompanionDailySummaryV1 = z.infer<typeof companionDailySummaryV1Schema>;

/**
 * 「隐藏/取消隐藏」的回执（40 §10）。
 *
 * `changed=false` 表示这次点击没有改变任何东西——**不是失败**。重复点隐藏是
 * 用户会做的事，把它报成错只会让界面闪一个红条。
 */
export const companionDailyVisibilityV1Schema = z.strictObject({
  version: z.literal(1),
  hidden: z.boolean(),
  changed: z.boolean(),
});
export type CompanionDailyVisibilityV1 = z.infer<typeof companionDailyVisibilityV1Schema>;

/**
 * 「删除日记」的实际范围（§11.1 要求「展示实际范围与结果」）。
 *
 * 三个数分别是：作品本身、派生预览与摘录、仅由该篇产生的记忆。
 * 界面照实报出来，用户才知道"删掉"到底带走了什么。
 */
export const companionDailyDeleteV1Schema = z.strictObject({
  version: z.literal(1),
  diary: z.boolean(),
  entries: z.number().int().min(0),
  memories: z.number().int().min(0),
});
export type CompanionDailyDeleteV1 = z.infer<typeof companionDailyDeleteV1Schema>;

export const companionDailyMonthValueV1Schema = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * 一个月里「她写过哪几天」——月历要打的标记。
 *
 * 只回**有记录的那些天**，不为空日补位：整月最多 31 条，空位由渲染端按月份自己
 * 排。`status` 只有 generated / failed 两种，因为表里就只有这两种行；
 * 「没写过」不是失败，是一种缺席，由日历上**没有标记**表达。
 */
export const companionDailyMonthV1Schema = z.strictObject({
  version: z.literal(1),
  month: companionDailyMonthValueV1Schema,
  days: z.array(z.strictObject({
    date: companionDailyDateV1Schema,
    status: z.enum(["generated", "failed"]),
  })).max(31),
});
export type CompanionDailyMonthV1 = z.infer<typeof companionDailyMonthV1Schema>;

// ─── 人格档案（§2.1/§12.2 pet-profile-routes.ts）────────────────────────

export const companionPersonaActivenessV1Schema = z.enum(["quiet", "moderate", "active"]);
export type CompanionPersonaActivenessV1 = z.infer<typeof companionPersonaActivenessV1Schema>;

export const companionPersonaBoundariesV1Schema = z.strictObject({
  allowPlayful: z.boolean().optional(),
  allowNudgeLearning: z.boolean().optional(),
  allowVoiceTags: z.boolean().optional(),
  catchphrase: z.string().max(80).nullable().optional(),
});
export type CompanionPersonaBoundariesV1 = z.infer<typeof companionPersonaBoundariesV1Schema>;

/** Account-scoped persona override. Workspace relationship metrics travel separately. */
export const companionPersonaProfileV1Schema = z.strictObject({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  presetId: z.string().max(80).nullable(),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.strictObject({ text: z.string().min(1).max(200) })).max(5),
  activeness: companionPersonaActivenessV1Schema,
  boundaries: companionPersonaBoundariesV1Schema,
  revision: z.number().int().positive(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type CompanionPersonaProfileV1 = z.infer<typeof companionPersonaProfileV1Schema>;

export const companionPersonaRelationshipV1Schema = z.strictObject({
  familiarity: z.number().min(0).max(1),
  interactionCount: z.number().int().min(0),
  lastActiveAt: isoTimestampSchema.nullable(),
});
export type CompanionPersonaRelationshipV1 = z.infer<typeof companionPersonaRelationshipV1Schema>;

export const companionPersonaPresetV1Schema = z.strictObject({
  presetId: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.strictObject({ text: z.string().min(1).max(200) })).max(5),
  activeness: companionPersonaActivenessV1Schema,
  boundaries: companionPersonaBoundariesV1Schema,
});
export type CompanionPersonaPresetV1 = z.infer<typeof companionPersonaPresetV1Schema>;

export const companionPersonaV1Schema = z.strictObject({
  version: z.literal(1),
  profile: companionPersonaProfileV1Schema.nullable(),
  profileRevision: z.number().int().nonnegative(),
  relationship: companionPersonaRelationshipV1Schema,
  presets: z.array(companionPersonaPresetV1Schema).max(20),
  activePreset: companionPersonaPresetV1Schema.nullable(),
});
export type CompanionPersonaV1 = z.infer<typeof companionPersonaV1Schema>;

/**
 * `PATCH /companion/pet-profile` 的请求体（§12.1.3）。
 *
 * 服务端把这份 body 整体写入，不做字段级合并：`examples` 与 `boundaries` 省略时
 * 会被服务端默认值清空。所以调用方**必须**每次提交完整的档案内容，而不是只提交
 * 被改动的那一项——`companionPersonaPatchFromProfile` 就是这条纪律的唯一实现。
 */
export const companionPersonaPatchV1Schema = z.strictObject({
  /** 当前 revision，CAS 乐观锁；服务端版本不一致时返回 409。 */
  revision: z.number().int().nonnegative(),
  presetId: z.string().min(1).max(80).nullable(),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).min(1).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.strictObject({ text: z.string().min(1).max(200) })).max(5),
  activeness: companionPersonaActivenessV1Schema,
  boundaries: companionPersonaBoundariesV1Schema,
});
export type CompanionPersonaPatchV1 = z.infer<typeof companionPersonaPatchV1Schema>;

/** `PATCH /companion/pet-profile` 的成功响应：被写入的那一版档案。 */
export const companionPersonaMutationV1Schema = z.strictObject({
  version: z.literal(1),
  profile: companionPersonaProfileV1Schema,
  profileRevision: z.number().int().positive(),
});
export type CompanionPersonaMutationV1 = z.infer<typeof companionPersonaMutationV1Schema>;

/** `POST /companion/pet-profile/reset` 的成功响应。 */
export const companionPersonaResetV1Schema = z.strictObject({
  version: z.literal(1),
  ok: z.literal(true),
  profileRevision: z.number().int().positive(),
});
export type CompanionPersonaResetV1 = z.infer<typeof companionPersonaResetV1Schema>;

export const companionPersonaProfileVersionV1Schema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  examplesRevision: z.number().int().positive(),
  author: z.enum(["user", "assistant_tool", "restore", "migration"]),
  action: z.enum(["update", "reset", "restore", "migration"]),
  reason: z.string().nullable(),
  moduleScope: z.array(z.string()).min(1).max(8),
  profile: companionPersonaPatchV1Schema.omit({ revision: true }).nullable(),
  createdAt: isoTimestampSchema,
});
export type CompanionPersonaProfileVersionV1 = z.infer<typeof companionPersonaProfileVersionV1Schema>;

export const companionPersonaVersionListV1Schema = z.strictObject({
  version: z.literal(1),
  currentRevision: z.number().int().nonnegative(),
  versions: z.array(companionPersonaProfileVersionV1Schema).max(100),
});
export type CompanionPersonaVersionListV1 = z.infer<typeof companionPersonaVersionListV1Schema>;

export const companionPersonaRestoreRequestV1Schema = z.strictObject({
  revision: z.number().int().positive(),
  currentRevision: z.number().int().nonnegative(),
});
export type CompanionPersonaRestoreRequestV1 = z.infer<typeof companionPersonaRestoreRequestV1Schema>;

export const companionPersonaRestoreV1Schema = z.strictObject({
  version: z.literal(1),
  profile: companionPersonaProfileV1Schema.nullable(),
  profileRevision: z.number().int().positive(),
});
export type CompanionPersonaRestoreV1 = z.infer<typeof companionPersonaRestoreV1Schema>;

/**
 * 「待生效」的那一版（40 §4.8.4「回执与设置页显示当前/待生效版本和生效条件」/ A50）。
 *
 * ## 为什么单独一个形状，而不是把 pending 塞进 `companionPersonaV1Schema`
 *
 * 一次调用绑定的永远是**当前**那一版（§4.8.4「一次调用使用固定版本」）。把两版
 * 混进同一个对象，读的人就得自己判断哪个在生效——判断错一次就是长会话中途换人。
 * 所以「当前」和「排队中的」是两份独立的读回，各自带自己的契约。
 *
 * `effectiveWhen` 是**服务端算出来的**产品规则（模型自改下一会话、用户直接纠正
 * 下一轮未开始的调用），不在界面里复述一遍：复述迟早漂，而这一格是用户判断
 * 「现在改还来不来得及」的唯一依据。
 */
export const companionPersonaPendingRevisionV1Schema = z.strictObject({
  revision: z.number().int().positive(),
  /** null = 那一版的内容是「回到当前发布的默认表达」，不是「没有内容」。 */
  profile: companionPersonaPatchV1Schema.omit({ revision: true }).nullable(),
  author: z.enum(["user", "assistant_tool", "restore", "migration"]),
  action: z.enum(["update", "reset", "restore", "migration"]),
  reason: z.string().nullable(),
  moduleScope: z.array(z.string()).min(1).max(8),
  stagedAt: isoTimestampSchema,
  effectiveWhen: z.string().min(1).max(80),
});
export type CompanionPersonaPendingRevisionV1 = z.infer<typeof companionPersonaPendingRevisionV1Schema>;

/** `GET /companion/pet-profile/pending`。 */
export const companionPersonaPendingV1Schema = z.strictObject({
  version: z.literal(1),
  currentRevision: z.number().int().nonnegative(),
  pending: companionPersonaPendingRevisionV1Schema.nullable(),
});
export type CompanionPersonaPendingV1 = z.infer<typeof companionPersonaPendingV1Schema>;

/**
 * `POST /companion/pet-profile/stage` 的回执。
 *
 * 只报两个版本号：**当前那一版没有动**（`profileRevision` 原样回来）才是
 * 「排队」这件事的全部含义，界面据此说「还没有生效」而不是「已保存」。
 */
export const companionPersonaStagedV1Schema = z.strictObject({
  version: z.literal(1),
  pendingRevision: z.number().int().positive(),
  profileRevision: z.number().int().nonnegative(),
});
export type CompanionPersonaStagedV1 = z.infer<typeof companionPersonaStagedV1Schema>;

/** `POST /companion/pet-profile/activate` 的回执：排队的那一版已被提升为当前。 */
export const companionPersonaActivatedV1Schema = z.strictObject({
  version: z.literal(1),
  ok: z.literal(true),
  profile: companionPersonaProfileV1Schema.nullable(),
  profileRevision: z.number().int().positive(),
});
export type CompanionPersonaActivatedV1 = z.infer<typeof companionPersonaActivatedV1Schema>;

/** 页面改动一项设置时，用它把「整套档案 + 这一项」拼成合法请求体。 */
export function companionPersonaPatchFromProfile(
  profile: CompanionPersonaProfileV1,
  change: {
    readonly presetId?: string | null;
    readonly activeness?: CompanionPersonaActivenessV1;
    readonly boundaries?: CompanionPersonaBoundariesV1;
    readonly name?: string;
  },
): CompanionPersonaPatchV1 {
  return companionPersonaPatchV1Schema.parse({
    revision: profile.revision,
    presetId: change.presetId !== undefined ? change.presetId : profile.presetId,
    // 名字以前是"跟着档案原样带回"的：整条写入路径（`PATCH /companion/pet-profile`）
    // 一直收 `name`，界面却没有任何地方能改它，于是她叫什么只能由预设决定。
    name: change.name ?? profile.name,
    personalityTags: profile.personalityTags,
    speakingStyle: profile.speakingStyle,
    examples: profile.examples,
    activeness: change.activeness ?? profile.activeness,
    boundaries: change.boundaries ?? profile.boundaries,
  });
}

/** 应用一套服务端预设：预设自带完整档案内容，所以不需要已有 profile。 */
export function companionPersonaPatchFromPreset(
  preset: CompanionPersonaPresetV1,
  revision: number,
): CompanionPersonaPatchV1 {
  return companionPersonaPatchV1Schema.parse({
    revision,
    presetId: preset.presetId,
    name: preset.name,
    personalityTags: preset.personalityTags,
    speakingStyle: preset.speakingStyle,
    examples: preset.examples,
    activeness: preset.activeness,
    boundaries: preset.boundaries,
  });
}

// ─── 连续对话历史（产品层不暴露 conversation）──────────────────────────

export const companionHistoryItemV1Schema = z.strictObject({
  version: z.literal(1),
  messageId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum(["text", "voice_transcript", "proactive", "action", "result", "error", "cancelled"]),
  blocks: z.array(companionContentBlockV1Schema).min(1).max(32),
  selection: companionSelectionV1Schema.optional(),
  runId: z.string().uuid().nullable(),
  createdAt: isoTimestampSchema,
  editedAt: isoTimestampSchema.nullable(),
});
export type CompanionHistoryItemV1 = z.infer<typeof companionHistoryItemV1Schema>;

export const companionHistoryPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionHistoryItemV1Schema).max(100),
  nextCursor: z.string().max(2000).nullable(),
});
export type CompanionHistoryPageV1 = z.infer<typeof companionHistoryPageV1Schema>;

export const companionHistorySearchV1Schema = z.strictObject({
  version: z.literal(1),
  query: z.string().min(1).max(120),
  items: z.array(companionHistoryItemV1Schema).max(50),
});
export type CompanionHistorySearchV1 = z.infer<typeof companionHistorySearchV1Schema>;

export const companionHistoryClearResultV1Schema = z.strictObject({
  version: z.literal(1),
  deletedMessages: z.number().int().min(0),
  deletedConversations: z.number().int().min(0),
  inboxCreated: z.literal(true),
});
export type CompanionHistoryClearResultV1 = z.infer<typeof companionHistoryClearResultV1Schema>;

export const companionHistoryQueryV1Schema = z.strictObject({
  before: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type CompanionHistoryQueryV1 = z.infer<typeof companionHistoryQueryV1Schema>;

export const companionHistorySearchQueryV1Schema = z.strictObject({
  q: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(50).optional(),
});
export type CompanionHistorySearchQueryV1 = z.infer<typeof companionHistorySearchQueryV1Schema>;

// ─── 记忆写操作请求 ─────────────────────────────────────────────────────

export const companionMemoryIdInputSchema = z.strictObject({
  memoryId: z.string().uuid(),
});
export type CompanionMemoryIdInput = z.infer<typeof companionMemoryIdInputSchema>;

/** 星图与列表共用的读取筛选；candidate / archived 默认都不进主视图。 */
export const companionMemoryListQuerySchema = z.strictObject({
  kind: companionMemoryKindV1Schema.optional(),
  q: z.string().min(1).max(200).optional(),
  scope: companionMemoryScopeV1Schema.optional(),
  includeCandidates: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});
export type CompanionMemoryListQuery = z.infer<typeof companionMemoryListQuerySchema>;

export const companionMemoryCreateInputV1Schema = z.strictObject({
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  importance: z.number().min(0).max(1).optional(),
  scope: companionMemoryScopeV1Schema.optional(),
  appliesWhen: z.string().max(200).nullable().optional(),
  validFrom: isoTimestampSchema.nullable().optional(),
  validUntil: isoTimestampSchema.nullable().optional(),
});
export type CompanionMemoryCreateInputV1 = z.infer<typeof companionMemoryCreateInputV1Schema>;

export const companionMemoryCorrectInputV1Schema = z.strictObject({
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  expectedRevision: z.number().int().min(1),
  reason: z.string().min(1).max(500).optional(),
  appliesWhen: z.string().max(200).nullable().optional(),
  validFrom: isoTimestampSchema.nullable().optional(),
  validUntil: isoTimestampSchema.nullable().optional(),
});
export type CompanionMemoryCorrectInputV1 = z.infer<typeof companionMemoryCorrectInputV1Schema>;

export const companionMemoryConflictListV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionMemoryItemV1Schema).max(200),
});
export const companionMemoryConflictResolveResultV1Schema = z.strictObject({
  version: z.literal(1),
  ok: z.literal(true),
});
export const companionMemoryQueueResultV1Schema = z.strictObject({
  version: z.literal(1),
  queued: z.literal(true),
});
export const companionMemoryClearResultV1Schema = z.strictObject({
  deletedCount: z.number().int().min(0),
});

// ─── 动态投递与数据管理（renderer-safe projection）──────────────────────

export const companionActivityDeliveryV1Schema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  inboxSequence: z.number().int().min(0),
  state: z.enum(["queued", "delivered", "displayed", "acted", "dismissed", "snoozed", "expired", "suppressed"]),
  kind: z.enum(["message", "proposal", "action_result", "system_event", "memory_candidate"]),
  label: z.string().min(1).max(240),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("dialogue"), messageId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("proposal"), proposalId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("memory"), memoryId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("none") }),
  ]),
  expired: z.boolean(),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});
export type CompanionActivityDeliveryV1 = z.infer<typeof companionActivityDeliveryV1Schema>;

export const companionActivityTimelineV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionActivityDeliveryV1Schema).max(100),
  nextCursor: z.number().int().min(0),
  serverTime: isoTimestampSchema,
});
export type CompanionActivityTimelineV1 = z.infer<typeof companionActivityTimelineV1Schema>;

export const companionActivityAckRequestV1Schema = z.strictObject({
  deliveryId: z.string().uuid(),
  inboxSequence: z.number().int().min(0),
  transition: z.enum(["displayed", "acted", "dismissed"]),
});
export type CompanionActivityAckRequestV1 = z.infer<typeof companionActivityAckRequestV1Schema>;

export const companionExportKindV1Schema = z.enum(["all", "memory", "audit"]);
export type CompanionExportKindV1 = z.infer<typeof companionExportKindV1Schema>;

export const companionExportResultV1Schema = z.strictObject({
  version: z.literal(1),
  saved: z.boolean(),
  canceled: z.boolean(),
  /** 只把用户已经选择的文件名回给 renderer，不暴露完整本机路径。 */
  fileName: z.string().min(1).nullable(),
  bytes: z.number().int().min(0),
});
export type CompanionExportResultV1 = z.infer<typeof companionExportResultV1Schema>;

export const companionAuditDeleteResultV1Schema = z.strictObject({
  deletedAudit: z.number().int().min(0),
  deletedLedger: z.number().int().min(0),
});
export type CompanionAuditDeleteResultV1 = z.infer<typeof companionAuditDeleteResultV1Schema>;
