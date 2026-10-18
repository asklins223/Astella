/**
 * 流式取一段语音并在宿主上边到边播（2026-10-17）。
 *
 * 与 `synthesizeSegment`（整段 base64 回来再解码）的区别只在**什么时候开始播**：
 * 这里第一块字节到达就能开口。走不通时（主进程没有这条通道、流中途报错、
 * 解不出任何可用单元）调用方应当退回整段那条路——所以这个函数只负责尝试，
 * 返回值告诉调用方"播放器有没有真的接管"。
 */

import type { CompanionVoiceSpeakSegmentRequestV2 } from "@astella/shared/companion-voice-contracts";
import { IncrementalAudioPlayer } from './companion-incremental-mp3.ts'
import { requestCompanionVoiceAudio } from './companion-voice-request'

export interface StreamingSegmentPlaybackArgs {
  readonly request: CompanionVoiceSpeakSegmentRequestV2
  /** 当前工作区纪元；主进程按它做一致性校验。 */
  readonly workspaceEpoch: number | undefined
  readonly context: AudioContext
  readonly destination: AudioNode
  /** 这条路线自己的闸门（静音/窗口不可见）。 */
  readonly audible: () => boolean
  /** 已播秒数 → 进度回调（宿主自己折算成 0..1）。 */
  readonly onProgress: (seconds: number) => void
  readonly signal?: AbortSignal
  /**
   * 把"停"的句柄交回给宿主：宿主在被打断时要能停掉这个播放器，
   * 否则停止朗读对这条路不生效（它不经过 `host.play`）。
   */
  readonly registerStop?: (stop: () => void) => void
  /**
   * 把**现算的播放位置**（0..1，没有在播时 null）交给宿主（2026-10-18）。
   *
   * 字幕只认音频时钟现算的位置。整段那条由 `playVoiceBuffer` 写 `activePlaybackRef`
   * 供 `host.progress()` 读取；流式这条路不经过它，位置就永远是 null，气泡退回
   * 阅读钟——文字与声音脱开。这里把增量播放器自己的时钟交出去，宿主挂到同一个
   * 读数上即可。播完/停止时回调 null，表示"没有声音了"。
   */
  readonly registerProgress?: (read: (() => number | null) | null) => void
  /**
   * 测试接缝：jsdom / node 里没有 `AudioDecoder`，注入整块解码让接线测试能跑。
   * 生产**不传**。
   */
  readonly decodeAllForTest?: (bytes: Uint8Array) => Promise<AudioBuffer | null>
}

/** 主进程是否提供了这条通道（旧版主进程没有）。 */
export function hasStreamingSegmentChannel(): boolean {
  return typeof window.astella?.companion?.voice?.speakSegmentStream === 'function'
    && typeof window.astella?.companion?.voice?.onSegmentChunk === 'function'
}

/**
 * 尝试用流式方式取段并播放。
 *
 * 返回 `true` 表示**播放器已接管**（已开始或已排上音频），调用方不必再合成一次；
 * 返回 `false` 表示这条路没走通且**没有响过任何声音**，调用方应退回整段那条。
 */
export async function playSegmentFromStream(
  args: StreamingSegmentPlaybackArgs,
): Promise<boolean> {
  const api = window.astella?.companion?.voice
  if (!api?.speakSegmentStream || !api.onSegmentChunk) return false

  // 事件按 `requestId` 过滤，而主进程回推的正是发起 invoke 时那份 `meta.requestId`。
  // 这里必须等真正发出请求后才知道它——自己先生成一个 UUID 会上永远对不上，
  // 每一块都在第一个 `if` 里被丢掉，播放器一声不响地卡到 15s 截止（2026-10-18 抓到）。
  let requestId: string | null = null
  const decodeContext = args.context
  let started = false
  let failure = false
  let ended = false
  /** 整条流已全部排完播完（`IncrementalAudioPlayer` 的 onDone）。 */
  let drained = false
  let wake: (() => void) | null = null
  const wakeUp = (): void => { const resume = wake; wake = null; resume?.(); }

  /**
   * 播放器自己用 WebCodecs 的 `AudioDecoder` 连续解码（见 `companion-incremental-mp3`）。
   *
   * 这里不再提供 `decode`：把每块字节交给 `decodeAudioData` 会把每块当成完整文件
   * ——预滚静音、逐块重采样的边缘失真（滋滋声）、完成顺序乱，三个问题都来自它。
   */
  const player = new IncrementalAudioPlayer({
    context: decodeContext,
    destination: args.destination,
    audible: args.audible,
    onProgress: args.onProgress,
    onDone: () => { drained = true; wakeUp() },
    ...(args.decodeAllForTest ? { decodeAllForTest: args.decodeAllForTest } : {}),
  })
  const unsubscribe = api.onSegmentChunk((event) => {
    if (requestId === null || event.requestId !== requestId) return
    if (event.kind === 'chunk') {
      if (!started) started = true
      player.push(event.bytes)
      wakeUp()
      return
    }
    if (event.kind === 'end') {
      ended = true
      player.finish()
      wakeUp()
      return
    }
    failure = true
    player.stop()
    wakeUp()
  })

  const onAbort = (): void => player.stop()
  args.signal?.addEventListener('abort', onAbort, { once: true })
  args.registerStop?.(() => player.stop())
  // 字幕位置：把播放器自己的音频时钟交出去（见 `registerProgress` 的注释）。
  args.registerProgress?.(() => player.playedFraction())

  try {
    const accepted = await requestCompanionVoiceAudio(
      (meta) => {
        // 先记下 id 再发：主进程可能在 invoke 返回之前就推第一块。
        requestId = meta.requestId
        return api.speakSegmentStream({ meta, request: args.request })
      },
      args.workspaceEpoch,
      args.signal,
    )
    if (!accepted) {
      unsubscribe()
      return false
    }
    // 这一步是**整段**的寿命，不是"第一块到了"就完事：返回 true 的语义是
    // "这一段已经由流式播放器念完"，调用方会立刻进入下一段并调 stopVoicePlayback。
    // 早返回会让每一段只念第一个单元就被下一段掐掉（2026-10-18 真窗口实测：
    // 两段各 0.2s）。所以等到字节流结束并且播放队列真的排空为止。
    const firstChunkDeadline = Date.now() + 15_000
    while (!started && !ended && !failure && Date.now() < firstChunkDeadline) {
      if (args.signal?.aborted) break
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(wakeUp, 25) })
    }
    if (started && !failure) {
      const drainDeadline = Date.now() + 120_000
      while (!drained && !failure && player.isLive && Date.now() < drainDeadline) {
        if (args.signal?.aborted) break
        // 解码器坏了就立刻收手：让调用方退回整段合成，而不是空等到 120 秒。
        if (player.failed) break
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(wakeUp, 25) })
      }
    }
    // 解码器不可用时这一段**一声没响**：返回 false，调用方走整段那条兜底。
    return started && !failure && !player.failed
  } catch {
    return false
  } finally {
    // 播完之后事件已经没有意义；中途失败同理（这一段判死，交给整段那条兜底）。
    // 位置读数也要撤掉：否则字幕会一直读一个已经停住的时钟。
    args.registerProgress?.(null)
    unsubscribe()
  }
}
