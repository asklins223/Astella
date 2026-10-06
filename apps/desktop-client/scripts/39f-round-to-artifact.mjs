/*
 * 真窗口：走完一整轮，直到模型自写的那一页上屏（2026-09-28 用户裁决之后）。
 *
 * 产物只在**新生成一条讲解**时才会重跑（`reused` 那条短路直接返回已有讲解），所以走的是
 * "结束这一轮 → 开新一轮 → 先看讲解"这一条真实用户路径。
 *
 * 导航按**实测的 DOM 形状**写死：左侧 rail 的 `button.nav-chip[aria-label="笔记"]` 进笔记库，
 * 书架上按标题前缀点开那一篇，页脚的「继续写」进学习页。历史教训（39f §6）：靠"看起来像"的
 * 选择器走，失败时只会安静地什么都没做——所以每一跳都断言落点。
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(appRoot, '../../.impeccable/review/39f-verify')
await mkdir(outDir, { recursive: true })

const NOTE_PREFIX = process.env.ASTELLA_VERIFY_NOTE ?? 'IndexTTS 2.5 让声音跨越语言'
const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const window = browser.contexts()[0].pages()[0]
const errors = []
window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
window.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
const settle = (ms = 1200) => window.waitForTimeout(ms)
const say = (l) => console.log(l)
let shotNo = 20
const shot = async (name) => {
  shotNo += 1
  const f = resolve(outDir, `${shotNo}-${name}.png`)
  await window.screenshot({ path: f })
  say(`  📸 ${f}`)
}

const state = () => window.evaluate(() => ({
  page: document.querySelector('.desktop-app')?.getAttribute('data-hud-page'),
  scene: document.querySelector('[data-learning-scene]')?.getAttribute('data-learning-scene') ?? null,
  frame: Boolean(document.querySelector('iframe')),
  bench: Boolean(document.querySelector('[data-round-bench="inline"]')),
  notice: document.querySelector('[data-round-notice]')?.textContent?.trim().slice(0, 90) ?? null,
  plate: document.querySelector('.notebook-journey__plate-question')?.textContent?.trim() ?? null,
  dock: [...document.querySelectorAll('.notebook-journey__dock button')].map((b) => b.textContent?.trim()),
  buttons: [...document.querySelectorAll('#notebook-learning-leaf button')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim()),
  presets: [...document.querySelectorAll('#notebook-learning-leaf button')].map((b) => b.textContent?.trim()).filter((t) => t?.startsWith('先弄懂')),
  hasInput: Boolean(document.querySelector('#notebook-round-question')),
}))

const clickText = async (text, { timeout = 6000, label = text } = {}) => {
  const t = window.getByText(text, { exact: false }).first()
  if (!(await t.count())) return false
  try { await t.waitFor({ state: 'visible', timeout }) } catch { return false }
  await t.click({ force: true })
  say(`  ▸ 点「${label}」`)
  await settle()
  return true
}

try {
  // ── 零、等窗口真的起来（刚重启时 `.desktop-app` 还没挂上，探测会读到 undefined）──
  await window.waitForFunction(
    () => Boolean(document.querySelector('.desktop-app')),
    undefined,
    { timeout: 60_000 },
  )
  await settle(1500)
  // 会话过期时门控是一张真的登录卡：那不是「没进到书房」，得先把门打开。
  if (await window.locator('.desktop-access-gate input[type="email"]').count()) {
    say('  · 会话已过期，按开发凭据重新登录')
    await window.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL ?? '')
    await window.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await window.getByRole('button', { name: '登录', exact: true }).click()
    await window.waitForFunction(() => Boolean(document.querySelector('.hud-rail')), undefined, { timeout: 60_000 })
    await settle(2500)
  }
  say(`✓ 窗口就绪（hudPage=${(await state()).page}）`)

  // ── 一、回到笔记库 ───────────────────────────────────────────────────
  if ((await state()).page !== '07') {
    const chip = window.locator('button.nav-chip[aria-label="笔记"]').first()
    if (await chip.count()) { await chip.click({ force: true }); await settle(3000) }
  }
  let s = await state()
  if (s.page !== '07') throw new Error(`没进到笔记库（hudPage=${s.page}）`)
  say('✓ 笔记库')

  // ── 二、打开那一篇 ───────────────────────────────────────────────────
  const cover = window.getByText(NOTE_PREFIX, { exact: false }).first()
  await cover.waitFor({ state: 'visible', timeout: 10_000 })
  await cover.click({ force: true })
  await settle(3000)
  say('  ▸ 打开目标笔记')
  await shot('note-open')

  // ── 三、进学习页（笔记详情页脚那颗主动作）────────────────────────────
  if (!(await clickText('开始学习', { label: '开始学习' })) && !(await clickText('继续学习'))) {
    throw new Error('笔记详情页脚没有「开始学习」')
  }
  s = await state()
  say(`✓ 学习页 scene=${s.scene} dock=${JSON.stringify(s.dock)}`)

  // ── 四、结束已有那一轮（产物只在**新讲解**时重跑）────────────────────
  if (await clickText('今天先到这里', { label: '今天先到这里（结束旧轮）' })) {
    await settle(2500)
    s = await state()
    if (s.scene === null && !(await clickText('开始学习', { label: '开始学习（再进一次）' }))) {
      throw new Error('结束之后回不去学习页')
    }
  }

  // ── 五、定一个问题 ───────────────────────────────────────────────────
  s = await state()
  if (!s.hasInput) {
    if (await clickText('换个问题，或者收尾')) await settle(400)
    if (await clickText('换一个问题')) await settle(600)
    s = await state()
  }
  if (!s.hasInput && !s.presets.length) throw new Error(`没进到定问题那一屏：${JSON.stringify(s)}`)
  // 优先用**有依据**的方向：这一篇自己的小节。
  const structure = window.locator('.notebook-journey__suggestions button')
  if (await structure.count()) {
    const n = await structure.count()
    const at = Math.min(1, n - 1)
    const label = (await structure.nth(at).textContent())?.trim()
    await structure.nth(at).click({ force: true })
    say(`  ▸ 用小节候选「${label}」`)
  } else if (s.presets.length) {
    await clickText(s.presets[1] ?? s.presets[0])
  }
  await settle(400)
  // 按钮随"这一轮开没开"换名字：新开是「开始这一轮」，改已有那一轮是保存。两种都收。
  let submitted = false
  for (const name of ['开始这一轮', '保存', '换好了', '就这样', '开始学']) {
    if (await clickText(name)) { submitted = true; say(`  ▸ 提交问题（${name}）`); break }
  }
  if (!submitted) throw new Error(`没有可提交问题的按钮：${JSON.stringify((await state()).buttons)}`)
  await settle(2500)
  s = await state()
  say(`✓ 开了一轮：${s.plate ?? ''}`)
  await shot('round-open')

  // ── 六、看讲解（含依据核对 + 模型整页生成）────────────────────────────
  if (!(await clickText('先看讲解'))) throw new Error(`没有「先看讲解」：${JSON.stringify(s.dock)}`)
  say('  …生成中（讲解 → 依据核对 → 整页演示），可能要几分钟')
  let ok = false
  for (let i = 0; i < 90; i += 1) {
    await window.waitForTimeout(5000)
    const cur = await state()
    if (i % 6 === 0) say(`  ${i * 5}s ${JSON.stringify({ scene: cur.scene, frame: cur.frame, notice: cur.notice })}`)
    if (cur.frame) { say(`  ✓ 产物上屏（${i * 5}s）`); ok = true; break }
    if (cur.notice && (cur.notice.includes('没有完成') || cur.notice.includes('被挡住'))) { say(`  ✗ ${cur.notice}`); break }
  }

  const fin = await state()
  await shot(ok ? 'artifact' : 'no-artifact')
  say(`\nfinal: ${JSON.stringify(fin)}`)

  if (ok) {
    const f = window.frames().find((x) => x !== window.mainFrame())
    if (f) {
      const probe = await f.evaluate(() => {
        const stage = document.querySelector('[data-stage]')
        const notice = document.querySelector('.astella-art__notice')
        return {
          outline: document.querySelector('[data-artifact-root]')?.getAttribute('data-outline-count'),
          svgs: document.querySelectorAll('svg').length,
          buttons: document.querySelectorAll('button').length,
          evidence: document.querySelectorAll('.astella-art__evidence-quote').length,
          textEquiv: document.querySelectorAll('.astella-art__list li').length,
          lessonMotion: typeof window.setLessonMotion === 'function',
          oldStepApi: typeof window.__artifact,
          headline: document.querySelector('.astella-art__title')?.textContent?.trim(),
          // 示意声明必须**看得见**：模型写 `.astella-art__notice{display:none}` 藏不掉它。
          noticeVisible: notice ? getComputedStyle(notice).display !== 'none' && notice.getBoundingClientRect().height > 0 : null,
          lessonMint: stage ? getComputedStyle(stage).getPropertyValue('--lesson-mint').trim() : null,
          stageHtml: (stage?.innerHTML ?? '').length,
        }
      }).catch((e) => ({ error: String(e) }))
      say(`\n[演示页] ${JSON.stringify(probe, null, 1)}`)
      await window.locator('iframe').first().scrollIntoViewIfNeeded()
      await settle(600)
      await shot('frame-closeup')
      // 教具必须能动：点一下画面里第一颗按钮，看画面有没有变
      const clicked = await f.evaluate(() => {
        const b = [...document.querySelectorAll('button')][0]
        if (!b) return null
        const before = document.body.innerText.slice(0, 300)
        b.click()
        return { label: b.textContent?.trim().slice(0, 20), textChanged: document.body.innerText.slice(0, 300) !== before }
      }).catch((e) => ({ error: String(e) }))
      say(`  [动手] ${JSON.stringify(clicked)}`)
      await settle(800)
      await shot('after-click')
    }
  }
} catch (e) {
  say(`\n!! ${e.message}`)
  await shot('error')
}

say(`\nERRORS: ${errors.length ? errors.join(' | ') : '(none)'}`)
await browser.close()
