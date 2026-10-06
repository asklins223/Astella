/**
 * 本机语音识别的**引擎侧**（主进程，2026-10-06）。
 *
 * ## 为什么识别从渲染进程的 worker 搬到了这里
 *
 * 随包的 `src/renderer/public/sherpa/sherpa-onnx-wasm-nodejs.js` 是 emscripten 的
 * **Node 构建**：工厂函数一开头就无条件 `require("path")`（`…js:1:7053`），运行时里还有
 * `if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}`。
 * 而窗口是 `sandbox: true` + `nodeIntegration: false`：2026-10-06 在打包应用里实测，
 * worker 内 `typeof process` / `typeof require` 都是 `undefined`，`init` 一律回
 * `{type:"fatal", message:"require is not defined"}`——用户说完话只会看到
 * 「识别失败：require is not defined」，语音输入整条不可用。
 *
 * 引擎本身没坏，是**位置**错了：它要一个 Node 上下文。所以解码搬到 Electron 的
 * `utilityProcess`（Node 子进程）里跑，而**录音仍然只在渲染层采集**——音频经一条本机
 * IPC 进来，不出这台机器。附带的好处是 NODERAWFS 能直接按路径读本机那份 228 MB 模型，
 * 省掉「fetch → arrayBuffer → MEMFS」那一趟搬运。
 *
 * ## 生命周期
 *
 * - 懒启动：第一次要识别才 `fork`，没装模型时调用方在更上一层就拒绝了，不会白起进程。
 * - 空闲 90 s 交还内存：一份引擎就是 228 MB 的 int8 模型加 onnxruntime 的图，
 *   而语音是偶尔用的功能（这条取值沿用渲染层 worker 时代的 `ASR_IDLE_RELEASE_MS`）。
 * - 崩了就丢：子进程退出时把所有在途请求判失败并清掉句柄，下一次识别重新 fork，
 *   死掉的句柄绝不复用。
 */

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  VOICE_ASR_MODEL_FILES,
} from '@astella/shared/voice-asr-model-contracts'
import { voiceAsrModelDirectory } from '../shared/voice-asr-model-path'

/** 一句说完之后隔多久把整个识别引擎交还内存（与渲染层 worker 时代同值）。 */
export const VOICE_ASR_IDLE_RELEASE_MS = 90_000

/** 一次解码的上限。第一次解码含引擎与 228 MB 模型的加载，所以给得比后续宽。 */
export const VOICE_ASR_DECODE_TIMEOUT_MS = 120_000

const HOST_FILE = 'voice-asr-host.js'

/** 引擎文件相对安装包根的位置：打包后是 `out/renderer/sherpa`，开发时是源码 public 树。 */
function candidateEngineDirectories(): string[] {
  const appPath = app.getAppPath()
  return [
    join(appPath, 'out', 'renderer', 'sherpa'),
    join(appPath, 'src', 'renderer', 'public', 'sherpa'),
  ]
}

export function resolveVoiceAsrEngineDirectory(): string | null {
  for (const directory of candidateEngineDirectories()) {
    if (existsSync(join(directory, 'sherpa-onnx-wasm-nodejs.js')) && existsSync(join(directory, 'sherpa-onnx-asr.js'))) {
      return directory
    }
  }
  return null
}

export interface VoiceAsrEnginePaths {
  readonly hostPath: string
  readonly engineDir: string
  readonly modelPath: string
  readonly tokensPath: string
}

export function resolveVoiceAsrEnginePaths(): VoiceAsrEnginePaths | null {
  const engineDir = resolveVoiceAsrEngineDirectory()
  if (!engineDir) return null
  // 宿主脚本与主进程产物同级（`out/main/`）：electron-vite 的 main 有两个入口。
  const hostPath = join(__dirname, HOST_FILE)
  if (!existsSync(hostPath)) return null
  const modelDir = voiceAsrModelDirectory({ userDataDir: app.getPath('userData') })
  const modelPath = join(modelDir, VOICE_ASR_MODEL_FILES[0].name)
  const tokensPath = join(modelDir, VOICE_ASR_MODEL_FILES[1].name)
  if (!existsSync(modelPath) || !existsSync(tokensPath)) return null
  return { hostPath, engineDir, modelPath, tokensPath }
}

interface PendingDecode {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 进程内唯一的一份引擎（主进程只有一个窗口，也就只有一路语音输入）。
 * 只放句柄，不在这里 fork：`resolveVoiceAsrEnginePaths()` 要看安装包布局与本机模型，
 * 那些事只有真正要用的时候才该发生（没装模型时连进程都不该起）。
 */
let sharedEngine: VoiceAsrEngine | null = null

export class VoiceAsrEngine {
  private child: UtilityProcess | null = null
  private pending = new Map<number, PendingDecode>()
  private seq = 0
  private idleTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly paths: VoiceAsrEnginePaths) {}

  /** 空闲到点就收摊；有在途解码时顺延，绝不把一次正在进行的识别踢掉。 */
  private armIdleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) {
        this.armIdleRelease()
        return
      }
      // 只收**进程**，不把这份句柄标成废弃：下一个要说话的人还得能再起一个。
      this.stopChild('voice asr engine idle')
      this.idleTimer = null
    }, VOICE_ASR_IDLE_RELEASE_MS)
    this.idleTimer.unref?.()
  }

  /**
   * 丢掉子进程（在途请求按给定原因判失败）。
   *
   * 「空闲收摊」与「整个应用退出」是两件事：只有后者才连这份句柄一起作废。
   * 把两者混在一起的后果很具体——说过一句话之后，这个窗口内**再也说不出第二句**
   * （`transcribe` 一直撞上 `disposed`）。
   */
  private stopChild(reason: string): void {
    const child = this.child
    this.child = null
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
    child?.kill()
  }

  private spawn(): UtilityProcess | null {
    if (this.child) return this.child
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(
        this.paths.hostPath,
        [this.paths.engineDir, this.paths.modelPath, this.paths.tokensPath],
        {
          serviceName: 'astella-voice-asr',
          // 引擎产物在 renderer 的 public 树里，路径由主进程推出来再交给子进程；
          // 子进程不读任何环境变量，也不碰网络。
          stdio: 'inherit',
        },
      )
    } catch {
      return null
    }
    child.on('message', (message: unknown) => this.handleMessage(message))
    // 崩了/被杀：在途请求立刻失败，句柄丢掉，下一次识别重新 fork。
    child.on('exit', () => {
      if (this.child === child) this.stopChild('voice asr engine exited')
    })
    this.child = child
    return child
  }

  private handleMessage(raw: unknown): void {
    const message = raw as { type?: unknown; id?: unknown; text?: unknown; message?: unknown }
    if (typeof message?.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)!
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.type === 'result') entry.resolve(String(message.text ?? ''))
      else entry.reject(new Error(String(message.message ?? 'decode failed')))
      this.armIdleRelease()
      return
    }
    // 没有 id 的只有 fatal：引擎初始化失败（引擎文件读不到、模型坏）。它在途请求
    // 随进程一起判失败，下一次识别重新拉起——用户可能刚刚把模型装好。
    //
    // 这里**显式丢掉句柄**，不等 `exit` 事件兜底：即便某个平台没把 kill 之后的退出
    // 报回来，下一次也会换一个进程，而不是抱着一个已经废掉的句柄发消息。
    if (message?.type === 'fatal') {
      this.stopChild('voice asr engine failed to start')
    }
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    if (this.disposed) throw new Error('voice asr engine disposed')
    const child = this.spawn()
    if (!child) throw new Error('voice asr engine unavailable')
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const id = ++this.seq
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时说明这个子进程已经不健康了：丢掉它，下一次重新拉起。
        this.child?.kill()
        reject(new Error('voice asr decode timeout'))
      }, VOICE_ASR_DECODE_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      child.postMessage({ type: 'decode', id, sampleRate, pcm })
    })
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.disposed = true
    this.stopChild('voice asr engine disposed')
  }
}

/**
 * 主进程侧的入口：把一段 16 kHz 单声道 Int16 PCM 解成文字。
 *
 * 失败一律抛普通 `Error`——**这一层不认识 IPC 的失败码**：把错误码映射留给
 * `desktop-ipc.ts`（否则这个模块要反过来 import 主进程的 IPC 模块，转成一个圈）。
 * 但"引擎坏了不留着"这件事在这里做：任何一次失败都丢掉句柄，下一次识别重新 fork，
 * 用户刚在设置里装好模型时不必重启应用。
 */
export async function transcribeWithVoiceAsrEngine(
  pcm: Int16Array,
  sampleRate: number,
): Promise<string> {
  if (!sharedEngine) {
    const paths = resolveVoiceAsrEnginePaths()
    if (!paths) throw new Error('voice asr engine not available')
    sharedEngine = new VoiceAsrEngine(paths)
  }
  try {
    return await sharedEngine.transcribe(pcm, sampleRate)
  } catch (error) {
    sharedEngine.dispose()
    sharedEngine = null
    throw error instanceof Error ? error : new Error(String(error))
  }
}
