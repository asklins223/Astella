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

/**
 * 唤醒信号的事件名。事件只用来喊"队列里有新段了"，段本身走队列——
 * 生产端（实时流）与留档补取端共用这一个名字，谁改了名字都不会只改一半。
 */
export const COMPANION_VOICE_SEGMENT_READY_EVENT = "astella:companion-voice-segment-ready";

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
  /**
   * 事件帧里带合成文本的摘要；**服务端留档那一份不带**（`/companion/runs/:id/voice-segments`
   * 只回分段身份与显示区间）。所以补听路径构造的段没有这个字段——它只用于诊断，
   * 不是播放判据，缺了不该让整帧被丢掉。
   */
  synthesisTextSha256?: string;
  /**
   * 这条音频属于哪一条助手消息（服务端签发时带）。同一轮的多条发言靠它分辨
   * 消息边界：段内连续播，换消息时留一个短停顿。旧留档没有这个字段时省略。
   */
  messageId?: string;
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
 * 这个窗口**见过**语音段的轮次（入过队就算，取走播放后也不删）。
 *
 * 判据是"这一轮的声音有没有自己到场过"：没到场才值得去服务端留档补一次。
 * 没有它就只能靠"队列里现在还有没有"来判，而队列会被 drain 清空——于是**已经念过**
 * 的那一轮会被当成"没到场"再补一次，她会把同一句念两遍。上限只防无界增长，
 * 不是功能闸门。
 */
const runsWithQueuedSegments = new Set<string>();
const MAX_REMEMBERED_RUNS = 64;

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
    && typeof detail.conversationId === "string" && typeof detail.generation === "number"
    && (detail.messageId === undefined || typeof detail.messageId === "string");
}

/**
 * 入队。返回 false = 这一帧残缺或已经排过了，生产端因此**不该**再发唤醒事件。
 */
export function queueCompanionVoiceSegment(detail: unknown): boolean {
  if (!isCompanionVoiceSegmentDetail(detail) || seenSegmentIds.has(detail.segmentId)) return false;
  seenSegmentIds.add(detail.segmentId);
  if (!runsWithQueuedSegments.has(detail.runId)) {
    runsWithQueuedSegments.add(detail.runId);
    // Set 的插入顺序就是"最早见过的那一轮"：删最早的一个，够用且不引入额外结构。
    while (runsWithQueuedSegments.size > MAX_REMEMBERED_RUNS) {
      runsWithQueuedSegments.delete(runsWithQueuedSegments.values().next().value as string);
    }
  }
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
 * 这一轮的声音有没有自己到场过（入过队就算，念完也不撤销）。
 *
 * 主动轮那条"从留档补一次"的判据就是它：到场过就别再要一份，否则同一句会念两遍；
 * 没到场（本轮气泡的文字是从历史/快照读回来的，`voice.segment.ready` 从没经过这个窗口）
 * 才去 `/companion/runs/:id/voice-segments` 取一次。
 */
export function hasCompanionRunVoiceSegments(runId: string): boolean {
  return runsWithQueuedSegments.has(runId);
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
