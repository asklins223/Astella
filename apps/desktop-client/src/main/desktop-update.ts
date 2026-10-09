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
 * ## macOS 安装签名
 *
 * macOS 使用完整 ZIP 下载与 SHA-512 校验，暂存并验证新包后，退出旧进程、
 * 同卷替换应用再启动。新包保留完整 ad-hoc 签名即可，无需 Apple 证书或
 * 旧包的跨版本签名要求；首次手动安装仍遵循系统的打开确认。
 */

import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { UpdateInstallReceiptStore } from './update-install-receipt'
import { macosAppBundle } from './macos-update-install'

import {
  updateStateV1Schema,
  type UpdatePhase,
  type UpdateStateV1,
} from '@astella/shared/desktop-ipc-contracts'

/** 检查结果缓存时长。GitHub 匿名限额是 60 次/小时/IP，6 小时一次对个人用户足够及时。 */
const CHECK_CACHE_MS = 6 * 60 * 60 * 1000

/**
 * Release 仓库。与 `electron-builder.yml` 的 `publish.github` 是同一处配置的两个
 * 副本——这里再写一遍，是为了让「去下载页」那条链接能自己算出来，而不用把整份
 * 打包配置读进运行时。**改仓库地址时两处要一起改。**
 */
const PUBLISH_OWNER = 'asklins223'
const PUBLISH_REPO = 'Astella'
const DESKTOP_TAG_PREFIX = 'v'

/**
 * Release 正文 → 纯文本。
 *
 * GitHub 的 release feed（`releases.atom` 里的 `<content type="html">`）交回来的是
 * **渲染后的 HTML**，而通知纸片与设置页都按纯文本显示它——不转的话用户读到的是
 * `<ul>` 和 `<li>` 这些标签本身。
 *
 * 只对带标签的正文调用它：实体解码不可逆，已经洗过的文本再过一遍会把正文里
 * 本来的尖括号（`v1<2`）当成标签吃掉。
 */
function plainTextReleaseNotes(notes: string): string {
  return notes
    .replace(/<br\s*\/?>\s*/gi, '\n')
    // 一个列表项在浏览器里就是一行：项内的换行是 markdown 的续行排版，不是分段，
    // 松散列表写进项里的那几个 <p> 也一并摊平。不折起来的话，通知纸片按要点取行时
    // 会把后半句当成另一段丢掉。
    .replace(/<li[^>]*>((?:(?!<\/?li\b|<[ou]l\b)[\s\S])*)<\/li>/gi,
      (_match, inner: string) => `<li>${inner.replace(/<\/?(?:p|div|blockquote)\s*>/gi, ' ').replace(/\s+/g, ' ').trim()}</li>`)
    // 列表项各占一行：项首换成「· 」，项尾给下一条留换行。GitHub 在块级标签之间
    // 排的空白是排版不是内容，一并吃掉；行内标签（strong / code / a）两侧的空格
    // 留着，那是真的词间空格。
    .replace(/\s*<li[^>]*>\s*/gi, '· ')
    .replace(/\s*<\/li\s*>\s*/gi, '\n')
    .replace(/\s*<(?:p|div|ul|ol|blockquote|h[1-6]|pre|table|thead|tbody|tr|td|th|section|article)[^>]*>\s*/gi, '\n')
    .replace(/\s*<\/(?:p|div|ul|ol|blockquote|h[1-6]|pre|table|thead|tbody|tr|td|th|section|article)\s*>\s*/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_entity, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_entity, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * `UpdateInfo.releaseNotes` 是 `string | ReleaseNoteInfo[] | null`——开了
 * `fullChangelog` 就是数组。逐条洗成纯文本再拼起来，数组按 `version` 去重后列出。
 */
function describeReleaseNotes(
  notes: string | { version?: string | null; note?: string | null }[] | null | undefined
): string | null {
  if (typeof notes === 'string') return plainTextReleaseNotes(notes) || null
  if (!Array.isArray(notes)) return null
  const lines = notes
    .map((entry) => {
      const text = plainTextReleaseNotes(typeof entry.note === 'string' ? entry.note : '')
      return text ? `${entry.version ?? ''}\n${text}`.trim() : ''
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

/**
 * 对应版本的 Release 页。
 *
 * macOS 更新签名无效时安装不了，界面要给出"去下载页手动装"的路——那条链接必须真的有
 * href，不能是个点了没反应的 `<a>`。按 tag 规则（v<version>）拼，
 * 与 `.github/scripts/desktop-version.mjs` 的 DESKTOP_TAG_PREFIX 是同一套约定。
 */
function releasePageUrl(version: string): string {
  return `https://github.com/${PUBLISH_OWNER}/${PUBLISH_REPO}/releases/tag/${DESKTOP_TAG_PREFIX}${version}`
}

interface PersistedCheck {
  readonly checkedAt: number
  readonly state: UpdateStateV1
}

let currentState: UpdateStateV1 | null = null
let autoUpdater: import('electron-updater').AppUpdater | null = null
let macosUpdater: import('./macos-archive-updater').MacosArchiveUpdater | null = null

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

/** 原始更新错误可能带本机路径、响应正文或栈；界面只展示能指导下一步的原因。 */
function updateFailureMessage(error: unknown, action: Exclude<UpdateOperation, null>): string {
  const detail = error instanceof Error ? error.message : String(error ?? '')
  if (/^MAC_UPDATE_(LOCATION|PERMISSION):/.test(detail)) return detail.replace(/^MAC_UPDATE_[A-Z]+: /, '')
  if (/app-update\.ya?ml|dev-app-update\.ya?ml/i.test(detail)) return '这份安装包缺少更新配置，请使用正式安装包后再检查。'
  if (/rate limit|\b429\b/i.test(detail)) return 'GitHub 的查询次数用完了，请稍后再检查。'
  if (/ENOSPC|no space left/i.test(detail)) return '设备可用空间不足，请腾出空间后重试。'
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|network|timeout/i.test(detail)) return '暂时无法连接更新服务，请检查网络后重试。'
  // 签名类失败说的是**这台电脑上的书房本身**，不是刚下下来的那份包：让用户
  // 「重新下载」是让他把同一件事再失败一遍。分开说，他才知道自己该去下载页手动装。
  if (/signature|code sign|not signed|signed with|sbvalidate|SecStatic/i.test(detail)) {
    return '新版本的应用校验未通过，已保留当前书房。请重新下载或到下载页手动安装。'
  }
  if (/sha512|checksum/i.test(detail)) return '安装包校验未通过，请重新下载或到下载页获取安装包。'
  if (/\b404\b|release.*not found|no published versions/i.test(detail)) return '更新服务暂时没有可用的发布版本，请稍后再检查。'
  return action === 'check' ? '暂时没拿到新版本信息，请稍后再检查。' : action === 'download' ? '这次下载没有完成，可以稍后重试。' : '这次安装没有完成，请到下载页手动安装。'
}

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
    window.webContents.send('astella.v1.update.state', next)
  }
  return next
}

export function getUpdateState(): UpdateStateV1 {
  return currentState ?? initialState()
}

function receiptStore(): UpdateInstallReceiptStore {
  return new UpdateInstallReceiptStore(app.getPath('userData'))
}

function loadPersistedCheck(): PersistedCheck | null {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as PersistedCheck
    if (typeof parsed?.checkedAt !== 'number') return null
    // 过期的结果只用来填"上次查过"，不再当成有效结论。
    if (Date.now() - parsed.checkedAt > CHECK_CACHE_MS) return null
    const checked = updateStateV1Schema.safeParse(parsed.state)
    if (!checked.success || checked.data.currentVersion !== app.getVersion()) return null
    // 修复之前落盘的缓存写着 GitHub 的 HTML 正文，读出来时洗一次。已经处理过的
    // 纯文本不再过第二遍——实体解码不可逆，跑两遍会把正文里本来的尖括号吃掉。
    const stillCarriesMarkup = /<\/?[a-z][^>]*>/i.test(checked.data.releaseNotes ?? '')
    return {
      checkedAt: parsed.checkedAt,
      state: { ...checked.data, currentVersion: app.getVersion(), installBlockedReason: null,
        installedUpdate: getUpdateState().installedUpdate ?? null,
        releaseNotes: stillCarriesMarkup ? describeReleaseNotes(checked.data.releaseNotes) : checked.data.releaseNotes },
    }
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
    let loaded: import('electron-updater').AppUpdater
    if (process.platform === 'darwin') {
      const { MacosArchiveUpdater } = await import('./macos-archive-updater')
      macosUpdater = new MacosArchiveUpdater()
      loaded = macosUpdater
    } else {
      loaded = (await import('electron-updater')).autoUpdater
    }
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
          fileSize: firstFileSize(process.platform === 'darwin' ? { files: info.files?.filter(file => file.url.endsWith(`-${process.arch}.zip`) || file.url.endsWith('-universal.zip')) } : info),
          // macOS 未签名那条提示里的「下载页」靠这个字段；没有它那条链接点不动。
          releaseUrl: releasePageUrl(info.version),
          message: null,
          installBlockedReason: null,
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
      if (operation === 'check') unreachable(updateFailureMessage(error, 'check'))
      else failed(updateFailureMessage(error, operation ?? 'download'))
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

  if (operation || getUpdateState().phase === 'ready') return getUpdateState()

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
    return unreachable(updateFailureMessage(error, 'check'))
  } finally {
    operation = null
  }
}

export async function downloadUpdate(): Promise<UpdateStateV1> {
  if (operation || getUpdateState().phase === 'ready') return getUpdateState()
  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')
  operation = 'download'
  try {
    await updater.downloadUpdate()
    return getUpdateState()
  } catch (error) {
    return failed(updateFailureMessage(error, 'download'))
  } finally {
    operation = null
  }
}

export async function installUpdate(): Promise<UpdateStateV1> {
  const updater = await loadAutoUpdater()
  if (!updater) return failed('更新模块加载失败。')

  if (operation || getUpdateState().phase !== 'ready') return getUpdateState()

  operation = 'install'
  try {
    const state = getUpdateState()
    const prepared = macosUpdater ? await macosUpdater.prepareInstall() : null
    receiptStore().write({ fromVersion: app.getVersion(), version: state.availableVersion!, status: 'pending',
      ...(prepared ? { stagingDirectory: prepared.stagingDirectory } : {}) })
    if (prepared) {
      await prepared.launch()
      app.quit()
    } else updater.quitAndInstall(false, true)
    return getUpdateState()
  } catch (error) {
    return failed(updateFailureMessage(error, 'install'))
  } finally {
    operation = null
  }
}

/** 应用启动时先拿上一次的结果打底，避免界面在第一次联网前一直空着。 */
export function primeUpdateStateFromCache(): void {
  let receipt: import('./update-install-receipt').UpdateInstallReceipt | null = null
  try { receipt = receiptStore().reconcile(app.getVersion()) }
  catch { /* A receipt write failure must not prevent opening the room. */ }
  // Also recognize successful installs performed by an older updater, which did
  // not write an intent receipt but did persist the previous and target version.
  if (!receipt && !receiptStore().read()) {
    try {
      const old = updateStateV1Schema.parse(JSON.parse(readFileSync(statePath(), 'utf8')).state)
      if (old.currentVersion !== app.getVersion() && old.availableVersion === app.getVersion()) {
        receiptStore().write({ fromVersion: old.currentVersion, version: app.getVersion(), status: 'completed' })
        receipt = receiptStore().read()
      }
    } catch { /* No reliable record of an update. */ }
  }
  const cached = loadPersistedCheck()
  publish({ ...(cached?.state ?? initialState()),
    installedUpdate: receipt?.status === 'completed' ? { fromVersion: receipt.fromVersion, version: receipt.version } : null,
    ...(receipt?.status === 'failed' ? { phase: 'failed', message: '重启后仍未完成更新，已保留原来的书房。请重新下载并安装。' } : {}),
  })
}

export function acknowledgeInstalledUpdate(version: string): UpdateStateV1 {
  if (getUpdateState().installedUpdate?.version !== version) return getUpdateState()
  const receipt = receiptStore().read()
  receiptStore().acknowledge(version)
  // Keep the rollback bundle until the new renderer really presents the receipt.
  const staging = receipt?.stagingDirectory
  if (receipt?.status === 'completed' && staging && dirname(staging) === dirname(macosAppBundle()) && staging.startsWith(join(dirname(macosAppBundle()), '.astella-update-'))) {
    void rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  return publish({ ...getUpdateState(), installedUpdate: null })
}

/**
 * 只给测试用：清掉模块级的三个单例。
 *
 * `currentState` / `autoUpdater` / `macosUpdateBlocked` 是这个模块的私有状态，
 * 而 `electron-updater` 只在第一次调用时加载——测试之间不复位的话，第二条用例
 * 会拿到上一条留下的 autoUpdater，整个文件只能跑第一条。
 * 生产代码路径里没有任何地方调用它。
 */
export function resetUpdateModuleForTests(): void {
  currentState = null
  autoUpdater = null
  macosUpdater = null
  operation = null
}
