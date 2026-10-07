import { describe, expect, it } from "vitest";
import {
  COMPANION_BARGE_IN_INITIAL_STATE,
  COMPANION_VAD_INITIAL_STATE,
  COMPANION_VAD_TUNING,
  companionBargeInStep,
  companionVadStep,
  type CompanionVadState,
  type CompanionVadVerdict,
} from "../companion-voice-vad";

const TICK_MS = 50;

/** 按录音器 20Hz 的节拍推一组电平，记录第一次出现某个判定的时刻。 */
function run(levels: readonly number[], options?: { readonly startAt?: number; readonly threshold?: number }): {
  readonly firstAt: (verdict: CompanionVadVerdict) => number | null;
  readonly state: CompanionVadState;
  readonly verdict: CompanionVadVerdict;
} {
  let state = COMPANION_VAD_INITIAL_STATE;
  let verdict: CompanionVadVerdict = "listening";
  const marks = new Map<CompanionVadVerdict, number>();
  let at = options?.startAt ?? 0;
  for (const level of levels) {
    const step = companionVadStep(state, { level, at, threshold: options?.threshold });
    state = step.state;
    verdict = step.verdict;
    if (!marks.has(step.verdict)) marks.set(step.verdict, at);
    at += TICK_MS;
  }
  return { firstAt: (target) => marks.get(target) ?? null, state, verdict };
}

function constant(level: number, count: number): number[] {
  return Array.from({ length: count }, () => level);
}

describe("companionVadStep 两级判定", () => {
  it("没人说话时既不切段也不收尾", () => {
    const { firstAt, state } = run(constant(0.001, 200));
    expect(firstAt("cut")).toBeNull();
    expect(firstAt("end")).toBeNull();
    expect(state.turnSpeechMs).toBe(0);
  });

  /**
   * 一声咳嗽、一次碰桌子：都不该有动作。
   *
   * 旧契约只保护"不自动结束"；对话模式下这条更要紧——提前 `end` 等于把一段
   * 没有话的音频当成一轮发出去。
   */
  it("短促杂响既切不出一段，也结束不了一轮", () => {
    const { firstAt, state } = run([0.2, 0.2, ...constant(0.001, 200)]);
    expect(state.turnSpeechMs).toBeLessThan(COMPANION_VAD_TUNING.minSpeechMs);
    expect(firstAt("cut")).toBeNull();
    expect(firstAt("end")).toBeNull();
  });

  it("说够一句之后，短停顿先切段", () => {
    const speech = constant(0.3, 11); // 0..500ms
    const silence = constant(0.001, 30);
    const { firstAt } = run([...speech, ...silence]);
    // 人声在 500ms 结束，静音满 cutSilenceMs 切第一段。
    expect(firstAt("cut")).toBe(500 + COMPANION_VAD_TUNING.cutSilenceMs);
  });

  it("长停顿才判定这一轮说完", () => {
    const { firstAt } = run([...constant(0.3, 11), ...constant(0.001, 40)]);
    expect(firstAt("end")).toBe(500 + COMPANION_VAD_TUNING.turnEndSilenceMs);
  });

  /** 字幕要的是"边说边长"：切完段接着说，必须还能切下一段。 */
  it("切了一段之后继续说，还能切出下一段", () => {
    const { firstAt, state } = run([
      ...constant(0.3, 11), // 500ms 人声
      ...constant(0.001, 10), // 500ms 静音 → 切段
      ...constant(0.3, 12), // 又说了一段
      ...constant(0.001, 20),
    ]);
    expect(firstAt("cut")).toBe(500 + COMPANION_VAD_TUNING.cutSilenceMs);
    // 切段把"这一段"的人声归零，第二段要重新攒够才切得动。
    expect(state.segmentSpeechMs).toBe(0);
    expect(state.turnSpeechMs).toBe(1100);
  });

  it("一直在说就不切也不收", () => {
    const { firstAt } = run(constant(0.3, 200));
    expect(firstAt("cut")).toBeNull();
    expect(firstAt("end")).toBeNull();
  });

  it("每次开口都把两个静音计时重新推回去", () => {
    const { firstAt } = run([
      ...constant(0.3, 11), // 500ms → 武装
      ...constant(0.001, 8), // 400ms 静音，还没到 450
      ...constant(0.3, 10), // 又说了一句 → 计时从头
      ...constant(0.001, 40),
    ]);
    // 停顿被打断过一次，收尾要从最后一次人声往后数整段 turnEndSilenceMs。
    expect(firstAt("end")).toBe(500 + 400 + 500 + COMPANION_VAD_TUNING.turnEndSilenceMs);
  });

  it("认显式给的阈值与各档时长", () => {
    const belowDefault = 0.02;
    expect(run(constant(belowDefault, 80)).state.turnSpeechMs).toBe(0);

    let state: CompanionVadState = COMPANION_VAD_INITIAL_STATE;
    let cutAt: number | null = null;
    let endAt: number | null = null;
    let at = 0;
    const feed = (level: number, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const step = companionVadStep(state, { level, at, threshold: 0.01, minSpeechMs: 100, cutSilenceMs: 150, turnEndSilenceMs: 250 });
        state = step.state;
        if (step.verdict === "cut" && cutAt === null) cutAt = at;
        if (step.verdict === "end" && endAt === null) endAt = at;
        at += TICK_MS;
      }
    };
    feed(0.02, 4); // 人声到 at=150（第一拍没有增量）
    feed(0.001, 10);
    expect(cutAt).toBe(300); // 150 + 150
    expect(endAt).toBe(400); // 150 + 250
  });
});

describe("companionBargeInStep", () => {
  it("电平不够就不算插话", () => {
    let state = COMPANION_BARGE_IN_INITIAL_STATE;
    for (let at = 0; at < 1000; at += TICK_MS) {
      const step = companionBargeInStep(state, { level: 0.06, at });
      state = step.state;
      expect(step.triggered).toBe(false);
    }
  });

  /** 回声消除压不干净它自己的声音：越过一下不算，要连续够久才算"真有人插话"。 */
  it("插话要连续越阈够久才算", () => {
    const first = companionBargeInStep(COMPANION_BARGE_IN_INITIAL_STATE, { level: 0.3, at: 0 });
    expect(first.triggered).toBe(false);
    const holding = companionBargeInStep(first.state, { level: 0.3, at: 100 });
    expect(holding.triggered).toBe(false);
    const step = companionBargeInStep(holding.state, { level: 0.3, at: 200 });
    expect(step.triggered).toBe(true);
    expect(step.state.sinceAt).toBeNull();
  });

  it("断一下就从新开始数", () => {
    const first = companionBargeInStep(COMPANION_BARGE_IN_INITIAL_STATE, { level: 0.3, at: 0 });
    const broke = companionBargeInStep(first.state, { level: 0.01, at: 100 });
    expect(broke.state.sinceAt).toBeNull();
    const again = companionBargeInStep(broke.state, { level: 0.3, at: 150 });
    expect(again.state.sinceAt).toBe(150);
    expect(again.triggered).toBe(false);
  });
});
