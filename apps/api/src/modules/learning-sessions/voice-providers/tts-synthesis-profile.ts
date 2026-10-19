import { qwenDialectForInstruction, qwenVoiceForInstruction } from '@astella/shared/tts-voice-catalog';
import type { TtsEngineConfig } from './tts-config.ts';
import type { ResolvedTtsSelection } from './tts-preference.ts';

/** 预热、整段与直接流式共用同一套音色和表达参数，缓存命中与否不能改变声音偏好。 */
export function resolveTtsSynthesisProfile(
  cfg: TtsEngineConfig,
  selection?: ResolvedTtsSelection,
  currentInstruction?: string | null,
) {
  const engine = selection?.engine ?? cfg.engine;
  const preferredQwenVoice = selection?.qwenVoice ?? cfg.qwen.voice;
  const baseInstruction = selection?.qwenInstruction?.trim() || cfg.qwen.instruction?.trim() || '';
  const turnInstruction = currentInstruction?.trim() || '';
  const turnDialect = qwenDialectForInstruction(turnInstruction);
  // 本轮明确改为普通话时，即使偏好写入失败，也不能继续沿用旧方言。
  const turnRequestsStandardMandarin = /(?:使用|请用|改用)标准普通话/u.test(turnInstruction);
  const requestedDialect = turnDialect ?? (turnRequestsStandardMandarin
    ? null
    : selection?.qwenDialect ?? qwenDialectForInstruction(baseInstruction));
  // 点名方言时保留官方短指令，不用通用音色描述稀释它；仅在没有本轮方言覆盖时
  // 才保留用户显式保存的音色/语速描述。普通场景表达则叠加到稳定的基础音色上。
  const baseSceneInstructions = selection?.qwenInstructionExplicit && !turnDialect
    ? baseInstruction.split(/[，,。；;]+/u).map(part => part.trim())
      .filter(part => part && !qwenDialectForInstruction(part))
    : [];
  const turnSceneInstructions = turnInstruction.split(/[，,。；;]+/u)
    .map(part => part.trim()).filter(part => part && !qwenDialectForInstruction(part));
  const dialectSceneInstruction = [...baseSceneInstructions, ...turnSceneInstructions].join('，');
  const instruction = requestedDialect
    ? `请用${requestedDialect}表达。${dialectSceneInstruction}`
    : turnInstruction && baseInstruction
      ? `保持基础音色：${baseInstruction}。本轮表达要求：${turnInstruction}`
      : turnInstruction || baseInstruction;
  const qwenVoice = qwenVoiceForInstruction(
    preferredQwenVoice, engine === 'qwen' ? instruction : null, cfg.qwen.model,
  );
  return {
    engine,
    qwenVoice,
    instruction,
    instructionSource: requestedDialect
      ? dialectSceneInstruction ? 'dialect+scene' : 'dialect-only'
      : turnInstruction
        ? (selection?.qwenInstructionExplicit ? 'turn+preference' : baseInstruction ? 'turn+config' : 'turn')
        : selection?.qwenInstructionExplicit ? 'preference' : baseInstruction ? 'config' : 'none',
    voiceOverriddenForDialect: qwenVoice !== preferredQwenVoice,
  };
}
