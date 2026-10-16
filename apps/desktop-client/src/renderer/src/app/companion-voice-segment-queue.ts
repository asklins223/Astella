/**
 * 语音段的缓冲队列（2026-10-16）。
 *
 * 原来这一段是 `window.dispatchEvent` 一发即走，唯一的订阅者住在 `CompanionHud` 的
 * `useEffect` 里。气泡那一刻不在场，段就永久丢了——生产实测：09:10 那条主动消息
 * 服务端下发了 2 段（`companion_stream_events` 里两条 `voice.segment.ready`），
 * 客户端本机音频缓存里一个字都没有，而"播放音频"那个按钮 `if (!ordinals) return null`
 * 要求本机先有缓存，于是这一句**永久静音，连手动补听的入口都没留下**。
 *
 * 现在队列在这里，事件只当唤醒信号：段先落队列，谁在场谁来取，取走才算消费。
 * 生产端仍然只在**真的存下新段**时才发事件，重复帧不会多唤醒一次。
 */

import type { CompanionServerVoiceSegment } from "./companion-voice-playback";

export type CompanionVoiceSegmentReadyDetail = Readonly<{
  version: 2;
  conversationId: string;
  runId: string;
  generation: number;
  segmentId: string;
  ordinal: number;
  displayText: string;
  displayStart: number;
  displayEnd: number;
  synthesisTextSha256: string;
  cue: CompanionServerVoiceSegment["cue"];
}>;

/**
 * 失控收敛上限（不是"砍功能"的上限）：队列只保证"这一轮没赶上的人还能补听"，
 * 跨很久不回放——那归服务端留档。没有上限的话，一次 HUD 长时间不挂载就会按轮次
 * 无界攒着整段会话的语音帧。
 */
const MAX_QUEUED_RUNS = 8;
const MAX_QUEUED_SEGMENTS_PER_RUN = 64;

const queued = new Map<string, CompanionVoiceSegmentReadyDetail[]>();
const seenSegmentIds = new Set<string>();

/**
 * V2 合同逐字段校验：`displayStart`/`displayEnd` 是干净正文里的字符区间，
 * 任一缺失就整帧丢掉——渲染层绝不猜"这段对应正文的哪里"。
 */
export function isCompanionVoiceSegmentDetail(value: unknown): value is CompanionVoiceSegmentReadyDetail {
  const detail = value as Partial<CompanionVoiceSegmentReadyDetail>;
  return !!detail && detail.version === 2 && typeof detail.runId === "string"
    && typeof detail.segmentId === "string" && typeof detail.ordinal === "number"
    && typeof detail.displayText === "string" && detail.displayText.length > 0
    && typeof detail.displayStart === "number" && typeof detail.displayEnd === "number"
    && typeof detail.conversationId === "string" && typeof detail.generation === "number";
}

/**
 * 入队。返回 false = 这一帧残缺或已经排过了，生产端因此**不该**再发唤醒事件。
 */
export function queueCompanionVoiceSegment(detail: unknown): boolean {
  if (!isCompanionVoiceSegmentDetail(detail) || seenSegmentIds.has(detail.segmentId)) return false;
  seenSegmentIds.add(detail.segmentId);
  const existing = queued.get(detail.runId);
  if (existing) {
    if (existing.length < MAX_QUEUED_SEGMENTS_PER_RUN) existing.push(detail);
  } else {
    // 挤出去的那一轮要连 `seenSegmentIds` 一起放手：只删段不删记号，这一帧再到达时
    // 会被"已经排过了"挡掉——正是本次要根治的那个"错过一次就永久静音"的形状。
    while (queued.size >= MAX_QUEUED_RUNS) {
      const oldest = queued.keys().next().value as string;
      for (const segment of queued.get(oldest) ?? []) seenSegmentIds.delete(segment.segmentId);
      queued.delete(oldest);
    }
    queued.set(detail.runId, [detail]);
  }
  return true;
}

/**
 * 取走全部待播段（按到达顺序），并清空。取走即消费：HUD 在场时是事件把它唤醒，
 * 不在场时是下一次挂载——两条路都只会拿到一次。
 */
export function drainCompanionVoiceSegments(): CompanionVoiceSegmentReadyDetail[] {
  const taken = [...queued.values()].flat();
  for (const segment of taken) seenSegmentIds.delete(segment.segmentId);
  queued.clear();
  return taken;
}

/** 诊断与测试用：当前排了多少、排在哪些 run 上。 */
export function companionVoiceSegmentQueueSize(): number {
  return [...queued.values()].reduce((sum, segments) => sum + segments.length, 0);
}
