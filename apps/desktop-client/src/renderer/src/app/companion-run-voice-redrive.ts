import type { CompanionRunVoiceSegmentsResultV1 } from "@astella/shared/companion-voice-contracts";
import { createRequestMeta, unwrapGatewayResult } from "./desktop-client";
import {
  COMPANION_VOICE_SEGMENT_READY_EVENT,
  hasCompanionRunVoiceSegments,
  queueCompanionVoiceSegment,
} from "./companion-voice-segment-queue";

/**
 * 主动轮"没在实时流里到场"的那一遍，从服务端留档把声音补回来（2026-10-16）。
 *
 * 真窗口实测（装好的生产包 + 本地栈）：开机后她自己开口那一句，气泡上有字、**没有声音**，
 * 而且客户端从头到尾没有发出过一次合成请求（`voice.speakSegment` 调用数 0、本机音频缓存 0 个文件）。
 * 原因不是合成失败，是声音这一段**根本没经过这个窗口**：
 * - 她的正文抵达桌面走"认领一条投递"（`receiveInitiative`）。投递落地时那一轮可能已经结束，
 *   客户端用 `eventCursor: 0` 订阅会话事件，服务端直接判 `CURSOR_EXPIRED`
 *   （真库实测：`GET /companion/conversations/:id/events?after=0` 回 CURSOR_EXPIRED）；
 * - 正文还有两条兜底（快照轮询、历史读回）都能把字显示出来，**语音段只有实时流这一条路**
 *   （`companion-chat-session.tsx` 只在流回调里 `queueCompanionVoiceSegment`）。
 * 于是"文字在、声音永久缺席"，而唯一的手动补听入口（`CompanionMessageAudioButton`）
 * 只挂在对话手记里，气泡上根本没有。
 *
 * 这里补的就是那一条：**没在流里到场过**的轮次（`hasCompanionRunVoiceSegments`），
 * 用她自己的留档接口取一次段，按同一份身份（segmentId / ordinal / 显示区间）排进常驻队列。
 * 之后 HUD 那条既有播放链照常走——不新增第二套播放器、不在本地重新切段、
 * 也不因为这次补取而多念一遍（到场过的轮次直接跳过）。
 */

const MAX_REDRIVE_ATTEMPTS = 64;
/** 这一窗口已经试过的轮次：留档取空、通道不可用都算试过，同一轮不反复打服务端。 */
const attempted = new Set<string>();

export interface CompanionRunVoiceRedriveDeps {
  /** 取一轮的留档分段；缺省走 `window.astella.companion.chat.listRunVoiceSegments`。 */
  readonly listSegments?: (runId: string) => Promise<CompanionRunVoiceSegmentsResultV1>;
  readonly enqueue?: (detail: unknown) => boolean;
  /** 入队后唤醒气泡；缺省派发与实时流同一条事件。 */
  readonly announce?: () => void;
  /** 「这一轮的声音已经到场过」的读数；缺省读常驻队列的记账。 */
  readonly alreadyArrived?: (runId: string) => boolean;
}

async function defaultListSegments(runId: string): Promise<CompanionRunVoiceSegmentsResultV1> {
  const api = window.astella?.companion?.chat?.listRunVoiceSegments;
  if (!api) throw new Error("语音留档通道还没准备好");
  return unwrapGatewayResult(await api({
    meta: createRequestMeta(),
    request: { version: 1, runId },
  }));
}

function remember(runId: string): void {
  attempted.add(runId);
  // Set 的插入顺序就是"最早试过的那一轮"。
  while (attempted.size > MAX_REDRIVE_ATTEMPTS) {
    attempted.delete(attempted.values().next().value as string);
  }
}

/** 测试用：清掉"这一窗口试过哪些轮次"的记账。 */
export function resetCompanionRunVoiceRedrive(): void {
  attempted.clear();
}

/**
 * 返回 true = 真的把段排进了队列（气泡下一次刷段就会念）。
 * 返回 false = 不需要或取不到：已经在流里到场过、留档为空（事件过了 TTL）、
 * 通道不可用、这一轮已经试过。任何失败都不抛——它只是补声音，不该影响文字与操作。
 */
export async function redriveCompanionRunVoice(
  runId: string,
  deps: CompanionRunVoiceRedriveDeps = {},
): Promise<boolean> {
  if (!runId) return false;
  const alreadyArrived = deps.alreadyArrived ?? hasCompanionRunVoiceSegments;
  if (alreadyArrived(runId)) return false;
  if (attempted.has(runId)) return false;
  // 先记账再发请求：并发的两次调用（例如"认领"与"补读历史"同拍）只该打一次服务端。
  remember(runId);
  const listSegments = deps.listSegments ?? defaultListSegments;
  const enqueue = deps.enqueue ?? queueCompanionVoiceSegment;
  try {
    const result = await listSegments(runId);
    // 三个字段同源：会话/世代为空、或一条段都没有，就是"这一轮没有可补的音频"——
    // 那是正常结论（事件过了 TTL 或从没签发过），不是错误。
    if (!result || result.generation === null || !result.conversationId || result.items.length === 0) return false;
    let queued = 0;
    for (const item of [...result.items].sort((left, right) => left.ordinal - right.ordinal)) {
      const accepted = enqueue({
        version: 2,
        conversationId: result.conversationId,
        runId,
        generation: result.generation,
        segmentId: item.segmentId,
        ordinal: item.ordinal,
        displayText: item.displayText,
        displayStart: item.displayStart,
        displayEnd: item.displayEnd,
        cue: item.cue,
      });
      if (accepted) queued += 1;
    }
    if (queued === 0) return false;
    (deps.announce ?? (() => window.dispatchEvent(new CustomEvent(COMPANION_VOICE_SEGMENT_READY_EVENT))))();
    return true;
  } catch {
    return false;
  }
}
