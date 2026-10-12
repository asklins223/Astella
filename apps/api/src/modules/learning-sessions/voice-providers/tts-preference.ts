/**
 * 「她这次用哪个引擎、哪个音色」的唯一判定处。
 *
 * 三个读方必须给出同一个答案，否则设置里显示的和实际听到的会分叉：
 *   1. GET /me/companion/voice-preference —— 设置界面画哪个选中；
 *   2. /voice/tts 两条合成分支 —— 真正进上游的参数；
 * 试听不在这里：它是渲染进程里的本地录音，不打上游，也不读偏好。
 * 所以这里做成纯函数：偏好（库里可能残缺、可能是已被下架的音色）与 config 默认
 * 都在这一处合流，调用方不再各自补默认值。
 */

import {
  isTtsVoiceAllowed,
  TTS_ENGINE_VALUES,
  type TtsEngineV1,
} from "@astella/shared/tts-voice-catalog";
import { VOICE_STYLE_INSTRUCTION_MAX_UNITS, voiceStyleInstructionUnits } from "@astella/shared/voice-expression-tags";
import type { TtsEngineConfig } from "./tts-config.ts";

/** 库里存的原样（未校验）；两键都缺 = 用户没设过。 */
export interface StoredVoicePreference {
  engine?: unknown;
  voice?: unknown;
  /** 用户自写的说话风格（qwen instruction 兜底）；未设/非法 = 用 config 默认。 */
  instruction?: unknown;
}

export interface ResolvedTtsSelection {
  engine: TtsEngineV1;
  /** 仅当 engine === "qwen" 有意义。 */
  qwenVoice: string;
  /** edge 固定一条音色，取 config（与目录那条同源，见测试）。 */
  edgeVoice: string;
  /**
   * 用户偏好的说话风格（qwen instruction 的**兜底层**）。伴星段每轮模型自写的
   * 指令优先于它（见 synthesizeTtsBytes 的解析顺序），此处只负责"偏好合不合法、
   * 不合法退回 config"。edge 引擎不消费它。
   */
  qwenInstruction: string;
  /** 是否是用户显式保存过的选择；false 表示这一身是 config 默认给的。 */
  explicit: boolean;
}

function normalizeStored(stored: StoredVoicePreference | null): {
  engine: TtsEngineV1 | null;
  voice: string | null;
} {
  const engine = typeof stored?.engine === "string" && (TTS_ENGINE_VALUES as readonly string[]).includes(stored.engine)
    ? (stored.engine as TtsEngineV1)
    : null;
  const voice = typeof stored?.voice === "string" && stored.voice.length > 0 ? stored.voice : null;
  return { engine, voice };
}

/** instruction 独立于 engine/voice 校验：它是另一个维度的偏好，坏一条不该拖垮整身。 */
function normalizeStoredInstruction(stored: StoredVoicePreference | null, fallback: string): string {
  const raw = stored?.instruction;
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  // 库里的存量值可能超限（合同改过、或早先没校验）：整体退回默认，不截断。
  if (voiceStyleInstructionUnits(trimmed) > VOICE_STYLE_INSTRUCTION_MAX_UNITS) return fallback;
  return trimmed;
}

/**
 * 偏好 → 实际选用。
 *
 * 任一环节对不上就整体退回 config 默认并把 explicit 记成 false：半个偏好生效
 * （引擎是用户的、音色是配置的）会让人在设置里看不出自己到底设成了什么，
 * 不如老实回默认并标明"这不是你选的"。
 */
export function resolveTtsSelection(
  stored: StoredVoicePreference | null,
  cfg: TtsEngineConfig,
): ResolvedTtsSelection {
  const qwenInstruction = normalizeStoredInstruction(stored, cfg.qwen.instruction);
  const fallback: ResolvedTtsSelection = {
    engine: cfg.engine,
    qwenVoice: cfg.qwen.voice,
    edgeVoice: cfg.edge.voice,
    qwenInstruction,
    explicit: false,
  };
  const { engine, voice } = normalizeStored(stored);
  if (!engine || !voice) return fallback;
  if (!isTtsVoiceAllowed(engine, voice)) return fallback;
  return { engine, qwenVoice: voice, edgeVoice: cfg.edge.voice, qwenInstruction, explicit: true };
}
