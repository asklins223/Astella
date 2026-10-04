import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  VOICE_ASR_MODEL_FILES,
  VOICE_ASR_MODEL_ID,
  VOICE_ASR_MODEL_SOURCES,
  type VoiceAsrModelFailure,
  type VoiceAsrModelFileName,
  type VoiceAsrModelFileStateV1,
  type VoiceAsrModelSourceV1,
  type VoiceAsrModelSnapshotV1,
  type VoiceAsrModelStatus
} from '@ailearn/shared/voice-asr-model-contracts'

export { voiceAsrModelDirectory } from '../shared/voice-asr-model-path'

/**
 * 本地语音识别模型的落盘与下载（主进程唯一的模型仓库）。
 *
 * ## 为什么模型在这里，不在安装包里
 *
 * SenseVoice int8 一份 239 MB，而语音输入是偶尔才用的功能。它由**用户自己决定要不要**：
 * 设置里点一下下到本机，随时可以移除。所以这里只做四件事——读状态、下载、中止、移除——
 * 一件识别都不做：识别在渲染进程的 worker 里就地发生，主进程连音频都碰不到。
 *
 * ## 原子性
 *
 * 每个文件先写 `<name>.part`，大小和 SHA-256 都通过才 `rename` 成正式文件。进程在半路被杀、
 * 用户点了中止、断网重来——留下的都是 `.part`，它**不计入已安装**，下一次下载从零起。
 * 「正式文件存在即完整」是这一层唯一需要维持的不变量。
 */
export type VoiceAsrModelState = Omit<VoiceAsrModelSnapshotV1, 'version' | 'mountUrl'>

const PART_SUFFIX = '.part'

/**
 * 把来源列表收成一份**非空**的：全被环境变量清空时退回合同里那份默认。
 * 一个空的来源列表会让「下载」永远立刻失败，而界面把它讲成"没下成"——
 * 那是一个接线错误，不该由用户的网络环境来背。
 */
function sourcesFromOption(sources?: readonly VoiceAsrModelSourceV1[]): readonly VoiceAsrModelSourceV1[] {
  const usable = (sources ?? []).map((source) => ({ ...source, baseUrl: source.baseUrl.replace(/\/+$/, '') }))
  return usable.length > 0 ? usable : VOICE_ASR_MODEL_SOURCES
}

/** 本模块自己判出来的失败类别；不是这几类的（网络抖动、磁盘满）交给 `classifyError`。 */
class VoiceAsrModelError extends Error {
  constructor(readonly failure: Exclude<VoiceAsrModelFailure, 'unknown'>) {
    super(failure)
    this.name = 'VoiceAsrModelError'
  }
}

function classifyError(error: unknown): VoiceAsrModelFailure {
  if (error instanceof VoiceAsrModelError) return error.failure
  const name = (error as { name?: string } | null)?.name
  if (name === 'AbortError') return 'cancelled'
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (
    code === 'ENOSPC'
    || code === 'EDQUOT'
    || code === 'EACCES'
    || code === 'EPERM'
    || code === 'EROFS'
    || code === 'EMFILE'
    || code === 'ENOTDIR'
    || code === 'EISDIR'
    || code === 'EEXIST'
  ) {
    return 'storage'
  }
  return 'unknown'
}

/**
 * 目录里的一个模型文件。
 *
 * `name` 只认合同里那两个（`voiceAsrModelFileNameSchema`），不给开一个「随便什么名字」：
 * 这条类型就是**协议层那条保留前缀路由的准入名单**，放开它等于让 `device/asr/…`
 * 能读出目录里的任何东西。测试也用它——只改字节数，不改名字。
 */
export interface VoiceAsrModelFileSpec {
  readonly name: VoiceAsrModelFileName
  readonly expectedBytes: number
  readonly sha256?: string
}

export interface VoiceAsrModelStoreOptions {
  /**
   * 按顺序试的上游地址。默认魔搭社区优先、国内镜像和官方库兜底（见合同的说明）；
   * `AILEARN_VOICE_ASR_SOURCE` 可以整份换掉——自建镜像、离线机器、内网制品库走这一条。
   *
   * 列表的语义是「第一个成了就用它」，不是「第一个不行就报错」。
   */
  readonly sources?: readonly VoiceAsrModelSourceV1[]
  /** 注入点：测试要断言下载过程，不该真的联网、更不该真的写 239MB。 */
  readonly fetchImpl?: typeof fetch
  /**
   * 目录里应该有哪几个文件。生产固定是合同里那两份；这是给测试用的参数化——
   * 真实模型一份 239MB，用例里没法真的把它写下来。名字不变，只改字节数。
   */
  readonly files?: readonly VoiceAsrModelFileSpec[]
  /** 连接与流中断的等待上限；不限制整份模型的下载时间。 */
  readonly connectTimeoutMs?: number
  readonly idleTimeoutMs?: number
}

export class VoiceAsrModelStore {
  readonly directory: string
  readonly files: readonly VoiceAsrModelFileSpec[]
  readonly sources: readonly VoiceAsrModelSourceV1[]
  private readonly fetchImpl: typeof fetch
  private readonly connectTimeoutMs: number
  private readonly idleTimeoutMs: number
  /** 正在进行的这一轮；没有就是 null。 */
  private transfer: AbortController | null = null
  private activeRun: Promise<void> | null = null
  private removal: Promise<void> | null = null
  private receivedThisRound = 0
  private activeFile: VoiceAsrModelFileName | null = null
  private activeSource: string | null = null
  private failure: VoiceAsrModelFailure | null = null
  private swept = false

  constructor(directory: string, options: VoiceAsrModelStoreOptions = {}) {
    this.directory = directory
    this.files = options.files ?? VOICE_ASR_MODEL_FILES
    this.sources = sourcesFromOption(options.sources)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000
  }

  /** 完整装好时占用的字节。清单可被测试替换，这一格跟着清单走。 */
  get expectedBytes(): number {
    return this.files.reduce((total, file) => total + file.expectedBytes, 0)
  }

  /**
   * 清掉上一次没下完的 `.part`。
   *
   * 只在本模块**构造那一刻**跑一次：那之前不可能有正在进行的传输（进程刚起），
   * 之后每轮下载自己管自己那份。留着它们没有价值——重启之后也不续传，
   * 白占一份磁盘，还让「占了多少空间」这句话算不准。
   */
  async sweepPartialFiles(): Promise<void> {
    if (this.swept) return
    this.swept = true
    try {
      await mkdir(this.directory, { recursive: true })
      await this.discardPartial()
    } catch (error) {
      // 模型是附加功能，模型目录不可写不能阻止整个书房启动。
      this.failure = classifyError(error)
    }
  }

  /** 一个文件此刻在磁盘上的样子。正式文件字节数对不上就当没有。 */
  private async fileState(file: VoiceAsrModelFileSpec): Promise<VoiceAsrModelFileStateV1> {
    try {
      const info = await stat(resolve(this.directory, file.name))
      if (info.isFile() && info.size === file.expectedBytes) {
        return { name: file.name, bytes: info.size, expectedBytes: file.expectedBytes, complete: true }
      }
    } catch {
      // 没有就是没有；下面那条 return 已经给了同一句话。
    }
    return { name: file.name, bytes: 0, expectedBytes: file.expectedBytes, complete: false }
  }

  async state(): Promise<VoiceAsrModelState> {
    const files = await Promise.all(this.files.map((file) => this.fileState(file)))
    const installedBytes = files.reduce((total, file) => total + file.bytes, 0)
    const ready = files.every((file) => file.complete)
    const status: VoiceAsrModelStatus = ready
      ? 'ready'
      : this.transfer
        ? 'downloading'
        : this.failure && this.failure !== 'cancelled'
          ? 'error'
          : 'absent'
    return {
      modelId: VOICE_ASR_MODEL_ID,
      status,
      expectedBytes: this.expectedBytes,
      // 已装的那些也算"这一轮已经收到"：补下 tokens.txt 时进度条要从 99% 走，
      // 而不是从 0% 再走一遍——那会让人以为刚才那份 239 MB 白下了。
      receivedBytes: Math.min(
        this.expectedBytes,
        installedBytes + (this.transfer && files.some((file) => file.name === this.activeFile && !file.complete)
          ? this.receivedThisRound : 0)
      ),
      installedBytes,
      files,
      sources: this.sources.map((source) => source.name),
      activeSource: this.activeSource,
      // 「装好了」与「正在下」都不是失败：留着上一轮那句失败，会让界面在下载中途
      // 同时讲「没下完」和「上次网络不通」，两句话自己打架。
      failure: status === 'ready' || status === 'downloading' ? null : this.failure,
      installedAt: ready ? await this.installedAt() : null,
    }
  }

  /** 装好的时刻取第一个模型文件的 mtime：不必再维护一份状态文件。 */
  private async installedAt(): Promise<string | null> {
    try {
      const info = await stat(resolve(this.directory, this.files[0].name))
      return info.mtime.toISOString()
    } catch {
      return null
    }
  }

  /** 协议层用：某个模型文件此刻可不可以直接读。 */
  async resolveReadablePath(name: string): Promise<string | null> {
    const file = this.files.find((entry) => entry.name === name)
    if (!file) return null
    const state = await this.fileState(file)
    return state.complete ? resolve(this.directory, file.name) : null
  }

  /**
   * 开始下载。**幂等**：已经在下了就什么都不做——
   * 设置页连点两下「下载」不该把 239 MB 从头再来一次。
   */
  async startDownload(): Promise<void> {
    if (this.removal) await this.removal
    if (this.activeRun) return
    // 在第一个 await 之前占住这一轮，连点/并发 IPC 不能创建两个写句柄。
    this.transfer = new AbortController()
    this.receivedThisRound = 0
    this.failure = null
    const run = this.run(this.transfer.signal)
    this.activeRun = run
    void run.finally(() => {
      if (this.activeRun === run) {
        this.activeRun = null
        this.transfer = null
        this.activeFile = null
        this.activeSource = null
      }
    })
  }

  /** 等这一轮自己跑完（有没有在跑都立刻回来）。中止信号本身不保证写句柄已经关上。 */
  async whenSettled(): Promise<void> {
    await this.activeRun
  }

  /**
   * 中止这一轮，并在它真正停下来之后才回来。
   *
   * `remove()` 依赖这一点：中止信号只是"请停下"，写句柄可能还开着，
   * 不等它落定就删文件，删除与 rename 会撞在一起，留下一个装不上的模型。
   */
  async cancel(): Promise<void> {
    const run = this.activeRun
    if (!run) return
    this.transfer?.abort()
    await run
  }

  /** 移除：先把没下完的停干净，再把属于模型的东西清掉。 */
  async remove(): Promise<void> {
    if (this.removal) return this.removal
    const removal = this.removeFiles()
    this.removal = removal
    try {
      await removal
    } finally {
      if (this.removal === removal) this.removal = null
    }
  }

  private async removeFiles(): Promise<void> {
    await this.cancel()
    await Promise.all(this.files.flatMap((file) => [
      rm(resolve(this.directory, file.name), { force: true }),
      this.discard(file.name)
    ]))
    this.receivedThisRound = 0
    this.failure = null
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true })
      for (const file of this.files) {
        if (signal.aborted) throw new VoiceAsrModelError('cancelled')
        const current = await this.fileState(file)
        if (current.complete) continue
        await this.downloadFileFromAnySource(file, signal)
      }
      const after = await this.state()
      // 两个文件都落到位才算好。没到位又没有明确错误时按"没下全"处理——
      // 否则界面会停在一条永远转不完的进度条上。
      if (after.status !== 'ready') throw new VoiceAsrModelError('size_mismatch')
    } catch (error) {
      this.failure = classifyError(error)
    } finally {
      await this.discardPartial()
    }
  }

  /** 删掉某个文件的半截文件（`.part`）。删不掉不算失败——它只是"没下完"的证据。 */
  private async discard(name: string): Promise<void> {
    await rm(resolve(this.directory, `${name}${PART_SUFFIX}`), { force: true }).catch(() => undefined)
  }

  private async discardPartial(): Promise<void> {
    await Promise.all(this.files.map((file) => this.discard(file.name)));
  }

  /**
   * 按顺序试每一个源，**成了就停**。
   *
   * `receivedThisRound` 只记录当前文件在当前源收到的字节，换源时归零。
   * 已完整落盘的文件另由 `state()` 计入进度，不重复累计。
   * 中止和磁盘失败立即返回；网络、超时和校验失败继续尝试后面的源。
   */
  private async downloadFileFromAnySource(file: VoiceAsrModelFileSpec, signal: AbortSignal): Promise<void> {
    let lastFailure: VoiceAsrModelFailure = 'network'
    let lastError: unknown = new VoiceAsrModelError('network')
    for (const source of this.sources) {
      if (signal.aborted) throw new VoiceAsrModelError('cancelled')
      this.activeFile = file.name
      this.activeSource = source.name
      this.receivedThisRound = 0
      try {
        await this.downloadFile(file, source, signal)
        return
      } catch (error) {
        lastFailure = classifyError(error)
        lastError = error
        this.receivedThisRound = 0
        await this.discard(file.name)
        // 磁盘写入失败与网络源无关，不继续换源重复下载。
        if (lastFailure === 'cancelled' || lastFailure === 'storage') throw error
      }
    }
    // 源全试过了。`unknown` 在这里没有更好的分类可给——而 `storage`（磁盘满/无权写）
    // 是这一轮之外的问题，早就在写文件那一步报出来了，不会走到这里。
    if (lastFailure === 'unknown') throw lastError
    throw new VoiceAsrModelError(lastFailure)
  }

  private async downloadFile(
    file: VoiceAsrModelFileSpec,
    source: VoiceAsrModelSourceV1,
    signal: AbortSignal
  ): Promise<void> {
    const url = `${source.baseUrl}/${file.name}`
    const partPath = resolve(this.directory, `${file.name}${PART_SUFFIX}`)
    const targetPath = resolve(this.directory, file.name)
    const attempt = new AbortController()
    const abort = () => attempt.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    let timeout: ReturnType<typeof setTimeout>
    const armTimeout = (milliseconds: number) => {
      clearTimeout(timeout)
      timeout = setTimeout(abort, milliseconds)
    }
    armTimeout(this.connectTimeoutMs)
    let response: Response | undefined
    try {
      response = await this.fetchImpl(url, { redirect: 'follow', signal: attempt.signal })
      if (!response.ok || !response.body) throw new VoiceAsrModelError('network')
      const length = response.headers.get('content-length')
      if (length && Number(length) !== file.expectedBytes) throw new VoiceAsrModelError('size_mismatch')
      armTimeout(this.idleTimeoutMs)
      let written = 0
      const hash = createHash('sha256')
      const sourceStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          armTimeout(this.idleTimeoutMs)
          written += chunk.length
          if (written > file.expectedBytes) {
            callback(new VoiceAsrModelError('size_mismatch'))
            return
          }
          hash.update(chunk)
          this.receivedThisRound = written
          callback(null, chunk)
        }
      })
      await pipeline(sourceStream, meter, createWriteStream(partPath), { signal: attempt.signal })
      if (written !== file.expectedBytes || (file.sha256 && hash.digest('hex') !== file.sha256)) {
        throw new VoiceAsrModelError('size_mismatch')
      }
      if (signal.aborted) throw new VoiceAsrModelError('cancelled')
      await rename(partPath, targetPath)
      this.receivedThisRound = 0
    } catch (error) {
      if (signal.aborted) throw new VoiceAsrModelError('cancelled')
      const failure = classifyError(error)
      throw new VoiceAsrModelError(failure === 'storage' || failure === 'size_mismatch' ? failure : 'network')
    } finally {
      clearTimeout(timeout!)
      signal.removeEventListener('abort', abort)
      // 非成功响应也要释放正文/连接，换源时不积压错误页。
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined)
    }
  }
}


/**
 * 读 `AILEARN_VOICE_ASR_SOURCE`：逗号分隔的地址列表，**顺序即优先级**。
 *
 * 为什么支持多个而不是一个：换源这件事最常见的形态是"镜像挂了，先用官方的"，
 * 一条环境变量就能表达，不必重启前改代码。给了空值 / 全是空白 → 用合同里的默认列表。
 */
export function voiceAsrModelSources(env: NodeJS.ProcessEnv): readonly VoiceAsrModelSourceV1[] {
  const raw = env.AILEARN_VOICE_ASR_SOURCE?.trim()
  if (!raw) return VOICE_ASR_MODEL_SOURCES
  const sources = raw
    .split(',')
    .map((entry, index) => entry.trim())
    .filter(Boolean)
    .map((baseUrl, index) => ({ id: `env-${index}`, name: `自定义源 ${index + 1}`, baseUrl }))
  return sources.length > 0 ? sources : VOICE_ASR_MODEL_SOURCES
}
