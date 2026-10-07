/**
 * 真窗口核验：伴星输入框传图（2026-10-06）。
 *
 * 附着 `npm run dev` 起的客户端（CDP 9222），走完整的一条路：
 * 注册/登录一个**只用于探测的账号** → 签 AI 同意 → 「＋」选一张测试图上传 →
 * 待发附件的缩略图真的取回字节 → 带图发送 → 她是否调用 `companion_read_image`
 * 读出图里的内容 → 这条图片消息在**三处展示**（气泡、对话手记、伴星中心的对话）
 * 是否都渲染出来。
 *
 * 测试图是画布现造的（不依赖仓库静态资源）：三个红圆 + 一个绿方块 + 大号「7421」，
 * 这三条事实都能在回复里逐条核对；缩略图用像素判定，破图不算通过。
 *
 * 探测账号默认 `companion-probe@astella.local`，口令取 `ASTELLA_PROBE_PASSWORD`
 * （没给就现造一个并把结论写进 outputs）。**不动 owner@astella.local。**
 * 证据与截图落在 outputs/companion-image-probe-20261006/。
 */
import { chromium } from 'playwright'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/companion-image-probe-20261006')
mkdirSync(outDir, { recursive: true })
const notesPath = join(outDir, 'notes.md')
writeFileSync(notesPath, '', 'utf8')
/** 每条结论都同步落盘：中途崩了也留得下已经看到的那部分。 */
const notes = {
  push(line) { console.log(line); appendFileSync(notesPath, `${line}\n`, 'utf8') },
}
const ok = (m) => notes.push(`✓ ${m}`)
const info = (m) => notes.push(`· ${m}`)
const bad = (m) => notes.push(`✗ ${m}`)

const probeEmail = process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local'
const probePassword = process.env.ASTELLA_PROBE_PASSWORD ?? `probe-${Math.random().toString(36).slice(2, 10)}`
const question = '这张图里有什么？请数一下红圆圈，说出那串数字。'

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].newPage())
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))
const shot = async (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
  .catch((e) => { info(`截图失败 ${name}：${String(e).slice(0, 80)}`) })

const finish = async (code = 0) => {
  writeFileSync(join(outDir, 'console-errors.txt'), consoleErrors.join('\n'), 'utf8')
  await browser.close()
  process.exit(code)
}

await page.waitForFunction(
  () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate')),
  undefined, { timeout: 60_000 },
)

// ── 0. 窗口里可能挂着别的账号（这台 dev 上跑过别的探针）：先退干净 ──────
const currentEmail = async () => page.evaluate(async () => {
  const meta = {
    version: 1, contractVersion: 'desktop-ipc-v1',
    requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), clientStartedAt: new Date().toISOString(),
  }
  const response = await window.astella.auth.getState({ meta })
  const data = response?.ok ? response.data : null
  return data?.account?.email ?? data?.user?.email ?? null
}).catch(() => null)

if (await page.locator('.hud-rail').count()) {
  const signedIn = await currentEmail()
  if (signedIn && signedIn !== probeEmail) {
    info(`窗口里挂着 ${signedIn}，先退出登录再用自己的探测账号`)
    await page.evaluate(async () => {
      const meta = {
        version: 1, contractVersion: 'desktop-ipc-v1',
        requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), clientStartedAt: new Date().toISOString(),
      }
      await window.astella.auth.logout({ meta })
    }).catch((e) => bad(`退出登录失败：${String(e).slice(0, 80)}`))
    await page.waitForSelector('.desktop-access-gate', { timeout: 30_000 })
  } else if (signedIn === probeEmail) {
    ok(`会话就是探测账号 ${probeEmail}`)
  } else if (!signedIn) {
    bad('读不到当前登录账号，停在这里：不拿别人的账号改策略、发消息')
    await finish(1)
  }
}
if (await page.locator('.hud-rail').count()) {
  const still = await currentEmail()
  if (still && still !== probeEmail) {
    bad(`窗口仍挂在 ${still}（不是探测账号），停在这里`)
    await finish(1)
  }
}

// ── 1. 进系统 ───────────────────────────────────────────────────────────
if (await page.locator('.desktop-access-gate').count()) {
  if (!(await page.getByRole('button', { name: /创建账号/ }).count())) {
    await page.getByRole('button', { name: /还没有账号？注册/ }).click()
  }
  await page.locator('.desktop-access-gate input[type="email"]').fill(probeEmail)
  const fields = page.locator('.desktop-access-gate input[type="password"]')
  await fields.nth(0).fill(probePassword)
  if (await fields.count() > 1) await fields.nth(1).fill(probePassword)
  await page.getByRole('button', { name: /创建账号/ }).click()
  await page.waitForTimeout(4000)
  if (await page.locator('.desktop-access-gate').count()) {
    info('注册没进去（多半是账号已存在），改走登录')
    if (await page.getByRole('button', { name: /已有账号？登录/ }).count()) {
      await page.getByRole('button', { name: /已有账号？登录/ }).click()
      await page.waitForTimeout(500)
    }
    await page.locator('.desktop-access-gate input[type="email"]').fill(probeEmail)
    await page.locator('.desktop-access-gate input[type="password"]').first().fill(probePassword)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForSelector('.hud-rail', { timeout: 90_000 })
  ok(`探测账号已进入：${probeEmail}（口令 ${probePassword}）`)
} else {
  ok('会话已在（跳过注册/登录）')
}
await page.waitForTimeout(3500)
await shot('01-in-room')

// ── 2. 签 AI 同意 + 打开外发与图片这两道闸 ────────────────────────────
const openSettings = async () => {
  await page.locator('.hud-rail button[data-label="设置"]').click({ force: true }).catch(() => {})
  if (await page.locator('.settings-hud').count()) return
  info('rail 上点设置没开页面，改点「打开设置中心」')
  await page.getByRole('button', { name: '打开设置中心' }).click({ timeout: 10_000 }).catch(() => {})
  await page.waitForSelector('.settings-hud', { timeout: 20_000 })
}
await openSettings()
await page.locator('.settings-menu button', { hasText: 'AI 数据同意' }).first().click()
await page.waitForTimeout(1500)

const switchState = async (name) => page.getByRole('switch', { name }).getAttribute('aria-checked')
const ensureSwitchOn = async (name) => {
  const before = await switchState(name).catch(() => null)
  if (before === null) { bad(`设置页里没有「${name}」这个开关`); return { before, after: null } }
  let after = before
  // 刚签完同意时这一排在重挂，第一下点击可能落在旧节点上：读到没变就再点一次。
  for (let attempt = 0; attempt < 3 && after !== 'true'; attempt += 1) {
    await page.getByRole('switch', { name }).click()
    await page.waitForTimeout(1500 + attempt * 1000)
    after = await switchState(name)
  }
  return { before, after }
}

await page.waitForSelector('[role="switch"]', { timeout: 20_000 })
const consentText = await page.evaluate(() => document.querySelector('.settings-hud')?.innerText ?? '')
if (!/已签署/.test(consentText)) {
  const sign = page.getByRole('button', { name: '签署', exact: true })
  if (await sign.count()) {
    await sign.click()
    await page.waitForTimeout(2500)
    await page.waitForSelector('[role="switch"]', { timeout: 20_000 })
    ok('已签署 AI 使用同意')
  } else info('这一页没有签署按钮（可能已签或政策由空间统一给），按已签继续')
} else info('同意已签（上一轮就签过）')
const external = await ensureSwitchOn('允许发送到外部模型服务')
const images = await ensureSwitchOn('允许发送图片内容')
notes.push(`${images.after === 'true' && external.after === 'true' ? '✓' : '✗'} 数据外发策略：外发 ${external.before}→${external.after}，图片 ${images.before}→${images.after}`)
info('（这一行的 before=false 是 0392 迁移之前建的那份；迁移只改列默认值，不动既有行）')
await shot('02-consent')

// ── 3. 打开气泡轻聊，「＋」= 传图 ──────────────────────────────────────
await page.locator('.hud-rail button[data-label="首页"]').click({ force: true })
await page.waitForTimeout(1500)
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.getByRole('button', { name: '气泡轻聊' }).click()
await page.waitForSelector('.companion-compose-image__input', { timeout: 20_000 })
ok('气泡里的输入框带上了隐藏的传图 input')
await shot('03-bubble-composer')

/** 画布现造测试图，落成 outDir 里的 PNG，返回绝对路径（不依赖仓库静态资源）。 */
const makeTestImage = async () => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 900
    canvas.height = 620
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#f7f5f0'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#d12b2b'
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath()
      ctx.arc(150 + i * 130, 200, 58, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = '#1f9d55'
    ctx.fillRect(700, 130, 120, 120)
    ctx.fillStyle = '#1c1c1c'
    ctx.font = 'bold 120px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('7421', 450, 480)
    return canvas.toDataURL('image/png')
  })
  const path = join(outDir, 'probe-image.png')
  writeFileSync(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return path
}

const imagePath = await makeTestImage()

/** 气泡里的输入框（含那条隐藏 file input）可能已收起，需要时重新打开。 */
const openBubbleComposer = async () => {
  if (await page.locator('textarea[aria-label^="给"]').count()) return
  // 抽屉也可能开着并占着同一批选择器：先收干净再开气泡。
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '气泡轻聊' }).click({ force: true }).catch(() => {})
  await page.waitForSelector('textarea[aria-label^="给"]', { timeout: 20_000 })
}

// 先按真路径试一次：点「＋」应当把系统文件框叫起来（Playwright 拦到 chooser 即算通）。
await openBubbleComposer()
const chooserHandle = await Promise.race([
  page.getByRole('button', { name: '传一张图给伴星' }).click()
    .then(() => page.waitForEvent('filechooser', { timeout: 8000 }))
    .catch(() => null),
  new Promise((r) => setTimeout(() => r('timeout'), 9000)),
])
if (chooserHandle && chooserHandle !== 'timeout') {
  await chooserHandle.setFiles(imagePath)
  ok('走的是真路径：点「＋」→ 系统文件框 → 选中文件')
} else {
  bad('点「＋」没拦到 filechooser（原生对话框没被自动化接管），这一轮改把文件直接交给同一个 input 的 onChange')
  await openBubbleComposer()
  await page.locator('.companion-compose-image__input').setInputFiles(imagePath)
}
const chipAppeared = await page.waitForSelector('.companion-compose-image', { timeout: 25_000 })
  .then(() => true).catch(() => false)
if (!chipAppeared) {
  const why = await page.evaluate(() => ({
    status: document.querySelector('.companion-compose-image__status')?.textContent?.trim() ?? null,
    account: document.querySelector('[title*="@"]')?.getAttribute('title') ?? null,
    hud: Boolean(document.querySelector('.companion-hud')),
    bubbleOpen: Boolean(document.querySelector('textarea')),
    notice: (document.querySelector('[class*="notice"], [class*="failure"]')?.textContent ?? '').trim().slice(0, 120),
  }))
  bad(`附件条没出现：${JSON.stringify(why)}`)
  await shot('04b-no-chip')
  await finish(1)
}
// 缩略图必须真的取回字节：blob URL + naturalWidth>0 才算，"正在载入图片"/破图不算通过。
const chipReady = await page.waitForFunction(() => {
  const chip = document.querySelector('.companion-compose-image')
  const img = chip?.querySelector('img')
  const status = document.querySelector('.companion-compose-image__status')?.textContent ?? ''
  if (status.includes('失败') || status.includes('取不回来')) return false
  return Boolean(img && img.complete && img.naturalWidth > 0)
}, undefined, { timeout: 30_000 }).then(() => true).catch(() => false)
const chip = await page.evaluate(() => ({
  name: document.querySelector('.companion-compose-image__name')?.textContent ?? null,
  ready: document.querySelector('.companion-compose-image')?.dataset.ready ?? null,
  thumbSrc: document.querySelector('.companion-compose-image img')?.src?.slice(0, 24) ?? null,
  natural: document.querySelector('.companion-compose-image img')?.naturalWidth ?? 0,
  status: document.querySelector('.companion-compose-image__status')?.textContent?.trim() ?? null,
}))
notes.push(`${chipReady ? '✓' : '✗'} 待发附件缩略图${chipReady ? '已就位（blob 字节真的取回来了）' : '没取回字节'}：${JSON.stringify(chip)}`)
await shot('04-attachment-chip')
if (!chipReady) await finish(1)

// ── 4. 带图发送 ─────────────────────────────────────────────────────────
await page.locator('textarea[aria-label^="给"]').fill(question)
await page.keyboard.press('Enter')
info('已提交带图的一轮，等她回答（思考开启，可能要几十秒）')
const replied = await page.waitForFunction(() => {
  const papers = document.querySelector('.companion-hud__papers')
  const text = papers?.innerText ?? ''
  const busy = /正在结合当前页面想一想|正在回复|思考中/.test(document.body.innerText)
  return text.trim().length > 4 && !busy
}, undefined, { timeout: 180_000 }).then(() => true).catch(() => false)
await page.waitForTimeout(2500)
const bubble = await page.evaluate(() => document.querySelector('.companion-hud__papers')?.innerText?.trim().slice(0, 600) ?? null)
// 气泡只承载**她的回复**（CompanionReplyPapers 读 chat.richReply.blocks），
// 用户那张图按设计不进气泡——所以这里判的是"她这一轮有没有在气泡里说话"。
if (bubble && bubble.length > 4) ok(`气泡里她的回复：${bubble.slice(0, 200)}`)
else info(`气泡纸面没有正文（等待结果=${replied ? "命中" : "超时"}；用户图按设计不进气泡，正文以手记/伴星中心为准）`)
await shot('05-reply-bubble')

/** 一条图片消息在某处是否真的画出来了：站内 blob 图 + naturalWidth。 */
const imageRender = () => page.evaluate(() => {
  const figures = [...document.querySelectorAll('figure.companion-record__image')]
  return figures.map((figure) => {
    const img = figure.querySelector('img')
    const article = figure.closest('article')
    return {
      caption: figure.querySelector('figcaption')?.textContent?.trim() ?? null,
      role: article?.dataset.role ?? null,
      src: img ? (img.currentSrc || img.src).slice(0, 22) : null,
      natural: img?.naturalWidth ?? 0,
    }
  })
})

// ── 6. 三处展示：气泡（上面已看）→ 对话手记 → 伴星中心的对话 ──────────
const openJournal = async () => {
  const button = page.getByRole('button', { name: '对话手记' })
  if (await button.count()) { await button.click(); return }
  // 气泡开着时那排控件可能不在：先收气泡再点。
  info('「对话手记」不在，先收掉气泡再试一次')
  await page.getByRole('button', { name: '收起消息气泡' }).click().catch(() => {})
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '对话手记' }).click({ timeout: 15_000 })
}
await openJournal()
await page.waitForSelector('.companion-history', { timeout: 20_000 })
await page.waitForTimeout(3000)
const journal = await imageRender()
notes.push(`${journal.some((f) => f.role === 'user' && f.natural > 0) ? '✓' : '✗'} 手记（对话手记抽屉）里的图片渲染：${JSON.stringify(journal)}`)
await shot('06-journal')

await page.getByRole('button', { name: '全部对话' }).click().catch(() => {})
await page.waitForTimeout(1200)
const journalAll = await imageRender()
info(`切到「全部对话」后：${JSON.stringify(journalAll)}`)
await page.getByRole('button', { name: '关闭' }).click().catch(() => {})
await page.waitForTimeout(800)

for (let attempt = 0; attempt < 2; attempt += 1) {
  await page.locator('.hud-rail button[data-label="伴星"]').click({ force: true })
  await page.waitForTimeout(3000)
  if (await page.locator('.cc-house-main').count()) break
  info('没进伴星中心，再点一次 rail 上的「伴星」')
}
// 伴星中心是「房间 + 坐垫页签」那一套：页签在 .cc-room-tabs 里，直接点同名按钮最稳。
const roomTab = async (label) => {
  const tab = page.locator('.cc-room-tabs button', { hasText: label }).first()
  if (await tab.count()) { await tab.click({ force: true }).catch(() => {}); await page.waitForTimeout(4000); return true }
  return false
}
const openedDialogue = await roomTab('对话')
info(`伴星中心「对话」页签：${openedDialogue ? '已点开' : '没找到同名页签'}`)
let centerImages = await imageRender()
if (!centerImages.length) {
  await roomTab('查看对话记录')
  centerImages = await imageRender()
}
const centerText = await page.evaluate(() => document.querySelector('.cc-house-main, main')?.innerText?.replace(/\s+/g, ' ').slice(0, 200) ?? null)
notes.push(`${centerImages.some((f) => f.natural > 0) ? '✓' : '✗'} 伴星中心的对话里的图片渲染：${JSON.stringify(centerImages)}`)
info(`伴星中心当前页文字：${centerText}`)
await shot('07-companion-center')

await finish(0)
