/**
 * 桌面端自动更新。
 *
 * ## 更新源为什么不经过自家服务端
 *
 * 检查走 `api.github.com`，安装包走 GitHub 的 CDN，`apps/api` 完全不在这条链路上。
 * 更新带宽不落在自家服务器上，自家 API 挂掉也不影响用户升级。
 *
 * 代价是 GitHub 匿名 API 有 **60 次/小时/IP** 的限额。公司 NAT 后面的一整层办公网
 * 共用一个出口 IP，很容易撞上。所以本模块做了两件事：
 *
 * 1. 检查结果落盘缓存（`update-state.json`），默认 6 小时内的结果直接复用；
 * 2. 把「拿不到更新信息」和「更新本身坏了」分成两个 phase（`unreachable` / `failed`）。
 *    前者只是"这次没问到"，后者才是"更新坏了"——对用户是两种完全不同的处境，
 *    渲染层也要能说出两句不同的话。
 *
 * ## macOS 未签名
 *
 * Squirrel.Mac（`electron-updater` 在 macOS 上的实现）会校验新旧两个 .app 的代码
 * 签名是否同一开发者，**未签名的应用下载得到、装不上**。仓库目前没有 Apple 证书，
 * 所以 macOS 的自动安装现在走不通。与其让用户点完"重启安装"再看到一个没头没尾的
 * 失败，不如在状态里如实标出 `installBlockedReason`，让界面提前说明。
 *
 * Windows 的 NSIS 路线没有这个约束，未签名可用。
 */

import { app, BrowserWindow } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  updateStateV1Schema,
  type UpdatePhase,
  type UpdateStateV1,
} from '@ailearn/shared/desktop-ipc-contracts'

/** 检查结果缓存时长。GitHub 匿名限额是 60 次/小时/IP，6 小时一次对个人用户足够及时。 */
const CHECK_CACHE_MS = 6 * 60 * 60 * 1000
/** 单次检查的网络超时，避免窗口一直挂在"正在检查"。 */
const CHECK_TIMEOUT_MS = 30_000

/**
 * Release 仓库。与 `electron-builder.yml` 的 `publish.github` 是同一处配置的两个
 * 副本——这里再写一遍，是为了让「去下载页」那条链接能自己算出来，而不用把整份
 * 打包配置读进运行时。**改仓库地址时两处要一起改。**
 */
const PUBLISH_OWNER = 'asklins223'
const PUBLISH_REPO = 'ai-learning-system'
const DESKTOP_TAG_PREFIX = 'desktop-v'

/**
 * 对应版本的 Release 页。
 *
 * macOS 未签名时安装不了，界面要给出"去下载页手动装"的路——那条链接必须真的有
 * href，不能是个点了没反应的 `<a>`。按 tag 规则（desktop-v<version>）拼，
 * 与 `.github/scripts/desktop-version.mjs` 的 DESKTOP_TAG_PREFIX 是同一套约定。
 */
/**
 * `UpdateInfo.releaseNotes` 是 `string | ReleaseNoteInfo[] | null`——开了
 * `fullChangelog` 就是数组。拼成纯文本，数组按 `version` 去重后逐条列出。
 */
function describeReleaseNotes(
  notes: string | { version?: string | null; note?: string | null }[] | null | undefined
): string | null {
  if (typeof notes === 'string') return notes.trim() ? notes.trim() : null
  if (!Array.isArray(notes)) return null
  const lines = notes
    .map((entry) => {
      const text = typeof entry.note === 'string' ? entry.note.trim() : ''
      return text ? `## ${entry.version ?? ''}\n${text}`.trim() : ''
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n\n') : null
}

/**
 * 安装包大小。
 *
 * 取 `files[0].size`——`latest.yml` / `latest-mac.yml` 里由 electron-builder 写下的
 * 真实字节数。取不到就返回 null，**不拿下载进度里的 total 顶替**：那要等开始下载
 * 才知道，而用户是在"还没下载、正在决定要不要更新"的时候就想知道多大。
 */
function firstFileSize(info: { files?: readonly { size?: number }[] }): number | null {
  const file = info.files?.find((entry) => typeof entry.size === 'number')
  return typeof file?.size === 'number' ? file.size : null
}

function releasePageUrl(version: string): string {
  return `https://github.com/${PUBLISH_OWNER}/${PUBLISH_REPO}/releases/tag/${DESKTOP_TAG_PREFIX}${version}`
}

interface PersistedCheck {
  readonly checkedAt: number
  readonly state: UpdateStateV1
}

let currentState: UpdateStateV1 | null = null
let autoUpdater: import('electron-updater').AppUpdater | null = null
let macosUnsigned: boolean | null = null

/**
 * 当前正在做的是哪一步。
 *
 * ## 为什么必须区分
 *
 * `electron-updater` 把两类完全不同的事都塞进 `error` 事件：查不到版本信息
 * （GitHub 403 限额、断网）和更新本身真的坏了（校验不过、装不上）。
 * 前者是"没问到"，后者是"坏了"，对用户是两句话。
 *
 * 不区分的话，一次限额会先被 error 事件判成 `failed`（渲染层据此弹一条
 * "这次更新没能完成"），随后 checkForUpdates 的 catch 又把它改成 `unreachable`——
 * 也就是说**用户会收到一条纯属捏造的失败通知**，而实际上更新啥事都没发生。
 */
type UpdateOperation = 'check' | 'download' | 'install' | null
let operation: UpdateOperation = null

function statePath(): string {
  return join(app.getPath('userData'), 'update-state.json')
}

function initialState(): UpdateStateV1 {
  return updateStateV1Schema.parse({
    phase: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseNotes: null,
    releaseName: null,
    releaseDate: null,
    fileSize: null,
    releaseUrl: null,
    percent: null,
    transferred: null,
    total: null,
    message: null,
    installBlockedReason: null,
    checkedAt: null,
  })
}

/** 状态只往一个方向推给所有窗口；新窗口自己调 `getState` 补齐当前快照。 */
function publish(next: UpdateStateV1): UpdateStateV1 {
  currentState = next
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send('ailearn.v1.update.state', next)
  }
  return next
}

export function getUpdateState(): UpdateStateV1 {
  return currentState ?? initialState()
}

/**
 * 判断 macOS 当前这份 app 到底签没签。
 *
 * 用 `codesign -dv` 真问一次系统，而不是猜：它对未签名的 bundle 返回非零并在
 * stderr 里写 "code object is not signed at all"。只在 macOS 且已打包时问——
 * 开发模式下 `electron .` 跑的是未签名的 Electron，结果没有参考意义。
 */
function detectMacosUnsigned(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  if (macosUnsigned !== null) return macosUnsigned

  // app.getAppPath() 在打包后是 `<Bundle>.app/Contents/Resources/app.asar`，
  // 往上三层才是真正的 .app —— codesign 只认 bundle。
  const bundle = join(app.getAppPath(), '..', '..', '..')
  if (!existsSync(bundle)) {
    macosUnsigned = false
    return macosUnsigned
  }
  const probe = spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8' })
  const detail = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
  macosUnsigned = probe.status !== 0 || /not signed|unsigned/i.test(detail)
  return macosUnsigned
}

function loadPersistedCheck(): PersistedCheck | null {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as PersistedCheck
    if (typeof parsed?.checkedAt !== 'number') return null
    // 过期的结果只用来填"上次查过"，不再当成有效结论。
    if (Date.now() - parsed.checkedAt > CHECK_CACHE_MS) return null
    return updateStateV1Schema.safeParse(parsed.state).success ? parsed : null
  } catch {
    return null
  }
}

function persistCheck(state: UpdateStateV1): void {
  try {
    const target = statePath()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ checkedAt: Date.now(), state } satisfies PersistedCheck))
  } catch {
    // 缓存写不进去只是下次多查一次，不该影响更新本身。
  }
}

function unreachable(message: string): UpdateStateV1 {
  return publish(
    updateStateV1Schema.parse({
      ...getUpdateState(),
      phase: 'unreachable' satisfies UpdatePhase,
      percent: null,
      message,
    }),
  )
}

function failed(message: string): UpdateStateV1 {
  return publish(
    updateStateV1Schema.parse({
      ...getUpdateState(),
      phase: 'failed' satisfies UpdatePhase,
      percent: null,
      message,
    }),
  )
}

/**
 * 懒加载 `electron-updater`。
 *
 * 它只能在主进程用：模块顶层会摸 `process.platform` 并 require 对应平台的
 * Updater 实现。放在函数里是为了让**开发模式**完全不必加载它——`npm run dev`
 * 跑的是未签名的 Electron，联网查更新只会得到一个必然失败的结论。
 */
async function loadAutoUpdater(): Promise<import('electron-updater').AppUpdater | null> {
  if (autoUpdater) return autoUpdater
  if (!app.isPackaged) return null

  try {
    const { autoUpdater: loaded } = await import('electron-updater')
    loaded.autoDownload = false
    loaded.autoInstallOnAppQuit = false
    loaded.logger = null

    loaded.on('checking-for-update', () => {
      publish(updateStateV1Schema.parse({ ...getUpdateState(), phase: 'checking', message: null }))
    })

    loaded.on('update-available', (info) => {
      publish(
        updateStateV1Schema.parse({
          ...getUpdateState(),
          phase: 'available',
          availableVersion: info.version,
          releaseNotes: describeReleaseNotes(info.releaseNotes),
          // 有标题就先给人看标题——它通常比自动生成的 notes 更像一句人话。
          releaseName: typeof info.releaseName === 'string' && info.releaseName ? info.releaseName : null,
          // 发布时刻与安装包大小：用户问"这次更新是什么、多大、什么时候的"，
          // 答案全在这三个字段里，对端本来就有，不取等于白放着。
          releaseDate: typeof info.releaseDate === 'string' && info.releaseDate ? info.releaseDate : null,
          fileSize: firstFileSize(info),
          // macOS 未签名那条提示里的「下载页」靠这个字段；没有它那条链接点不动。
          releaseUrl: releasePageUrl(info.version),
          message: null,
          installBlockedReason: detectMacosUnsigned() ? 'macosUnsigned' : null,
        }),
      )
    })

    loaded.on('update-not-available', () => {
      publish(
        updateStateV1Schema.parse({
          ...getUpdateState(),
          phase: 'upToDate',
          availableVersion: null,
          // 一起清掉：不然"已是最新"的状态上还挂着上一版的版本号、大小和日期，
          // 读起来像"最新版本有 250MB、昨天发的"，那是在骗人。
          releaseNotes: null,
          releaseName: null,
          releaseDate: null,
          fileSize: null,
          percent: null,
          message: null,
        }),
      )
    })

    loaded.on('download-progress', (progress) => {
      publish(
        updateStateV1Schema.parse({
          ...getUpdateState(),
          phase: 'downloading',
          // 真实字节数，不是假动画：progress.percent 在极慢的连接下长时间停在 0。
          percent: Math.round(progress.percent),
          transferred: progress.transferred,
          total: progress.total,
        }),
      )
    })

    loaded.on('update-downloaded', (info) => {
      publish(
        updateStateV1Schema.parse({
          ...getUpdateState(),
          phase: 'ready',
          availableVersion: info.version,
          percent: 100,
          message: null,
        }),
      )
    })

    loaded.on('error', (error: Error) => {
      // 检查阶段的失败是"没问到"，不是"更新坏了"——见 UpdateOperation 的说明。
      if (operation === 'check') unreachable(error.message || '暂时拿不到更新信息。')
      else failed(error.message || '更新失败')
    })

    autoUpdater = loaded
    return autoUpdater
  } catch (error) {
    return null
  }
}

export async function checkForUpdates(options: { userInitiated: boolean }): Promise<UpdateStateV1> {
  if (!app.isPackaged) {
    // 开发模式下如实说明"这里没有可更新的东西"，而不是去查一个装不上的版本。
    return publish(
      updateStateV1Schema.parse({
        ...getUpdateState(),
        phase: 'upToDate',
        availableVersion: null,
        message: '开发模式下不检查更新。',
      }),
    )
  }

  if (!options.userInitiated) {
    const cached = loadPersistedCheck()
    if (cached) return publish(cached.state)
  }

  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')

  publish(updateStateV1Schema.parse({ ...getUpdateState(), phase: 'checking', message: null }))
  operation = 'check'

  try {
    const result = await updater.checkForUpdates()
    // electron-updater 把"查不到版本信息"也塞进 error 事件（含 403 限额、网络不通）。
    // 那不是更新坏了，是我们没问到 —— 落到 unreachable，让界面说"暂时没拿到新版本"。
    if (result?.updateInfo) {
      persistCheck(getUpdateState())
    }
    return getUpdateState()
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : '暂时拿不到更新信息。')
  } finally {
    operation = null
  }
}

export async function downloadUpdate(): Promise<UpdateStateV1> {
  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')
  operation = 'download'
  try {
    await updater.downloadUpdate()
    return getUpdateState()
  } catch (error) {
    return failed(error instanceof Error ? error.message : '下载失败。')
  } finally {
    operation = null
  }
}

export async function installUpdate(): Promise<UpdateStateV1> {
  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')

  if (detectMacosUnsigned()) {
    // 与其让 Squirrel 抛一个签名错误，不如提前把话说清楚。
    return failed('这份 macOS 安装包没有代码签名，系统不允许自动替换应用。请到下载页手动安装。')
  }

  operation = 'install'
  try {
    updater.quitAndInstall(false, true)
    return getUpdateState()
  } catch (error) {
    return failed(error instanceof Error ? error.message : '安装失败。')
  } finally {
    operation = null
  }
}

/** 应用启动时先拿上一次的结果打底，避免界面在第一次联网前一直空着。 */
export function primeUpdateStateFromCache(): void {
  const cached = loadPersistedCheck()
  if (cached) publish(cached.state)
}

/**
 * 只给测试用：清掉模块级的三个单例。
 *
 * `currentState` / `autoUpdater` / `macosUnsigned` 是这个模块的私有状态，
 * 而 `electron-updater` 只在第一次调用时加载——测试之间不复位的话，第二条用例
 * 会拿到上一条留下的 autoUpdater，整个文件只能跑第一条。
 * 生产代码路径里没有任何地方调用它。
 */
export function resetUpdateModuleForTests(): void {
  currentState = null
  autoUpdater = null
  macosUnsigned = null
  operation = null
}