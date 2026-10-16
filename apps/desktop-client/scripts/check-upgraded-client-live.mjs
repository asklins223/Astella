/**
 * 升级后的真窗口走查（2026-10-16，⑤）。
 *
 * 驱动的是**装在本机的那一份**（/Applications/Astella.app，打的是生产后端），
 * 不是 dev 构建——所以这一条验的是"更新链路走完之后的用户界面"，不是仓库里的代码。
 *
 * 两个模式，因为升级那一步会把应用自己关掉：
 *   MODE=update  进设置 → 更新 → 检查更新 →（下载更新）→ 重启并安装，然后退出
 *   MODE=verify  等新版起来之后重连，跑那三条：打招呼不复述旧失败／笔记写完不再报没成功／念出来的话真落了音频
 *
 * 先按调试端口把装好的那份起起来（同实例锁：一次只能有一份在跑）：
 *   /Applications/Astella.app/Contents/MacOS/Astella --remote-debugging-port=9322 &
 *   MODE=update   ASTELLA_CDP=http://127.0.0.1:9322 node scripts/check-upgraded-client-live.mjs
 *   # 装完会自己重启；等旧端口没了再用同一个端口重连
 *   MODE=verify   ASTELLA_CDP=http://127.0.0.1:9322 node scripts/check-upgraded-client-live.mjs
 */
import { chromium } from '@playwright/test'

const mode = process.env.MODE ?? 'verify'
const cdp = process.env.ASTELLA_CDP ?? 'http://127.0.0.1:9322'
const output = process.env.ASTELLA_PROBE_OUT ?? 'outputs/upgraded-client-20261016'
const { mkdir, writeFile } = await import('node:fs/promises')
const { resolve } = await import('node:path')
await mkdir(resolve(output), { recursive: true })

const browser = await chromium.connectOverCDP(cdp)
const context = browser.contexts().find(ctx => ctx.pages().length > 0) ?? browser.contexts()[0]
const page = context.pages().find(p => !p.url().startsWith('devtools://')) ?? await context.newPage()
await page.bringToFront()

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}
const clickNamed = async (label) => page.evaluate(label => {
  // 优先点看得见的；HUD 收起时「打开设置中心」这类按钮仍在 DOM 里但宽度为 0，
  // 那种只能直接派发 click（真窗口实测：hidden-clicked 一样能打开设置中心）。
  const matches = [...document.querySelectorAll('button, [role="tab"], a')].filter(el =>
    !el.disabled && `${el.textContent || ''}|${el.getAttribute('aria-label') || ''}|${el.getAttribute('title') || ''}`.includes(label))
  const hit = matches.find(el => el.getBoundingClientRect().width > 0) ?? matches[0]
  if (!hit) return null
  hit.click()
  return `${hit.getBoundingClientRect().width > 0 ? 'visible' : 'hidden'}:${(hit.textContent || hit.getAttribute('aria-label') || '').trim().slice(0, 24)}`
}, label)

const FAIL_WORDS = ['没能完成', '没有成功', '这次回复没', '失败了', '中断了', '上次', '之前那几件']

const send = async (text) => {
  if (!await page.locator('textarea[aria-label^="给"]').count()) {
    await page.locator('button[aria-label*="AI 伴星互动"]').first().click({ timeout: 10_000 })
  }
  await page.waitForSelector('textarea[aria-label^="给"]', { timeout: 30_000 })
  await page.locator('textarea[aria-label^="给"]').click()
  await page.locator('textarea[aria-label^="给"]').fill(text)
  await page.keyboard.press('Enter')
}
const lastReply = async () => page.evaluate(() => {
  // HUD 的气泡不是 article：真窗口实测（1.8.6 打包版）正文在 `.companion-hud__sr-status`
  // 与 `.companion-hud` 上，而 `article/.companion-message` 只存在于手记那一层。
  const sr = document.querySelector('.companion-hud__sr-status')
  const text = (sr?.textContent || '').trim().replace(/\s+/g, ' ')
  if (text) return text
  const nodes = [...document.querySelectorAll('article, .companion-message, .cc-bubble')]
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => (el.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
  return nodes.at(-1) ?? ''
})
const waitForFreshReply = async (before, timeoutMs) => {
  // 判据是"这一轮发完了"，不是"文字变了"：同一句请求连着两轮拿到一模一样的回答很常见
  // （真窗口实测：第二次写笔记的正文与第一次一字不差），只比文本会把真回复判成没回。
  // 所以先等那一步真的进入发送中（最多 20 秒），再等它落下来——不然会把上一条当成新的。
  const sending = () => page.evaluate(() => Boolean(document.querySelector('form[data-sending]')))
  const startedAt = Date.now()
  while (Date.now() - startedAt < 20_000) { if (await sending()) break; await page.waitForTimeout(700) }
  const started = Date.now()
  let text = ''
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(2_000)
    text = await lastReply()
    if (!await sending() && text && !/正在想|正在看|正在准备|让我想想/.test(text)) return text
  }
  return text
}

if (mode === 'update') {
  // 设置中心那颗按钮住在 HUD 的快捷面板里，先把 HUD 打开再点（1.8.3 真窗口实测：
  // 面板收起时那颗按钮不在 DOM 里）。它的 aria-label 在有新版本时会变成
  // 「打开设置中心（有新版本 x.y.z）」，这一行本身就是更新链路的第一条读数。
  await page.evaluate(() => {
    const hud = [...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') || '').includes('AI 伴星'))
    if (hud && !document.querySelector('[aria-label*="打开设置中心"]')) hud.click()
  })
  await page.waitForTimeout(1_500)
  const settings = await clickNamed('打开设置中心')
  check(Boolean(settings), '设置中心点得开', { settings })
  await page.waitForTimeout(1_500)
  const toUpdate = await clickNamed('数据与维护') ?? await clickNamed('更新')
  check(Boolean(toUpdate), '「数据与维护」那一组切得过去（更新面板在这一组里）', { toUpdate })
  await page.waitForTimeout(1_000)
  check(await clickNamed('检查更新'), '「检查更新」点得动')
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(3_000)
    if (await clickNamed('下载更新')) { console.log('note: 需要手点下载'); }
    const body = await page.evaluate(() => document.body.innerText)
    const percent = body.match(/正在下载\s*(\d+)%/)?.[1]
    if (i % 10 === 0) console.log(`note: 下载中 ${percent ?? '?'}%（${Math.round(i * 3 / 60)} 分钟）`)
    if (/重启并安装/.test(body)) break
  }
  const readyBody = await page.evaluate(() => document.body.innerText.slice(0, 1200))
  check(/重启并安装/.test(readyBody), '新版下好了，界面上给出「重启并安装」', { excerpt: readyBody.split('\n').filter(Boolean).slice(-6) })
  await writeFile(resolve(output, 'update-panel.txt'), readyBody)
  if (await clickNamed('重启并安装')) console.log('note: 已点「重启并安装」，应用会自己退出并装上新版')
  else check(false, '点不动「重启并安装」')
  await browser.close()
  process.exit(checks.some(c => !c.ok) ? 1 : 0)
}

// ── verify ───────────────────────────────────────────────────────────
// 输入框在 HUD 的气泡轻聊面板里，而那一层是**点出来的**：`el.click()` 派发不出它
// （真窗口实测：只有真鼠标点伴星本体才会把面板打开并挂上 textarea）。
// 但它是个开关——已经开着时再点一次会关掉，所以只在没有输入框时才点。
if (!await page.locator('textarea[aria-label^="给"]').count()) {
  await page.locator('button[aria-label*="AI 伴星互动"]').first().click({ timeout: 15_000 })
}
await page.waitForFunction(() => document.querySelector('textarea[aria-label^="给"], .desktop-access-gate'), { timeout: 45_000 })
const gate = await page.locator('.desktop-access-gate').count()
check(gate === 0, '升级之后还是登录着的（更新没有把人踢出去）', { gate })

const scene = await page.evaluate(() => ({
  hasCompanion: Boolean(document.querySelector('.companion-presence')),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
}))
check(scene.hasCompanion, '伴星在场上', scene)

// ① 打招呼：新的一条回复里不许出现旧失败的字样。
const before = await lastReply()
await send('你好')
const greeting = await waitForFreshReply(before, 90_000)
check(Boolean(greeting), '打招呼拿到了新的回复', { greeting: greeting.slice(0, 120) })
const recap = FAIL_WORDS.filter(word => greeting.includes(word))
check(recap.length === 0, '打招呼没有复述旧失败', { greeting: greeting.slice(0, 160), recap })

// ② 写笔记：落成了就不许再说"没成功"。
const beforeNote = await lastReply()
await send('写一篇三句话的笔记，题目《光子与能级（验收样例）》，写完把标题告诉我。')
const noteReply = await waitForFreshReply(beforeNote, 200_000)
check(Boolean(noteReply), '写笔记那一条拿到了回复', { noteReply: noteReply.slice(0, 160) })
const noteFail = FAIL_WORDS.filter(word => noteReply.includes(word))
const mentions = /光子与能级|已保存|写好了|存好了|笔记已经/.test(noteReply)
check(mentions, '回复里点名了那篇笔记', { mentions, noteReply: noteReply.slice(0, 200) })
check(noteFail.length === 0, '笔记写完没有报"没成功"', { noteFail, noteReply: noteReply.slice(0, 200) })

// ③ 出声：这一轮的语音段真的落到本机音频缓存里（record.json 就是客户端取到字节的凭据）。
await page.waitForTimeout(20_000)
const { homedir } = await import('node:os')
const { readdir, stat } = await import('node:fs/promises')
const root = resolve(homedir(), 'Library/Application Support/astella-desktop-client/companion-message-audio')
const entries = []
const walk = async (dir, depth) => {
  for (const name of await readdir(dir).catch(() => [])) {
    const full = resolve(dir, name)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    if (info.isDirectory() && depth < 3) { await walk(full, depth + 1); continue }
    if (name === 'record.json' && info.mtimeMs > Date.now() - 10 * 60_000) entries.push({ full, size: info.size })
  }
}
await walk(root, 0)
check(entries.length > 0, '这十分钟内真有语音落到本机缓存（念出来的话不是只到气泡）', { freshRecords: entries.map(e => e.full.replace(root, '~')).slice(0, 4) })

const png = await page.screenshot({ path: resolve(output, 'upgraded-window.png') })
await writeFile(resolve(output, 'notes.md'), `# 升级后真窗口走查 2026-10-16（MODE=verify）\n\n`
  + `- 打招呼：${greeting.slice(0, 160)}\n- 写笔记：${noteReply.slice(0, 200)}\n- 新落缓存的语音：${entries.length} 条\n\n`
  + checks.map(c => `- ${c.ok ? 'x' : ' '} ${c.label} ${c.detail === undefined ? '' : JSON.stringify(c.detail)}`).join('\n') + '\n')
void png
await browser.close()
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
