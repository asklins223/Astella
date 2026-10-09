import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(appRoot, '../..')
const devComposeFile = resolve(workspaceRoot, 'docker-compose.dev.yml')
const evidenceRoot = resolve(appRoot, '../../.impeccable/evidence')
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const { extractFile, listPackage } = require('@electron/asar')

/**
 * 打包后的可执行文件名就是 `productName`（electron-builder 拿它当 bundle 名）。
 * 这里从 `electron-builder.yml` 读，而不是把「AI Learn」抄一遍——2026-10-04 产品名
 * 改成「理解引擎」时，抄写的那份就静默失效了：脚本找不到包，报的还是"请先跑
 * `npm run dist`"，而 dist 其实已经跑过、包就在那儿。
 */
function packagedProductName() {
  const configPath = resolve(appRoot, 'electron-builder.yml')
  if (!existsSync(configPath)) return 'AI Learn'
  const line = readFileSync(configPath, 'utf8').split('\n').find((row) => /^productName:\s*/.test(row))
  const name = line?.replace(/^productName:\s*/, '').trim()
  return name || 'AI Learn'
}

const productName = packagedProductName()
const rejectedRuntimeMedia = [
  'graph-entry-fog-v1.mp4',
  'validation-ink-bloom-v1.mp4',
  'companion-wake-v1.webm',
  'companion-confirm-v1.webm',
  'review-card-tray-v1.png',
  'review-card-stand-v2.png',
]
// 2026-10-01：旧 3D 学习房归档包（`assets/3d/`）已整条删除，public 树不再有任何
// 需要排除的目录，`packageExcludedPrefixes` 与 `electron.vite.config.ts` 里的
// `releasePublicAssetsPlugin` 一同退场。
// 2026-10：重新有了一条 —— **语音识别模型不进安装包**。它变成用户在设置里自己下载
// 的附加功能（239MB），落点在 `<userData>/voice-models/`，public 树里没有对应目录。
// 这一条是那道边界的**判据**：谁把一份模型拷回 `out/renderer/models/`，
// 打包冒烟会在 `npm run package:smoke` 这一步红掉，而不是等用户下载完 200MB
// 之后才发现安装包大了一圈。
const packageExcludedPrefixes = ['out/renderer/models/']
const packagedManifestEntry = 'out/renderer/assets/learning-room/v1/manifest.json'
const runtimeManifestPath = resolve(appRoot, 'src/renderer/public/assets/learning-room/v1/manifest.json')
const outManifestPath = resolve(appRoot, 'out/renderer/assets/learning-room/v1/manifest.json')

function candidateExecutables() {
  if (process.platform === 'darwin') {
    return [resolve(appRoot, `release/mac-arm64/${productName}.app/Contents/MacOS/${productName}`)]
  }
  if (process.platform === 'win32') {
    return [resolve(appRoot, `release/win-unpacked/${productName}.exe`)]
  }
  return [resolve(appRoot, `release/linux-unpacked/${productName}`)]
}

function packagedExecutable() {
  const configured = process.env.ASTELLA_PACKAGED_APP?.trim()
  if (configured && existsSync(configured)) return configured
  const found = candidateExecutables().find((candidate) => existsSync(candidate))
  if (found) return found
  throw new Error('No packaged Electron executable found. Set ASTELLA_PACKAGED_APP after npm run dist.')
}

const executablePath = packagedExecutable()

function packagedAsarPath(executable) {
  const candidates = process.platform === 'darwin'
    ? [resolve(executable, '../../Resources/app.asar')]
    : [resolve(executable, '../resources/app.asar'), resolve(executable, '../Resources/app.asar')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  throw new Error(`Packaged app.asar is unavailable for containment inspection: ${candidates.join(', ')}`)
}

async function listFiles(root) {
  const files = []
  const visit = async (entryPath) => {
    const entryStat = await stat(entryPath)
    if (entryStat.isFile()) {
      files.push({ path: entryPath, mtimeMs: entryStat.mtimeMs })
      return
    }
    if (!entryStat.isDirectory()) throw new Error(`Unsupported freshness input: ${entryPath}`)
    for (const entry of await readdir(entryPath, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Unsupported freshness entry: ${resolve(entryPath, entry.name)}`)
      await visit(resolve(entryPath, entry.name))
    }
  }
  await visit(root)
  return files
}

async function newestFile(paths, label) {
  const files = []
  for (const candidate of paths) {
    if (!existsSync(candidate)) throw new Error(`${label} freshness input is missing: ${candidate}`)
    files.push(...await listFiles(candidate))
  }
  if (files.length === 0) throw new Error(`${label} freshness inputs contained no files`)
  return files.reduce((latest, entry) => entry.mtimeMs > latest.mtimeMs ? entry : latest)
}

function normalizeArchiveEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '')
}

/**
 * 把规范化后的归档条目（`/` 分隔、无前导斜杠）转成 `@electron/asar` 认的查询路径。
 *
 * 那个库的 `searchNodeFromDirectory` 用 `p.split(path.sep)` 逐级往下走，
 * 所以查询路径必须用**本平台的分隔符**，且不能有前导分隔符（会先切出一个空目录名）。
 * 详见调用点那段注释：这三个平台各错过一次。
 */
function archiveLookupPath(normalizedEntry) {
  return normalizedEntry.split('/').join(sep)
}

function collectManifestAssetPaths(value, assets = new Set()) {
  if (typeof value === 'string' && /\.(?:avif|m4a|mp4|png|svg|vtt|webp)$/i.test(value)) {
    assets.add(value)
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectManifestAssetPaths(entry, assets))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectManifestAssetPaths(entry, assets))
  }
  return assets
}

async function inspectPackagedArtifact(executable) {
  const asarPath = packagedAsarPath(executable)
  const sourceNewest = await newestFile([
    resolve(appRoot, 'src/main'),
    resolve(appRoot, 'src/preload'),
    resolve(appRoot, 'src/renderer/src'),
    resolve(appRoot, 'src/renderer/index.html'),
    resolve(appRoot, 'src/renderer/public/assets/fonts'),
    resolve(appRoot, 'src/renderer/public/assets/learning-room'),
    resolve(workspaceRoot, 'packages/shared/src'),
    resolve(appRoot, 'electron.vite.config.ts'),
    resolve(appRoot, 'electron-builder.yml'),
    resolve(appRoot, 'package.json'),
  ], 'source')
  const buildNewest = await newestFile([
    resolve(appRoot, 'out/main'),
    resolve(appRoot, 'out/preload'),
    resolve(appRoot, 'out/renderer'),
  ], 'build')
  const asarStat = await stat(asarPath)
  const timestampToleranceMs = 1_000
  if (buildNewest.mtimeMs + timestampToleranceMs < sourceNewest.mtimeMs) {
    throw new Error(`Packaged smoke refused a stale build: newest build ${buildNewest.path} predates source ${sourceNewest.path}. Run npm run dist.`)
  }
  if (asarStat.mtimeMs + timestampToleranceMs < buildNewest.mtimeMs) {
    throw new Error(`Packaged smoke refused a stale artifact: ${asarPath} predates build output ${buildNewest.path}. Run npm run dist.`)
  }

  const [runtimeManifest, outManifest] = await Promise.all([
    readFile(runtimeManifestPath),
    readFile(outManifestPath),
  ])
  if (!runtimeManifest.equals(outManifest)) {
    throw new Error('Renderer out manifest is not byte-identical to the runtime source manifest')
  }

  // 归档条目的**分隔符**与**前导斜杠**都不能假定。
  //
  // 2026-10-06 CI 实测，同一处代码在三个平台上各错一次：
  //   · Windows：`listPackage` 报出来的条目是反斜杠（`out\renderer\assets\...`），
  //     而脚本传的是正斜杠 —— `extractFile` 内部用 `path.sep` 切分目录
  //     （`@electron/asar/lib/filesystem.js` 的 `searchNodeFromDirectory`），
  //     于是整个 `out/renderer/...` 被当成**一个**目录名，报
  //     `"out/renderer/assets/learning-room/v1/manifest.json" was not found in this archive`。
  //   · macOS / Linux：`listPackage` 的条目**带前导 `/`**，原样传回去之后
  //     `split(path.sep)` 先切出一个空串，同样找不到。
  //
  // 所以：先规范化成 `/` 分隔、去掉前导斜杠（那正是归档里的层级起点），
  // 再按**本平台的分隔符**拼出查询路径。规范化那份继续用来做集合判断。
  const rawArchiveEntries = listPackage(asarPath)
  const archiveEntries = rawArchiveEntries.map(normalizeArchiveEntry)
  const archiveEntrySet = new Set(archiveEntries)
  const manifestEntryIndex = archiveEntries.indexOf(packagedManifestEntry)
  if (manifestEntryIndex < 0) {
    throw new Error(`Packaged manifest is missing from app.asar: ${packagedManifestEntry}`)
  }
  const packagedManifest = extractFile(asarPath, archiveLookupPath(archiveEntries[manifestEntryIndex]))
  if (!runtimeManifest.equals(packagedManifest)) {
    throw new Error('Packaged manifest is not byte-identical to the runtime source and fresh renderer out manifests')
  }

  const manifestJson = JSON.parse(packagedManifest.toString('utf8'))
  if (manifestJson.id !== 'astella-learning-room-v1' || manifestJson.canonicalMode !== '2d') {
    throw new Error('Packaged learning-room manifest identity or canonical mode drifted')
  }
  const manifestText = packagedManifest.toString('utf8')
  const rejectedManifestMedia = rejectedRuntimeMedia.filter((name) => manifestText.includes(name))
  const rejectedArchiveMedia = archiveEntries.filter((entry) => rejectedRuntimeMedia.some((name) => entry.endsWith(`/${name}`) || entry === name))
  if (rejectedManifestMedia.length || rejectedArchiveMedia.length) {
    throw new Error(`Rejected runtime media entered packaged evidence: ${JSON.stringify({ rejectedManifestMedia, rejectedArchiveMedia })}`)
  }

  const excludedArchiveEntries = archiveEntries.filter((entry) => packageExcludedPrefixes.some((prefix) => entry === prefix.slice(0, -1) || entry.startsWith(prefix)))
  if (excludedArchiveEntries.length) {
    throw new Error(`Package-excluded paths entered app.asar: ${excludedArchiveEntries.slice(0, 12).join(', ')}`)
  }
  // 运行时不从磁盘 require 任何第三方包：main/preload 在 electron.vite.config.ts 里是
  // `externalizeDeps: false`（全部打进 out/），renderer 由 Vite 打包，成品里非内置模块的
  // require 只剩 `electron`。所以整棵 node_modules 是死重量（2026-10-09 实测：原始 408MB、
  // 压进 asar 105MB），边界写在 electron-builder.yml 的 files 里。
  // 唯一的例外是笔记导出：`src/main/note-writing-files.ts` 用 require.resolve 读 katex 的
  // CSS 和 woff2 字体。谁把别的包放回来、或者把 katex 这几样裁掉，这里红——
  // 后一种在开发机上永远不会暴露（那里 node_modules 是完整的）。
  // `listPackage` 会把**目录**也列出来，所以 `node_modules` 和 `node_modules/katex`
  // 这两个目录条目本身要放过，判的是"katex 之外还有没有别的包"。
  const unexpectedDependencyEntries = archiveEntries.filter((entry) => (
    entry.startsWith('node_modules/')
    && entry !== 'node_modules/katex'
    && !entry.startsWith('node_modules/katex/')
  ))
  if (unexpectedDependencyEntries.length) {
    throw new Error(`Runtime-unread node_modules re-entered app.asar: ${unexpectedDependencyEntries.slice(0, 8).join(', ')}`)
  }
  const noteExportKatexFiles = [
    'node_modules/katex/package.json',
    'node_modules/katex/dist/katex.min.css',
    'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',
    'node_modules/katex/dist/fonts/KaTeX_Math-BoldItalic.woff2',
  ]
  const missingNoteExportKatexFiles = noteExportKatexFiles.filter((entry) => !archiveEntrySet.has(entry))
  if (missingNoteExportKatexFiles.length) {
    throw new Error(`Packaged note export lost its katex files: ${missingNoteExportKatexFiles.join(', ')}`)
  }
  // 2026-09-16 裁决移除 orb，打包产物不得再包含它（Live2D 是唯一形态）；
  // 2026-10-01 旧书房底板整条删除后，`objects/` 整个目录都已不在产物里。
  const removedOrb = 'out/renderer/assets/learning-room/v1/objects/companion-orb.webp'
  if (archiveEntrySet.has(removedOrb)) throw new Error(`Removed orb asset still packaged: ${removedOrb}`)
  const retiredStudyPack = [
    'posters/room-day.webp',
    'posters/room-night.webp',
    'posters/study-seat-day-v2.png',
    'posters/study-seat-night-v2.png',
    'posters/review-seat-day-v1.png',
    'posters/review-seat-night-v1.png',
    'posters/search-reference-day-v1.png',
    'posters/search-reference-night-v1.png',
    'posters/login-entry/',
    'foreground/',
    'motion/',
    'objects/',
    'textures/',
    'masks/',
    'audio/',
    'captions/',
  ].map((entry) => `out/renderer/assets/learning-room/v1/${entry}`)
  const resurrectedStudyPack = retiredStudyPack.filter((entry) => (
    [...archiveEntrySet].some((packaged) => packaged === entry || packaged.startsWith(entry))
  ))
  if (resurrectedStudyPack.length) {
    throw new Error(`Retired study pack re-entered app.asar: ${resurrectedStudyPack.join(', ')}`)
  }
  // 2026-10-04 Owner 裁决删除 mao-pro / seethrough：大肥鱼是唯一打进的 Live2D 模型，
  // 两个被删的包一个文件都不许留在 app.asar 里。
  const removedLive2dPrefixes = [
    'out/renderer/assets/companion/live2d-v1/',
    'out/renderer/assets/companion/live2d-v2/',
  ]
  const repackagedRemovedLive2d = [...archiveEntrySet].filter((entry) => (
    removedLive2dPrefixes.some((prefix) => entry.startsWith(prefix))
  ))
  if (repackagedRemovedLive2d.length) {
    throw new Error(`Removed Live2D packages still packaged: ${repackagedRemovedLive2d.join(', ')}`)
  }
  const requiredLive2dAssets = [
    'out/renderer/assets/companion/live2d-v3/whale/c_0120.model3.json',
    'out/renderer/assets/companion/vendor/pixi.min.js',
    'out/renderer/assets/companion/vendor/live2dcubismcore.min.js',
    'out/renderer/assets/companion/vendor/cubism4.min.js',
  ]
  const missingLive2dAssets = requiredLive2dAssets.filter((entry) => !archiveEntrySet.has(entry))
  if (missingLive2dAssets.length) throw new Error(`Bundled Live2D runtime is incomplete: ${missingLive2dAssets.join(', ')}`)

  const manifestAssetPaths = [...collectManifestAssetPaths(manifestJson)]
  const missingPackagedAssets = manifestAssetPaths.filter((assetPath) => (
    !archiveEntrySet.has(`out/renderer/assets/learning-room/v1/${assetPath}`)
  ))
  if (missingPackagedAssets.length) {
    throw new Error(`Packaged manifest references missing runtime assets: ${missingPackagedAssets.join(', ')}`)
  }

  const outFiles = await listFiles(resolve(appRoot, 'out/renderer'))
  const outRelativePaths = outFiles.map((entry) => relative(appRoot, entry.path).split(sep).join('/'))
  const rejectedOutMedia = outRelativePaths.filter((entry) => rejectedRuntimeMedia.some((name) => entry.endsWith(`/${name}`)))
  const excludedOutEntries = outRelativePaths.filter((entry) => packageExcludedPrefixes.some((prefix) => entry === prefix.slice(0, -1) || entry.startsWith(prefix)))
  if (rejectedOutMedia.length || excludedOutEntries.length) {
    throw new Error(`Fresh renderer out failed containment: ${JSON.stringify({ rejectedOutMedia, excludedOutEntries: excludedOutEntries.slice(0, 12) })}`)
  }

  return {
    asar: relative(appRoot, asarPath).split(sep).join('/'),
    sourceNewest: { path: relative(appRoot, sourceNewest.path).split(sep).join('/'), mtime: new Date(sourceNewest.mtimeMs).toISOString() },
    buildNewest: { path: relative(appRoot, buildNewest.path).split(sep).join('/'), mtime: new Date(buildNewest.mtimeMs).toISOString() },
    artifactMtime: new Date(asarStat.mtimeMs).toISOString(),
    manifestByteIdentical: true,
    manifestSha256: createHash('sha256').update(packagedManifest).digest('hex'),
    manifestAssetCount: manifestAssetPaths.length,
    rejectedMediaAbsent: rejectedRuntimeMedia,
    excludedArchivesAbsent: packageExcludedPrefixes,
    orbAssetAbsent: true,
    live2dRuntimePresent: true,
  }
}

const packageContainment = await inspectPackagedArtifact(executablePath)
if (process.env.ASTELLA_PACKAGED_PREFLIGHT_ONLY === '1') {
  process.stdout.write(`${JSON.stringify(packageContainment, null, 2)}\n`)
  process.exit(0)
}
const portableOfflineOnly = process.env.ASTELLA_PACKAGED_OFFLINE_ONLY === '1'
const userDataDir = await mkdtemp(resolve(tmpdir(), 'astella-packaged-smoke-'))
const errors = []
const ownerCredentialsAvailable = Boolean(process.env.OWNER_EMAIL?.trim() && process.env.OWNER_PASSWORD)
const memberCredentialsAvailable = Boolean(process.env.MEMBER_EMAIL?.trim() && process.env.MEMBER_PASSWORD)
const smokeRole = ownerCredentialsAvailable ? 'owner' : memberCredentialsAvailable ? 'member' : 'anonymous'
const learningRunResponseLossOperations = smokeRole === 'member' ? ['draft', 'action', 'submit'] : []
const learningRunResponseLossExpected = learningRunResponseLossOperations.length > 0

/**
 * 启动打包应用时要**摘掉**的环境变量。
 *
 * `ELECTRON_RUN_AS_NODE` 让 Electron 二进制退化成纯 Node：它不再建窗口，还会把
 * `--user-data-dir` 当成 Node 的未知选项直接拒掉。表现是 Playwright 抛
 * `Process failed to launch!`——看起来像打包坏了或应用起不来，实际是**父进程的
 * 一个环境变量**改变了子进程的性质。
 *
 * 2026-10-06 本地实测：这个变量在某些编辑器终端 / 工具链里是默认带上的，
 * 而 `smokeAppEnv` 是 `...process.env` 整份透传，于是它一路漏进被测应用。
 * `NODE_OPTIONS` 同理：注入的 `--require` 之类会作用到应用的主进程。
 */
const stripFromAppEnv = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']
const baseAppEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !stripFromAppEnv.includes(key)),
)
const smokeAppEnv = {
  ...baseAppEnv,
  ASTELLA_PACKAGED_EVIDENCE: '1',
  // CI runners do not own the local API stack or test credentials. Point the
  // portable smoke at a closed loopback port so every supported package proves
  // the real fail-closed DesktopAccessGate instead of merely staying alive.
  //
  // **但只给端口不够**：主进程的 `readConfiguration` 要求
  // `ASTELLA_DOMAIN_SCHEMA_REVISION`，而 http（回环）模式还额外要配对 key/secret
  // （`src/main/desktop-gateway.ts`）。少了任何一样，`connect()` 连试都不试就返回
  // `configuration_error`（reason `pairing_secret_missing`）——于是这条冒烟**没有在测
  // 它自己声称测的东西**：它想验"传输层失败也照样 fail closed"，实际验到的是
  // "这个包根本没配置"。
  //
  // 2026-10-06 CI 实测：三个平台都报
  // `{"health":{"code":"configuration_error"},"room":{"code":"stale_workspace"}}`，
  // 而下面 `runPortableOfflineSmoke` 期待的是 `api_unavailable` / `network_timeout`
  // / `invoke_failed` 那一族。补上这一组之后，应用会真的去连那个关闭的端口，
  // 失败才落在传输层——那正是这道闸存在的意义。
  //
  // 值本身是**夹具**，不是机密：只为了让配置校验过得去（`readPairingSecret`
  // 要求 base64url、≥32 字节且可往返）。同族写法见
  // `scripts/capture-home-v2-lighthouse.mjs` 的 fixture 三件套。
  ...(portableOfflineOnly
    ? {
        DESKTOP_API_ORIGIN: 'http://127.0.0.1:9',
        ASTELLA_DOMAIN_SCHEMA_REVISION: 'portable-smoke-domain-v1',
        ASTELLA_DESKTOP_PAIRING_KEY_ID: 'portable-smoke-key',
        ASTELLA_DESKTOP_PAIRING_SECRET: Buffer.alloc(32, 23).toString('base64url'),
        DESKTOP_DEPLOYMENT_CONFIG_REVISION: 'portable-smoke-v1',
      }
    : {}),
  ...(learningRunResponseLossExpected ? { ASTELLA_PACKAGED_LEARNING_RUN_RESPONSE_LOSS: learningRunResponseLossOperations.join(',') } : {}),
}
const ownerJourney = {
  attempted: ownerCredentialsAvailable,
  authenticated: false,
  cardGeneration: false,
  cardActivation: false,
  note: false,
  learningRun: false,
  returned: false,
}
const memberJourney = {
  attempted: memberCredentialsAvailable,
  authenticated: false,
  reviewQueue: false,
  learningRun: false,
  result: false,
  returned: false,
  note: false,
}
let electronApp
let currentWindow
let apiRestartRecovery = false
let responseLossRecovery = false
const learningRunResponseLossRecoveries = []
let markerRestartRecovery = false
let offlineStartRecovery = false
let offlineAccessGateBoundary = null
let formalGuardRuntime = false
let formalGuardActiveObserved = false
let formalGuardReleasedObserved = false
const HOME_READY_SELECTOR = '.action-rail, .home-v2-objects'

async function waitForHomeReady(window, timeout = 30_000) {
  await window.locator(HOME_READY_SELECTOR).first().waitFor({ state: 'visible', timeout })
}

async function activateHomeAction(window, action) {
  await waitForHomeReady(window)
  const v2Objects = window.locator('.home-v2-objects')
  if (await v2Objects.count()) {
    const objectId = action === 'primary' ? 'desk-book' : 'review-cards'
    const targetZone = 'desk'
    const object = window.locator(`[data-room-object="${objectId}"]`)
    await object.waitFor({ state: 'visible', timeout: 15_000 })
    const activeZone = await v2Objects.getAttribute('data-active-zone')
    if (activeZone !== targetZone) {
      await object.click()
      await window.waitForFunction(
        ({ zone }) => document.querySelector('.home-v2-objects')?.getAttribute('data-active-zone') === zone
          && document.querySelector('.desktop-app')?.getAttribute('data-home-v2-camera-state') !== 'moving',
        { zone: targetZone },
        { timeout: 15_000 },
      )
    }
    await object.click()
    return
  }

  await window.getByTestId(action === 'primary' ? 'action-continue' : 'action-review').click()
}

async function waitForLearningRunPlayer(window, label, timeout = 60_000) {
  try {
    await window.waitForFunction(
      () => Boolean(document.querySelector('.learning-run-workbench'))
        || Boolean(document.querySelector('.learning-run-result-board'))
        || Boolean(document.querySelector('.task-surface .surface-data-state--error')),
      undefined,
      { timeout },
    )
  } catch (error) {
    const diagnostics = await window.evaluate(() => ({
      workbenchClass: document.querySelector('.learning-run-workbench')?.className ?? null,
      surfaceText: document.querySelector('.task-surface')?.textContent?.slice(0, 500) ?? null,
      headings: [...document.querySelectorAll('h1,h2,h3')].map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 8),
    }))
    throw new Error(`${label} did not leave loading state: ${JSON.stringify(diagnostics)} (${error.message})`)
  }
}

function attachWindowDiagnostics(window) {
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
}

async function waitForPackagedWindow(window, label) {
  await window.waitForLoadState('domcontentloaded')
  await window.locator('.desktop-app').waitFor({ state: 'visible', timeout: 15_000 })
  await window.waitForFunction(() => window.location.protocol === 'astella-app:')
  const boundary = await window.evaluate(() => ({
    protocol: window.location.protocol,
    hasDesktopPreload: typeof window.astellaDesktop?.platform === 'string',
    hasM2Preload: typeof window.astella?.contract?.version === 'number',
    hasAccessGate: document.querySelector('.desktop-access-gate') !== null,
    hasRoomDom: document.querySelector('.scene-stage') !== null,
    hasActionRail: document.querySelector('.action-rail') !== null,
    hasHomeV2Objects: document.querySelector('.home-v2-objects') !== null,
    hasOnboarding: document.querySelector('.onboarding-card') !== null,
  }))
  if (
    boundary.protocol !== 'astella-app:'
    || !boundary.hasDesktopPreload
    || !boundary.hasM2Preload
    || (!boundary.hasAccessGate && !boundary.hasRoomDom)
  ) {
    throw new Error(`${label} packaged boundary contract failed: ${JSON.stringify(boundary)}`)
  }
  return boundary
}

async function readAccessGateBoundary(window) {
  return window.evaluate(() => {
    const gate = document.querySelector('.desktop-access-gate')
    return {
      present: gate instanceof HTMLElement,
      // The workspace phase also carries a form (the invite-code join), so the
      // workspace list has to be tested first or every workspace screen would
      // be reported as the sign-in screen.
      phase: gate?.querySelector('.desktop-access-gate__workspace-list')
        ? 'workspace'
        : gate?.querySelector('.desktop-access-gate__form')
          ? 'auth'
          : gate?.querySelector('.desktop-access-gate__notice')
            ? 'blocked'
            : 'loading',
      heading: gate?.querySelector('h1')?.textContent?.trim() ?? null,
      detail: gate?.querySelector('#desktop-gate-detail')?.textContent?.trim() ?? null,
      hasRoomDom: document.querySelector('.scene-stage') !== null,
      hasActionRail: document.querySelector('.action-rail') !== null,
      hasHomeV2Objects: document.querySelector('.home-v2-objects') !== null,
      hasOnboarding: document.querySelector('.onboarding-card') !== null,
    }
  })
}

async function assertFailClosedAccessGate(window, label) {
  await window.locator('.desktop-access-gate').waitFor({ state: 'visible', timeout: 20_000 })
  await window.waitForFunction(
    () => !document.querySelector('.desktop-access-gate__loading'),
    undefined,
    { timeout: 20_000 },
  ).catch(() => undefined)
  const boundary = await readAccessGateBoundary(window)
  if (!boundary.present || boundary.hasRoomDom || boundary.hasActionRail || boundary.hasHomeV2Objects || boundary.hasOnboarding) {
    throw new Error(`${label} did not stop at the fail-closed DesktopAccessGate: ${JSON.stringify(boundary)}`)
  }
  return boundary
}

async function runPortableOfflineSmoke() {
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: smokeAppEnv,
  })
  currentWindow = await electronApp.firstWindow()
  attachWindowDiagnostics(currentWindow)
  const boundary = await waitForPackagedWindow(currentWindow, 'Portable offline package')
  const accessGate = await assertFailClosedAccessGate(currentWindow, 'Portable offline package')
  const [health, room] = await Promise.all([
    packagedTransportProbe(currentWindow, 'health'),
    packagedTransportProbe(currentWindow, 'room'),
  ])
  // 两格问的是**不同**的问题，所以判据也不同。
  //
  // `health` 与工作区无关：它必须**真的走到传输层**再失败，否则这道闸测的就不是
  // "网络不可达时也 fail closed"。这一格保持严格。
  const transportFailureCodes = ['api_unavailable', 'network_timeout', 'invoke_failed']
  //
  // `room` 是**工作区相关**的调用，而离线冒烟从来没有登录过：`createRequestMeta()`
  // 只在 `currentWorkspaceEpoch > 0` 时才带 `workspaceEpoch`，而主进程的
  // `assertEpoch` 对工作区相关的通道要求这一格必须等于当前纪元
  // （`src/main/desktop-ipc.ts`）。于是本机**根本没有活动工作区**时，它在碰网络
  // **之前**就被拒掉，返回 `stale_workspace`。
  //
  // 2026-10-06 CI 实测：三个平台都报
  // `{"health":{"code":"api_unavailable"},"room":{"code":"stale_workspace"}}`——
  // 补上最小部署配置之后 `health` 这一格已经对了，`room` 这一格则**在离线模式下
  // 结构上不可能**返回传输层错误（要走到传输层就得先有一个活动工作区，而那需要
  // 后端与凭据，CI 两样都没有）。此前它被要求必须是 `api_unavailable`，于是这条
  // 冒烟从建立起就不可能绿——这也解释了它为什么一直没被发现。
  //
  // 所以这一格接受两类**都算 fail closed** 的结局：传输层失败，或工作区边界拒绝。
  // 它真正要证明的是"这个包不会凭空造出一份投影"，这两类都证明了。
  const workspaceScopedFailClosedCodes = [
    ...transportFailureCodes,
    'stale_workspace',
    'auth_required',
    'reauth_required',
  ]
  if (
    health.ok
    || !transportFailureCodes.includes(health.code)
    || room.ok
    || !workspaceScopedFailClosedCodes.includes(room.code)
  ) {
    throw new Error(`Portable package did not fail closed at the API boundary: ${JSON.stringify({ health, room })}`)
  }
  if (errors.length > 0) throw new Error(`Packaged renderer emitted errors: ${errors.join('; ')}`)

  const runtime = await electronApp.evaluate(() => ({
    electronVersion: process.versions.electron ?? 'unknown',
    chromiumVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
  }))
  const smokeEvidence = {
    schemaVersion: 1,
    kind: 'packaged-offline-smoke',
    artifact: process.env.ASTELLA_PACKAGED_APP?.trim() ? 'configured-external' : relative(appRoot, executablePath).split('\\').join('/'),
    packageContainment,
    runtime,
    boundary,
    accessGate,
    probes: { health, room },
    errors,
  }
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(resolve(evidenceRoot, 'package-smoke-offline.json'), `${JSON.stringify(smokeEvidence, null, 2)}\n`, 'utf8')
  process.stdout.write('packaged offline smoke passed\n')
}

async function authenticateThroughAccessGate(window, { email, password, expectedRole, label }) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.action-rail, .home-v2-objects')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator(HOME_READY_SELECTOR).count() === 0) {
    await window.locator('.desktop-access-gate input[type="email"]').fill(email)
    await window.locator('.desktop-access-gate input[type="password"]').fill(password)
    await window.getByRole('button', { name: '登录', exact: true }).click()
  }

  const deadline = Date.now() + 30_000
  let workspaceChosen = false
  while (Date.now() < deadline && await window.locator(HOME_READY_SELECTOR).count() === 0) {
    const formError = window.locator('.desktop-access-gate__form-error')
    if (await formError.count()) throw new Error(`${label} Gate login failed: ${await formError.innerText()}`)
    const workspaceButtons = window.locator('.desktop-access-gate__workspace-list button')
    if (!workspaceChosen && await workspaceButtons.count()) {
      const roleLabel = expectedRole === 'owner' ? '所有者' : '成员'
      const roleWorkspace = workspaceButtons.filter({ hasText: roleLabel }).first()
      await (await roleWorkspace.count() ? roleWorkspace : workspaceButtons.first()).click()
      workspaceChosen = true
    }
    const blockedNotice = window.locator('.desktop-access-gate__notice')
    if (await blockedNotice.count()) {
      throw new Error(`${label} Gate stopped before Room ready: ${JSON.stringify(await readAccessGateBoundary(window))}`)
    }
    await window.waitForTimeout(250)
  }
  await waitForHomeReady(window, 1_000)

  const session = await window.evaluate(async () => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const response = await window.astella.auth.getState({
      meta: {
        version: 1,
        contractVersion: window.astella.contract.contractVersion,
        requestId: opaqueId('packaged-session-request'),
        correlationId: opaqueId('packaged-session-correlation'),
        clientStartedAt: new Date().toISOString(),
      },
    })
    return response.ok
      ? { ok: true, status: response.data.status, role: response.data.membership?.role ?? null }
      : { ok: false, errorCode: response.error.code }
  })
  if (!session.ok || session.status !== 'authenticated' || session.role !== expectedRole) {
    throw new Error(`${label} Gate did not reach an authenticated ${expectedRole} Room: ${JSON.stringify(session)}`)
  }

  await window.waitForTimeout(700)
  if (await window.locator('.onboarding-card').count()) {
    await window.getByRole('button', { name: '无声进入' }).click()
  }
}

/**
 * 今日学习（页 14）是 `.day-route`：三张真实站点票 + 学习记录栏。这里等它或它的
 * 安全状态出现，而不是等已被删除的 `.study-workbench`（旧学习台的类名）。
 */
async function waitForTodayRoute(window, label) {
  await window.waitForFunction(
    () => Boolean(document.querySelector('.task-surface--study .day-route'))
      || Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.day-route').count() !== 1) {
    const boundary = await window.locator('.task-surface .surface-data-state').first().innerText().catch(() => 'missing Today boundary')
    throw new Error(`${label} did not reach the real 今日学习 surface: ${boundary}`)
  }
  if (await window.getByRole('heading', { name: '今日学习' }).count() !== 1) {
    throw new Error(`${label} did not land on the 今日学习 page`)
  }
}

/**
 * 从页 14 进入研究册：页面自己的「继续写作 · …」票是正门，没有笔记票时退回书房
 * 目录的「笔记」入口 —— 旧页面的「进入研究册」按钮已经不存在了。
 */
async function openNotebookFromToday(window) {
  const noteTicket = window.getByRole('button', { name: /继续写作/ }).first()
  if (await noteTicket.count()) {
    await noteTicket.click()
  } else {
    await window.getByRole('navigation', { name: '学习空间目录' }).getByRole('button', { name: '笔记' }).click()
    await window.locator('.note-open').first().waitFor({ state: 'visible', timeout: 15_000 })
    await window.locator('.note-open').first().click()
  }
  await window.locator('.notebook[data-mode]').waitFor({ state: 'visible', timeout: 15_000 })
}

async function readCardGenerationDiagnostics(window) {
  return window.evaluate(() => ({
    heading: document.querySelector('.task-title h1, .candidate-desk__title h1, .card-making__header h1')?.textContent?.trim() ?? null,
    runMeta: document.querySelector('.card-making__footer')?.textContent?.trim() ?? null,
    hudState: document.querySelector('.card-generation-hud-state')?.textContent?.trim() ?? null,
    error: document.querySelector('.card-generation-hud-state[role="alert"]')?.textContent?.trim() ?? null,
    candidates: [...document.querySelectorAll('.candidate-study-card')].map((node) => ({
      text: node.textContent?.trim() ?? '',
      decision: node.querySelector('.candidate-card__meta')?.textContent?.trim() ?? null,
      keepButtons: [...node.querySelectorAll('button')]
        .filter((button) => button.textContent?.trim() === '保留')
        .map((button) => ({ disabled: button.disabled })),
      selectedInputs: node.querySelectorAll('.candidate-activation-choice input[type="checkbox"]').length,
    })).slice(0, 5),
    receipt: document.querySelector('.candidate-review-slip__receipt')?.textContent?.trim() ?? null,
    buttons: [...document.querySelectorAll('button')]
      .map((button) => button.textContent?.trim() || button.getAttribute('aria-label'))
      .filter(Boolean)
      .slice(-16),
  }))
}

async function waitForCardGenerationSurface(window) {
  // 页 12「学习卡生成中」渲染 .card-making-workshop，页 13「候选卡审核」渲染
  // .candidate-review-table；两者都在 .task-surface--card-generation 里。
  const paper = window.locator('.task-surface--card-generation .card-making-workshop, .task-surface--card-generation .candidate-review-table').first()
  try {
    await paper.waitFor({ state: 'visible', timeout: 30_000 })
    return
  } catch (error) {
    // A successful start can race with renderer navigation after a transport
    // reconnect. If the page already exposes a server-issued recovery action,
    // take that explicit route before failing the packaged journey.
    const recoveryButton = window.getByRole('button', { name: /重新检查|返回笔记|回笔记重新生成/ })
    if (await recoveryButton.count()) {
      await recoveryButton.first().click()
      await paper.waitFor({ state: 'visible', timeout: 30_000 })
      return
    }
    const diagnostics = await window.evaluate(() => ({
      route: window.location.href,
      roomText: document.querySelector('.scene-stage')?.textContent?.slice(0, 600) ?? null,
      buttons: [...document.querySelectorAll('button')].map((button) => button.textContent?.trim() || button.getAttribute('aria-label')).filter(Boolean).slice(-16),
    }))
    throw new Error(`Packaged Card Generation surface did not open: ${JSON.stringify(diagnostics)} (${error.message})`)
  }
}

async function packagedTransportProbe(window, kind) {
  return window.evaluate(async (probeKind) => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const meta = () => ({
      version: 1,
      contractVersion: window.astella.contract.contractVersion,
      requestId: opaqueId(`packaged-${probeKind}-request`),
      correlationId: opaqueId(`packaged-${probeKind}-correlation`),
      clientStartedAt: new Date().toISOString(),
    })
    try {
      const response = probeKind === 'room'
        ? await window.astella.room.getProjection({ meta: meta() })
        : await window.astella.runtime.getHealth({ meta: meta() })
      return response.ok
        ? { ok: true, kind: probeKind, dataKind: probeKind === 'health' ? response.data.kind : 'projection' }
        : { ok: false, kind: probeKind, code: response.error.code }
    } catch {
      return { ok: false, kind: probeKind, code: 'invoke_failed' }
    }
  }, kind)
}

async function readFormalGuardEvidence() {
  if (!electronApp) return null
  return electronApp.evaluate(() => {
    const hook = globalThis.__astellaFormalAssessmentGuardEvidence
    if (!hook) return null
    const snapshot = hook.getSnapshot()
    const decisions = ['prompt', 'proposal', 'voice'].map((kind) => {
      const decision = hook.authorizeCompanionDelivery(kind)
      return { kind, allowed: decision.allowed, reason: decision.allowed ? null : decision.reason }
    })
    return {
      state: snapshot.state,
      reason: snapshot.reason,
      hasRunKey: snapshot.runId !== null && snapshot.runtimeEpoch !== null,
      decisions,
    }
  }).catch(() => null)
}

async function assertFormalGuardActive(label) {
  const evidence = await readFormalGuardEvidence()
  if (!evidence || evidence.state !== 'active' || evidence.decisions.some((decision) => decision.allowed || decision.reason !== 'formal_assessment_silence')) {
    throw new Error(`${label} FormalAssessmentGuard did not enter active silent state: ${JSON.stringify(evidence)}`)
  }
  formalGuardActiveObserved = true
}

async function assertFormalGuardReleased(label) {
  const evidence = await readFormalGuardEvidence()
  if (!evidence || evidence.state !== 'inactive' || evidence.decisions.some((decision) => !decision.allowed)) {
    throw new Error(`${label} FormalAssessmentGuard did not release after renderer cleanup: ${JSON.stringify(evidence)}`)
  }
  formalGuardReleasedObserved = true
}

async function waitForLocalApiReady(timeout = 120_000) {
  const origin = (process.env.DESKTOP_API_ORIGIN || `http://127.0.0.1:${process.env.PORT || '4000'}`).replace(/\/+$/, '')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2_500) })
      if (response.ok) {
        const body = await response.json()
        if (body?.status === 'ready') return
      }
    } catch {
      // The compose service can be running before its dependency checks pass.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  throw new Error('Local API did not become ready after packaged offline startup probe')
}

async function runOfflineStartupRecovery() {
  const offlineUserDataDir = await mkdtemp(resolve(tmpdir(), 'astella-packaged-offline-'))
  let offlineElectronApp
  try {
    await execFileAsync('docker', ['compose', '-f', devComposeFile, 'stop', 'api'], {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    offlineElectronApp = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${offlineUserDataDir}`],
      env: smokeAppEnv,
    })
    const offlineWindow = await offlineElectronApp.firstWindow()
    attachWindowDiagnostics(offlineWindow)
    const boundary = await waitForPackagedWindow(offlineWindow, 'Offline cold start')
    const accessGate = await assertFailClosedAccessGate(offlineWindow, 'Packaged offline cold start')
    offlineAccessGateBoundary = accessGate
    const shell = await offlineWindow.evaluate(() => ({
      hasAccessGate: Boolean(document.querySelector('.desktop-access-gate')),
      hasRoomDom: Boolean(document.querySelector('.scene-stage')),
      hasOnboarding: Boolean(document.querySelector('.onboarding-card')),
      hasActionRail: Boolean(document.querySelector('.action-rail')),
      hasHomeV2Objects: Boolean(document.querySelector('.home-v2-objects')),
    }))
    if (!boundary.hasAccessGate || !shell.hasAccessGate || shell.hasRoomDom || shell.hasOnboarding || shell.hasActionRail || shell.hasHomeV2Objects) {
      throw new Error(`Packaged offline startup did not isolate Room behind the access Gate: ${JSON.stringify({ boundary, accessGate, shell })}`)
    }
    const health = await packagedTransportProbe(offlineWindow, 'health')
    const room = await packagedTransportProbe(offlineWindow, 'room')
    const unavailableCodes = ['api_unavailable', 'network_timeout', 'invoke_failed']
    if (health.ok || !unavailableCodes.includes(health.code) || room.ok || !unavailableCodes.includes(room.code)) {
      throw new Error(`Packaged offline startup did not fail closed at the API boundary: ${JSON.stringify({ health, room })}`)
    }
    const retry = await offlineWindow.evaluate(async () => {
      const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const response = await window.astella.runtime.retryApiConnection({
        meta: {
          version: 1,
          contractVersion: window.astella.contract.contractVersion,
          requestId: opaqueId('packaged-offline-retry-request'),
          correlationId: opaqueId('packaged-offline-retry-correlation'),
          clientStartedAt: new Date().toISOString(),
        },
      }).catch(() => null)
      return response?.ok ? { ok: true, kind: response.data.kind } : { ok: false, code: response?.error?.code ?? 'invoke_failed' }
    })
    if (retry.ok || !unavailableCodes.includes(retry.code)) {
      throw new Error(`Packaged offline retry did not remain fail closed: ${JSON.stringify(retry)}`)
    }
    offlineStartRecovery = true
  } finally {
    await offlineElectronApp?.close()
    await rm(offlineUserDataDir, { recursive: true, force: true })
    await execFileAsync('docker', ['compose', '-f', devComposeFile, 'up', '-d', 'api'], {
      cwd: workspaceRoot,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    await waitForLocalApiReady()
  }
}

async function restartApiForPackagedRecovery() {
  await execFileAsync('docker', ['compose', '-f', devComposeFile, 'stop', 'api'], {
    cwd: workspaceRoot,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  try {
    let unavailable = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      unavailable = await packagedTransportProbe(currentWindow, 'health')
      if (!unavailable.ok && ['api_unavailable', 'network_timeout', 'invoke_failed'].includes(unavailable.code)) break
      await currentWindow.waitForTimeout(500)
    }
    if (!unavailable || unavailable.ok || !['api_unavailable', 'network_timeout', 'invoke_failed'].includes(unavailable.code)) {
      throw new Error(`Packaged API restart did not expose a fail-closed unavailable state: ${JSON.stringify(unavailable)}`)
    }
    const lostProjection = await packagedTransportProbe(currentWindow, 'room')
    if (lostProjection.ok || !['api_unavailable', 'network_timeout', 'invoke_failed'].includes(lostProjection.code)) {
      throw new Error(`Packaged response-loss probe did not fail closed: ${JSON.stringify(lostProjection)}`)
    }
    responseLossRecovery = true
  } finally {
    await execFileAsync('docker', ['compose', '-f', devComposeFile, 'up', '-d', 'api'], {
      cwd: workspaceRoot,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    })
  }

  let recovered = null
  for (let attempt = 0; attempt < 36; attempt += 1) {
    recovered = await currentWindow.evaluate(async () => {
      const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const meta = () => ({
        version: 1,
        contractVersion: window.astella.contract.contractVersion,
        requestId: opaqueId('packaged-restart-request'),
        correlationId: opaqueId('packaged-restart-correlation'),
        clientStartedAt: new Date().toISOString(),
      })
      const response = await window.astella.runtime.retryApiConnection({ meta: meta() })
      return response.ok ? { ok: true, kind: response.data.kind } : { ok: false, code: response.error.code }
    }).catch(() => ({ ok: false, code: 'invoke_failed' }))
    if (recovered.ok && recovered.kind === 'ready') break
    await currentWindow.waitForTimeout(1_000)
  }
  if (!recovered?.ok || recovered.kind !== 'ready') throw new Error(`Packaged API did not recover after restart: ${JSON.stringify(recovered)}`)
  const healthy = await packagedTransportProbe(currentWindow, 'health')
  if (!healthy.ok) throw new Error(`Packaged API health did not recover after restart: ${JSON.stringify(healthy)}`)
  await waitForHomeReady(currentWindow, 20_000)
  apiRestartRecovery = true
}

async function prepareRestartMarker(window) {
  return window.evaluate(async () => {
    const opaqueId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const meta = (workspaceEpoch) => ({
      version: 1,
      contractVersion: window.astella.contract.contractVersion,
      requestId: opaqueId('packaged-marker-request'),
      correlationId: opaqueId('packaged-marker-correlation'),
      ...(workspaceEpoch > 0 ? { workspaceEpoch } : {}),
      clientStartedAt: new Date().toISOString(),
    })
    const sessionResponse = await window.astella.auth.getState({ meta: meta(0) })
    if (!sessionResponse.ok || sessionResponse.data.status !== 'authenticated' || !sessionResponse.data.user || !sessionResponse.data.workspace) {
      throw new Error(`Packaged marker recovery requires an authenticated session: ${JSON.stringify(sessionResponse)}`)
    }
    const epoch = sessionResponse.data.workspaceEpoch
    const projectionResponse = await window.astella.room.getProjection({ meta: meta(epoch) })
    if (!projectionResponse.ok) throw new Error(`Packaged marker recovery room read failed: ${JSON.stringify(projectionResponse)}`)
    const focus = projectionResponse.data.primaryFocus
    const objective = focus.state === 'data' ? focus.data.objective : null
    const cardId = objective?.content.presentation.cardId ?? null
    let resolvedOrigin = cardId && objective
      ? { kind: 'card', cardId, objectiveId: objective.objectiveId }
      : null
    if (!resolvedOrigin) {
      const queueResponse = await window.astella.review.getQueue({ meta: meta(epoch), limit: 20 })
      if (!queueResponse.ok) throw new Error(`Packaged marker recovery queue read failed: ${JSON.stringify(queueResponse)}`)
      const item = queueResponse.data.items.find((candidate) => candidate.startability.kind === 'ready')
      if (!item) throw new Error('Packaged marker recovery requires a card origin or one ready review item')
      resolvedOrigin = {
        kind: 'review',
        scheduleId: item.scheduleId,
        objectiveId: item.objectiveId,
        scheduleGeneration: item.scheduleGeneration,
      }
    }
    const runResponse = await window.astella.learningRun.start({
      meta: meta(epoch),
      commandId: `packaged-marker-start-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      request: {
        version: 2,
        originV2: resolvedOrigin,
        goal: 'stabilize',
        requestedTimeBudgetSeconds: 180,
        responsePreference: 'text',
      },
    })
    if (!runResponse.ok) throw new Error(`Packaged marker recovery run start failed: ${JSON.stringify(runResponse)}`)
    return {
      subjectId: sessionResponse.data.user.userId,
      workspaceId: sessionResponse.data.workspace.workspaceId,
      runId: runResponse.data.runId,
      originV2: runResponse.data.originV2,
    }
  })
}

async function restartPackagedWindow(email, password) {
  await electronApp?.close()
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: smokeAppEnv,
  })
  currentWindow = await electronApp.firstWindow()
  attachWindowDiagnostics(currentWindow)
  await waitForPackagedWindow(currentWindow, 'Restarted')
  await authenticateThroughAccessGate(currentWindow, {
    email,
    password,
    expectedRole: smokeRole,
    label: 'Packaged restart',
  })
}

async function runPackagedRestartRecovery(email, password) {
  const marker = await prepareRestartMarker(currentWindow)
  const markerPath = resolve(userDataDir, 'pending-return-markers-v2.json')
  await writeFile(markerPath, JSON.stringify({
    version: 1,
    entries: [{
      subjectId: marker.subjectId,
      workspaceId: marker.workspaceId,
      marker: {
        version: 2,
        runId: marker.runId,
        originV2: marker.originV2,
        checkedAt: new Date().toISOString(),
      },
    }],
  }), { mode: 0o600 })
  await restartPackagedWindow(email, password)
  const persisted = JSON.parse(await readFile(markerPath, 'utf8'))
  const remaining = persisted.entries?.filter((entry) => entry.subjectId === marker.subjectId && entry.workspaceId === marker.workspaceId) ?? []
  if (remaining.length !== 0) throw new Error(`Packaged marker was not cleared after restart recovery: ${JSON.stringify(remaining)}`)
  markerRestartRecovery = true
}

async function runOwnerJourney(window) {
  if (!ownerCredentialsAvailable) return
  await authenticateThroughAccessGate(window, {
    email: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PASSWORD,
    expectedRole: 'owner',
    label: 'Packaged Owner',
  })
  ownerJourney.authenticated = true

  // 房间里的恢复入口（RunRecoveryNotice）已于 2026-10-01 删除；恢复改由
  // `resumable` 页与 `CardGenerationSurface` 承担。
  const generationRecoveryButton = window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ })
  if (await generationRecoveryButton.count()) {
    await generationRecoveryButton.first().click()
    await window.waitForFunction(
      () => Boolean(document.querySelector('.task-surface--card-generation .card-making-workshop, .task-surface--card-generation .candidate-review-table')),
      undefined,
      { timeout: 15_000 },
    )
    if (await window.locator('.card-generation-hud-state[role="alert"]').count()) {
      throw new Error(`Packaged Owner Card Generation recovery failed: ${await window.locator('.card-generation-hud-state[role="alert"]').innerText()}`)
    }
    const generationContract = await window.evaluate(() => ({
      heading: document.querySelector('.task-title h1, .candidate-desk__title h1, .card-making__header h1')?.textContent?.trim() ?? null,
      runMetaVisible: Boolean(document.querySelector('.card-making__footer')),
      candidateVisible: Boolean(document.querySelector('.candidate-study-card')),
      hudStateVisible: Boolean(document.querySelector('.card-generation-hud-state')),
      // 本机推断出来的"成功"控件在服务端合同里不存在，必须为 0。
      localSuccessControls: [...document.querySelectorAll('button')].filter((button) => /本机候选|自动激活|生成完成/.test(button.textContent ?? '')).length,
    }))
    if (!generationContract.runMetaVisible && !generationContract.candidateVisible && !generationContract.hudStateVisible) {
      throw new Error(`Packaged Owner Card Generation contract failed: ${JSON.stringify(generationContract)}`)
    }
    if (generationContract.localSuccessControls !== 0) {
      throw new Error(`Packaged Owner Card Generation exposed a local-success control: ${JSON.stringify(generationContract)}`)
    }
    ownerJourney.cardGeneration = true
    await window.getByLabel(/关闭任务面并返回/).click()
  }

  await activateHomeAction(window, 'primary')
  await waitForTodayRoute(window, 'Packaged Owner Study')
  await openNotebookFromToday(window)
  await window.waitForFunction(
    () => Boolean(document.querySelector('.notebook[data-mode] .reading-body, .notebook[data-mode] .note-editor .ProseMirror'))
      || Boolean(document.querySelector('.notebook .surface-data-state--error, .notebook .surface-data-state--empty')),
    undefined,
    { timeout: 15_000 },
  )
  if (await window.locator('.notebook .surface-data-state--error, .notebook .surface-data-state--empty').count()) {
    throw new Error(`Packaged Owner Note projection failed: ${await window.locator('.notebook .surface-data-state').first().innerText()}`)
  }
  const ownerNoteContract = await window.evaluate(() => {
    const paper = document.querySelector('.notebook[data-mode]')
    const body = paper?.querySelector('.reading-body')
    const editor = paper?.querySelector('.note-editor .ProseMirror')
    return {
      mode: paper?.getAttribute('data-mode') ?? null,
      bodyChars: ((body?.textContent ?? editor?.textContent) ?? '').trim().length,
      rawIdentityVisible: /\b[0-9a-f]{8}(?:-[0-9a-f-]{27})?\b/i.test(paper?.textContent ?? ''),
    }
  })
  if (ownerNoteContract.mode !== 'read' && ownerNoteContract.mode !== 'edit') {
    throw new Error(`Packaged Owner Note did not enter the real notebook paper: ${JSON.stringify(ownerNoteContract)}`)
  }
  if (ownerNoteContract.bodyChars === 0) throw new Error('Packaged Owner Note projection did not expose real note content')
  if (ownerNoteContract.rawIdentityVisible) throw new Error('Packaged Owner Note exposed a raw identity')
  ownerJourney.note = true

  const startCardGeneration = async () => {
    // 笔记页的入口在生成在飞时会换成状态入口（cardGenerationEntryLabel）。
    const generateCardsButton = window.getByRole('button', { name: /生成学习卡|审核学习卡|处理生成任务|查看生成进度|查看激活进度/ }).first()
    await generateCardsButton.waitFor({ state: 'visible', timeout: 15_000 })
    if (await generateCardsButton.isDisabled()) throw new Error('Packaged Owner Card Generation action is unavailable')
    await generateCardsButton.click()
    await waitForCardGenerationSurface(window)
  }
  await startCardGeneration()
  let selectedCandidate = false
  let lastKeepAttempt = null
  for (let generationAttempt = 0; generationAttempt < 3 && !selectedCandidate; generationAttempt += 1) {
    if (generationAttempt > 0) {
      const returnToNote = window.getByRole('button', { name: '返回笔记' }).first()
      if (await returnToNote.count() === 0) break
      await returnToNote.click()
      await window.locator('.notebook[data-mode]').waitFor({ state: 'visible', timeout: 15_000 })
      await startCardGeneration()
    }
    lastKeepAttempt = null
    for (let attempt = 0; attempt < 5 && !selectedCandidate; attempt += 1) {
    const cardGenerationDeadline = Date.now() + (attempt === 0 ? 180_000 : 60_000)
    while (Date.now() < cardGenerationDeadline) {
      if (await window.locator('.card-generation-hud-state[role="alert"]').count()) break
      if (await window.locator('.candidate-card__meta').filter({ hasText: '待审核' }).count()) break
      const refreshButton = window.getByRole('button', { name: /刷新状态|重新检查/ }).first()
      if (await refreshButton.count()) await refreshButton.click().catch(() => {})
      await window.waitForTimeout(2_000)
    }
    if (await window.locator('.card-generation-hud-state[role="alert"]').count()) {
      const resyncButton = window.getByRole('button', { name: '重新同步' }).first()
      if (await resyncButton.count()) await resyncButton.click().catch(() => {})
      await window.waitForFunction(
        () => !document.querySelector('.card-generation-hud-state[role="alert"]'),
        undefined,
        { timeout: 10_000 },
      ).catch(() => {})
      await window.waitForTimeout(1_000)
      continue
    }
    if (await window.locator('.candidate-card__meta').filter({ hasText: '待审核' }).count() === 0) {
      lastKeepAttempt = { attempt: attempt + 1, reason: 'review_ready_not_reached_before_deadline', diagnostics: await readCardGenerationDiagnostics(window) }
      const refreshButton = window.getByRole('button', { name: /刷新状态|重新检查/ }).first()
      if (await refreshButton.count()) await refreshButton.click().catch(() => {})
      await window.waitForTimeout(1_000)
      continue
    }
    // The worker can replace a failed candidate with a bounded-repair revision
    // between two refreshes. Scope the click to one rendered candidate and
    // require the same DOM snapshot to survive a short settling window so the
    // action carries the latest revision/hash pair from React state.
    // 页 13 一次只渲染一张候选，所以"这张卡"就是 .candidate-study-card 本身。
    const reviewCandidate = window.locator('.candidate-study-card').filter({
      has: window.locator('button').filter({ hasText: /^保留$/ }),
    }).first()
    await reviewCandidate.waitFor({ state: 'visible', timeout: 5_000 })
    const firstSnapshot = await reviewCandidate.innerText()
    await window.waitForTimeout(350)
    const secondSnapshot = await reviewCandidate.innerText()
    if (firstSnapshot !== secondSnapshot) {
      lastKeepAttempt = { attempt: attempt + 1, reason: 'candidate_dom_changed_before_click', diagnostics: await readCardGenerationDiagnostics(window) }
      continue
    }
    const keepButton = reviewCandidate.getByRole('button', { name: '保留', exact: true })
    await keepButton.scrollIntoViewIfNeeded()
    await keepButton.click()
    const reviewCommitDeadline = Date.now() + 45_000
    while (Date.now() < reviewCommitDeadline) {
      // 「保留」的真实回执写在这张卡的 meta 行上：已保留 · 待激活。
      if (await window.locator('.candidate-card__meta').filter({ hasText: '已保留' }).count()) {
        selectedCandidate = true
        break
      }
      if (await window.locator('.card-generation-hud-state[role="alert"]').count()) {
        lastKeepAttempt = { attempt: attempt + 1, reason: 'review_request_rejected', diagnostics: await readCardGenerationDiagnostics(window) }
        break
      }
      await window.waitForTimeout(1_000)
    }
    if (!selectedCandidate) {
      if (!lastKeepAttempt || lastKeepAttempt.attempt !== attempt + 1) {
        lastKeepAttempt = { attempt: attempt + 1, reason: 'review_commit_timeout', diagnostics: await readCardGenerationDiagnostics(window) }
      }
      const resyncButton = window.getByRole('button', { name: '重新同步' }).first()
      if (await resyncButton.count()) await resyncButton.click().catch(() => {})
      const refreshButton = window.getByRole('button', { name: /刷新状态|重新检查/ }).first()
      if (await refreshButton.count()) await refreshButton.click().catch(() => {})
      await window.waitForFunction(
        () => !document.querySelector('.card-generation-hud-state[role="alert"]'),
        undefined,
        { timeout: 10_000 },
      ).catch(() => {})
      await window.waitForTimeout(1_000)
    }
    }
    if (!selectedCandidate && generationAttempt < 2 && lastKeepAttempt?.reason === 'review_ready_not_reached_before_deadline') {
      // Provider output is intentionally not part of the UI contract. A
      // needs_attention run is a valid server terminal for that run, so use a
      // bounded fresh run attempt rather than clicking forbidden controls or
      // treating the failed quality gate as success.
      continue
    }
    break
  }
  if (!selectedCandidate) {
    const diagnostics = { lastKeepAttempt, final: await readCardGenerationDiagnostics(window) }
    throw new Error(`Packaged Owner Card Generation could not commit a stable keep decision: ${JSON.stringify(diagnostics)}`)
  }
  const selectCandidate = window.locator('.candidate-activation-choice input[type="checkbox"]').first()
  await selectCandidate.waitFor({ state: 'visible', timeout: 15_000 })
  await selectCandidate.check()
  const activateButton = window.getByRole('button', { name: /^激活 \d+ 个目标/ })
  await activateButton.waitFor({ state: 'visible', timeout: 15_000 })
  await activateButton.click()
  // 真实回执：.candidate-review-slip__receipt 里的「已确认 N 个目标映射」。
  await window.locator('.candidate-review-slip__receipt').filter({ hasText: '已确认' })
    .waitFor({ state: 'visible', timeout: 30_000 })
  if (await window.locator('.candidate-review-slip__receipt').filter({ hasText: '个目标映射' }).count() === 0) {
    throw new Error(`Packaged Owner Card Activation receipt did not confirm target mappings: ${JSON.stringify(await readCardGenerationDiagnostics(window))}`)
  }
  ownerJourney.cardGeneration = true
  ownerJourney.cardActivation = true
  await window.getByLabel(/关闭任务面并返回/).click()

  // GS-01A ends at the strict CardActivationReceiptV2. The Owner branch must
  // not auto-start a same-session formal LearningRun; that is the Member
  // branch's responsibility in GS-01B.
}

async function runMemberJourney(window) {
  if (!memberCredentialsAvailable || ownerCredentialsAvailable) return
  await authenticateThroughAccessGate(window, {
    email: process.env.MEMBER_EMAIL,
    password: process.env.MEMBER_PASSWORD,
    expectedRole: 'member',
    label: 'Packaged Member',
  })
  memberJourney.authenticated = true

  if (await window.getByRole('button', { name: /查看恢复状态|恢复候选审核/ }).count()) {
    throw new Error('Packaged Member session exposed the Owner-only Card Generation recovery action')
  }

  await activateHomeAction(window, 'review')
  // 页 15 的标题是「复习队列」；卡叠是 [aria-label="复习队列卡叠"] 里的 .deck-card.front。
  await window.getByRole('heading', { name: '复习队列' }).waitFor({ timeout: 20_000 })
  await window.waitForFunction(
    () => Boolean(document.querySelector('.task-surface--review .deck-card.front'))
      || Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.task-surface .surface-data-state--error').count()) {
    throw new Error(`Packaged Member review queue failed: ${await window.locator('.task-surface .surface-data-state--error').innerText()}`)
  }
  if (await window.locator('.task-surface .surface-data-state--empty').count()) {
    throw new Error('Packaged Member review journey requires at least one due ReviewQueueV2 fixture item')
  }
  const reviewStart = window.getByRole('button', { name: /^开始复习/ }).first()
  await reviewStart.waitFor({ state: 'visible', timeout: 15_000 })
  if (await reviewStart.isDisabled()) throw new Error('Packaged Member review item is not startable')
  memberJourney.reviewQueue = true
  await reviewStart.click()

  // LearningRun 用页 16 的 HUD 标题（hud-pages.ts 的 assessment）。
  await window.getByRole('heading', { name: '理解练习' }).waitFor({ timeout: 20_000 })
  await waitForLearningRunPlayer(window, 'Packaged Member LearningRun')
  if (await window.locator('.task-surface .surface-data-state--error').count()) {
    throw new Error(`Packaged Member LearningRun failed: ${await window.locator('.task-surface .surface-data-state--error').innerText()}`)
  }
  await assertFormalGuardActive('Packaged Member LearningRun')
  memberJourney.learningRun = true
  await window.locator('.task-surface[data-transition="entered"]').waitFor({ state: 'visible', timeout: 15_000 })

  if (learningRunResponseLossOperations.includes('draft')) {
    const textEditor = window.locator('.learning-run-response .run-text-editor textarea').first()
    await textEditor.waitFor({ state: 'visible', timeout: 15_000 })
    await textEditor.fill('这是一条用于确认草稿回执的临时回答。')
    const draftResyncDock = window.locator('.learning-run-dock').filter({ hasText: '草稿版本需要同步' })
    await draftResyncDock.waitFor({ state: 'visible', timeout: 15_000 })
    await draftResyncDock.getByRole('button', { name: '同步当前状态' }).click()
    learningRunResponseLossRecoveries.push('draft')
  }

  if (learningRunResponseLossOperations.includes('action')) {
    const hintButton = window.getByRole('button', { name: /给我一点提示|查看第 \d+ 级提示/ }).first()
    await hintButton.waitFor({ state: 'visible', timeout: 15_000 })
    await hintButton.click()
    const resyncDock = window.locator('.learning-run-dock').filter({ hasText: '上一动作结果需要确认' })
    await resyncDock.waitFor({ state: 'visible', timeout: 15_000 })
    await resyncDock.getByRole('button', { name: '同步当前状态' }).click()
    learningRunResponseLossRecoveries.push('action')
  }

  await window.locator('.learning-run-more > summary').click()
  const unableButton = window.getByRole('button', { name: '暂时不会' })
  await unableButton.waitFor({ state: 'visible', timeout: 15_000 })
  await unableButton.click()
  if (learningRunResponseLossOperations.includes('submit')) {
    const resyncDock = window.locator('.learning-run-dock').filter({ hasText: '上一动作结果需要确认' })
    await resyncDock.waitFor({ state: 'visible', timeout: 15_000 })
    const syncButton = resyncDock.getByRole('button', { name: '同步当前状态' })
    await syncButton.click()
    learningRunResponseLossRecoveries.push('submit')
  }
  await window.waitForFunction(
    () => Boolean(document.querySelector('.learning-run-result-board')),
    undefined,
    { timeout: 35_000 },
  )
  if (await window.locator('.learning-run-result-board').count() !== 1) {
    throw new Error('Packaged Member LearningRun did not expose a server result or terminal result')
  }
  memberJourney.result = true

  const resultReturn = window.getByRole('button', { name: /回到复习队列|返回学习空间/ }).first()
  await resultReturn.waitFor({ state: 'visible', timeout: 15_000 })
  await resultReturn.click()
  await window.getByRole('heading', { name: '复习队列' }).waitFor({ timeout: 20_000 })
  await window.waitForFunction(
    () => Boolean(document.querySelector('.task-surface--review .deck-card.front'))
      || Boolean(document.querySelector('.task-surface .surface-data-state--empty, .task-surface .surface-data-state--error')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.task-surface .surface-data-state--error').count()) {
    throw new Error(`Packaged Member review return failed: ${await window.locator('.task-surface .surface-data-state--error').innerText()}`)
  }
  await assertFormalGuardReleased('Packaged Member LearningRun')
  memberJourney.returned = true

  await window.getByLabel('关闭任务面并返回学习空间').click()
  await activateHomeAction(window, 'primary')
  await waitForTodayRoute(window, 'Packaged Member Study')
  await openNotebookFromToday(window)
  await window.waitForFunction(
    () => Boolean(document.querySelector('.notebook[data-mode="read"] .reading-body'))
      || Boolean(document.querySelector('.notebook .surface-data-state--error, .notebook .surface-data-state--empty')),
    undefined,
    { timeout: 20_000 },
  )
  if (await window.locator('.notebook .surface-data-state--error, .notebook .surface-data-state--empty').count()) {
    throw new Error(`Packaged Member Note projection failed: ${await window.locator('.notebook .surface-data-state').first().innerText()}`)
  }
  if (await window.locator('.notebook[data-mode="edit"]').count() !== 0 || await window.locator('.notebook .note-editor .ProseMirror[contenteditable="true"]').count() !== 0) {
    throw new Error('Packaged Member Note projection is not read-only')
  }
  if (await window.getByRole('button', { name: /生成学习卡|审核学习卡|查看生成进度/ }).count() !== 0) {
    throw new Error('Packaged Member Note still exposes the Owner-only Card Generation action')
  }
  memberJourney.note = true
  await window.getByLabel('关闭任务面并返回学习空间').click()
}

try {
  if (portableOfflineOnly) {
    await runPortableOfflineSmoke()
  } else {
  await runOfflineStartupRecovery()
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: smokeAppEnv,
  })
  currentWindow = await electronApp.firstWindow()
  attachWindowDiagnostics(currentWindow)
  const boundary = await waitForPackagedWindow(currentWindow, 'Initial')
  const runtime = await electronApp.evaluate(() => ({
    electronVersion: process.versions.electron ?? 'unknown',
    chromiumVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
  }))

  if (boundary.protocol !== 'astella-app:' || !boundary.hasDesktopPreload || !boundary.hasM2Preload) {
    throw new Error(`Packaged boundary contract failed: ${JSON.stringify(boundary)}`)
  }
  const anonymousAccessGate = smokeRole === 'anonymous'
    ? await assertFailClosedAccessGate(currentWindow, 'Packaged anonymous startup')
    : null
  await runOwnerJourney(currentWindow)
  await runMemberJourney(currentWindow)
  if (errors.length > 0) throw new Error(`Packaged renderer emitted errors: ${errors.join('; ')}`)
  if (process.env.ASTELLA_PACKAGED_API_RESTART === '1') {
    await restartApiForPackagedRecovery()
    const restartCredentials = smokeRole === 'owner'
      ? { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD }
      : { email: process.env.MEMBER_EMAIL, password: process.env.MEMBER_PASSWORD }
    if (!restartCredentials.email || !restartCredentials.password) throw new Error(`Packaged ${smokeRole} restart recovery credentials are unavailable`)
    await runPackagedRestartRecovery(restartCredentials.email, restartCredentials.password)
  }
  if (errors.length > 0) throw new Error(`Packaged renderer emitted errors: ${errors.join('; ')}`)
  if (smokeRole === 'member') {
    formalGuardRuntime = formalGuardActiveObserved && formalGuardReleasedObserved
    if (!formalGuardRuntime) throw new Error('Packaged FormalAssessmentGuard runtime evidence is incomplete')
  } else {
    formalGuardRuntime = 'not_applicable'
  }
  await mkdir(evidenceRoot, { recursive: true })
  const smokeEvidence = {
    schemaVersion: 1,
    kind: 'packaged-smoke',
    artifact: process.env.ASTELLA_PACKAGED_APP?.trim() ? 'configured-external' : relative(appRoot, executablePath).split('\\').join('/'),
    packageContainment,
    runtime,
    boundary,
    authMode: smokeRole,
    ownerJourney,
    memberJourney,
    apiRestartRecovery,
    responseLossRecovery,
    learningRunResponseLossRecovery: smokeRole === 'member' ? learningRunResponseLossRecoveries.length === learningRunResponseLossOperations.length : 'not_applicable',
    learningRunResponseLossOperations: smokeRole === 'member' ? learningRunResponseLossRecoveries : 'not_applicable',
    markerRestartRecovery,
    offlineStartRecovery,
    offlineAccessGateBoundary,
    anonymousAccessGate,
    formalGuardRuntime,
    errors,
  }
  await writeFile(resolve(evidenceRoot, 'package-smoke.json'), `${JSON.stringify(smokeEvidence, null, 2)}\n`, 'utf8')
  await writeFile(resolve(evidenceRoot, `package-smoke-${smokeRole}.json`), `${JSON.stringify(smokeEvidence, null, 2)}\n`, 'utf8')
  process.stdout.write('packaged smoke passed\n')
  }
} finally {
  await electronApp?.close()
  await rm(userDataDir, { recursive: true, force: true })
}
