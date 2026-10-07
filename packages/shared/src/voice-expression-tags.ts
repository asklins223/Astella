/**
 * 15b 二期：情感与富语言标签（阿里百炼 Qwen-Audio-TTS 专属能力）。
 *
 * 模型在生成回复时决定表达，宿主只解析白名单，不根据正文关键词猜情绪。
 * 展示/入库正文剥标签；Qwen 合成保留；其他引擎在外发前剥标签。
 *
 * 2026-08-13（引擎兼容）：标签是 qwen-audio 模型的专属能力——edge-tts 等
 * 其他引擎会把 `[excited]` 当普通文字朗读。api 是引擎边界：edge 分支在
 * 合成前调用 stripVoiceExpressionTags 净化文本；emotion 字段（Live2D
 * 表情驱动）与引擎无关，worker 始终解析下发。
 */

/** 控制类标签（23 个，文档全表）：作用于其后文本的情感/风格。 */
export const VOICE_EMOTION_TAGS = [
  "sad",
  "amazed",
  "deep and loud shouting",
  "trembling",
  "angry",
  "excited",
  "sarcastic",
  "curious",
  "like dracula",
  "bored",
  "tired",
  "scornful",
  "shouting",
  "asmr",
  "panicked",
  "mischievously",
  "empathetic",
  "whispers",
  "reluctantly",
  "crying",
  "serious",
  "very slowly",
  "very fast",
] as const;

/** 富语言类标签（7 个，文档全表）：在当前位置插入拟声效果。 */
export const VOICE_RICH_TAGS = [
  "gasp",
  "sighing",
  "clears throat",
  "giggles",
  "laughing",
  "cough",
  "snorts",
] as const;

export type VoiceEmotionTag = (typeof VOICE_EMOTION_TAGS)[number];
export type VoiceRichTag = (typeof VOICE_RICH_TAGS)[number];
/** 宿主复位标记，不是供应商标签；合成时按独立任务恢复自然语气。 */
export type VoiceControlTag = VoiceEmotionTag | "neutral";

export const COMPANION_VOICE_EXPRESSION_PROTOCOL_V1 = `声音表达协议：下面的语音标记是正文禁止事件标记的唯一例外。它们只控制这一句怎样说，不向用户显示，不写进历史正文，也不是工具或动作。
历史回复中的标记已由宿主剥除；历史正文没有标记不表示本轮关闭声音表达。本轮始终按这份协议重新选择表达。
每一步回复必须先写一个完整控制标记再写正文（自然语气也写 [neutral]）；表达转折时在转折处换标记。普通自然说话用 [neutral]，认真说明用 [serious]，安慰用 [empathetic]，祝贺用 [excited]，惊喜用 [amazed]，好奇用 [curious]，轻松打趣用 [mischievously]。根据当前完整语境与自己的表达意图决定。
控制标记作用到下一个控制标记。其他可用控制标记：${VOICE_EMOTION_TAGS.filter(tag => !["serious", "empathetic", "excited", "amazed", "curious", "mischievously"].includes(tag)).map(tag => `[${tag}]`).join("、")}。耳语、哭腔、大喊、讽刺等只在用户当前明确要求相应表演且适合语境时使用；保持同一个音色，不把安慰演成庆祝。
可在适合的位置、随后的短语之前插入 ${VOICE_RICH_TAGS.map(tag => `[${tag}]`).join("、")}：分别是吸气、叹息、清嗓、轻笑、大笑、咳嗽、哼声。仅在这段交流确实需要该声音时使用，不例行加笑声或叹息，不用声音责备用户，不强迫活泼。
标记必须完整使用上面的拼写，不自造 [happy] 等标记。放在语句或短语边界，不放入代码、公式、引用原文、事实占位符或工具参数。正文仍按原要求回答，不用 JSON 信封或说明这些标记。
格式示例（不是本轮事实）：[empathetic]辛苦了，能坚持到这里已经很棒了。[neutral]今晚先歇一会儿吧。
格式示例：[mischievously]这个比喻还挺贴切。[giggles]一下就记住了。[serious]接下来看看它的适用条件。`;

/** 只读标记 → 有界形象投影；这是协议映射，不对自然语言做分类。 */
export function voiceExpressionCue(tag: VoiceControlTag | VoiceRichTag | null): {
  version: 1; intent: "explain"; emotion: "neutral" | "happy" | "curious" | "concerned" | "surprised"; intensity: number;
} {
  const emotion = tag === "excited" || tag === "mischievously" || tag === "giggles" || tag === "laughing" ? "happy"
    : tag === "amazed" || tag === "gasp" ? "surprised"
    : tag === "curious" ? "curious"
    : tag === "empathetic" || tag === "sad" || tag === "crying" || tag === "trembling" || tag === "panicked" ? "concerned"
    : "neutral";
  return { version: 1, intent: "explain", emotion, intensity: emotion === "neutral" ? 0.3 : 0.6 };
}

/** 完整标记扫描，位置在输入的 UTF-16 字符区间内。neutral 只由宿主消费。 */
export function readVoiceExpressionTags(text: string): Array<{
  start: number; end: number; tag: VoiceControlTag | VoiceRichTag; kind: "control" | "rich";
}> {
  const found: ReturnType<typeof readVoiceExpressionTags> = [];
  const codeRanges = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/g)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  for (const match of text.matchAll(/\[([a-z][a-z ]{2,29})\]/gi)) {
    if (codeRanges.some(range => match.index! >= range.start && match.index! < range.end)) continue;
    const tag = match[1]!.toLowerCase();
    const kind = tag === "neutral" || (VOICE_EMOTION_TAGS as readonly string[]).includes(tag) ? "control"
      : (VOICE_RICH_TAGS as readonly string[]).includes(tag) ? "rich" : null;
    if (kind) found.push({ start: match.index!, end: match.index! + match[0].length,
      tag: tag as VoiceControlTag | VoiceRichTag, kind });
  }
  return found;
}

/** 流式半个 ASCII 标记暂不展示，完成后由白名单解析；普通中文方括号保留。 */
export function withholdPartialVoiceExpressionTag(text: string): string {
  return text.replace(/\[(?:[a-z][a-z0-9 ]{0,29})?$/i, "");
}

export function qwenSupportsVoiceExpressionTags(model: string): boolean {
  return ["qwen-audio-3.1-tts-flash", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"].includes(model);
}

/** Provider capability gate; neither unknown nor host reset tags may be read aloud. */
export function prepareQwenVoiceExpressionText(text: string, model: string): string {
  const complete = withholdPartialVoiceExpressionTag(text);
  return qwenSupportsVoiceExpressionTags(model)
    ? stripUnknownVoiceExpressionTags(complete).replace(/\[neutral\]/gi, "")
    : stripVoiceExpressionTags(complete);
}

function escapeTagRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 白名单正则：只匹配已知标签（`[excited]` 等），不误伤正文 `[重要]` 方括号。 */
const VOICE_TAG_PATTERN = new RegExp(
  `\\[(?:${[...VOICE_EMOTION_TAGS, ...VOICE_RICH_TAGS].map(escapeTagRegex).join("|")})\\]`,
  "gi",
);

/**
 * 2026-08-24（AI 设计审查 §4.2 修复）：未知标签防御。
 * 此前白名单只剥 30 个已知标签，模型自造的 `[happy]` 这类标签会原样
 * 漏进展示文本与 TTS（被当普通文字读出）。此处按"ASCII 标签形态"
 * 剥离未知标签：
 * - 负向前瞻逐项锚定 `]`（只豁免完整已知标签）——否则已知标签的变形词
 *   （[sadly]、[excitedly]、[gasps]，恰是最高发的幻觉家族）会因前缀命中
 *   已知名而逃过剥离；
 * - 形态：`[a-z]` 开头、仅含小写字母/数字/空格、内长 ≥3（排除 CEFR 级别
 *   [A1]/[B2] 这类合法短 token）；
 * - 中文正文方括号（如 `[重要]`）与单字符标记（`[b]`）不受影响。
 * 已知取舍：3 字符以上的 ASCII 缩写（[FAQ]/[TODO]）也会被剥——V4 人格已
 * 禁止模型输出任何方括号标记，此残留面可接受；如未来需要保留，应改为
 * 显式白名单而非放宽本模式。
 */
const UNKNOWN_TAG_PATTERN = new RegExp(
  `\\[(?!${[...VOICE_EMOTION_TAGS, ...VOICE_RICH_TAGS].map((t) => escapeTagRegex(t) + "\\]").join("|")})`
  + `[a-z][a-z0-9 ]{2,29}\\]`,
  "gi",
);

/** 只剥未知标签形态 token（保留已知标签——TTS 原始文本管线专用）。迭代到不动点，清除嵌套残留（如 "[excited ]"）；末轮顺带清掉剥空后的 "[]" 空壳。 */
export function stripUnknownVoiceExpressionTags(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(UNKNOWN_TAG_PATTERN, "").replace(/\[\s*\]/g, "");
    if (next === out) return out;
    out = next;
  }
}

/** 剥离全部语音标签：已知 30 个 + 未知 ASCII 标签形态（展示/入库/非 qwen 引擎合成前调用）。 */
export function stripVoiceExpressionTags(text: string): string {
  return stripUnknownVoiceExpressionTags(text.replace(VOICE_TAG_PATTERN, "").replace(/\[neutral\]/gi, ""));
}

/** 提取文本中最后一个控制类标签名（小写；无则 null）——段级 emotion 来源。 */
export function extractVoiceEmotion(text: string): string | null {
  const pattern = new RegExp(
    `\\[(${VOICE_EMOTION_TAGS.map(escapeTagRegex).join("|")})\\]`,
    "gi",
  );
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    last = match[1].toLowerCase();
  }
  return last;
}
