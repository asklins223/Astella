import { beforeEach, describe, expect, it } from "vitest";
import {
  redriveCompanionRunVoice,
  resetCompanionRunVoiceRedrive,
} from "../companion-run-voice-redrive.ts";

/**
 * 真窗口实测（装机版生产包 + 本地栈）：开机后她主动开口那一句，气泡有字、**没有声音**，
 * 而客户端一次合成请求都没发过。原因是正文由"认领投递 + 快照/历史"读回来，
 * 而语音段只有实时流那一条路（`after=0` 早已被判 CURSOR_EXPIRED）。
 * 这个模块就是补那一条：没到场过的轮次去留档取一次段，排进队列交给既有播放链。
 */
const segment = (over: Record<string, unknown> = {}) => ({
  ordinal: 1,
  segmentId: "a".repeat(64),
  displayText: "来了，晚上好。",
  displayStart: 0,
  displayEnd: 7,
  cue: { emotion: "neutral" },
  ...over,
});

const result = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  runId: "run-redrive",
  conversationId: "conv-redrive",
  generation: 5,
  items: [segment()],
  ...over,
});

describe("主动轮留档补声", () => {
  beforeEach(() => resetCompanionRunVoiceRedrive());

  it("没在实时流里到场过的轮次：取留档、按同一份身份入队、唤醒气泡", async () => {
    const queued: unknown[] = [];
    let announced = 0;
    const ok = await redriveCompanionRunVoice("run-redrive", {
      alreadyArrived: () => false,
      listSegments: async () => result(),
      enqueue: (detail) => { queued.push(detail); return true; },
      announce: () => { announced += 1; },
    });
    expect(ok).toBe(true);
    expect(announced).toBe(1);
    expect(queued).toEqual([expect.objectContaining({
      version: 2, conversationId: "conv-redrive", runId: "run-redrive", generation: 5,
      segmentId: "a".repeat(64), ordinal: 1, displayText: "来了，晚上好。", displayStart: 0, displayEnd: 7,
    })]);
  });

  /** 反向：已经在流里念过的那一轮，补一次就等于同一句念两遍。 */
  it("已经在流里到场过的轮次直接跳过，不打服务端也不唤醒", async () => {
    let listed = 0;
    const queued: unknown[] = [];
    const ok = await redriveCompanionRunVoice("run-redrive", {
      alreadyArrived: () => true,
      listSegments: async () => { listed += 1; return result(); },
      enqueue: (detail) => { queued.push(detail); return true; },
      announce: () => { throw new Error("不该唤醒"); },
    });
    expect(ok).toBe(false);
    expect(listed).toBe(0);
    expect(queued).toEqual([]);
  });

  it("留档为空（事件过了 TTL）时如实返回没补到，不抛错", async () => {
    let announced = 0;
    for (const empty of [result({ items: [] }), result({ generation: null, conversationId: null, items: [] })]) {
      const ok = await redriveCompanionRunVoice("run-redrive", {
        alreadyArrived: () => false,
        listSegments: async () => empty,
        enqueue: () => true,
        announce: () => { announced += 1; },
      });
      expect(ok).toBe(false);
    }
    expect(announced).toBe(0);
  });

  it("通道异常只当没补到：不抛，也不影响文字与操作", async () => {
    await expect(redriveCompanionRunVoice("run-redrive", {
      alreadyArrived: () => false,
      listSegments: async () => { throw new Error("语音留档通道还没准备好"); },
      enqueue: () => true,
      announce: () => { throw new Error("不该唤醒"); },
    })).resolves.toBe(false);
  });

  /** 认领与历史读回可能同拍要走同一条补声；并发的两次只该打一次服务端。 */
  it("同一轮只问服务端一次", async () => {
    let listed = 0;
    const listSegments = async () => { listed += 1; return result(); };
    const deps = { alreadyArrived: () => false, listSegments, enqueue: () => true, announce: () => undefined };
    const [first, second] = await Promise.all([
      redriveCompanionRunVoice("run-redrive", deps),
      redriveCompanionRunVoice("run-redrive", deps),
    ]);
    expect([first, second].filter(Boolean).length).toBe(1);
    expect(listed).toBe(1);
  });

  it("空 runId 直接返回 false", async () => {
    await expect(redriveCompanionRunVoice("", { alreadyArrived: () => false })).resolves.toBe(false);
  });
});
