/**
 * TTS 音色目录（设置 → 语音与伴星 的唯一数据源）。
 *
 * 为什么放在 shared：这三处必须读同一份名单，任何一处自定都会漂移——
 *   1. 服务端校验用户偏好与试听请求（音色值直接进上游计费接口，不能由前端自由传）；
 *   2. 设置界面画可选项；
 *   3. 合成链路把偏好翻成 provider 参数。
 *
 * 音色的「声线特质 / 适用场景 / 试听语种」原文取自阿里百炼《Qwen-Audio-TTS 音色列表》，
 * 不自行形容音质：我们对音色的判断只有官方那一条，猜出来的描述会误导选择。
 * 名字里的 `_v3.1` 后缀是模型版本号，**不能**与 `qwen-audio-3.0-tts-flash` 混用
 * （混用时上游只回 `[cosyvoice:]Engine error [411]`，不说是音色不对）。
 */

import { z } from "zod";

/** 试听录音所在目录（相对渲染进程根，与 live2d 用同一套引用姿势）。 */
export const TTS_PREVIEW_ASSET_DIR = "assets/companion/voice-preview-v1";

/** 两条引擎取值；界面选项与服务端校验都从这一行派生。 */
export const TTS_ENGINE_VALUES = ["qwen", "edge"] as const;
export type TtsEngineV1 = (typeof TTS_ENGINE_VALUES)[number];

/** Qwen-Audio-3.1-TTS-Flash cloned-voice dialects documented by Alibaba Cloud. */
export const QWEN_TTS_SUPPORTED_DIALECTS = [
  "广东话",
  "重庆话",
  "东北话",
  "甘肃话",
  "贵州话",
  "浙江话",
  "河北话",
  "河南话",
  "湖北话",
  "湖南话",
  "江西话",
  "宁波话",
  "宁夏话",
  "青岛话",
  "陕西话",
  "山西话",
  "山东话",
  "上海话",
  "四川话",
  "云南话",
] as const;

/** Account-level explicit preference key. Kept separate from the user's voice-tone instruction. */
export const QWEN_TTS_DIALECT_PREFERENCE_KEY = "tts_dialect" as const;

/**
 * 「这一轮回普通话」的规范措辞。合成侧认它（也认模型/分类器写的近义写法），
 * worker 在文案工作轮拿它压过账号里存的长期方言，分类器在 clear 那一支也写它——
 * 措辞只有一份，两边才不会各说各话。
 */
export const QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION = "使用标准普通话" as const;

/** Qwen-Audio-3.1-TTS-Flash system voices list these eight dialects natively. */
export const QWEN_TTS_SYSTEM_DIALECTS = [
  "上海话", "广东话", "东北话", "重庆话", "陕西话", "云南话", "宁波话", "甘肃话",
] as const;

/**
 * 会说方言的系统女声。官方按音色列了各自支持的方言，没列到的方言统一走「龙安欢」——
 * 2026-10-13 用户真听对照：项目那条**普通话样本**复刻出来的女声，接方言指令只改节奏
 * 不改口音（"不是方言的声音"），而龙安欢念河南话被判定为像。所以方言轮不再用复刻角色，
 * 也不为了方言再去复刻新嗓子；代价是方言轮与普通话轮不是同一个音色，这是实测换来的。
 */
export const QWEN_TTS_GENERAL_DIALECT_VOICE = "longanhuan_v3.1";

export const QWEN_TTS_DIALECT_VOICE_BY_DIALECT: Partial<Record<(typeof QWEN_TTS_SUPPORTED_DIALECTS)[number], string>> = {
  "上海话": "longanlingxin_v3.1",
  "广东话": "longanhuan_v3.1",
  "东北话": "longanfengyue_v3.1",
  "重庆话": "longanhuan_v3.1",
  "陕西话": "longanlingxin_v3.1",
  "云南话": "longanlingxin_v3.1",
  "宁波话": "longanhuan_v3.1",
  "甘肃话": "longanhuan_v3.1",
};

const QWEN_TTS_SPEECH_ACTION = /(?:用|说|讲|表达|念|读|听|朗读|切换到|换成|改成|换|来一段|来点)/u;
const QWEN_TTS_DIALECT_NEGATION = /(?:不要|别|不想|不愿意|不能|避免|不再|不用|不需要)(?:(?:再|继续)?(?:用|说|讲|表达|念|读|听|使用|采用|切换到|换成))?\s*$/u;

const QWEN_TTS_DIALECT_ALIASES: ReadonlyArray<readonly [string, (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number]]> = [
  ["广东方言", "广东话"], ["广东话", "广东话"], ["粤语", "广东话"], ["粤方言", "广东话"],
  ["重庆方言", "重庆话"], ["重庆话", "重庆话"], ["渝语", "重庆话"],
  ["东北方言", "东北话"], ["东北话", "东北话"], ["东北口音", "东北话"], ["东北腔", "东北话"],
  ["甘肃方言", "甘肃话"], ["甘肃话", "甘肃话"],
  ["贵州方言", "贵州话"], ["贵州话", "贵州话"],
  ["浙江方言", "浙江话"], ["浙江话", "浙江话"],
  ["河北方言", "河北话"], ["河北话", "河北话"],
  ["河南方言", "河南话"], ["河南话", "河南话"],
  ["湖北方言", "湖北话"], ["湖北话", "湖北话"],
  ["湖南方言", "湖南话"], ["湖南话", "湖南话"],
  ["江西方言", "江西话"], ["江西话", "江西话"],
  ["宁波方言", "宁波话"], ["宁波话", "宁波话"],
  ["宁夏方言", "宁夏话"], ["宁夏话", "宁夏话"],
  ["青岛方言", "青岛话"], ["青岛话", "青岛话"],
  ["陕西方言", "陕西话"], ["陕西话", "陕西话"], ["陕话", "陕西话"],
  ["山西方言", "山西话"], ["山西话", "山西话"],
  ["山东方言", "山东话"], ["山东话", "山东话"], ["齐鲁话", "山东话"],
  ["上海方言", "上海话"], ["上海话", "上海话"], ["沪语", "上海话"],
  ["四川方言", "四川话"], ["四川话", "四川话"], ["川话", "四川话"], ["四川口音", "四川话"],
  ["云南方言", "云南话"], ["云南话", "云南话"],
];

function findQwenDialectMention(request: string): { alias: string; dialect: (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number]; index: number } | null {
  let found: { alias: string; dialect: (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number]; index: number } | null = null;
  for (const [alias, dialect] of QWEN_TTS_DIALECT_ALIASES) {
    const index = request.indexOf(alias);
    if (index < 0) continue;
    if (!found || index < found.index || (index === found.index && alias.length > found.alias.length)) {
      found = { alias, dialect, index };
    }
  }
  return found;
}

/** Normalize an explicitly named dialect in a user or model voice instruction. */
export function qwenDialectForInstruction(
  instruction: string | null | undefined,
): (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number] | null {
  const request = instruction?.trim();
  if (!request) return null;
  const requested = findQwenDialectMention(request);
  if (!requested) return null;
  const { dialect, index } = requested;
  const beforeDialect = request.slice(0, index).slice(-16);
  // Negative requests should not switch dialects; allow continuation phrases such as
  // “不要忘了用河南话” by requiring the negation to sit directly before the speech verb.
  if (/(?:不要|别|不想|不愿意|不能|避免|不再)(?:再|继续)?(?:用|说|讲|听|使用|采用|表达|切换到|换成)\s*$/u.test(beforeDialect)) return null;
  return dialect;
}

/** A dialect mentioned by the user counts as a voice request only when tied to a speech action. */
export function qwenDialectRequestedByUser(
  request: string | null | undefined,
): (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number] | null {
  const text = request?.trim();
  const dialect = qwenDialectForInstruction(text);
  if (!text || !dialect) return null;
  const requested = findQwenDialectMention(text);
  if (!requested) return null;
  const before = text.slice(Math.max(0, requested.index - 24), requested.index);
  const after = text.slice(requested.index + requested.alias.length, requested.index + requested.alias.length + 24);
  const negatedBefore = QWEN_TTS_DIALECT_NEGATION.test(before);
  const negatedAfter = /^[，,：:\s]*(?:(?:不过|但是|只是)[，,：:\s]*)?(?:不要|别|不想|不愿意|不能|避免|不再|不用|不需要)(?:(?:再|继续)?(?:用|说|讲|表达|念|读|听|使用|采用|切换到|换成)|(?=$|[，,。；;！？!?\n]))/u.test(after);
  if (negatedBefore || negatedAfter) return null;

  // Both Chinese word orders are common: “用河南话讲……” and “河南话讲……”.
  // Keep the action close to the dialect mention so a regional topic alone does not
  // silently switch the companion's voice.
  const speechActionBefore = new RegExp(`${QWEN_TTS_SPEECH_ACTION.source}[^，,。；;！？!?\\n]{0,10}$`, "u").test(before);
  const speechActionAfter = /^[，,：:\s]*(?:(?:能不能|可不可以|可以|想|要|我|你|给我|帮我|再|就|来)[，,：:\s]*)?(?:用|说|讲|表达|念|读|听|朗读|切换到|换成|改成|换|来一段|来点)/u.test(after);
  return speechActionBefore || speechActionAfter ? dialect : null;
}

/** 引擎的 zod 取值：偏好合同、IPC 入参、试听请求共用这一个枚举实例（枚举写两遍会各说各话）。 */
export const ttsEngineV1Schema = z.enum(TTS_ENGINE_VALUES);

export interface TtsVoiceOptionV1 {
  /** 引擎；同一份列表里两类引擎的音色互不相干。 */
  engine: TtsEngineV1;
  /** 进上游 `voice` 参数的值，也是持久化到偏好里的值。 */
  voice: string;
  /** 界面上显示的名字。 */
  name: string;
  /** 一行补充说明（官方声线特质，或试听语种）；空串表示官方没给。 */
  note: string;
  /** 方言能力按阿里当前音色列表记载；缺省表示该音色未列为方言音色。 */
  supportedDialects?: readonly (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number][];
  /**
   * 试听音频：渲染进程本地资产，不在用户点下去的时候现合成。
   *
   * 每段试听都是一次真金白银的上游调用，而"挑声音"这件事天然要把同一句话听好几遍，
   * 所以这里直接发同一句的录音。它按当前 config 的 model + voice + instruction 生成
   * （见目录里的 PROVENANCE.md）：这三样任何一个改了，这批录音就过期，要重新生成。
   */
  previewAsset: string;
}

/** 千问可选音色。第一条是默认值，改这一条要同步改 config `tts.qwen.voice`。 */
export const QWEN_TTS_VOICE_OPTIONS: readonly TtsVoiceOptionV1[] = [
  {
    engine: "qwen",
    voice: "longhua_v3.1",
    name: "龙华",
    note: "元气甜美女 · 社交陪伴",
    previewAsset: `${TTS_PREVIEW_ASSET_DIR}/longhua_v3.1.mp3`,
  },
  {
    engine: "qwen",
    voice: "longanlingxi_v3.1",
    name: "龙安灵希",
    note: "可爱甜美音 · 社交陪伴（未列入方言音色）",
    previewAsset: `${TTS_PREVIEW_ASSET_DIR}/longanlingxi_v3.1.mp3`,
  },
  {
    engine: "qwen",
    voice: "longanhuan_v3.1",
    name: "龙安欢",
    note: "方言音色 · 官方列上海、广东、东北、重庆、陕西、云南、宁波、甘肃话；其余方言也由她说",
    supportedDialects: QWEN_TTS_SYSTEM_DIALECTS,
    previewAsset: `${TTS_PREVIEW_ASSET_DIR}/longanhuan_v3.1.mp3`,
  },
] as const;

/** edge-tts 固定一条：这条链路本来只是千问不可用时的退路，不打算给它做音色菜单。 */
export const EDGE_TTS_VOICE_OPTIONS: readonly TtsVoiceOptionV1[] = [
  {
    engine: "edge",
    voice: "zh-CN-XiaoxiaoNeural",
    name: "晓晓",
    note: "",
    previewAsset: `${TTS_PREVIEW_ASSET_DIR}/zh-CN-XiaoxiaoNeural.mp3`,
  },
] as const;

export const DEFAULT_TTS_ENGINE: TtsEngineV1 = QWEN_TTS_VOICE_OPTIONS[0].engine;
export const DEFAULT_TTS_VOICE = QWEN_TTS_VOICE_OPTIONS[0].voice;

/** 某引擎的默认音色 = 该引擎列表的第一条（顺序即优先级，不再另设常量）。 */
export function defaultTtsVoiceFor(engine: TtsEngineV1): string {
  return ttsVoiceOptionsFor(engine)[0].voice;
}

/** 试听句：固定写在这里，界面与服务端读同一句，才存在"听到的就是这段文字"这件事。 */
export const TTS_PREVIEW_TEXT = "你好呀，我是伴星。今天想一起学点什么？我在这儿陪你慢慢来。";

export function ttsVoiceOptionsFor(engine: TtsEngineV1): readonly TtsVoiceOptionV1[] {
  return engine === "qwen" ? QWEN_TTS_VOICE_OPTIONS : EDGE_TTS_VOICE_OPTIONS;
}

/**
 * 某引擎下可用的 voice 白名单。
 *
 * 只认这一份：试听与偏好写入都走它，越界的值一律拒。`voice` 会直接进上游的计费
 * 接口，放一个前端可任意填写的字符串过去，等于把这条链路开成付费代理。
 */
export function isTtsVoiceAllowed(engine: TtsEngineV1, voice: string): boolean {
  return ttsVoiceOptionsFor(engine).some((option) => option.voice === voice);
}

export function findTtsVoiceOption(engine: TtsEngineV1, voice: string): TtsVoiceOptionV1 | null {
  return ttsVoiceOptionsFor(engine).find((option) => option.voice === voice) ?? null;
}

/** 点名方言时换成会说该方言的系统女声；没点名就还是账号里那一身。 */
export function qwenVoiceForInstruction(
  preferredVoice: string,
  instruction: string | null | undefined,
  model = "qwen-audio-3.1-tts-flash",
): string {
  if (model !== "qwen-audio-3.1-tts-flash") return preferredVoice;
  const request = instruction?.trim();
  if (!request) return preferredVoice;
  const dialect = qwenDialectForInstruction(request);
  if (!dialect) return preferredVoice;
  return QWEN_TTS_DIALECT_VOICE_BY_DIALECT[dialect] ?? QWEN_TTS_GENERAL_DIALECT_VOICE;
}

/** Account-level speaking-style shortcuts shown before the custom instruction field. */
export const TTS_VOICE_STYLE_PRESETS = [
  {
    id: "natural",
    label: "系统默认",
    description: "使用系统配置的默认女声描述。",
    instruction: null,
  },
  {
    id: "gentle",
    label: "温柔舒缓",
    description: "中音偏柔、音色圆润；语速偏慢，语气温柔平和。",
    instruction: "青年女性，中音偏柔、音色圆润；语速偏慢、停顿自然，情感温柔平和，适合学习陪伴。",
  },
  {
    id: "bright",
    label: "明亮轻快",
    description: "中音偏亮、音色清脆；语速轻快，亲切活泼不过度夸张。",
    instruction: "青年女性，中音偏亮、音色清脆；语速轻快、语调自然上扬，情感亲切活泼，适合日常对话。",
  },
  {
    id: "storytelling",
    label: "故事讲述",
    description: "音色温润；语速从容，语调起伏自然，适合故事朗读。",
    instruction: "青年女性，中音、音色温润；语速从容、语调起伏自然，情感温柔知性，适合故事朗读。",
  },
] as const;
