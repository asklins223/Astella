/**
 * 真窗口验收：把 PDF 与 Word 拖进来源库，看解析、正文与失败语是不是真的按这一版说的走。
 *
 * 跑法（dev 栈要在起，凭据用本地探测账号）：
 *   ASTELLA_QA_EMAIL=… ASTELLA_QA_PASSWORD=… node scripts/check-document-capture.mjs <真实 PDF> <真实 DOCX>
 *
 * 起的是**自己的隔离实例**（独立 user-data-dir + 独立渲染端口）：同一个 userData 只允许一个实例活着，
 * 直接再起会把用户正在用的那个 dev 窗口静默 SIGTERM。
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const [pdfPath, docxPath] = process.argv.slice(2)
if (!pdfPath || !docxPath) throw new Error('用法：node scripts/check-document-capture.mjs <真实 PDF> <真实 DOCX>')
const output = resolve(appRoot, '../../outputs/document-capture-20261009')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-document-capture-'))
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5197, strictPort: true } })
await server.listen()
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9237'],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5197' },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const page = await app.firstWindow()
const errors = []
const logs = []
const checks = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => {
  logs.push(`${message.type()}: ${message.text().slice(0, 200)}`)
  if (message.type() === 'error') errors.push(message.text())
})
const check = (condition, label, detail) => {
  checks.push({ ok: Boolean(condition), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const shot = async name => {
  await page.waitForTimeout(200)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, `${name}.png`), Buffer.from(png, 'base64'))
}
const room = fn => page.evaluate(async source => {
  const { useRoomStore } = await import('/src/app/room-store.ts')
  return (new Function('room', source))(useRoomStore)
}, fn)
/**
 * 采集栏那一个隐藏的文件输入：setInputFiles 给的是真文件，`arrayBuffer()` 由操作系统背书。
 *
 * 投放之前要等它**解除禁用**：来源库刚打开那几十毫秒里索引还在加载，整条采集栏是 disabled 的
 * （界面上那颗按钮也是灰的，真人点这里没反应，是诚实的）。Playwright 不等这个状态，
 * 于是它的第一次投放什么也不会发生——探针必须跟同一个门槛。
 */
const dropFile = async path => {
  await page.waitForFunction(() => document.querySelector('input.source-file-input')?.disabled === false, { timeout: 30_000 })
  await page.setInputFiles('input.source-file-input', path)
}
const titles = () => page.evaluate(async () => {
  const { createRequestMeta, unwrapGatewayResult } = await import('/src/app/desktop-client.ts')
  const list = unwrapGatewayResult(await window.astella.source.list({ meta: createRequestMeta(), limit: 50 }))
  return list.items.map(item => ({ id: item.id, title: item.title, status: item.status }))
}
)
/**
 * 等一份新材料出现在来源列表里，并把解析出来的正文取回来。
 *
 * 默认给 90 秒：**dev 模式下第一次解析要 Vite 现编 pdfjs 那一份 chunk**，实测冷编能越过 40 秒；
 * 打包后的应用不吃这一段。这一句写在这里，是为了下一个看到长耗时的人不用重新猜一遍。
 */
const waitForNewSource = async (before, seconds = 90) => {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const now = await titles()
    const created = now.find(item => !before.some(previous => previous.id === item.id))
    if (created) {
      const detail = await page.evaluate(async sourceId => {
        const { createRequestMeta, unwrapGatewayResult } = await import('/src/app/desktop-client.ts')
        const loaded = unwrapGatewayResult(await window.astella.source.get({ meta: createRequestMeta(), sourceId }))
        return { status: loaded.source.status, text: (loaded.segments ?? []).map(segment => segment.text).join('\n\n') }
      }, created.id)
      if (detail.status === "ready") return { ...created, ...detail }
    }
    await page.waitForTimeout(500)
  }
  return null
}
/** 主线程在解析期间是否还转得动：解析跑在 pdf.js 自己的 worker 与异步链路上，界面不该停。 */
const watchThread = () => page.evaluate(() => {
  globalThis.__probe = { gaps: [], sawParsing: false, last: performance.now() }
  globalThis.__timers = [
    setInterval(() => {
      const now = performance.now()
      globalThis.__probe.gaps.push(Math.round(now - globalThis.__probe.last))
      globalThis.__probe.last = now
    }, 5),
    setInterval(() => { if (document.body.innerText.includes('正在本机解析')) globalThis.__probe.sawParsing = true }, 20),
  ]
})
const stopThread = () => page.evaluate(() => {
  globalThis.__timers.forEach(clearInterval)
  const gaps = globalThis.__probe.gaps.slice().sort((a, b) => b - a)
  return { samples: gaps.length, worstGapMs: gaps[0] ?? 0, sawParsing: globalThis.__probe.sawParsing }
})

await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 810); w.show(); w.focus() })
await page.waitForFunction(() => document.querySelector('.companion-presence, .desktop-access-gate input[type="email"]'), { timeout: 40_000 })
if (!await page.locator('.companion-presence').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.ASTELLA_QA_EMAIL ?? process.env.OWNER_EMAIL)
  await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.ASTELLA_QA_PASSWORD ?? process.env.OWNER_PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
await page.waitForFunction(() => document.querySelector('.companion-presence'), { timeout: 40_000 })
await room('room.getState().finishOnboarding()')
await room('room.getState().invoke("open-sources")')
await page.waitForFunction(() => document.querySelector('.capture-strip'), { timeout: 20_000 })

/**
 * 一次投递最多试几次的理由要说清：**dev 模式下第一次投放会被 Vite 现编 pdfjs 那一份 chunk**，
 * 实测冷编一次能越过 40s；打包后的应用不吃这一段。这里重试不是为了掩盖失败，
 * 是为了让这一份脚本在 dev 与 packaged 两种跑法下说的是同一件事。
 */

let aborted = 0
try {
  // 1) PDF：正文进得来，部首区码位折回汉字，中文折行不补空格。
  const before = await titles()
  await page.evaluate(() => {
    const input = document.querySelector('input.source-file-input')
    globalThis.__dropTrace = []
    input.addEventListener('change', event => {
      globalThis.__dropTrace.push({ at: Date.now(), files: event.target.files?.length ?? -1, disabled: event.target.disabled, stillInDom: globalThis.__tracedInput === event.target && document.contains(event.target) })
    }, true)
    globalThis.__tracedInput = input
    globalThis.__dropTrace = []
    const strip = document.querySelector('.capture-strip')
    globalThis.__stripWatch = new MutationObserver(() => { globalThis.__lastStrip = strip?.innerText.slice(-160) ?? null })
    globalThis.__stripWatch.observe(strip, { childList: true, subtree: true, characterData: true })
  })
  await watchThread()
  const started = Date.now()
  await dropFile(pdfPath)
  await page.waitForTimeout(3_000)
  const firstMoments = await page.evaluate(() => ({
    trace: globalThis.__dropTrace,
    strip: document.querySelector('.capture-strip')?.innerText.slice(-260) ?? null,
    inputDisabled: document.querySelector('input.source-file-input')?.disabled ?? null,
    sheetOpen: document.querySelector('.source-capture-sheet')?.hasAttribute('inert') === false,
    dialog: Boolean(document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')),
  }))
  console.log('FIRST DROP MOMENTS', JSON.stringify(firstMoments))
  console.log('PAGE LOGS SO FAR', JSON.stringify(logs.slice(-8)))
  const pdf = await waitForNewSource(before)
  const threads = await stopThread()
  const stripLine = await page.locator('.capture-strip').innerText()
  const text = pdf?.text ?? ''
  check(Boolean(pdf), 'PDF 建出了来源', { before: before.length, strip: stripLine.slice(-220) })
  check(threads.sawParsing, '解析期间界面说出「正在本机解析」')
  check(text.includes('记忆'), 'PDF 正文含文档自己的文字', { chars: text.length, seconds: ((Date.now() - started) / 1000).toFixed(1) })
  check(!/[\u2f00-\u2fd5]/u.test(text), 'Kangxi 部首区码位已折回汉字', { count: (text.match(/[\u2f00-\u2fd5]/gu) ?? []).length })
  const supplement = text.match(/[\u2e80-\u2eff]/gu) ?? []
  console.log(`INFO 部首补充区（Unicode 没有折算关系）残留 ${supplement.length} 个`, JSON.stringify(supplement.slice(0, 6)))
  check(text.includes('检索练习比重读更能留住内容'), '中文折行处没有被补上空格', { sample: text.slice(text.indexOf('检索练习'), text.indexOf('检索练习') + 40) })
  check(/：/.test(text), '全角标点没有被归一改成半角', { count: (text.match(/：/g) ?? []).length })
  check(text.length > 400, 'PDF 正文不是碎片', { chars: text.length })
  check(threads.worstGapMs < 400, '解析期间主线程没有被长时间占住', threads)
  await shot('after-pdf')

  // 2) Word：结构与表格来自文档自己声明的样式。
  const beforeDocx = await titles()
  await dropFile(docxPath)
  const docx = await waitForNewSource(beforeDocx)
  const docxText = docx?.text ?? ''
  check(Boolean(docx), 'Word 建出了来源')
  check(/\|\s*级别\s*\|/.test(docxText), 'Word 表格落成 GFM', { head: docxText.slice(0, 60) })
  check(!docxText.includes('data:image'), 'Word 图片没有变成一整串 base64')
  await shot('after-docx')
  // 读的那一屏：GFM 表格要落成真的表格，不然这一版选 GFM 就只是字符串好看。
  if (docx) {
    await page.evaluate(async sourceId => {
      const { useRoomStore } = await import('/src/app/room-store.ts')
      useRoomStore.getState().setActiveSourceId(sourceId)
      useRoomStore.getState().invoke('open-source')
    }, docx.id)
    await page.waitForSelector('.source-table', { timeout: 15_000 }).catch(() => {})
    check(await page.locator('.source-table').count() > 0, 'Word 表格在原文页落成真的表格')
    await shot('docx-detail')
    // 回资料架：下面那两条要往采集栏投放，停在原文页就没有那一个输入框。
    await room('room.getState().invoke("open-sources")')
    await page.waitForFunction(() => document.querySelector('.capture-strip'), { timeout: 20_000 })
  }

  // 3) 两类收不了的：那两句话要说得出下一步。
  const scanPath = resolve(profile, 'scan.pdf')
  const scanned = await app.evaluate(async ({ BrowserWindow }) => {
    const window = new BrowserWindow({ show: false })
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0"><img width="700" height="900" alt="" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="></body>'))
    const pdf = await window.webContents.printToPDF({})
    window.destroy()
    return Array.from(pdf)
  })
  await writeFile(scanPath, Buffer.from(scanned))
  const beforeScan = await titles()
  await dropFile(scanPath)
  const scan = await waitForNewSource(beforeScan)
  check(Boolean(scan), '没有文字层的 PDF 仍可作为扫描图像收录')
  check(scan?.text.includes('/api/uploads/'), '扫描页图片以站内地址保留')

  const docPath = resolve(profile, 'legacy.doc')
  await writeFile(docPath, 'old binary word')
  await dropFile(docPath)
  await page.waitForFunction(() => document.body.innerText.includes('另存为'), { timeout: 15_000 }).catch(() => {})
  check((await page.locator('.capture-strip').innerText()).includes('另存为'), '旧版 .doc 那句带着下一步')
  await shot('after-refusals')
} catch (failure) {
  aborted += 1
  console.error('PROBE ERROR', failure)
  await shot('error').catch(() => {})
} finally {
  const report = { checks, errors, failed: checks.filter(item => !item.ok).length + aborted }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${report.failed === 0 ? '全部通过' : `有 ${report.failed} 项没通过`} · 页面错误 ${errors.length} 条 · 报告 ${output}`)
  if (errors.length) console.log(errors.slice(0, 5).join('\n'))
  await app.close().catch(() => {})
  await server.close().catch(() => {})
  process.exit(report.failed === 0 ? 0 : 1)
}
