import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  companionVoiceSegmentQueueSize, drainCompanionVoiceSegments, hasCompanionRunVoiceSegments,
  queueCompanionVoiceSegment,
} from "../companion-voice-segment-queue.ts";

const segment = (over: Record<string, unknown> = {}) => ({
  version: 2, conversationId: "c1", runId: "r1", generation: 1, segmentId: "s1", ordinal: 1,
  displayText: "刚讲完饭锅的故事", displayStart: 0, displayEnd: 8,
  synthesisTextSha256: "a".repeat(64), cue: { emotion: "neutral" }, ...over,
});

describe("伴星语音段队列", () => {
  /**
   * 2026-10-16 生产 09:10 那条主动消息：服务端下发了 2 段，客户端本机音频缓存里
   * 一个字都没有——段是 `window` 事件一发即走，唯一订阅者在气泡组件里，
   * 那一刻气泡不在场就永久丢了。队列存在的唯一理由就是让"晚到的气泡"还能补听。
   */
  it("气泡不在场时语音段留在队列里，下一次取还能拿到", () => {
    expect(queueCompanionVoiceSegment(segment({ segmentId: "queue-a1" }))).toBe(true);
    expect(queueCompanionVoiceSegment(segment({ segmentId: "queue-a2", ordinal: 2 }))).toBe(true);
    expect(companionVoiceSegmentQueueSize()).toBe(2);
    const taken = drainCompanionVoiceSegments();
    expect(taken.map(item => item.segmentId)).toEqual(["queue-a1", "queue-a2"]);
    expect(companionVoiceSegmentQueueSize()).toBe(0);
  });

  it("同一段不会被排两次，生产端因此不会多唤醒一次", () => {
    expect(queueCompanionVoiceSegment(segment({ segmentId: "queue-b1" }))).toBe(true);
    expect(queueCompanionVoiceSegment(segment({ segmentId: "queue-b1" }))).toBe(false);
    expect(drainCompanionVoiceSegments().map(item => item.segmentId)).toEqual(["queue-b1"]);
  });

  /** 残帧不入库：渲染层绝不猜"这段对应正文的哪里"。 */
  it("缺任一字段的残帧直接丢掉，不进队列也不报错", () => {
    for (const broken of [
      undefined, null, {}, { ...segment(), version: 1 },
      { ...segment(), displayStart: undefined }, { ...segment(), displayText: "" },
    ]) expect(queueCompanionVoiceSegment(broken)).toBe(false);
    expect(companionVoiceSegmentQueueSize()).toBe(0);
  });

  /** 上限是失控收敛判据，不是砍功能：跨很久不回放，那归服务端留档。 */
  it("长时间没人取时队列按声明的上限收敛，不无界攒着整段会话", () => {
    for (let run = 0; run < 20; run += 1) {
      queueCompanionVoiceSegment(segment({ runId: `queue-run-${run}`, segmentId: `queue-seg-${run}` }));
    }
    expect(companionVoiceSegmentQueueSize()).toBeLessThanOrEqual(8);
    for (let i = 0; i < 200; i += 1) {
      queueCompanionVoiceSegment(segment({ runId: "queue-overflow", segmentId: `queue-over-${i}` }));
    }
    const taken = drainCompanionVoiceSegments();
    expect(taken.filter(item => item.runId === "queue-overflow").length).toBeLessThanOrEqual(64);
    expect(companionVoiceSegmentQueueSize()).toBe(0);
  });

  /**
   * 反向对照：上限挤出去的那一轮，"已排过"的记号必须一起放手。
   * 只删段不删记号时，同一帧再到达会被认成重复而永久丢弃——就是本次根治的
   * "错过一次就永久静音"形状在队列里重演一遍。
   */
  it("被上限挤出去的那一段，重新到达时还能再排进队", () => {
    for (let run = 0; run < 8; run += 1) {
      queueCompanionVoiceSegment(segment({ runId: `queue-evict-${run}`, segmentId: `queue-evict-seg-${run}` }));
    }
    queueCompanionVoiceSegment(segment({ runId: "queue-evict-8", segmentId: "queue-evict-seg-8" }));
    expect(companionVoiceSegmentQueueSize()).toBe(8);
    expect(queueCompanionVoiceSegment(segment({ runId: "queue-evict-0", segmentId: "queue-evict-seg-0" }))).toBe(true);
    const ids = drainCompanionVoiceSegments().map(item => item.segmentId);
    expect(ids).toContain("queue-evict-seg-0");
    expect(ids).not.toContain("queue-evict-seg-1");
  });

  /**
   * 主动轮补声的判据（2026-10-16）："这一轮的声音有没有自己到场过"。
   *
   * 必须是**入过队就记住、取走后也不撤销**：拿"队列里现在还有没有"当判据时，
   * 已经念完并取走的那一轮会被当成"没到场"，补声入口就会把同一句再念一遍。
   */
  it("见过语音段的轮次记账不随取走清空，没见过的轮次才需要补声", () => {
    expect(hasCompanionRunVoiceSegments("queue-arrived")).toBe(false);
    queueCompanionVoiceSegment(segment({ runId: "queue-arrived", segmentId: "queue-arrived-seg" }));
    expect(hasCompanionRunVoiceSegments("queue-arrived")).toBe(true);
    drainCompanionVoiceSegments();
    expect(hasCompanionRunVoiceSegments("queue-arrived")).toBe(true);
    expect(hasCompanionRunVoiceSegments("queue-never")).toBe(false);
  });

  /**
   * 接线守卫：上面几条只证明队列本身算得对，证明不了生产端真的入队、
   * 气泡真的从队列取。这两头一旦有人"顺手改回"直接读事件负载，
   * 线上表现就是主动消息又只剩文字——不报错，只会安静地没声音。
   */
  it("生产端先入队、气泡从队列取，谁都不再直接读事件负载", () => {
    const producer = readFileSync(new URL("../companion-chat-session.tsx", import.meta.url), "utf8");
    const hud = readFileSync(new URL("../../components/companion/CompanionHud.tsx", import.meta.url), "utf8");
    const queue = readFileSync(new URL("../companion-voice-segment-queue.ts", import.meta.url), "utf8");
    // 生产端又变成直接 dispatch 负载，或气泡又只读事件负载 —— 两者都会让
    // "气泡不在场的那一段"永久丢；挂载不补取则晚到的气泡仍然听不到。
    expect(producer).toMatch(/queueCompanionVoiceSegment\(\{/);
    expect(producer).toMatch(/if \(queuedSegment\)[\s\S]{0,140}COMPANION_VOICE_SEGMENT_READY_EVENT/);
    expect(hud).toMatch(/drainCompanionVoiceSegments\(\)/);
    expect(hud).toMatch(/takeQueuedVoiceSegments\(\);\s*\n\s*const onVoiceSegment/);
    // 事件名只有一处定义，三个端点（实时流生产、补声生产、气泡消费）都用它。
    expect(queue).toMatch(/export const COMPANION_VOICE_SEGMENT_READY_EVENT = "astella:companion-voice-segment-ready"/);
    expect(hud).toMatch(/addEventListener\(COMPANION_VOICE_SEGMENT_READY_EVENT/);
  });

  /**
   * 主动轮"有字没声"的接线守卫（2026-10-16 真窗口实测）。
   *
   * 正文由他路（快照/历史）读回时，语音段只有实时流那一份；补声必须在**把回复交给
   * 气泡之前**完成——气泡拿到回复就会喂段并封队，晚到的段只会被丢掉。
   * 顺序写反了不会报错，只会让那一句又变成有字没声。
   */
  it("主动轮的留档补声排在把回复交给气泡之前，两处都有", () => {
    const producer = readFileSync(new URL("../companion-chat-session.tsx", import.meta.url), "utf8");
    const ordered = producer.match(/redriveCompanionRunVoice\(delivery\.runId\)[\s\S]{0,320}setCurrentLiveReply\(\{/g) ?? [];
    expect(ordered.length).toBe(2);
  });

  /**
   * 气泡按"这条回复自己的轮次"筛段：主动开口没有草稿，`draftRunIdRef` 还停在上一条
   * 用户消息上——用它筛会把刚补回来的段全部跳过，又变回有字没声。
   */
  it("气泡筛段用的是回复自己的 runId，不是上一拍草稿的轮次", () => {
    const hud = readFileSync(new URL("../../components/companion/CompanionHud.tsx", import.meta.url), "utf8");
    expect(hud).toMatch(/const runId = reply\.runId \?\? draftRunIdRef\.current;/);
  });
});
