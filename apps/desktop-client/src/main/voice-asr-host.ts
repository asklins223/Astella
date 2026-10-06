/**
 * 本机识别引擎的**子进程宿主**（Electron `utilityProcess`，Node 上下文）。
 *
 * 它只做三件事，别的都不做：
 *   1. 把随包的两份引擎脚本 require 进来（`sherpa-onnx-wasm-nodejs.js` 是 emscripten 的
 *      Node 构建，`sherpa-onnx-asr.js` 在 Node 环境下自己 `module.exports`）；
 *   2. 按**绝对路径**读本机那份模型（NODERAWFS 把 emscripten 的 FS 直接接到真实文件系统，
 *      所以模型不必再走 fetch 进 MEMFS）；
 *   3. 把一段 16 kHz 单声道 PCM 解成文字。
 *
 * 协议（`process.parentPort`）：
 *   父 → 子  `{ type: "decode", id, sampleRate, pcm: Int16Array }`
 *   子 → 父  `{ type: "result", id, text }` / `{ type: "error", id, message }`
 *            `{ type: "fatal", message }`（引擎初始化失败，同批请求由父侧超时兜底）
 * 路径走 argv（`engineDir`、模型、词表），不走消息：少一次握手，就少一处"谁先谁后"。
 *
 * 这个进程不读环境变量、不碰网络、不写文件；音频只在这一段内存里存在。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

interface DecodeMessage {
  readonly type: 'decode'
  readonly id: number
  readonly sampleRate: number
  readonly pcm: Int16Array
}

interface RecognizerStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}
interface Recognizer {
  createStream(): RecognizerStream
  decode(stream: RecognizerStream): void
  getResult(stream: RecognizerStream): { text?: unknown }
}

/**
 * `require` 的基准路径只用来说明"这是一次 CJS require"：两份引擎脚本一律用**绝对路径**
 * 传进来，所以 base 取哪儿都不影响解析。用 `process.execPath` 而不是 `__filename`：
 * 前者不依赖产物打成 CJS 还是 ESM。
 */
const nodeRequire = createRequire(process.execPath)

const parentPort = (process as unknown as {
  parentPort: {
    on(event: 'message', listener: (event: { data: unknown }) => void): void
    postMessage(message: unknown): void
  }
}).parentPort

/** argv = [electron, host.js, engineDir, modelPath, tokensPath]（由主进程算好）。 */
function readPathsFromArgv(): { engineDir: string; modelPath: string; tokensPath: string } {
  const [, , engineDir, modelPath, tokensPath] = process.argv
  const values = [engineDir, modelPath, tokensPath]
  if (values.some((value) => typeof value !== 'string' || !isAbsolute(value))) {
    throw new Error('voice asr host needs absolute engine paths')
  }
  if (!existsSync(join(engineDir!, 'sherpa-onnx-wasm-nodejs.js')) || !existsSync(join(engineDir!, 'sherpa-onnx-asr.js'))) {
    throw new Error('voice asr engine files missing')
  }
  if (!existsSync(modelPath!) || !existsSync(tokensPath!)) throw new Error('voice asr model files missing')
  return { engineDir: engineDir!, modelPath: modelPath!, tokensPath: tokensPath! }
}

let recognizerPromise: Promise<Recognizer> | null = null
let queue: Promise<void> = Promise.resolve()

function ensureRecognizer(): Promise<Recognizer> {
  if (recognizerPromise) return recognizerPromise
  const paths = readPathsFromArgv()
  recognizerPromise = (async () => {
    type WasmModule = Record<string, unknown>
    const factory = nodeRequire(join(paths.engineDir, 'sherpa-onnx-wasm-nodejs.js')) as (
      options: { locateFile: (file: string) => string },
    ) => Promise<WasmModule>
    // locateFile 给的是**真实文件系统**里的绝对路径：这条构建开着 NODERAWFS，
    // emscripten 自己会用 fs.readFileSync 去读它。
    const mod = await factory({ locateFile: (file) => join(paths.engineDir, file) })
    const { OfflineRecognizer } = nodeRequire(join(paths.engineDir, 'sherpa-onnx-asr.js')) as {
      OfflineRecognizer: new (config: unknown, module: unknown) => Recognizer
    }
    return new OfflineRecognizer(
      {
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: paths.modelPath, language: '', useInverseTextNormalization: 1 },
          tokens: paths.tokensPath,
          numThreads: 2,
          debug: 0,
        },
        decodingMethod: 'greedy_search',
      },
      mod,
    )
  })()
  recognizerPromise = recognizerPromise.catch((error: unknown) => {
    // 失败后允许重试（比如用户刚在设置里把模型装好，不必重启应用）。
    recognizerPromise = null
    throw error
  })
  return recognizerPromise
}

async function decode(message: DecodeMessage): Promise<string> {
  // 先确认引擎起得来：起不来这一句按 fatal 回，父侧据此丢掉这个进程重开。
  const recognizer = await ensureRecognizer()
  const { pcm, sampleRate } = message
  const samples = new Float32Array(pcm.length)
  for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index]! / 32_768
  const stream = recognizer.createStream()
  try {
    stream.acceptWaveform(sampleRate, samples)
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    return String(result?.text ?? '').trim()
  } finally {
    stream.free()
  }
}

parentPort?.on('message', (event) => {
  const message = event.data as Partial<DecodeMessage> & { type?: string }
  if (message?.type !== 'decode' || typeof message.id !== 'number' || !(message.pcm instanceof Int16Array)) return
  const job = message as DecodeMessage
  // 一句一句来：引擎不是线程安全的，而语音输入本来也只有一路。
  queue = queue
    .then(async () => {
      const text = await decode(job)
      parentPort.postMessage({ type: 'result', id: job.id, text })
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      // 引擎这一轮没起来（recognizerPromise 已被重置）⇒ fatal，父侧换一个进程；
      // 起得来只是这一句解不动 ⇒ error，进程留着，下一句照样能说。
      const fatal = recognizerPromise === null
      parentPort.postMessage({ type: fatal ? 'fatal' : 'error', id: job.id, message: detail })
    })
})
