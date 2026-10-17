/**
 * 伴星语音对话的轮次判定（2026-10-07 改成两级）。
 *
 * 交互从「点一句、识别一句、再点发送」变成**常驻对话**：说完一句直接发给伴星。
 * 判定因此要同时给两个信号：
 *
 * - `cut`——短停顿，把已经说出的这一段切出去识别。字幕就这样一段段长出来，
 *   用户不用等整句解完才看见自己在说什么。切完人声继续累计归零，接着说就接着切。
 * - `end`——长停顿，这一轮真的说完了。调用方把在途的几段解完、拼起来，直接发送。
 *
 * 两个门槛都必须**先有足够人声**才武装：`minSpeechMs` 挡住的是咳嗽、椅子响、
 * 键盘声——一声杂响既不该切出一段空白识别，更不该把一轮"说完"判出去
 * （那样连静音都没录进去，界面会凭空发一条空消息）。
 *
 * 纯函数，节拍由 `CompanionVoiceRecorder` 的帧回调驱动，便于单测。
 */

export interface CompanionVadState {
  /** 当前这一段累计的人声时长；`cut` 之后归零，重新数下一段。 */
  readonly segmentSpeechMs: number;
  /** 这一轮累计的人声时长；`end` 的门槛看它，不被切段打断。 */
  readonly turnSpeechMs: number;
  /** 上一次步进的时间，用来算这一拍的增量。 */
  readonly lastStepAt: number | null;
  /** 最近一次越过阈值的时间；两个静音计时都从这里开始。 */
  readonly lastVoiceAt: number | null;
}

export const COMPANION_VAD_INITIAL_STATE: CompanionVadState = Object.freeze({
  segmentSpeechMs: 0,
  turnSpeechMs: 0,
  lastStepAt: null,
  lastVoiceAt: null,
});

export const COMPANION_VAD_TUNING = Object.freeze({
  /** 判定"在说话"的振幅阈值，与录音器的 RMS 同一量纲（0..1）。 */
  threshold: 0.045,
  /** 人声累计到这么久，切段与收尾才武装。 */
  minSpeechMs: 250,
  /** 连续静音这么久切一段去识别（字幕推进的节奏）。 */
  cutSilenceMs: 450,
  /** 连续静音这么久判定这一轮说完。 */
  turnEndSilenceMs: 1400,
});

export type CompanionVadVerdict = "listening" | "cut" | "end";

export interface CompanionVadInput {
  readonly level: number;
  readonly at: number;
  readonly threshold?: number;
  readonly minSpeechMs?: number;
  readonly cutSilenceMs?: number;
  readonly turnEndSilenceMs?: number;
}

export interface CompanionVadStep {
  readonly state: CompanionVadState;
  readonly verdict: CompanionVadVerdict;
}

export function companionVadStep(state: CompanionVadState, input: CompanionVadInput): CompanionVadStep {
  const threshold = input.threshold ?? COMPANION_VAD_TUNING.threshold;
  const minSpeechMs = input.minSpeechMs ?? COMPANION_VAD_TUNING.minSpeechMs;
  const cutSilenceMs = input.cutSilenceMs ?? COMPANION_VAD_TUNING.cutSilenceMs;
  const turnEndSilenceMs = input.turnEndSilenceMs ?? COMPANION_VAD_TUNING.turnEndSilenceMs;

  const delta = state.lastStepAt === null ? 0 : Math.max(0, input.at - state.lastStepAt);
  const voiced = input.level >= threshold;
  const next: CompanionVadState = {
    segmentSpeechMs: voiced ? state.segmentSpeechMs + delta : state.segmentSpeechMs,
    turnSpeechMs: voiced ? state.turnSpeechMs + delta : state.turnSpeechMs,
    lastStepAt: input.at,
    lastVoiceAt: voiced ? input.at : state.lastVoiceAt,
  };

  if (next.lastVoiceAt === null) return { state: next, verdict: "listening" };
  const silenceMs = input.at - next.lastVoiceAt;
  // 先判收尾：一次足够长的静音同时满足两个门槛时，这一轮已经结束了，
  // 再切一段去识别就是把同一句话解两遍。
  if (next.turnSpeechMs >= minSpeechMs && silenceMs >= turnEndSilenceMs) {
    return { state: next, verdict: "end" };
  }
  if (next.segmentSpeechMs >= minSpeechMs && silenceMs >= cutSilenceMs) {
    // 切段只归零"这一段"的人声；整轮的累计留着，下一段接着说仍然算这一轮。
    return { state: { ...next, segmentSpeechMs: 0 }, verdict: "cut" };
  }
  return { state: next, verdict: "listening" };
}
