/**
 * P2 — Durable Text Conversation 共享合同（03-conversation-api-data-proactive-contract.md §2–§6）。
 *
 * 唯一 wire truth：Conversation / Message / ContentBlock / Turn / CharacterCue /
 * SSE envelope + discriminated payload / 公开错误码。所有网络/IPC/DB JSON shape
 * 均为 zod strict；类型只用 z.infer 导出；枚举未知值 fail closed。
 *
 * 长度语义：V1 全部 min/max 按 JavaScript UTF-16 code unit（text.length）计数。
 * hash：所有小写 64 位 SHA-256 复用 content-hash.ts 的 canonicalJsonV1/sha256Hex。
 */

import { z } from "zod";
import { VOICE_STYLE_INSTRUCTION_MAX_UNITS, voiceStyleInstructionUnits } from "../../companion/voice-expression-tags.ts";
import { companionNoteEditingContextV1Schema, companionAnnotationTargetV1Schema } from "./companion-note-authoring-contracts.ts";
import { allowedMainRouteV2Schema } from "./companion-bridge-contracts.ts";
import {
  characterCueEmotionV1Schema,
  characterCueIntentV1Schema,
} from "./companion-character-contracts.ts";
import { companionAgentToolEventV1Schema } from "./companion-agent-contracts.ts";
import { sourceImageObjectKeyFromUrl } from "../desktop/source-image-contracts.ts";
import { companionFileBlockV1Schema } from "./companion-file-contracts.ts";

// ─── 基础 ────────────────────────────────────────────────────────────────

export const companionHashV1Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type CompanionHashV1 = z.infer<typeof companionHashV1Schema>;

/**
 * 收件箱投递的 NOTIFY 通道（16 §14.3）。
 *
 * 放在 shared 而不是 api 的 companion-notify.ts 里，是因为写入方有两个进程：
 * API 的 `deliver()` 和 worker 直投的主动交流/记忆候选。通道名写不一致**不会报错**，
 * 只会让新投递安静地等到 SSE 的 durable 轮询才被发现——主动气泡因此"看起来从不出现"。
 */
export const COMPANION_INBOX_NOTIFY_CHANNEL = "astella_companion_inbox_v1";

// ─── Conversation（§3.1） ────────────────────────────────────────────────

export const companionConversationV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(["dialogue", "inbox", "journey"]),
  title: z.string().min(1).max(120),
  titleSource: z.enum(["placeholder", "auto", "user", "system"]),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
}).strict();

export type CompanionConversationV1 = z.infer<typeof companionConversationV1Schema>;

// ─── Content blocks（§3.2） ───────────────────────────────────────────────

/**
 * 单个块的 schema 各自命名导出：桌宠日记（0252）只收 `text`/`quote`/`image`
 * 三种，它必须**引用**这里的定义而不是再抄一份——抄的那份会在
 * "图片 url 只收站内 /api/uploads/"这类校验规则变化时悄悄落后。
 */
/**
 * 她一次回复能有多长（2026-10-07）。
 *
 * 这**不是**"陪聊一句话的长度"，而是 agent 一轮可以交付的上限：长解释、读图后的
 * 长转述、带路里的多段话都要落在这一条消息里。旧值 20_000 与 worker 的输出预算
 * 是两处各写一遍的数，模型档案已经声明到 10 万级输出，两万字就成了新的硬截断。
 *
 * 输入侧另有其限（`COMPANION_P2_LIMITS.serverHardMaxChars`，用户消息 20_000），
 * 两者不是一回事，别再合并。
 */
export const COMPANION_REPLY_MAX_CHARS = 200_000;

/** 上传与实际识图使用同一上限，不能收下图片后再按另一个阈值拒绝。 */
export const COMPANION_IMAGE_MAX_BYTES_V1 = 10 * 1024 * 1024;
/** Clients prepare oversized originals before uploading to object storage. */
export const COMPANION_IMAGE_UPLOAD_TARGET_BYTES_V1 = 4 * 1024 * 1024;

export const companionTextBlockV1Schema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(COMPANION_REPLY_MAX_CHARS),
  // 语气层情绪（2026-09-18）：worker 确定性语气分类的落库形态，
  // 渲染层据此驱动 Live2D 表情。可选，历史消息没有该字段。
  emotion: characterCueEmotionV1Schema.optional(),
}).strict();

/**
 * 她读出来的那段原文（方案 29 §4.8，抱怨 #10「只能输出纯文本」）。
 *
 * 为什么由服务端而不是模型给：`notes.read.read` 已经取到了正文，
 * 让模型把这几百字**再抄一遍**既慢又必然改写——用户看到的"引用"就不是原文。
 * 服务端直接带出这一块，她的正文只负责说"我读到了什么、意味着什么"。
 * 桌宠日记（0252）同一条规矩：她给引用编号，原文由服务端带。
 */
export const companionQuoteBlockV1Schema = z.object({
  type: z.literal("quote"),
  label: z.string().min(1).max(80),
  text: z.string().min(1).max(2_000),
  /** Executor-owned identity; a label alone never invents a source location. */
  sourceRef: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("note"), noteId: z.string().uuid(), noteVersionId: z.string().uuid(), blockOrdinal: z.number().int().min(0).optional() }).strict(),
    z.object({ kind: z.literal("source"), sourceId: z.string().uuid(), segmentOrdinal: z.number().int().min(0).optional() }).strict(),
  ]).optional(),
}).strict();

/**
 * 她把某张图**摆到对话里**（方案 29 §4.8 里 B6 剩下的那一块，抱怨 #9 的另一半）。
 *
 * 与 `visual.read_image` 是两件不同的事：读图要把字节发给视觉模型（受
 * `sendImageContent` 管，政策关着时工具根本不下发）；这一块只是让本机显示一张
 * **她自己库里**的图，一个字节都不出境。所以用户说"把那张图给我看"时，即使
 * 图片外发关着，她也做得成。
 *
 * `url` 的校验刻意复用渲染层那同一个函数（`sourceImageObjectKeyFromUrl`）：
 * "合同收得下"与"显示得出"必须是同一件事，否则会出现一条能落库却永远显示不出来的块。
 * 而它只能由**服务端**从 `note_image_assets` 的行拼出来——模型给不出这个字段，
 * 也就给不出一个指向站外地址的 img src。
 */
export const companionImageBlockV1Schema = z.object({
  type: z.literal("image"),
  url: z.string().max(2_000).refine(
    (value) => sourceImageObjectKeyFromUrl(value) !== null,
    { message: "only site-internal /api/uploads/ image urls are displayable" },
  ),
  /** 图注：她说的是哪一张（`《笔记标题》· 第 2 张`）。渲染在图下面。 */
  label: z.string().min(1).max(80),
  /** 无障碍替代文字；缺省时渲染层回落到 label。 */
  alt: z.string().min(1).max(120).optional(),
  /**
   * 用户这一轮自己传的图（2026-10-06 输入框传图）。
   *
   * 指向 `note_image_assets` 行；由**服务端**在创建 turn 时按 url 解析并写入
   *（客户端给的值一律被服务端结果覆盖）。她读图时 `visual.read_image` 的
   * assetId 与这里是同一个 id。她摆出来的图（服务端拼 url 的展示块）没有该字段。
   */
  assetId: z.string().uuid().optional(),
}).strict();

/**
 * 卡片富块里题面/摘要的展示长度，**这一个**声明就是全部：合同按它校验，装配按它取预览。
 *
 * 它不是给她的额度——同一轮工具的 value 里是完整题面，块只做纸上那一段。
 */
export const COMPANION_CARD_BLOCK_PREVIEW_MAX_CHARS = 600;

/**
 * 推荐落点卡片：一条 = 一样东西。`kindLabel`/`title`/`updatedLabel` 都由服务端查库带出，
 * 只有 `reason` 是她的话（她凭什么把这一样挑出来），长度按"纸上一行"收。
 *
 * 一次推荐的上限 `COMPANION_RECOMMENDATION_MAX_ITEMS` 同时也是她那条工具能提交的
 * 条目上限——两处用同一个数，否则会出现"她递 7 条、消息只落 5 条"那种半截结果。
 */
export const COMPANION_RECOMMENDATION_MAX_ITEMS = 5;
export const COMPANION_RECOMMENDATION_REASON_MAX_CHARS = 120;

export const companionRecommendationBlockV1Schema = z.object({
  type: z.literal("recommendation"),
  /** 落点种类的自己一个字说法（笔记／学习卡／互动演示／思维导图／速看）。 */
  kindLabel: z.string().min(1).max(12),
  /** 库里真实的标题，不是她转述的名字。 */
  title: z.string().min(1).max(80),
  /** 为什么是这一样；没有就不显示这一行。 */
  reason: z.string().min(1).max(COMPANION_RECOMMENDATION_REASON_MAX_CHARS).nullable(),
  /** 「3 天前更新」这类时间读数，与她在正文里看到的口径同源。 */
  updatedLabel: z.string().min(1).max(20).nullable(),
  route: allowedMainRouteV2Schema,
}).strict();
export type CompanionRecommendationBlockV1 = z.infer<typeof companionRecommendationBlockV1Schema>;

/**
 * `companion_recommend_learning` 的参数。她只报"哪一样"，不报"在哪张表"：
 * 学习卡那条路已经证明，用户/到期列表递过来的 id 可能是 objective_id 而不是 card_id
 * （`open.card` 的别名规则），产物三张表也各有各的 id——让她分辨表格只会多一类
 * "她报错了种类"的失败。执行体按 id 查回真实身份与种类，认不出来就如实报那一条。
 */
export const COMPANION_RECOMMENDATION_TARGET_KINDS_V1 = ["note", "card", "artifact"] as const;

export const companionRecommendLearningV1Schema = z.object({
  items: z.array(z.object({
    kind: z.enum(COMPANION_RECOMMENDATION_TARGET_KINDS_V1)
      .describe("note=她搜到的笔记，card=学习卡，artifact=笔记学出来的互动演示/思维导图/速看"),
    targetId: z.string().uuid().describe("这一样的 id：本轮工具回执里的那个，不要沿用旧回复"),
    reason: z.string().min(1).max(COMPANION_RECOMMENDATION_REASON_MAX_CHARS).optional()
      .describe("为什么把这一样推荐给他，一句话；不是标题的复述"),
  }).strict()).min(1).max(COMPANION_RECOMMENDATION_MAX_ITEMS),
}).strict();
export type CompanionRecommendLearningV1 = z.infer<typeof companionRecommendLearningV1Schema>;

/** Optional next-message prompts attached to a completed assistant reply. */
export const companionFollowupSuggestionsBlockV1Schema = z.object({
  type: z.literal("follow_up_suggestions"),
  prompts: z.array(z.string().min(4).max(120)).min(1).max(3),
}).strict();

export const companionContentBlockV1Schema = z.discriminatedUnion("type", [
  companionTextBlockV1Schema,
  z.object({
    type: z.literal("code"),
    language: z.string().min(1).max(40).optional(),
    code: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal("citation"),
    label: z.string().min(1).max(200),
    /** Stable identity supplied by the search executor, never by the model. */
    referenceId: z.string().regex(/^web-[a-f0-9]{16}$/).optional(),
    media: z.string().max(100).optional(),
    publishDate: z.string().max(80).optional(),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("external_https"),
        href: z.string().url().max(2_000).refine((value) => new URL(value).protocol === "https:"),
      }).strict(),
      z.object({
        kind: z.literal("entity"),
        entityRef: z.string().min(1).max(240),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("action_ref"),
    proposalId: z.string().uuid(),
  }).strict(),
  /**
   * 跳转落点**进消息流**（方案 29 §4.8，抱怨 #5「连跳到某个笔记都做不到」的收尾）。
   *
   * 以前 route 只活在 `agent.tool` SSE 事件与一个游离在消息之外的 chip 行里：
   * 事件有 TTL、chip 不落在正文顺序里，于是"她带我去看的那篇笔记"在回看时**根本不存在**。
   * 现在 she 打开什么，就在那句话下面留一个可点、可重放的落点。
   *
   * `route` 直接复用主进程那份白名单 schema（`allowedMainRouteV2Schema`），
   * 不再抄第二份"客户端能跳哪儿"的清单——两份清单必然分叉。
   */
  z.object({
    type: z.literal("nav"),
    label: z.string().min(1).max(80),
    route: allowedMainRouteV2Schema,
  }).strict(),
  /**
   * 她推荐给用户的那一样东西（2026-10-14）。
   *
   * `nav` 是「她带我去哪儿」的一张纸签，一次只对应一个落点、话由她说完再递门牌；
   * 推荐是反过来的：一次给出几样，每样都要能自己站住——是什么、为什么是它、点哪儿。
   * 所以标题与种类由服务端查库带出（她报的 id 只用来定位行，不进卡片文字），
   * `reason` 才是她的判断。跳转仍要用户点：这一份的落点是"先看一眼"，
   * 不是"换屏"，五样连跳五次是事故。
   */
  companionRecommendationBlockV1Schema,
  /**
   * 她读出来的那段原文（方案 29 §4.8，抱怨 #10「只能输出纯文本」）。
   *
   * 为什么由服务端而不是模型给：`notes.read.read` 已经取到了正文，
   * 让模型把这几百字**再抄一遍**既慢又必然改写——用户看到的"引用"就不是原文。
   * 服务端直接带出这一块，她的正文只负责说"我读到了什么、意味着什么"。
   */
  companionQuoteBlockV1Schema,
  /**
   * 步骤/流程（方案 29 §4.8）。收的是**结构化输入**（`visual.diagram`），
   * 不是让模型用文字"画"——她用字符画箭头时，客户端只能当纯文本换行显示，
   * 手机上还会折行错乱。
   *
   * 竖向步骤流随实际内容延展，长流程仍能完整阅读。
   */
  z.object({
    type: z.literal("diagram"),
    title: z.string().min(1).max(60),
    steps: z.array(z.object({
      label: z.string().min(1),
      detail: z.string().optional(),
    }).strict()).min(2),
  }).strict(),
  /**
   * 她打开的那张卡片**内容**（§4.8）。`nav` 块只回答"跳去哪"，这块回答"这张卡写着什么"——
   * 由 `open.card` 服务端带出，同样不让模型转抄题面。
   *
   * 字段按 `learning_cards_v2` 真实有的东西来：题面（front.cue/prompt）、
   * 这张卡在考什么（public_summary）、知识形态。**没有"答案"字段**——
   * 回忆卡的正文里本来就不存标准答案，编一个出来比缺一个字段更糟。
   *
   * `front`/`summary` 是**展示预览**：整份题面同时进工具的 value（她自己看的），
   * 所以裁这一块不会让她读少什么；上限只有下面这一个源。
   */
  z.object({
    type: z.literal("card"),
    cardId: z.string().uuid(),
    front: z.string().min(1).max(COMPANION_CARD_BLOCK_PREVIEW_MAX_CHARS),
    summary: z.string().max(COMPANION_CARD_BLOCK_PREVIEW_MAX_CHARS).nullable(),
    knowledgeForm: z.string().max(40).nullable(),
  }).strict(),
  companionImageBlockV1Schema,
  /**
   * 用户这一轮传的文件（2026-10-15 移动端扩展 A：对话发文件）。
   * 正文由客户端本机抽取随块上送（「原件不出本机」：解析不发生服务端）。
   */
  companionFileBlockV1Schema,
  companionFollowupSuggestionsBlockV1Schema,
]);

export type CompanionContentBlockV1 = z.infer<typeof companionContentBlockV1Schema>;

/** 用户随这一轮主动提供的原文快照，保存在 run.page_context.selection。 */
export const COMPANION_SELECTION_MAX_CHARS = 20_000;
export const companionSelectionV1Schema = z.strictObject({
  text: z.string().min(1).max(COMPANION_SELECTION_MAX_CHARS),
  sharing: z.literal("user_selected"),
});
export type CompanionSelectionV1 = z.infer<typeof companionSelectionV1Schema>;

/** 用户主动随消息带上的来源身份；不包含页面权限、编辑坐标或后台上下文。 */
export const companionInputReferenceV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid(), noteVersionId: z.string().uuid().optional(), title: z.string().min(1).max(200).optional() }),
  z.strictObject({ kind: z.literal("diary"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), version: z.number().int().positive() }),
]);

// ─── Message（§3.3） ──────────────────────────────────────────────────────

export const companionMessageV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  seq: z.number().int().positive(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum([
    "text",
    "voice_transcript",
    "proactive",
    "action",
    "result",
    "error",
    /**
     * 用户按下"停止"时已经产出、但没能说完的那一段（2026-09-19）。
     *
     * 取消后 worker 的 latest-generation fence 会让迟到的 final 零写入，于是用户
     * 看过的内容会从历史里消失。这条 kind 把当时累积的文本留下来——它是**给人看
     * 的历史记录，不是给模型的上下文**：装配 next-turn prompt 时必须排除它，
     * 否则半截话会让下一轮顺着断句续写（见 companion-dialogue.ts 的历史 SELECT）。
     */
    "cancelled",
  ]),
  blocks: z.array(companionContentBlockV1Schema).min(1).max(32),
  /** Optional continuation prompts are presentation metadata, stored outside the hashed content blocks. */
  followUpPrompts: z.array(z.string().min(4).max(120)).max(3).optional(),
  selection: companionSelectionV1Schema.optional(),
  inputReference: companionInputReferenceV1Schema.optional(),
  runId: z.string().uuid().nullable(),
  clientMessageId: z.string().uuid().nullable(),
  // 2026-08-11：API 实际返回 contentSha256（内容校验用），契约补齐声明
  contentSha256: z.string().length(64),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
}).strict();

export type CompanionMessageV1 = z.infer<typeof companionMessageV1Schema>;

// ─── Turn run（§4.3） ─────────────────────────────────────────────────────

export const companionRunStatusV1Schema = z.enum([
  "accepted",
  "running",
  "waiting_for_confirmation",
  "succeeded",
  "cancel_requested",
  "cancelled",
  "failed",
  "superseded",
]);

export type CompanionRunStatusV1 = z.infer<typeof companionRunStatusV1Schema>;

export const companionTurnRunV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid().nullable(),
  assistantMessageId: z.string().uuid().nullable(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  phase: z.enum(["accepted", "thinking", "streaming", "acting", "awaiting_confirmation"]).nullable(),
  previewText: z.string().max(20_000),
  previewTextSha256: companionHashV1Schema,
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type CompanionTurnRunV1 = z.infer<typeof companionTurnRunV1Schema>;

// ─── Turn cancel（§6.5） ──────────────────────────────────────────────────

export const cancelCompanionRunRequestV1Schema = z.object({
  version: z.literal(1),
  generation: z.number().int().positive(),
  reason: z.literal("user"),
}).strict();

export const cancelCompanionRunResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  eventCursor: z.number().int().nonnegative(),
}).strict();

export type CancelCompanionRunRequestV1 = z.infer<typeof cancelCompanionRunRequestV1Schema>;
export type CancelCompanionRunResponseV1 = z.infer<typeof cancelCompanionRunResponseV1Schema>;

// ─── Page context（§4.1） — P2 提交的 bounded 页面上下文 ───────────────────

export const companionPageContextV1Schema = z.discriminatedUnion("pageKind", [
  z.object({
    pageKind: z.literal("note"),
    sharing: z.literal("page_registered"),
    noteId: z.string().uuid(),
    noteVersionId: z.string().uuid().optional(),
    noteTitle: z.string().trim().min(1).max(200).optional(),
    editing: companionNoteEditingContextV1Schema.optional(),
    replyPurpose: z.enum(["annotation", "overview", "recall", "recall_hint", "expansion"]).optional(),
    annotationTarget: companionAnnotationTargetV1Schema.optional(),
  }).strict(),
  z.object({
    pageKind: z.literal("star_map"),
    sharing: z.enum(["page_registered", "user_selected"]),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema.optional(),
  }).strict(),

]);

export type CompanionPageContextV1 = z.infer<typeof companionPageContextV1Schema>;

// ─── Turn create response（§4.2） ─────────────────────────────────────────

export const COMPANION_TURN_MAX_IMAGES_V1 = 12;

export const createCompanionTurnRequestV1Schema = z.object({
  version: z.literal(1),
  clientMessageId: z.string().uuid(),
  inputKind: z.enum(["text", "voice_transcript"]),
  /**
   * 2026-10-23：可选的首块文字＋最多 9 张图片＋最多一个文件；允许仅附件。
   * 所有附件归属同一条用户消息，无文字时保留真实的仅附件意图。
   * 语音转写仍必须是唯一文字块、不携带附件。
   */
  blocks: z.array(companionContentBlockV1Schema).min(1).max(COMPANION_TURN_MAX_IMAGES_V1 + 2),
  voiceArtifactId: z.string().uuid().optional(),
  sourceSurface: z.enum(["pet", "main"]),
  /**
   * 发起端界面（2026-10-15 扩展 C）：`mobile` 发起的回合里，伴星对笔记正文的
   * 修改（notes.write.edit）一律先出「确认后写回」提案（before_execute），
   * 用户在客户端看前后对照后确认才落库；桌面（缺省）行为不变。
   */
  clientSurface: z.enum(["desktop", "mobile"]).optional(),
  supersedesGeneration: z.number().int().positive().optional(),
  context: companionPageContextV1Schema.optional(),
  // 划选/拖拽投喂（2026-09-18）：用户在页面上选中的原文，随 turn 上抛。
  // 持久化进 page_context，worker 以 <selection_data> 边界注入 prompt。
  selection: companionSelectionV1Schema.optional(),
  /**
   * 日记引用（40 §6「聊聊这篇」）。
   *
   * 日记页那个次级动作只**打开对话并附上引用**，不自动发送用户消息；用户自己
   * 接着打字之后，这条引用随本轮上抛，伴星据此调用 `memory.read.diary`
   * 按**当前权限**现读那一篇——而不是让用户把全文复制粘贴。
   *
   * `version` 必填：§5.5 保证已发布成稿不被后台重跑静默替换，所以「用户看到的
   * 那一版」是稳定的；版本对不上时伴星应当说清楚，而不是拿新版顶替。
   */
  diaryReference: z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    version: z.number().int().min(1),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  const first = value.blocks[0];
  if (value.inputKind === "voice_transcript") {
    if (first?.type !== "text" || value.blocks.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "voice transcript turn carries exactly one text block and no attachment" });
    }
  } else {
    for (const [index, block] of value.blocks.entries()) {
      if (block.type !== "image" && block.type !== "file" && !(index === 0 && block.type === "text")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks", index], message: "only the first optional text block and image/file attachments are allowed" });
      }
    }
    if (value.blocks.filter((block) => block.type === "image").length > COMPANION_TURN_MAX_IMAGES_V1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: `at most ${COMPANION_TURN_MAX_IMAGES_V1} images per turn` });
    }
    if (value.blocks.filter((block) => block.type === "file").length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "at most one file per turn" });
    }
  }
  if ((value.inputKind === "voice_transcript") !== (value.voiceArtifactId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["voiceArtifactId"], message: "required iff voice_transcript" });
  }
});

export type CreateCompanionTurnRequestV1 = z.infer<
  typeof createCompanionTurnRequestV1Schema
>;

export const createCompanionTurnResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  // 幂等重放已终态 run 时返回真实状态（§6.3），客户端据此决定挂 SSE 还是恢复快照。
  status: z.enum(["accepted", "running", "succeeded", "cancelled", "failed", "superseded"]),
  eventCursor: z.number().int().nonnegative(),
}).strict();

export type CreateCompanionTurnResponseV1 = z.infer<
  typeof createCompanionTurnResponseV1Schema
>;

/** 服务端持久化的 page context（§4.1）：去掉 grant signature/raw，只存 bounded refs。 */
export const companionPersistedPageContextV1Schema = z.object({
  version: z.literal(1),
  context: z.discriminatedUnion("pageKind", [
    z.object({
      pageKind: z.literal("note"),
      sharing: z.literal("page_registered"),
      noteId: z.string().uuid(),
      noteVersionId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("star_map"),
      sharing: z.enum(["page_registered", "user_selected"]),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
  ]),
}).strict();

export type CompanionPersistedPageContextV1 = z.infer<
  typeof companionPersistedPageContextV1Schema
>;

/** 恢复快照（§6.4）：P2–P4 两个学习动作字段为 null；P5 可恢复 durable proposal/run。 */
export const companionConversationSnapshotV1Schema = z.object({
  version: z.literal(1),
  conversation: companionConversationV1Schema,
  activeRun: companionTurnRunV1Schema.nullable(),
  latestEventSeq: z.number().int().nonnegative(),
  // These P5 schemas are declared below; lazy references avoid a module-load
  // temporal-dead-zone while keeping the exported snapshot contract unified.
  pendingProposal: z.lazy(() => pendingLearningActionProposalV1Schema).nullable(),
}).strict();

export type CompanionConversationSnapshotV1 = z.infer<
  typeof companionConversationSnapshotV1Schema
>;

// ─── Character cue（§4.4，wire 版；区别于 P1 表现层 characterCueV1Schema） ──

export const companionCharacterCueV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum([
    "acknowledge",
    "listen",
    "think",
    "explain",
    "encourage",
    "celebrate",
    "uncertain",
    "warn",
    "sleep",
  ]),
  emotion: z.enum(["neutral", "happy", "curious", "concerned", "surprised"]),
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().min(100).max(10_000).optional(),
}).strict();

export type CompanionCharacterCueV1 = z.infer<typeof companionCharacterCueV1Schema>;

// ─── P5 §4.5 Learning action proposal（第一批冻结） ─────────────────────

/**
 * 方案 16 §18 plan_understanding_route 工具的请求合同（与
 * POST /understanding/routes/plan 的 routePlanBodySchema 同构；共享侧为
 * canonical，projection-routes 从此导入，禁止再本地复制一份）。
 */
export const understandingRoutePlanRequestV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum(["repair_gap", "prepare_review", "explore_neighbors"]),
  targetKeyPointId: z.string().uuid().optional(),
  maxSteps: z.number().int().min(1).max(5),
  lens: z.enum(["current_target", "evidence", "provenance", "issues"]),
  filter: z.object({
    showArchived: z.boolean(),
    sourceId: z.string().uuid().optional(),
    cardId: z.string().uuid().optional(),
    relationKinds: z.array(z.string()).optional(),
  }).passthrough(),
  expectedCheckpointToken: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
});
export type UnderstandingRoutePlanRequestV1 = z.infer<typeof understandingRoutePlanRequestV1Schema>;

/**
 * §18.1 AssistantMemoryItemV1 kind（与 memory-service 一致；40 §4.5.4 加了 judgment）。
 *
 * `judgment` 只出现在**读取**侧——她的看法要能被她自己重新读到。
 * 写入侧 `save_memory` 的参数枚举不含它，因为抽取任务只提事实。
 */
export const assistantMemoryKindV1Schema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
  "judgment",
]);

/** §18.1 defer_review 展示层 reason code（不修改 official dueAt）。 */
export const deferReviewReasonCodeV1Schema = z.enum([
  "user_requested",
  "temporary_unavailable",
]);

export const proposedLearningActionPayloadV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent_tool_review"),
    // Domain tool (`companion_notes_write`) or internal operation (`notes.write.create`).
    // The ledger keys on the operation, so a confirmed card must be able to name it too.
    toolName: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/).max(80),
    arguments: z.record(z.unknown()),
    confirmationStage: z.enum(["after_preview", "before_execute"]),
    expectedTarget: z.record(z.unknown()).optional(),
    preview: z.object({
      title: z.string().min(1).max(200),
      markdown: z.string().optional(),
      beforeMarkdown: z.string().optional(),
      noteId: z.string().uuid().optional(),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal("open_card"), cardId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("open_star_map"), keyPointId: z.string().uuid().optional() }).strict(),
  // 已删除两个无法实现的 kind（2026-09-16）：
  // - ask_grounded_tutor：无 producer、无 decision 分支，确认必落 409；当前 target
  //   Tutor 由 companion-context-grants + grounded evidence 流程交付。
  // - propose_memory_candidate：契约要求 payload 携带 sourceMessageId，而该 id 由
  //   服务端在 proposal 创建事务内生成（菜单路径 userMessageId、agent 路径
  //   event.read.userMessageId），调用方无从提供 ⇒ 该 kind 不可满足。已落地的候选
  //   记忆路径是 worker memory-extractor + delivery 气泡 + confirm_or_reject_memory。
  // ── 方案 16 §18.1 工具网关（第二批：Orchestrator 动作工具全集） ──
  // 全部为"用户确认后才执行"的业务动作；导航类同步 succeeded，业务类
  // 事务内确定性执行（执行函数见 learning-action-bridge.ts）。
  // `plan_understanding_route` 已删除（2026-09-24，39d W2-1）：它唯一的 producer 是
  // `companion_plan_route`，而那个工具的参数曾是 `z.record(z.unknown())`——31 个工具里
  // 唯一能改状态却零字段校验的写工具；全窗口 30 天真实流量 **0 次调用**（总盘 144 轮 /
  // 181 次调用），连一条状态行都没有。按 AGENTS.md 与 39b §9.8 的规则整条删。
  // `route-plan-service` 本身**保留**：它同时服务 HTTP 路由 `POST /understanding/routes/plan`。
  z.object({
    kind: z.literal("focus_graph_node"),
    keyPointId: z.string().uuid(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]),
  }).strict(),
  z.object({
    kind: z.literal("open_conversation_history"),
  }).strict(),
  z.object({
    // revision = 目标记忆 updatedAt 的 epoch millis（单调 CAS 令牌；
    // 记忆无独立 revision 列，见 assistant-memory 表）。
    kind: z.literal("confirm_or_reject_memory"),
    memoryId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    decision: z.enum(["confirm", "reject"]),
  }).strict(),
  z.object({
    kind: z.literal("delete_assistant_memory"),
    memoryId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  }).strict(),
  // ── 2026-09-19：auto-set / auto-fill 工具（guided 档提案确认后的执行分支）──
  // full 档不创建提案，由 worker executeDirectTool 直执行；这里的 payload 形状
  // 与 worker 侧 buildActionPayload 映射同源。
  z.object({
    kind: z.literal("save_memory"),
    // 枚举与 assistant_memory_items.kind 的 DB CHECK 约束同源。
    memoryKind: z.enum(["preference", "goal", "learning_context", "interaction_note", "episodic"]),
    content: z.string().min(1).max(200),
    sourceQuote: z.string().min(3).max(80).nullable().optional(),
    appliesWhen: z.string().max(200).nullable().optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal("revise_memory"),
    memoryId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    content: z.string().min(1).max(200),
    appliesWhen: z.string().max(200).nullable().optional(),
    validFrom: z.string().datetime({ offset: true }).nullable().optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal("set_pet_activeness"),
    activeness: z.enum(["quiet", "moderate", "active"]),
  }).strict(),
]).superRefine((value, context) => {
  if (
    value.kind === "revise_memory"
    && value.validFrom && value.validUntil
    && Date.parse(value.validUntil) <= Date.parse(value.validFrom)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "validUntil must follow validFrom" });
  }
});

export const companionActionProposalV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  contextGrantId: z.string().uuid().nullable(),
  payload: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  requiresConfirmation: z.literal(true),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
  decision: z.enum(["confirm", "reject"]).nullable(),
  expiresAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const pendingLearningActionProposalV1Schema = companionActionProposalV1Schema.extend({
  status: z.literal("pending"),
  decision: z.null(),
  decidedAt: z.null(),
}).strict();

export const companionProposalSnapshotV1Schema = z.object({
  version: z.literal(1),
  proposal: companionActionProposalV1Schema,
}).strict();

export type CompanionProposalSnapshotV1 = z.infer<typeof companionProposalSnapshotV1Schema>;


// ── 方案 16 §18.1：通用工具 proposal 请求（Orchestrator 网关入口） ──
export const createToolProposalRequestV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid().optional(),
  clientMessageId: z.string().uuid(),
  payload: proposedLearningActionPayloadV1Schema,
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  sourceSurface: z.enum(["pet", "main"]),
}).strict();
export type CreateToolProposalRequestV1 = z.infer<typeof createToolProposalRequestV1Schema>;

// ─── P5 §6.6 Proposal decision（confirm/reject） ────────────────────────

export const proposalDecisionRequestV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  decision: z.enum(["confirm", "reject"]),
  idempotencyKey: z.string().uuid(),
  // §6.6：confirm 必须匹配服务端冻结的 payload hash。
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const proposalDecisionResponseV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  status: z.enum(["rejected", "accepted", "executing", "succeeded", "failed"]),
  resultRef: z.string().min(1).max(240).nullable(),
  // 2026-08-15：服务端 navigationRouteFor 返回 V2 合同（§18 新导航 kind 的
  // lens/restoreRun/assistantSessionId 是 V1 strict 之外的新键）——decision
  // 响应必须用 V2 route schema，否则 focus_graph_node 等确认后客户端
  // parse 502 INVALID_DECISION_RESPONSE。
  route: allowedMainRouteV2Schema.nullable(),
  safeSummary: z.string().min(1).max(240).nullable(),
}).strict();
export type ProposalDecisionResponseV1 = z.infer<typeof proposalDecisionResponseV1Schema>;





// ─── P2 §5.2/§6.9 恢复块：错误码 + 16 事件 discriminated union + limits ──

export const companionPublicErrorCodeV1Schema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONVERSATION_LIMIT_REACHED",
  "IDEMPOTENCY_CONFLICT",
  "RUN_ALREADY_ACTIVE",
  "STALE_GENERATION",
  "CURSOR_EXPIRED",
  "INVALID_CURSOR",
  "RATE_LIMITED",
  // 2026-08-11：SSE 连接数上限（companion-events.ts / account-events.ts 429）
  "TOO_MANY_CONNECTIONS",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_FIRST_OUTPUT_TIMEOUT",
  "PROVIDER_IDLE_TIMEOUT",
  "TURN_CANCELLED",
  "VOICE_PERMISSION_DENIED",
  "VOICE_AUDIO_TOO_LARGE",
  "VOICE_UNSUPPORTED_FORMAT",
  "ASR_FAILED",
  "TTS_FAILED",
  "ACTION_CONFIRMATION_REQUIRED",
  "ACTION_EXPIRED",
  "ACTION_STALE",
  "ACTION_NOT_EXECUTED",
  "TOOL_ARGUMENTS_INVALID",
  "REPLY_LENGTH_LIMIT",
  "REPLY_FORMAT_INVALID",
  "AGENT_BUDGET_EXCEEDED",
  // 2026-10-16：agent 里取消了全部预算上限，于是"她转不出来"必须由事实收口——
  // 同一个工具调用（工具名 + 参数）拿到成功回执后又被原样要了第二次
  // （判据 `workers/ai-worker/src/handlers/agent/companion-progress-guard.ts`）。
  // 列进枚举是硬要求：不在枚举里的事件帧会被桌面主进程整帧丢弃。
  "AGENT_NO_PROGRESS",
  "AI_DATA_POLICY_DENIED",
  // 2026-08-12+（15a-E）：学习快捷方式错误码细分——context 变化/无进行中会话/无候选
  "CONTEXT_STALE",
  "NO_ACTIVE_RUN",
  "NO_CANDIDATE",
  "PAYLOAD_HASH_MISMATCH",
  // 孤儿 run 回收（0232/0424）写进 `error` 事件的那些码。列进枚举不是走形式：
  // 不在枚举里的事件帧会被桌面主进程的严格校验**整帧丢弃**，于是"回收发生了、
  // 客户端什么也没看见"，气泡永远停在"正在路上"。JOB_MISSING/JOB_DEAD 是补登记
  // （0232 早就在写，客户端一直读不到）。
  "JOB_MISSING",
  "JOB_DEAD",
  "JOB_NEVER_STARTED",
  "JOB_LEASE_LOST",
  "JOB_FINISHED_WITHOUT_RUN",
  "INTERNAL_ERROR",
]);

export const companionErrorV1Schema = z.object({
  version: z.literal(1),
  error: companionPublicErrorCodeV1Schema,
  message: z.string().min(1),
  recoverable: z.boolean(),
  requestId: z.string().min(1).max(120),
}).strict();

export const COMPANION_P2_LIMITS = Object.freeze({
  composerMaxChars: 4_000,
  serverHardMaxChars: 20_000,
  deltaMaxChars: 2_000,
  blocksPerMessage: 32,
});



// envelope 的 strict：base 字段展开进每个 union 分支，分支整体 .strict()，
// 未知顶层字段被分支拒绝（§5.1 唯一 wire truth）。不能用 z.intersection +
// base.strict()：intersection 的两个 schema 都作用于含 type/payload 的完整对象。
const companionStreamEventBaseShapeV1 = {
  version: z.literal(1),
  eventId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  generation: z.number().int().nonnegative(),
  accountEpoch: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
} as const;

// SSE 的 character.cue 必须与方案 13 §9.6 / 03 §4.4 的高层语义 cue 合同一致
// （intent/emotion 为固定 enum，含 durationMs），不复用 presentation 名。
export const characterCuePayloadV1Schema = z.object({
  version: z.literal(1),
  intent: characterCueIntentV1Schema,
  emotion: characterCueEmotionV1Schema,
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().positive().optional(),
}).strict();
export type CharacterCuePayloadV1 = z.infer<typeof characterCuePayloadV1Schema>;

/**
 * 伴星回复的服务端语音片段合同。
 *
 * `display*` 永远对应已经提交给用户的干净正文；`synthesisText` 只供服务端按
 * 严格引用重新读取并合成，可包含受控语气标签。桌面主进程会在跨 IPC 前删除
 * `synthesisText`，渲染层只看到引用、正文区间、摘要和语义 cue。
 */
export const companionVoiceSegmentReadyPayloadV2Schema = z.strictObject({
  version: z.literal(2),
  messageId: z.string().uuid().optional(),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  ordinal: z.number().int().min(1).max(200),
  displayText: z.string().min(1).max(160),
  displayStart: z.number().int().nonnegative(),
  displayEnd: z.number().int().positive(),
  synthesisText: z.string().min(1).max(200),
  synthesisTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cue: characterCuePayloadV1Schema,
  /**
   * 这一轮的说话风格指令（并行的结构化注意力解释器结合当前话语和近期上下文语义判定；
   * 只有解释缺失时，宿主才从明确点名的方言请求兜底识别。一轮一条随每段下发，
   * 服务端合成时从事件重读）。缺省 = 本轮没有声音变化请求，合成侧回退用户偏好 → config。
   * 只有 qwen 消费；渲染层不需要它（桌面过桥时与 synthesisText 一起剥掉）。
   */
  instruction: z.string().min(1).max(VOICE_STYLE_INSTRUCTION_MAX_UNITS * 2).optional(),
}).superRefine((value, context) => {
  if (value.displayEnd <= value.displayStart) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayEnd"], message: "displayEnd must be greater than displayStart" });
  }
  if (value.displayEnd - value.displayStart !== value.displayText.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayText"], message: "display range must match displayText length" });
  }
  if (value.instruction !== undefined && voiceStyleInstructionUnits(value.instruction) > VOICE_STYLE_INSTRUCTION_MAX_UNITS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruction"], message: "instruction exceeds upstream unit budget" });
  }
});
export type CompanionVoiceSegmentReadyPayloadV2 = z.infer<typeof companionVoiceSegmentReadyPayloadV2Schema>;

const actionProposedProposalV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  kind: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
  origin: z.enum(["menu", "agent_tool"]).optional(),
  agentToolCallId: z.string().max(200).optional(),
}).strict();

export const companionStreamEventV1Schema = z.discriminatedUnion("type", [
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.accepted"), payload: z.object({
    clientMessageId: z.string().uuid(), userMessageId: z.string().uuid(), status: z.literal("accepted"), resumed: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.status"), payload: z.object({
    /**
     * `waiting` = 这一轮还在路上，**没有**任何"她在想"的承诺（2026-10-07）。
     *
     * 伴星按本轮意图决定开不开思考，闲聊轮不开——所以"发送中"不等于"在思考"。
     * 只有真的开了思考档，worker 才会补发一条 `thinking`。
     */
    status: z.enum(["waiting", "thinking", "acting"]), safeLabel: z.string().min(1).max(240),
    inputKind: z.enum(["user", "initiative"]).optional(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.thinking"), payload: z.object({
    /**
     * 本轮内从 0 递增的思考块序号。
     *
     * 与 `assistant.delta.appendFrom` 不同，这里刻意**不是**写入偏移：这一串文字
     * 永远不会被拼成任何正文，客户端只需要按顺序续接显示尾部，所以缺口/重复都
     * 只影响显示，不需要对账。
     */
    index: z.number().int().nonnegative(),
    /**
     * 模型这一轮思考的原文增量。
     *
     * 只用于显示：不进 `assistant.delta`、不进 `companion_messages`、不进语音分段，
     * 因此朗读链路根本看不见它。流事件随 `companion_stream_events` 的 TTL 一起清；
     * 完成后另有独立的 run 历史留档，不混入答案正文。
     */
    text: z.string().min(1).max(4_000),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("agent.tool"), payload: z.object({
    tool: companionAgentToolEventV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.delta"), payload: z.object({
    appendFrom: z.number().int().nonnegative(), textDelta: z.string().min(1).max(2_000),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.utterance"), payload: z.object({
    messageId: z.string().uuid(), messageSeq: z.number().int().positive(),
    text: z.string().min(1).max(12_000), proactive: z.boolean(),
    deviceSessionId: z.string().max(200).nullable(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.completed"), payload: z.object({
    messageIds: z.array(z.string().uuid()).max(40), silent: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.final"), payload: z.object({
    messageId: z.string().uuid(), textLength: z.number().int().nonnegative(),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    messageContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    // 22 方案 §12.3/§14.5/§16.3：本轮真正使用的记忆引用，仅 UI 展示。
    memoryRefs: z.array(z.object({
      memoryId: z.string().uuid(),
      kind: z.string().min(1).max(64),
      content: z.string().min(1).max(80),
    }).strict()).max(3).optional(),
    followUpPrompts: z.array(z.string().min(4).max(120)).min(1).max(3).optional(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.followups.ready"), payload: z.object({
    messageId: z.string().uuid(),
    messageContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    followUpPrompts: z.array(z.string().min(4).max(120)).max(3),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("character.cue"), payload: z.object({
    cue: characterCuePayloadV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.proposed"), payload: z.object({
    proposal: actionProposedProposalV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.decision"), payload: z.object({
    proposalId: z.string().uuid(), decision: z.enum(["confirm", "reject"]),
    status: z.enum(["accepted", "rejected"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.expired"), payload: z.object({
    proposalId: z.string().uuid(),
  }).strict() }).strict(),
  z.object({
    ...companionStreamEventBaseShapeV1,
    type: z.literal("voice.segment.ready"),
    payload: companionVoiceSegmentReadyPayloadV2Schema,
  }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("proactive.delivery"), payload: z.object({
    deliveryId: z.string().uuid(), messageId: z.string().uuid(), expiresAt: z.string().datetime(),
    contentPolicy: z.enum(["content", "content_hidden"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("proactive.delivery.updated"), payload: z.object({
    deliveryId: z.string().uuid(), status: z.enum(["shown", "suppressed", "dismissed", "expired"]),
    contentClaimed: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.cancelled"), payload: z.object({
    reason: z.enum(["user", "superseded", "shutdown", "timeout"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("error"), payload: z.object({
    code: companionPublicErrorCodeV1Schema, recoverable: z.boolean(), requestId: z.string().min(1).max(120).optional(),
    /**
     * 这一轮**为什么**停下的那句话。worker 在写事件时就带上（reason），
     * 2026-10-12 补进合同：strict 下多出来的键会让整条事件在所有客户端被判失败，
     * 屏幕上只留一个永远转不过去的"正在路上"——比没有这行字更糟。
     */
    message: z.string().min(1).max(400).optional(),
  }).strict() }).strict(),
  ]);

export type CompanionStreamEventV1 = z.infer<typeof companionStreamEventV1Schema>;

// ─── P2/P3：TTS request + 错误码 type ────────────────────────────────────

export type CompanionPublicErrorCodeV1 = z.infer<typeof companionPublicErrorCodeV1Schema>;

// ─── P6 §13 流式 TTS 请求（句子级，每稳定句一条流） ─────────────────────

export const companionTtsStreamRequestV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(160),
  /**
   * 伴星回合里的分句：**给了就按引用取正文**，`text` 只作协议占位不再采信。
   *
   * 客户端手里只有段引用（它不持有正文），而服务端要用 (conversationId, runId,
   * generation, ordinal, segmentId) 五个字段才能确认"这一段确实是这一轮签发的"。
   * 不给这个字段时仍按 `text` 直接合成（普通朗读/探针走的那条）。
   */
  conversationId: z.string().uuid().optional(),
  voice: z.string().min(1).max(120).optional(),
  // 2026-08-12（伴星语音设置）：语速（"-30%" | "+0%" | "+30%"）。
  rate: z.string().min(1).max(16).optional(),
  // 15b：TTS 引擎选择（缺省 = config tts.engine；前端通常不传，由服务端决定）。
  engine: z.enum(["qwen", "edge"]).optional(),
}).strict();

/**
 * 读对话原文这一族的**分页预算**，声明与执行共用这一个数。
 *
 * 以前它是 worker 里的私有常量（`companion-summary-retrieval.ts`），而能力面上这两格写的
 * 是 `defineAgentCapability` 的默认 4,000——两头都对不上：真要按 4,000 执法就会把消息切半。
 * 规则不变：**一条消息要么整条给，要么这一轮不给**，装不下的留给下一次 `fromSeq`。
 */
// Soft page target, not an output ceiling. A single longer message is returned
// intact; remaining whole messages have an explicit source cursor. Provenance
// and server-derived time metadata also count in the full model request budget.
export const PAST_MESSAGES_PAGE_TARGET_CHARS = 6_000;
