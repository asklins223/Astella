import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  companionModelInstalledMarkerV1Schema,
  type CompanionModelId,
  type CompanionModelManifestFileV1,
  type CompanionModelManifestV1,
} from '@astella/shared/companion-model-contracts'
import { DesktopGatewayFailure } from '../gateway/desktop-gateway-failure'

/**
 * 伴星 Live2D 模型的**本机仓库**（2026-11-18）。
 *
 * 一条模型一份实例，落点 `<companion-models>/<modelId>/`。三件事在这里收口：
 *  1. 下载：清单来自服务端（已登录会话），逐文件写 `.part`，字节数与 SHA-256
 *     都对上才 `rename` 成正式文件；任何一步失败都整份丢弃——入口只认整份装好。
 *  2. 安装标记：`installed.json` 是「整份装好」的唯一凭据，同时是路由的准入名单
 *     （只有标记里列出的路径可读）。
 *  3. 版本：标记与本次清单不一致时整份重下；不做增量拼接。
 *
 * 失败分类只服务界面文案：网络 / 存储服务 / 文件校验 / 磁盘 / 用户中止。
 */

export type CompanionModelFailure = 'network' | 'storage' | 'integrity' | 'disk' | 'cancelled'

export type CompanionModelFileOpener = (
  file: CompanionModelManifestFileV1,
  signal: AbortSignal,
) => Promise<Response>

export interface CompanionModelStoreDeps {
  /** 经网关取清单（服务端 `/companion/model/manifest`）。 */
  fetchManifest: (signal: AbortSignal) => Promise<CompanionModelManifestV1>
  /** 取一份文件的字节流；远程存储是签名 URL，本地存储走会话授权。 */
  openFile: CompanionModelFileOpener
  now?: () => Date
}

export interface CompanionModelLocalState {
  readonly status: 'absent' | 'downloading' | 'verifying' | 'ready' | 'failed'
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly installedVersion: string | null
  readonly failure: CompanionModelFailure | null
}

const MARKER_NAME = 'installed.json'

class CompanionModelStoreError extends Error {
  constructor(readonly failure: CompanionModelFailure) {
    super(failure)
    this.name = 'CompanionModelStoreError'
  }
}

function classifyFailure(error: unknown): CompanionModelFailure {
  if (error instanceof CompanionModelStoreError) return error.failure
  if (error instanceof DesktopGatewayFailure) {
    if (error.code === 'cancelled') return 'cancelled'
    if (error.code === 'api_unavailable' || error.code === 'network_timeout') return 'network'
    return 'storage'
  }
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'disk'
  if ((error as Error)?.name === 'AbortError') return 'cancelled'
  return 'network'
}

function isWithin(parent: string, child: string): boolean {
  const parentResolved = resolve(parent)
  const childResolved = resolve(child)
  return childResolved === parentResolved || childResolved.startsWith(`${parentResolved}/`)
}

export class CompanionModelStore {
  readonly modelId: CompanionModelId
  readonly directory: string
  private readonly deps: CompanionModelStoreDeps
  private readonly now: () => Date
  private manifest: CompanionModelManifestV1 | null = null
  private transfer: AbortController | null = null
  private activeRun: Promise<void> | null = null
  private failure: CompanionModelFailure | null = null
  private receivedThisRound = 0
  private totalThisRound = 0

  constructor(modelId: CompanionModelId, root: string, deps: CompanionModelStoreDeps) {
    this.modelId = modelId
    this.directory = join(root, modelId)
    this.deps = deps
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * 启动时清掉装了一半的目录。
   *
   * 判据是安装标记本身：标记缺失、损坏或与磁盘对不上，就整份删掉。不做续传——
   * 半截文件既不能读，又会让「占了多少空间」这句话算不准。
   */
  async sweepPartialFiles(): Promise<void> {
    const marker = await this.readMarker()
    if (marker) return
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  async state(): Promise<CompanionModelLocalState> {
    if (this.transfer) {
      const totalBytes = this.totalThisRound
      return {
        status: 'downloading',
        receivedBytes: Math.min(totalBytes, this.receivedThisRound),
        totalBytes,
        installedVersion: null,
        failure: null,
      }
    }
    const marker = await this.readMarker()
    if (marker) {
      const bytes = marker.files.reduce((total, file) => total + file.byteLength, 0)
      return { status: 'ready', receivedBytes: bytes, totalBytes: bytes, installedVersion: marker.modelVersion, failure: null }
    }
    if (this.failure && this.failure !== 'cancelled') {
      return { status: 'failed', receivedBytes: 0, totalBytes: this.totalThisRound, installedVersion: null, failure: this.failure }
    }
    return { status: 'absent', receivedBytes: 0, totalBytes: this.totalThisRound, installedVersion: null, failure: null }
  }

  async installedVersion(): Promise<string | null> {
    return (await this.readMarker())?.modelVersion ?? null
  }

  /**
   * 路由侧的唯一读口：只认标记里的文件，路径越界/未登记一律返回 null。
   * 字节数与标记不一致也当读不到——那说明目录被人动过，不拿坏文件去渲染。
   */
  async resolveReadableFile(relativePath: string): Promise<{ path: string; contentType: string; byteLength: number } | null> {
    const marker = await this.readMarker()
    if (!marker) return null
    const entry = marker.files.find((file) => file.path === relativePath)
    if (!entry) return null
    const absolute = resolve(this.directory, entry.path)
    if (!isWithin(this.directory, absolute)) return null
    try {
      const info = await stat(absolute)
      if (!info.isFile() || info.size !== entry.byteLength) return null
    } catch {
      return null
    }
    return { path: absolute, contentType: entry.contentType, byteLength: entry.byteLength }
  }

  /** 下载是长任务：发起即返回，进度靠再读状态拿（与识别模型同一口径）。 */
  startDownload(): void {
    if (this.activeRun) return
    const run = this.run().finally(() => {
      if (this.activeRun === run) this.activeRun = null
    })
    this.activeRun = run
  }

  /** 等这一轮下载落定（成功、失败或被中止）。测试与关机清理用。 */
  async whenIdle(): Promise<void> {
    await this.activeRun
  }

  async cancel(): Promise<void> {
    const run = this.activeRun
    if (!run) return
    this.transfer?.abort()
    await run
  }

  async remove(): Promise<void> {
    await this.cancel()
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
    this.failure = null
    this.totalThisRound = 0
  }

  private async run(): Promise<void> {
    const controller = new AbortController()
    this.transfer = controller
    this.failure = null
    this.receivedThisRound = 0
    this.totalThisRound = 0
    try {
      const manifest = await this.deps.fetchManifest(controller.signal)
      if (manifest.modelId !== this.modelId) throw new CompanionModelStoreError('integrity')
      this.manifest = manifest
      this.totalThisRound = manifest.files.reduce((total, file) => total + file.byteLength, 0)
      // 版本升级与上次装坏一律整份重来：标记是「整份装好」的唯一凭据。
      await rm(this.directory, { recursive: true, force: true })
      await mkdir(this.directory, { recursive: true })
      for (const file of manifest.files) {
        if (controller.signal.aborted) throw new CompanionModelStoreError('cancelled')
        await this.downloadFile(file, controller.signal)
      }
      await this.writeMarker(manifest)
    } catch (error) {
      const failure = controller.signal.aborted ? 'cancelled' : classifyFailure(error)
      this.failure = failure
      await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
      this.receivedThisRound = 0
    } finally {
      this.transfer = null
    }
  }

  private async downloadFile(file: CompanionModelManifestFileV1, signal: AbortSignal): Promise<void> {
    const target = resolve(this.directory, file.path)
    if (!isWithin(this.directory, target)) throw new CompanionModelStoreError('integrity')
    await mkdir(dirname(target), { recursive: true })
    const partPath = `${target}.part`
    const response = await this.deps.openFile(file, signal)
    if (!response.ok || !response.body) throw new CompanionModelStoreError('network')
    const handle = await open(partPath, 'w')
    const hash = createHash('sha256')
    let written = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (signal.aborted) throw new CompanionModelStoreError('cancelled')
        written += chunk.value.byteLength
        if (written > file.byteLength) throw new CompanionModelStoreError('integrity')
        hash.update(chunk.value)
        await handle.write(chunk.value)
        this.receivedThisRound += chunk.value.byteLength
      }
    } finally {
      await handle.close()
    }
    if (written !== file.byteLength || hash.digest('hex') !== file.sha256) {
      throw new CompanionModelStoreError('integrity')
    }
    await rename(partPath, target)
  }

  private async writeMarker(manifest: CompanionModelManifestV1): Promise<void> {
    const marker = companionModelInstalledMarkerV1Schema.parse({
      version: 1,
      modelId: this.modelId,
      modelVersion: manifest.modelVersion,
      installedAt: this.now().toISOString(),
      files: manifest.files.map((file) => ({
        path: file.path,
        contentType: file.contentType,
        byteLength: file.byteLength,
        sha256: file.sha256,
      })),
    })
    const markerPath = join(this.directory, MARKER_NAME)
    const partPath = `${markerPath}.part`
    const handle = await open(partPath, 'w')
    try {
      await handle.write(JSON.stringify(marker))
    } finally {
      await handle.close()
    }
    await rename(partPath, markerPath)
  }

  private async readMarker() {
    try {
      const parsed = companionModelInstalledMarkerV1Schema.safeParse(
        JSON.parse(await readFile(join(this.directory, MARKER_NAME), 'utf8')),
      )
      if (!parsed.success || parsed.data.modelId !== this.modelId) return null
      for (const file of parsed.data.files) {
        const absolute = resolve(this.directory, file.path)
        if (!isWithin(this.directory, absolute)) return null
        const info = await stat(absolute)
        if (!info.isFile() || info.size !== file.byteLength) return null
      }
      return parsed.data
    } catch {
      return null
    }
  }

  /** 最近一次清单（仅本进程内有效），给状态接口补总量用。 */
  get fetchedManifest(): CompanionModelManifestV1 | null {
    return this.manifest
  }
}