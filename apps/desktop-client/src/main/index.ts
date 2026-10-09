import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  protocol,
  session,
  systemPreferences,
  type WebContents
} from 'electron'
import { appendFileSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { createAssetResponsePlan, mimeTypeForPath } from './asset-response'
import { VoiceAsrModelStore, voiceAsrModelSources } from './voice-asr-model-store'
import { CompanionVoiceAudioCache } from './companion-voice-audio-cache'
import { CompanionMessageAudioCache } from './companion-message-audio-cache'
import { primeUpdateStateFromCache } from './desktop-update'
import { voiceAsrModelDirectory } from '../shared/voice-asr-model-path'
import { createVoiceAsrModelResponder } from './voice-asr-model-route'
import { createAvatarImageStore } from './avatar-image-store'
import { createNoteImageStore } from './note-image-store'
import { VOICE_ASR_MODEL_ROUTE_PREFIX } from '@astella/shared/voice-asr-model-contracts'
import { ARTIFACT_HOST, isArtifactFrameUrl, isArtifactId } from '../shared/artifact-frame'
import {
  artifactDocumentContentSecurityPolicy,
  artifactFrameOrigin,
  assembleArtifactDocument,
  classifyFramePolicySubject,
  isAllowedSubFrameNavigation,
  rejectAllContentSecurityPolicy
} from './artifact-surface'
import { nativeWindowChrome, titleBarOverlayForTheme } from './window-chrome'
import { installWindowZoomShortcuts } from './window-zoom'
import {
  WINDOW_STATE_CHANNEL,
  WINDOW_STATE_SNAPSHOT_CHANNEL,
  resolveWindowState,
  type AstellaWindowState,
  type WindowStateSnapshot,
  TITLE_BAR_THEME_CHANNEL,
} from '../shared/window-state'
import {
  HOME_WINDOW_INITIAL_CONTENT_SIZE,
  HOME_WINDOW_MINIMUM_SIZE
} from '../shared/window-geometry'
import { registerM1DesktopIpc } from './desktop-ipc'
import { desktopDeploymentEnvironment } from './desktop-deployment'
import { FilePendingReturnMarkerStore } from './pending-return-marker-store'
import { FileNoteDocCacheStore } from './note-doc-cache-store'
import { guardProcessOutputStreams } from './output-stream-guard'
import { configureDesktopAppIdentity } from './desktop-app-identity'
import { DesktopRenderingPreferences, registerDesktopRenderingHealthMonitor, registerDesktopRenderingIpc } from './desktop-rendering'
import { DESKTOP_RENDERING_STATE_CHANNEL } from '../shared/desktop-rendering'

// 主进程的第一件事：stdout/stderr 的写失败（终端关掉后的 EIO/EPIPE）不能再升级成
// 未捕获异常——那会弹出一个阻塞整个应用的模态框，而原因只是"没人再读日志"。
// 现场与理由见 output-stream-guard.ts。
guardProcessOutputStreams(process.stdout, process.stderr)

configureDesktopAppIdentity(app)

// GPU backend selection is startup-only. Loading this after ready is too late.
const desktopRendering = new DesktopRenderingPreferences(
  resolve(app.getPath('userData'), 'desktop-rendering.json'), app,
)
registerDesktopRenderingHealthMonitor(app, desktopRendering, traceBoot)

const APP_SCHEME = 'astella-app'
const APP_HOST = 'bundle'
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

// Chromium cannot initialize its own sandbox from inside a restricted
// environment (CI containers, sandboxed agent shells): every child process then
// dies with "sandbox initialization failed: Operation not permitted" until the
// GPU process gives up and the app exits with "GPU process isn't usable". This
// mirrors the capture scripts' opt-in `ASTELLA_CAPTURE_NO_SANDBOX`, so an
// ordinary local run keeps Electron's sandbox in place.
if (process.env.ASTELLA_ELECTRON_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
      stream: true
    }
  }
])

function response(
  status: number,
  message: string,
  method: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): Response {
  const body = method === 'HEAD' ? null : message

  return new Response(body, {
    status,
    headers: {
      'Content-Length': String(Buffer.byteLength(message)),
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders
    }
  })
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)

  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

/**
 * 产物在本机的落点：`<userData>/artifacts/<artifactId>.html`。
 *
 * 路径安全靠 `artifactId` 的形状（只认 uuid，见 `shared/artifact-frame.ts`）：没有 `..`、
 * 没有分隔符可写，所以 `resolve` 之后一定落在 `artifacts/` 里。
 *
 * 本轮这一份由隔离探针（`scripts/probe-artifact-isolation.ts`）用夹具写入；产品侧的写入方
 * 是"生成产物"那一段（W4-1 第二段）。**手写这段时不要把 `artifactId` 换成任意字符串**。
 */
function artifactSourcePath(artifactId: string): string {
  return resolve(app.getPath('userData'), 'artifacts', `${artifactId}.html`)
}

/**
 * `astella-app://artifact/<id>`：交给渲染进程读的是**组装好的那一份文档**
 * （我们的模板 + 产物），配额在这里做第二道校验，超量整份拒绝（D4 §6）。
 */
async function artifactDocumentResponse(requestUrl: URL, method: string): Promise<Response> {
  const artifactId = requestUrl.pathname.replace(/^\/+/, '')
  if (!isArtifactId(artifactId)) return response(404, 'Not found', method)

  let content: string
  try {
    content = await readFile(artifactSourcePath(artifactId), 'utf8')
  } catch {
    return response(404, 'Not found', method)
  }

  const assembled = assembleArtifactDocument({ artifactId, content })
  if (!assembled.ok) return response(413, assembled.detail, method)

  const document = assembled.document
  return new Response(method === 'HEAD' ? null : document, {
    status: 200,
    headers: {
      'Content-Length': String(Buffer.byteLength(document)),
      'Content-Type': 'text/html; charset=utf-8'
    }
  })
}

function registerAppProtocol(voiceAsrModel: VoiceAsrModelStore): void {
  const rendererRoot = resolve(__dirname, '../renderer')
  const respondVoiceAsr = createVoiceAsrModelResponder(voiceAsrModel)

  /**
   * `rendererRoot` 整个进程里不会变，它的 realpath 没必要每个资源请求都再问一次磁盘
   * （0269 轮 M21：Pixi 房间、字体、Live2D 模型与清单在启动时就是几十上百个请求，每个
   * 都白做一次 syscall）。解析失败不缓存，下一次请求会重试。
   */
  let rendererRealRootPromise: Promise<string> | null = null
  const rendererRealRoot = (): Promise<string> => {
    if (!rendererRealRootPromise) {
      rendererRealRootPromise = realpath(rendererRoot).catch((error: unknown) => {
        rendererRealRootPromise = null
        throw error
      })
    }
    return rendererRealRootPromise
  }

  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response(405, 'Method not allowed', request.method, { Allow: 'GET, HEAD' })
    }

    let requestUrl: URL

    try {
      requestUrl = new URL(request.url)
    } catch {
      return response(400, 'Invalid request URL', request.method)
    }

    if (
      requestUrl.hostname !== APP_HOST &&
      requestUrl.hostname !== ARTIFACT_HOST
    ) {
      return response(403, 'Forbidden', request.method)
    }

    if (
      requestUrl.username !== '' ||
      requestUrl.password !== '' ||
      requestUrl.port !== ''
    ) {
      return response(403, 'Forbidden', request.method)
    }

    if (requestUrl.hostname === ARTIFACT_HOST) {
      return artifactDocumentResponse(requestUrl, request.method)
    }

    let requestedPath: string

    try {
      requestedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
    } catch {
      return response(400, 'Invalid path encoding', request.method)
    }

    if (requestedPath.includes('\0')) return response(400, 'Invalid path', request.method)

    /**
     * `device/asr/…`：用户自己下的本地识别模型，落在 userData 而不是安装包里。
     *
     * 之所以挂在**与页面同一个 host**（`bundle`）而不是另开一个 scheme：同源就意味着
     * 渲染层 fetch 它时 CSP 的 `'self'` 直接命中，不用在 connect-src 上多开一条口子——
     * 「为了下一份模型给页面开外连」这件事因此根本不存在，开发模式与打包模式走同一条。
     *
     * 路径是**保留前缀**且只认清单里那两个文件名：前缀之后给什么都回 404，
     * 于是这条路由没有能力读出 userData 里的任何别的东西。
     */
    if (requestedPath === VOICE_ASR_MODEL_ROUTE_PREFIX.slice(0, -1) || requestedPath.startsWith(VOICE_ASR_MODEL_ROUTE_PREFIX)) {
      return respondVoiceAsr(requestedPath.slice(VOICE_ASR_MODEL_ROUTE_PREFIX.length), request)
    }

    const assetPath = requestedPath || 'index.html'
    const absolutePath = resolve(rendererRoot, assetPath)

    if (!isWithin(rendererRoot, absolutePath)) {
      return response(403, 'Forbidden', request.method)
    }

    let rendererRealPath: string
    let assetRealPath: string

    try {
      const resolvedPaths = await Promise.all([
        rendererRealRoot(),
        realpath(absolutePath)
      ])
      rendererRealPath = resolvedPaths[0]
      assetRealPath = resolvedPaths[1]
    } catch {
      return response(404, 'Not found', request.method)
    }

    if (!isWithin(rendererRealPath, assetRealPath)) {
      return response(403, 'Forbidden', request.method)
    }

    let assetStat

    try {
      assetStat = await stat(assetRealPath)
    } catch {
      return response(404, 'Not found', request.method)
    }

    if (!assetStat.isFile()) return response(404, 'Not found', request.method)

    const plan = createAssetResponsePlan(
      request.method,
      assetStat.size,
      mimeTypeForPath(assetRealPath),
      request.headers.get('range')
    )

    if (!plan.bodyRange) {
      return new Response(null, { status: plan.status, headers: plan.headers })
    }

    const fileStream = createReadStream(assetRealPath, plan.bodyRange)
    return new Response(Readable.toWeb(fileStream), {
      status: plan.status,
      headers: plan.headers
    })
  })
}

function configuredDevOrigin(): string | undefined {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (!rendererUrl) return undefined

  try {
    const url = new URL(rendererUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

function rendererWebSocketOrigin(devOrigin: string): string {
  const url = new URL(devOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.origin
}

function rendererContentSecurityPolicy(): string {
  const devOrigin = configuredDevOrigin()
  const devConnectSources = devOrigin
    ? ` ${devOrigin} ${rendererWebSocketOrigin(devOrigin)}`
    : ''
  // Vite's React refresh preamble is an inline script in development. Keep
  // this exception scoped to the dev server; packaged renderer pages retain a
  // strict script policy without `unsafe-inline`.
  const devScriptSources = devOrigin ? " 'unsafe-inline'" : ''

  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'${devScriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    // 设置里的音色试听放的是本渲染进程自己用 Blob 造出来的一段 mp3。blob: 不引入
    // 任何外部地址，且这条策略的 img-src / connect-src / worker-src 本来就允许它；
    // 只放开 media-src 是因为 <audio> 只认这一条（实测：不放开时 src 设上了但
    // metadata 永远不加载，点了没声也没有报错）。
    "media-src 'self' blob:",
    "font-src 'self' data:",
    // 模型在**页面自己的 origin** 上：打包后是 app scheme 的保留前缀（`'self'` 命中），
    // 开发时由 Vite 开发服务器在同一 origin 提供。这里因此不需要为它多开一条 connect-src。
    `connect-src 'self' blob:${devConnectSources}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    // D4 §3.4：本方案对既有防线的**全部改动只有这一条**——从 `'none'` 放开到
    // "可以嵌入我们自己那个受限 origin"。主渲染进程自身的能力一条没变
    //（script-src／img-src／connect-src／object-src 全不动）。
    `frame-src ${artifactFrameOrigin()}`,
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ')
}

function isAllowedRendererRequest(target: string): boolean {
  if (target.startsWith('blob:') || target.startsWith('data:')) return true

  // 产物文档走我们自己的第二个 host。**这不是放宽**：外连一条不放（下面那个 else 分支
  // 仍然只认 app scheme 的 bundle），加进来的只是"主页面可以嵌入自己的一块受限面"。
  // 产物文档自身不许有任何外部子资源——它的 CSP 里 `default-src 'none'`（artifact-surface.ts）。
  if (isArtifactFrameUrl(target)) return true

  try {
    const targetUrl = new URL(target)
    const developmentOrigin = configuredDevOrigin()

    if (developmentOrigin) {
      return targetUrl.origin === developmentOrigin || targetUrl.origin === rendererWebSocketOrigin(developmentOrigin)
    }

    return (
      targetUrl.protocol === `${APP_SCHEME}:` &&
      targetUrl.hostname === APP_HOST &&
      targetUrl.username === '' &&
      targetUrl.password === '' &&
      targetUrl.port === ''
    )
  } catch {
    return false
  }
}

/**
 * 两道闸的计数（D4 §7.2 的"阳性对照先证明计数会动"）。
 *
 * 计数本身是产品路径的一部分（零成本），但**只有隔离探针读得到**：见下面那处
 * `ASTELLA_ISOLATION_PROBE=1` 的挂载——默认关着，也没有任何 IPC 通道碰它。
 */
const isolationGateCounters = {
  blockedRequests: 0,
  blockedNavigations: 0,
  /**
   * `will-frame-navigate` 一共触发了几次。它不是判据，是**诊断读数**：
   * 第一轮实测里 T1b／T3b 两次子 frame 自导航没有把它打动（计数停在 0），
   * 而 frame 确实被导航走了（落到错误页）——记这个数就是为了把
   * "闸没拦"与"事件压根没来"分开（D4 §4.4 那句"事件名与覆盖范围必须实测"）。
   */
  frameNavigateEvents: 0
}

if (process.env.ASTELLA_ISOLATION_PROBE === '1') {
  ;(globalThis as Record<string, unknown>).__astellaIsolationProbe = isolationGateCounters
}

function registerRendererSecurityPolicy(): void {
  // 过滤器必须**逐 host 列**：`<all_urls>` 不匹配自定义 scheme（实测：漏了 artifact 这一条时，
  // 产物文档既拿不到自己的 CSP，请求闸也不会拦它发出的外部请求）。
  const appSchemeFilter = [`<all_urls>`, `${APP_SCHEME}://${APP_HOST}/*`, `${APP_SCHEME}://${ARTIFACT_HOST}/*`]

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: appSchemeFilter },
    (details, callback) => {
      const allowed = isAllowedRendererRequest(details.url)
      if (!allowed) isolationGateCounters.blockedRequests += 1
      callback({ cancel: !allowed })
    }
  )

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: appSchemeFilter },
    (details, callback) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({ responseHeaders: details.responseHeaders })
        return
      }

      // 三路分流（D4 §3.4）：主页面套主策略；产物 origin 套产物策略；**其余一律收紧**——
      // 以前这里只会套主策略，那对一帧不可信内容太宽。
      const subject = classifyFramePolicySubject({
        url: details.url,
        rendererDevOrigin: configuredDevOrigin() ?? null
      })
      const policy =
        subject === 'artifact'
          ? artifactDocumentContentSecurityPolicy()
          : subject === 'renderer'
            ? rendererContentSecurityPolicy()
            : rejectAllContentSecurityPolicy()

      const responseHeaders = { ...details.responseHeaders }
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key]
      }
      responseHeaders['Content-Security-Policy'] = [policy]
      callback({ responseHeaders })
    }
  )
}

function isAllowedNavigation(target: string): boolean {
  try {
    const targetUrl = new URL(target)
    const developmentOrigin = configuredDevOrigin()

    if (developmentOrigin) {
      return targetUrl.origin === developmentOrigin
    }

    return (
      targetUrl.protocol === `${APP_SCHEME}:` &&
      targetUrl.hostname === APP_HOST &&
      targetUrl.username === '' &&
      targetUrl.password === '' &&
      targetUrl.port === ''
    )
  } catch {
    return false
  }
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event, target) => {
    if (isAllowedNavigation(target)) return
    isolationGateCounters.blockedNavigations += 1
    event.preventDefault()
  })

  contents.on('will-redirect', (event, target) => {
    if (isAllowedNavigation(target)) return
    isolationGateCounters.blockedNavigations += 1
    event.preventDefault()
  })

  /**
   * 子 frame 的导航（D4 §4.4）：上面那两条只覆盖主 frame。
   *
   * 只有一种放行：**宿主发起、且 frame 还在首次加载**、目标是我们自己的产物 origin。
   * 产物自己发起的任何导航（`location.href=…`、`top.location=…`）都在这里被拒——
   * 包括把自己导航到 `astella-app://bundle`（那一份文档带着 preload 桥，是探针要打的一发）。
   *
   * 判断依据取"发起者是不是这个 frame 自己"＋"这个 frame 当前还在不在初始文档"，
   * 而不是"目标在不在允许集合"：后者放不住"从产物 origin 导航到主页面 origin"。
   */
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    isolationGateCounters.frameNavigateEvents += 1

    const frame = details.frame
    const initiator = details.initiator ?? null
    const initiatedBySelf = Boolean(
      frame &&
        initiator &&
        initiator.processId === frame.processId &&
        initiator.routingId === frame.routingId
    )

    if (
      isAllowedSubFrameNavigation({
        target: details.url,
        frameUrl: frame?.url ?? null,
        initiatedBySelf
      })
    ) {
      return
    }

    isolationGateCounters.blockedNavigations += 1
    details.preventDefault()
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

function windowFor(contents: WebContents, sourceUrl: string): BrowserWindow | null {
  if (!isAllowedNavigation(contents.getURL()) || !isAllowedNavigation(sourceUrl)) return null

  const window = BrowserWindow.fromWebContents(contents)
  return window && !window.isDestroyed() ? window : null
}

function registerWindowIpc(): void {
  registerDesktopRenderingIpc(ipcMain, desktopRendering, event =>
    Boolean(windowFor(event.sender, event.senderFrame?.url ?? '')))
  desktopRendering.subscribe(state => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()
        && isAllowedNavigation(window.webContents.getURL())) {
        window.webContents.send(DESKTOP_RENDERING_STATE_CHANNEL, state)
      }
    }
  })
  ipcMain.on(TITLE_BAR_THEME_CHANNEL, (event, theme: unknown) => {
    const window = windowFor(event.sender, event.senderFrame?.url ?? '')

    if (!window || process.platform === 'darwin' || (theme !== 'day' && theme !== 'night')) return
    window.setTitleBarOverlay(titleBarOverlayForTheme(theme))
  })

  ipcMain.handle(WINDOW_STATE_SNAPSHOT_CHANNEL, (event): WindowStateSnapshot | null => {
    const window = windowFor(event.sender, event.senderFrame?.url ?? '')
    return window ? windowStateSnapshot(window) : null
  })
}

const windowStateRevisions = new WeakMap<BrowserWindow, number>()
const publishedWindowStates = new WeakMap<BrowserWindow, AstellaWindowState>()

function currentWindowState(window: BrowserWindow): AstellaWindowState {
  return resolveWindowState({
    minimized: window.isMinimized(),
    visible: window.isVisible()
  })
}

function windowStateSnapshot(window: BrowserWindow): WindowStateSnapshot {
  return synchronizeWindowState(window).snapshot
}

function synchronizeWindowState(window: BrowserWindow): {
  readonly changed: boolean
  readonly snapshot: WindowStateSnapshot
} {
  const state = currentWindowState(window)
  const changed = publishedWindowStates.get(window) !== state
  const revision = (windowStateRevisions.get(window) ?? 0) + (changed ? 1 : 0)

  windowStateRevisions.set(window, revision)
  publishedWindowStates.set(window, state)

  return { changed, snapshot: { state, revision } }
}

function publishWindowState(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return

  const { changed, snapshot } = synchronizeWindowState(window)
  if (changed) window.webContents.send(WINDOW_STATE_CHANNEL, snapshot)
}

function registerWindowLifecycle(window: BrowserWindow): void {
  windowStateRevisions.set(window, 0)
  publishedWindowStates.set(window, currentWindowState(window))

  // 焦点不在这一组里：`resolveWindowState` 已经不看焦点了，留着这两条只会变成
  // 每次都判定、永远判定为"没变"的空转订阅（方案 35 E7）。
  window.on('show', () => publishWindowState(window))
  window.on('hide', () => publishWindowState(window))
  window.on('minimize', () => publishWindowState(window))
  window.on('restore', () => publishWindowState(window))
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: HOME_WINDOW_INITIAL_CONTENT_SIZE.width,
    height: HOME_WINDOW_INITIAL_CONTENT_SIZE.height,
    minWidth: HOME_WINDOW_MINIMUM_SIZE.width,
    minHeight: HOME_WINDOW_MINIMUM_SIZE.height,
    useContentSize: true,
    show: false,
    ...nativeWindowChrome(process.platform),
    autoHideMenuBar: true,
    backgroundColor: '#211914',
    title: '拾星笔记',
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      safeDialogs: true
    }
  })

  // 曾经这里调 `window.setAspectRatio(16/9)` 把原生窗口锁死成 16:9，并配合
  // `maximizable: false` 让最大化/全屏整条路都关掉。那条锁挡的不是渲染能力，
  // 是一张会露边、会被拉变形的底板——而这两件事渲染层本来就不该有：
  // `.scene-reference-frame[data-scene-fit="cover"]` 按 `--scene-world-aspect`
  // 把参考画幅放大到至少覆盖视口（`max(100%, …)`），再由 `.room-backplate`
  // 的 `object-fit: cover` 按比例裁切，所以任何窗口比例下底板都是满的、
  // 比例不变的，只是裁掉的部分随比例变化。
  //
  // 也就是说，比例锁换来的"永远不露边"并不依赖原生锁比；锁比反而让用户没法把
  // 书房放到整块屏幕上。现在窗口只保留下限（`HOME_WINDOW_MINIMUM_SIZE`）：
  // 小于此尺寸，纸面正文与伴星座位才真的会挤到一起，那才是真正的能力边界。
  installWindowZoomShortcuts(window.webContents, process.platform)

  registerWindowLifecycle(window)

  window.on('ready-to-show', () => traceBoot('renderer-ready-to-show'))
  window.on('closed', () => traceBoot('window-closed'))
  // 渲染进程没了是最需要看见的一种：它不会让主进程抛错，窗口却就此消失，
  // 最终表现成"应用自己退出了"。
  window.webContents.on('render-process-gone', (_event, details) =>
    traceBoot(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`))
  window.webContents.on('did-fail-load', (_event, code, description, url) =>
    traceBoot(`did-fail-load code=${code} description=${description} url=${url}`))
  window.webContents.on('preload-error', (_event, preloadPath, error) =>
    traceBoot(`preload-error path=${preloadPath} message=${error.message}`))

  window.once('ready-to-show', () => {
    window.show()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (rendererUrl) await window.loadURL(rendererUrl)
  else await window.loadURL(APP_URL)

  return window
}

/**
 * 单实例锁。两个实例同开时，同一篇笔记会在两份内存草稿之间互相原地覆盖：自动保存
 * 走的是"原地改写版本行且令牌不推进"，所以后写的一方静默赢，而两边的界面都显示
 * "已同步"。锁按 userData 目录生效，因此协同验收仍可以用不同的 `--user-data-dir`
 * 起两个互不干扰的实例。
 */
const singleInstanceLock = app.requestSingleInstanceLock()
traceBoot(`single-instance-lock=${singleInstanceLock}`)

if (!singleInstanceLock) {
  // 拿不到锁就立刻退出——这是"另一个实例已在跑"，不是故障，所以不打错误日志。
  // 但它必须被看见：Windows 上这段以前完全无声，排查时看不出应用是走到这里退的。
  traceBoot('quit-because-single-instance-lock-lost')
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
}

/**
 * 启动链上任何一步抛错，都要变成**一句看得见的失败 + 一个非零退出码**，
 * 绝不能变成"双击之后什么都没发生"。
 *
 * ## 为什么要专门加这个 catch（2026-10）
 *
 * 下面那个 `whenReady()` 的回调里第 721 行是 `await createMainWindow()`，而
 * `window-all-closed` 在非 macOS 上是 `app.quit()`。于是只要启动链任何一步抛错：
 *
 *   createMainWindow() reject → 没人接（unhandled rejection）→ 窗口从没建出来
 *   → BrowserWindow 里没有窗口 → app 认为窗口全关 → window-all-closed 触发
 *   → app.quit() → **退出码 0，stdout/stderr 一行都没有**
 *
 * Windows 上实测就是这样：安装正常（35 秒、app.asar 281MB 齐全），启动后 40 秒内
 * "干净地退出"，退出码 0，日志全空。macOS 上同一个 bug 不暴露——因为 darwin 分支
 * 的 `window-all-closed` 不 quit，进程会留着。
 *
 * 也就是说：**一个真实的启动失败，在 Windows 上伪装成了正常退出**。这个 catch
 * 不能定位到根因（那要一台 Windows 机器），但它让下一次 CI 跑就能读到
 * "到底是哪一步抛的"，并且给用户一个错误而不是一片空白。
 */
/**
 * 启动轨迹（2026-10）。
 *
 * ## 为什么需要它
 *
 * CI 实测：Windows 上装好的应用退出码 0、无 stderr、`startup-failure.log` 也不存在
 * ——也就是说主进程**没有抛错**。Chromium 日志显示它完成了 browser/GPU/network
 * 进程启动后约 **200ms** 就退出了，而 `Code Cache/js` 只有 16KB（我们那份 bundle
 * 压缩后是 7MB 级别），说明**渲染层根本没把应用代码加载起来**。
 *
 * 到这一步为止 we've 排除了：主进程抛错、沙箱、缺文件。剩下的是"它在哪一步停了"，
 * 而 stdout/stderr 与 Chromium 日志都答不上来——所以在这里自己写一份。
 *
 * ## 它是诊断用的，失败也不该连累启动
 *
 * 每个里程碑 appendFileSync 一次，同步落盘。写不进去（userData 不可写、磁盘满）
 * 就静默跳过：这个文件的存在是为了定位问题，它自己出问题绝不能变成新的启动失败。
 * 它只往 userData 写，不打 console，所以正常运行时对用户**完全无感**。
 */
function traceBoot(milestone: string): void {
  try {
    appendFileSync(
      resolve(app.getPath('userData'), 'boot-trace.log'),
      `${new Date().toISOString()} pid=${process.pid} ${milestone}\n`,
    )
  } catch {
    // 诊断设施不该制造故障。
  }
}

traceBoot('module-loaded (main/index.ts 顶层执行完毕)')

function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  // stderr：Electron 在 Windows 上会把主进程的 console.error 转发到父进程的 stderr，
  // CI 那边 `Start-Process -RedirectStandardError` 收得到。
  console.error('[astella] 启动失败：', message)
  // userData 下留一份：用户报障时可以直接拿到，不依赖他截得到终端。
  try {
    const logPath = join(app.getPath('userData'), 'startup-failure.log')
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, `${new Date().toISOString()}\n${message}\n`, 'utf8')
  } catch {
    // 连日志都写不下去时不能反过来再抛一次——那会盖掉原始错误。
  }
  // 退出码非 0：CI 与用户都能分辨"启动失败"和"正常退出"。原来这里是 0。
  app.exit(1)
}

app.whenReady()
  .then(async () => {
  traceBoot('whenReady-resolved')
  // Keep enough local evidence to distinguish renderer crashes from driver
  // compatibility. Do not collect page contents or send diagnostics anywhere.
  void app.getGPUInfo('complete').then((info) => {
    const attributes = typeof info === 'object' && info !== null && 'auxAttributes' in info
      ? info.auxAttributes as Record<string, unknown> | undefined : undefined
    traceBoot(`rendering-runtime ${JSON.stringify({
      electron: process.versions.electron, chromium: process.versions.chrome,
      os: process.getSystemVersion(), arch: process.arch,
      ...desktopRendering.getState(), features: app.getGPUFeatureStatus(),
      renderer: attributes?.glRenderer, backend: attributes?.skiaBackendType,
    })}`)
  }).catch(() => undefined)
  Menu.setApplicationMenu(null)
  /**
   * 用上一次查到的结果给界面打底（2026-10）。不联网、不预取安装包——
   * 只是让「有新版本 vX.Y.Z」这类提示在用户点开设置页之前就已经在。
   * GitHub 匿名 API 有 60 次/小时/IP 的限额，所以自动检查走 6 小时缓存，
   * 真正联网的那一次由渲染层主动触发。
   */
  primeUpdateStateFromCache()
  /**
   * 本地语音识别模型的仓库（2026-10）。它**不在安装包里**：目录是空的，
   * 用户在设置里点过下载之后才会有第一份字节。清掉上一次没下完的半截文件，
   * 免得「占了多少空间」这句话算在已经没人要的进度上。
   */
  const voiceAsrModel = new VoiceAsrModelStore(
    voiceAsrModelDirectory({ env: process.env, userDataDir: app.getPath('userData') }),
    { sources: voiceAsrModelSources(process.env) }
  )
  await voiceAsrModel.sweepPartialFiles()
  traceBoot('voice-asr-swept')
  createNoteImageStore(join(app.getPath('userData'), 'note-images'))
  createAvatarImageStore(join(app.getPath('userData'), 'avatars'))
  registerAppProtocol(voiceAsrModel)
  traceBoot('app-protocol-registered')
  registerRendererSecurityPolicy()
  traceBoot('renderer-security-policy-registered')
  registerWindowIpc()
  registerM1DesktopIpc({
    env: desktopDeploymentEnvironment(process.env, app.isPackaged ? join(process.resourcesPath, 'deployment.json') : undefined),
    resolveWindow: windowFor,
    getWindowState: windowStateSnapshot,
    setTitlebarTheme: (window, theme) => {
      if (process.platform === 'darwin') return false
      window.setTitleBarOverlay(titleBarOverlayForTheme(theme))
      return true
    },
    getReducedMotion: () => {
      try {
        return !systemPreferences.getAnimationSettings().shouldRenderRichAnimation
      } catch {
        return false
      }
    },
    pendingReturnMarkerStore: new FilePendingReturnMarkerStore(
      resolve(app.getPath('userData'), 'pending-return-markers-v2.json')
    ),
    // 决定 7：断网可编辑要能跨过重启，所以这份是本机的那一篇正文，落盘。
    noteDocCache: new FileNoteDocCacheStore(
      resolve(app.getPath('userData'), 'note-doc-cache.json')
    ),
    guidanceAudioCache: new CompanionVoiceAudioCache(
      // 目录名不改：这台电脑上已经攒下的带路音频要继续命中，换名字等于让所有人重合成一遍。
      resolve(app.getPath('userData'), 'companion-guidance-audio')
    ),
    thoughtAudioCache: new CompanionVoiceAudioCache(
      resolve(app.getPath('userData'), 'companion-thought-audio')
    ),
    messageAudioCache: new CompanionMessageAudioCache(
      resolve(app.getPath('userData'), 'companion-message-audio')
    ),
    // 刀五：动态产物往这儿写。传函数不在注册期求值，与读侧 `artifactSourcePath`
    // （上面那个）共用同一个 `app.getPath('userData')` 来源，落点必然一致。
    artifactUserDataDir: () => app.getPath('userData'),
    // 语音识别模型的仓库。与协议层那一条路由共用**同一个 store 实例**：
    // 下载写进去的与 worker 读出来的必须是同一个目录，不能各拼一次路径。
    voiceAsrModelStore: voiceAsrModel
  })

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents)
  })

  /**
   * 权限闸：默认全拒，只放行伴星语音输入真正要的那一样（麦克风）。
   *
   * 这两行以前是无条件 `false`，于是 `navigator.mediaDevices.getUserMedia` 永远被拒；
   * 而渲染层的 `isSupported()` 只看 API 存不存在（Chromium 里恒存在），所以麦克风按钮照常
   * 画出来、tooltip 写着「语音输入」，点下去只能得到「麦克风不可用或未授权」，连 macOS 的
   * 授权弹窗都不会弹 —— 伴星的语音输入从第一天起就没有工作过（方案 35 E0）。
   *
   * 摄像头与其余一切仍然拒：伴星只收声音。`audioCapture` 是 macOS 的设备级授权，
   * 与 `media` 成对出现，少一个都会变成"点了没反应"。放行前还要过一遍应用自己的
   * 来源判据，不给第三方帧开口子。
   */
  const grantedPermissions = new Set(['media', 'audioCapture'])
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    grantedPermissions.has(permission)
  )
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const fromAppPage = isAllowedNavigation(details?.requestingUrl ?? contents.getURL())
    callback(grantedPermissions.has(permission) && fromAppPage)
  })

  traceBoot('ipc-registered')
  await createMainWindow()
  traceBoot('main-window-created-and-loaded')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
  })
  .catch(reportStartupFailure)

app.on('window-all-closed', () => {
  traceBoot('window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})
