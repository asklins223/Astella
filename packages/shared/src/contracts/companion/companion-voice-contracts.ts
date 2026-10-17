import { z } from "zod";

/**
 * Companion M2 语音朗读合同（`companion.voice.speak`）。
 *
 * renderer 只提交一段已净化的短中文提示文本；main 通过 `POST /voice/tts`
 * 取回 `audio/mpeg` 原始字节，再投影为本模块的 strict
 * result。服务端仍会二次拒绝 SSML/URL/脚本，因此这里只承载纯文本上限。
 */
export const COMPANION_VOICE_MAX_TEXT_LENGTH = 120;

/** main 侧音频硬上限（字节）：与 schema 上限一致，超限直接 fail closed。 */
export const COMPANION_VOICE_MAX_AUDIO_BYTES = 524288;

/** 朗读只允许已审核的固定 voice profile。 */
export const COMPANION_VOICE_SPEAK_VOICE = "zh-CN-XiaoxiaoNeural" as const;

export const companionVoiceSpeakRequestV1Schema = z.strictObject({
  version: z.literal(1),
  /**
   * 单次请求的上限，不是"能念多长"的上限。它同时是渲染层分段器每段的大小
   * （`COMPANION_SPEECH_MAX_SEGMENT_CHARS` 就取这个常量），一段长旁白会被切成
   * 几句念出来的，不是被截断的；这里卡住的只是"一次 `POST /voice/tts` 该回多少字节、
   * 该在多久内回"——512KB 音频硬顶与通知声道的合成截止都挂在单次请求上。
   */
  text: z.string().trim().min(1).max(COMPANION_VOICE_MAX_TEXT_LENGTH),
  /**
   * Guidance uses the default Qwen voice; ordinary notifications use Edge.
   */
  purpose: z.enum(["notification", "guidance"]).optional(),
});
export type CompanionVoiceSpeakRequestV1 = z.infer<typeof companionVoiceSpeakRequestV1Schema>;

/** Default Qwen configuration identity for persistent guidance audio, without provider credentials. */
export const companionGuidanceVoiceProfileV1Schema = z.strictObject({
  version: z.literal(1),
  profileId: z.string().regex(/^[a-f0-9]{64}$/),
  voice: z.string().min(1).max(64),
});
export type CompanionGuidanceVoiceProfileV1 = z.infer<typeof companionGuidanceVoiceProfileV1Schema>;

export const companionVoiceSpeakResultV1Schema = z.strictObject({
  version: z.literal(1),
  mimeType: z.literal("audio/mpeg"),
  audioBase64: z.string().min(1),
  byteLength: z.number().int().positive().max(COMPANION_VOICE_MAX_AUDIO_BYTES),
  voice: z.string().min(1).max(64),
});
export type CompanionVoiceSpeakResultV1 = z.infer<typeof companionVoiceSpeakResultV1Schema>;

/**
 * 流式朗读一段语音时的下行事件（2026-10-17，主进程 → 渲染层）。
 *
 * `chunk` 是**原始 MP3 字节**，按到达顺序给；渲染层按帧累计、边解边排。
 * 它不是"一条完整的音频"—— 一个 chunk 可能切在帧中间，帧的拼接由渲染层负责
 * （`companion-incremental-mp3.ts`）。这里因此**不带**任何时长/段索引语义，
 * 那些都由调用方按 `requestId` 自己记。
 */
export const companionVoiceSpeakChunkEventV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("chunk"),
    /** 这个 chunk 属于哪一次 speakSegmentStream 调用。 */
    requestId: z.string().min(1).max(200),
    /**
     * MP3 原始字节。上限按单块给：上游就是分块吐的，一块远小于整段。
     *
     * 两种形状都收：结构化克隆正常时是 `Uint8Array`，某些环境的 ipc
     * 序列化会给回普通数组。归一化放在 preload 一处，渲染层只认 TypedArray。
     */
    bytes: z.union([
      z.instanceof(Uint8Array),
      z.array(z.number().int().min(0).max(255)),
    ]).transform(value => (value instanceof Uint8Array ? value : Uint8Array.from(value))),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("end"),
    requestId: z.string().min(1).max(200),
    /** 整段实际字节数，供调用方核对（与缓存那份一致）。 */
    byteLength: z.number().int().nonnegative(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("error"),
    requestId: z.string().min(1).max(200),
    /**
     * 复用整段那条的失败分类（`GatewayErrorCode` + 重试口径）：渲染层据此决定
     * 重试还是降级纯文字。这里不复制枚举——网关那边加一个码，这里跟着放宽即可，
     * 复制一份的结果是两边迟早对不上。
     */
    failure: z.object({
      code: z.string().min(1).max(80),
      retry: z.enum(["never", "safe_retry", "user_action", "resync_first"]),
    }).strict(),
  }),
]);
export type CompanionVoiceSpeakChunkEventV1 = z.infer<typeof companionVoiceSpeakChunkEventV1Schema>;


/**
 * Agent 正文朗读只提交服务端签发的片段引用，正文、语气标签和 voice profile 都不由
 * renderer 指定。API 会在当前工作区内重读事件并再次校验 run/generation fence。
 */
export const companionVoiceSpeakSegmentRequestV2Schema = z.strictObject({
  version: z.literal(2),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CompanionVoiceSpeakSegmentRequestV2 = z.infer<typeof companionVoiceSpeakSegmentRequestV2Schema>;

/**
 * 一轮回复**已经签发过**的语音段（2026-10-16）。
 *
 * 补听入口用：本机没留下录音时，客户端拿这一份重建 `CompanionVoiceSpeakSegmentRequestV2`
 * 去取字节。**分段的权威在服务端**——客户端照着这份重建，不自己重新切段，
 * 否则切出来的段与当时念的不是同一批，缓存与 playback-outcome 全会对不上。
 *
 * 事件本身按 `companion_stream_events` 的既有 TTL 清理：过期后这一轮就真的没有可补的音频了，
 * 那时如实说"这段没有留下语音记录"，不假装还能放。
 */
export const companionRunVoiceSegmentsResultV1Schema = z.strictObject({
  version: z.literal(1),
  runId: z.string().uuid(),
  /** 与 `generation` 同源：这一轮没有留档时两个都是 null。 */
  conversationId: z.string().uuid().nullable(),
  /** 没有留档时是 null（`items` 也必为空）——"这一轮没有可补的音频"是正常结论，不是错误。 */
  generation: z.number().int().positive().nullable(),
  items: z.array(z.strictObject({
    ordinal: z.number().int().min(1).max(200),
    segmentId: z.string().regex(/^[a-f0-9]{64}$/),
    displayText: z.string().min(1),
    displayStart: z.number().int().nonnegative(),
    displayEnd: z.number().int().nonnegative(),
    cue: z.unknown(),
  })).max(200),
});
export type CompanionRunVoiceSegmentsResultV1 = z.infer<typeof companionRunVoiceSegmentsResultV1Schema>;

export const companionRunVoiceSegmentsRequestV1Schema = z.strictObject({
  version: z.literal(1),
  // 只带 runId：会话身份由服务端从这一轮本身取（`companion_stream_events.conversation_id`）。
  // 原来要求客户端传 conversationId，而**连续对话历史按产品层不暴露 conversation**，
  // 于是伴星中心与手记那两处根本没有 conversationId 可传——入口给了也永远取不到。
  runId: z.string().uuid(),
});
export type CompanionRunVoiceSegmentsRequestV1 = z.infer<typeof companionRunVoiceSegmentsRequestV1Schema>;

/** 本机原声按回复身份保留，分段不单独占用消息额度，回听不产生合成请求。 */
export const COMPANION_MESSAGE_AUDIO_LIMIT = 100;
export const companionCachedVoiceListRequestV1Schema = z.strictObject({
  runIds: z.array(z.string().uuid()).max(COMPANION_MESSAGE_AUDIO_LIMIT),
});
export const companionCachedVoiceListResultV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(z.strictObject({
    runId: z.string().uuid(),
    ordinals: z.array(z.number().int().min(1).max(200)).min(1).max(200),
  })).max(COMPANION_MESSAGE_AUDIO_LIMIT),
});
export const companionCachedVoiceReadRequestV1Schema = z.strictObject({
  runId: z.string().uuid(),
  ordinal: z.number().int().min(1).max(200),
});
export type CompanionCachedVoiceListResultV1 = z.infer<typeof companionCachedVoiceListResultV1Schema>;
export type CompanionCachedVoiceReadRequestV1 = z.infer<typeof companionCachedVoiceReadRequestV1Schema>;

/**
 * 一段音频在客户端那一侧的结局（0247）。
 *
 * 只报**原因**，不报 outcome：`outcome` 由服务端按这张表映射（客户端同时报两个字段
 * 只会造出 `reason=deadline, outcome=ok` 这种自相矛盾的行，而报表正是靠这些行回答
 * "她没声音"是哪一种）。
 *
 * 取值域只有三个，且每一个都对应渲染进程里一条真实分支：播完了、等到超时被跳过、
 * 取段这一步本身就失败。**没有**为"以后可能观察到"的情形预留取值。
 * 用户打断（新一轮开始）不在这里：那是正常行为，不是故障，记进同一张表只会让
 * "失败率"随用户打字速度浮动。
 */
export const COMPANION_TTS_PLAYBACK_REASONS = [
  "played",       // 播完了
  "deadline",     // 字节在路上，但首段/段间截止先到 → 这段被跳过
  "synth_failed", // 取段/合成请求本身失败（网络、502、解不出音频）
  // 字节已经到手（或已在路上），但这一轮被打断/宿主卸载，段被丢掉。
  // 它与 deadline 的区别是"没有超时这回事"：实机 2026-09-22 为了找那 1 段
  // "给了音频却没响"，只能靠跨表反推，因为客户端在这些分支上一个字都不报。
  // 记成 rejected 而不是 failed——用户打断是正常行为，不该进失败率（见下）。
  "dropped",
] as const;
export type CompanionTtsPlaybackReason = (typeof COMPANION_TTS_PLAYBACK_REASONS)[number];

/** reason → `companion_tts_outcomes.outcome`（沿用 0246 的词表，不新增取值）。 */
export const COMPANION_TTS_PLAYBACK_REASON_TO_OUTCOME: Record<
  CompanionTtsPlaybackReason,
  "ok" | "rejected" | "failed"
> = {
  played: "ok",
  deadline: "failed",
  synth_failed: "failed",
  dropped: "rejected",
};

export const companionVoicePlaybackOutcomeRequestV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.enum(COMPANION_TTS_PLAYBACK_REASONS),
  /** 从发起取段到这段有结局的耗时；`played` 时就是"听完这一段一共等了多久"。 */
  durationMs: z.number().int().min(0).max(600_000).optional(),
});
export type CompanionVoicePlaybackOutcomeRequestV1 = z.infer<
  typeof companionVoicePlaybackOutcomeRequestV1Schema
>;

/**
 * 上报的回执。`recorded` 说的是"**这次请求被接受了**"，不是"那一段播好了"——
 * 后者在请求里。同一段重发会被幂等索引吞掉，仍然回 recorded=true：从客户端的视角
 * 这两次都是"我已经把这段的结局告诉你了"，没有需要它处理的差别。
 */
export const companionVoicePlaybackOutcomeResultV1Schema = z.strictObject({
  version: z.literal(1),
  recorded: z.boolean(),
});
export type CompanionVoicePlaybackOutcomeResultV1 = z.infer<
  typeof companionVoicePlaybackOutcomeResultV1Schema
>;
