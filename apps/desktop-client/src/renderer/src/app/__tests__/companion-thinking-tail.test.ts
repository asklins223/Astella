import { describe, expect, it } from "vitest";
import {
  appendCompanionThinking,
  companionThinkingPending,
  companionThinkingText,
  revealCompanionThinking,
  COMPANION_THINKING_TAIL_CHARS,
  type CompanionThinkingView,
} from "../companion-session/companion-thinking-tail";

/** 收一块（画是心跳的事），与界面拿到事件后做的事一致。 */
const receive = (index: number, text: string, current: CompanionThinkingView | null = null, runId = "run-1") =>
  appendCompanionThinking(current, runId, index, text);

const revealAll = (view: CompanionThinkingView) => {
  let state = view;
  for (let tick = 0; tick < 200; tick++) state = revealCompanionThinking(state);
  return state;
};

describe("思考窗口的收", () => {
  it("按序号续接，露完就是收到的那一段", () => {
    const state = revealAll(receive(1, "然后想到后半段。", receive(0, "她先想了前半段。")));
    expect(companionThinkingText(state)).toBe("她先想了前半段。然后想到后半段。");
    expect(companionThinkingPending(state)).toBe(false);
  });

  it("重放的同一块不重复贴，缺块时从这一块重新起头", () => {
    const first = revealAll(receive(0, "第一段思考"));
    expect(companionThinkingText(receive(0, "第一段思考", first))).toBe("第一段思考");
    const afterGap = receive(4, "第五块", first);
    expect(afterGap.pending).toBe("第五块");
    // 缺块时正在露的那一段也一起丢：留着它拼上新块，屏幕上就是一句没连续想过的话。
    expect(afterGap.shown).toBe("");
    expect(afterGap.nextIndex).toBe(5);
  });

  it("换一轮就清空：上一轮想过的字不留在这一轮的气泡里", () => {
    const previous = revealAll(receive(0, "上一轮还剩个尾巴"));
    const next = receive(0, "这一轮从头开始", previous, "run-2");
    expect(companionThinkingText(next)).toBe("");
    expect(next.nextIndex).toBe(1);
  });

  it("空增量与已经关不掉的重复都不产生新状态", () => {
    const empty = receive(0, "");
    expect(companionThinkingPending(empty)).toBe(false);
    expect(revealCompanionThinking(empty)).toBe(empty);
  });
});

describe("思考窗口的露", () => {
  it("每步搬积压的四分之一，所以一块 300 字是铺出来的不是糊上来的", () => {
    let state = receive(0, "想".repeat(300));
    const steps: number[] = [];
    for (let tick = 0; tick < 4; tick++) {
      state = revealCompanionThinking(state);
      steps.push(companionThinkingText(state).length);
    }
    expect(steps).toEqual([75, 132, 174, 206]);
    expect(companionThinkingPending(state)).toBe(true);
  });

  it("窗口裁头时正在露的那一行不会变空", () => {
    let state = revealAll(receive(0, "甲".repeat(100)));
    expect(companionThinkingText(state)).toBe("甲".repeat(100));
    // 再来一大块：显示区被顶到上限并裁掉最早的甲，但每一拍都有字可看。
    state = receive(1, "乙".repeat(COMPANION_THINKING_TAIL_CHARS * 2), state);
    for (let tick = 0; tick < 20; tick++) {
      state = revealCompanionThinking(state);
      expect(companionThinkingText(state).length).toBeGreaterThan(0);
    }
    expect(companionThinkingText(state).length).toBeLessThanOrEqual(COMPANION_THINKING_TAIL_CHARS);
  });
});

describe("平滑不许拖慢上游（用户明确的要求）", () => {
  it("按实测最快速率连灌 20 秒，积压始终不超过一屏，收流后一秒内见底", () => {
    // 400 字/拍 = 每秒 8,000 字：比这两次真窗口实测的思考速率（约 200–600 字/秒）
    // 高一个量级，用来证明"按比例追"不是固定速度。
    let state = receive(0, "想".repeat(400));
    let maxPending = state.pending.length;
    for (let tick = 1; tick < 400; tick++) {
      state = revealCompanionThinking(receive(tick, "想".repeat(400), state));
      maxPending = Math.max(maxPending, state.pending.length);
    }
    expect(maxPending).toBeLessThanOrEqual(COMPANION_THINKING_TAIL_CHARS);
    // 停止下发之后，最多 25 拍（1.25 秒）就追平，不会留一屏欠账一直滚。
    let ticks = 0;
    while (companionThinkingPending(state) && ticks < 40) {
      state = revealCompanionThinking(state);
      ticks += 1;
    }
    expect(ticks).toBeLessThanOrEqual(25);
    expect(companionThinkingText(state)).toBe("想".repeat(COMPANION_THINKING_TAIL_CHARS));
  });

  it("一次涌进两万字也只露看得见的尾部：中段永远滚不进窗口，不拿它垫后", () => {
    let state = receive(0, "丙".repeat(20_000));
    expect(state.pending.length).toBe(COMPANION_THINKING_TAIL_CHARS);
    state = revealAll(state);
    expect(companionThinkingText(state)).toBe("丙".repeat(COMPANION_THINKING_TAIL_CHARS));
  });
});
