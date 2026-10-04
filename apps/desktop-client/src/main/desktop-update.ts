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

interface PersistedCheck {
  readonly checkedAt: number
  readonly state: UpdateStateV1
}

let currentState: UpdateStateV1 | null = null
let autoUpdater: import('electron-updater').AppUpdater | null = null
let macosUnsigned: boolean | null = null

function statePath(): string {
  return join(app.getPath('userData'), 'update-state.json')
}

function initialState(): UpdateStateV1 {
  return updateStateV1Schema.parse({
    phase: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseNotes: null,
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
          releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
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
      failed(error.message || '更新失败')
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
  }
}

export async function downloadUpdate(): Promise<UpdateStateV1> {
  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')
  try {
    await updater.downloadUpdate()
    return getUpdateState()
  } catch (error) {
    return failed(error instanceof Error ? error.message : '下载失败。')
  }
}

export async function installUpdate(): Promise<UpdateStateV1> {
  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')

  if (detectMacosUnsigned()) {
    // 与其让 Squirrel 抛一个签名错误，不如提前把话说清楚。
    return failed('这份 macOS 安装包没有代码签名，系统不允许自动替换应用。请到下载页手动安装。')
  }

  try {
    updater.quitAndInstall(false, true)
    return getUpdateState()
  } catch (error) {
    return failed(error instanceof Error ? error.message : '安装失败。')
  }
}

/** 应用启动时先拿上一次的结果打底，避免界面在第一次联网前一直空着。 */
export function primeUpdateStateFromCache(): void {
  const cached = loadPersistedCheck()
  if (cached) publish(cached.state)
}