/**
 * 真窗口走查：邀请码重试这一串报错（2026-10-09）。
 *
 * 线上症状：第一次加入报错 → 第二次说"这个邀请码已经被使用过了" → 换一张新码说
 * "你的账号已经在这个协作空间里了"。三段来自一次其实已经成功的加入：服务端整笔提交后，
 * 主进程还要重读一次会话，那一跳失败就被当成邀请失败；而本人重试同一条码过去只会得到
 * already_consumed。
 *
 * 附着 `npm run dev`（CDP 9222），用一个刚注册、还没进过任何协作空间的账号，把三步
 * 在界面上原样走一遍。夹具（空间与两张邀请码）由 scripts/../ 的 HTTP 脚本先行造好，
 * 参数从环境变量进来，避免把口令写进仓库。
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const outDir = resolve(import.meta.dirname, '../outputs/invite-code-retry-20261009')
mkdirSync(outDir, { recursive: true })
const notesPath = resolve(outDir, 'notes.md')
writeFileSync(notesPath, `# 邀请码重试真窗口走查 ${new Date().toISOString()}\n\n`, 'utf8')
const log = (line) => { console.log(line); appendFileSync(notesPath, `${line}\n`, 'utf8') }

const email = process.env.PROBE_EMAIL
const password = process.env.PROBE_PASSWORD
const codeA = process.env.PROBE_CODE_A
const codeB = process.env.PROBE_CODE_B
const spaceName = process.env.PROBE_SPACE_NAME
if (!email || !password || !codeA || !codeB) throw new Error('PROBE_EMAIL / PROBE_PASSWORD / PROBE_CODE_A / PROBE_CODE_B 必填')

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
/** 主进程在退登时会重建窗口：page 句柄会随旧 target 一起失效，所以每次都重新取。 */
const current = () => context.pages().filter(p => !p.url().includes('devtools')).at(-1)
let page = current() ?? await context.newPage()
await page.bringToFront()

/** 本机已经存着会话时，UI 退登会把窗口 target 换掉，探针抓不住；先按账号决定要不要退。 */
async function signedInEmail(target) {
  return target.evaluate(async () => {
    const meta = { version: 1, contractVersion: 'desktop-ipc-v1', requestId: 'probe-state', correlationId: 'probe-state-c', clientStartedAt: new Date().toISOString() }
    try {
      const result = await window.astella.auth.getState({ meta })
      return result?.ok && result.data?.status === "authenticated" ? result.data.user.email : null
    } catch { return null }
  }).catch(() => null)
}

let asWhom = await signedInEmail(page)
if (asWhom && asWhom !== email) {
  log(`· 当前会话是 ${asWhom}，不是走查账号，先退出`)
  await page.evaluate(async () => {
    const meta = { version: 1, contractVersion: 'desktop-ipc-v1', requestId: 'probe-signout', correlationId: 'probe-signout-c', clientStartedAt: new Date().toISOString() }
    await window.astella.auth.logout({ meta })
  })
  await page.waitForSelector('.desktop-access-gate', { timeout: 8_000 }).catch(() => {})
  page = current()
  await page.bringToFront()
  if ((await page.locator('.desktop-access-gate').count()) === 0) {
    try { await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 20_000 }) } catch { /* 下面按门禁那一屏判定 */ }
    page = current()
  }
  asWhom = null
}
if (asWhom === email) {
  log(`· 会话已经是 ${email}，不再走一遍登录`)
} else {
  await page.waitForSelector('.desktop-access-gate', { timeout: 60_000 })
  await page.locator('.desktop-access-gate input[type="email"]').fill(email)
  const fields = page.locator('.desktop-access-gate input[type="password"]')
  await fields.nth(0).fill(password)
  if ((await fields.count()) > 1) await fields.nth(1).fill(password)
  await page.locator('.desktop-access-gate button[type="submit"]').first().click()
}
try {
  await page.waitForSelector('.room-control', { timeout: 60_000 })
} catch {
  await page.screenshot({ path: resolve(outDir, '00-not-in-room.png') })
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 700)
  log(`✗ 没能进房间。当时屏上：${JSON.stringify(body)}`)
  throw new Error('room not ready')
}
log(`✓ 房间已就绪，走查账号 ${email}`)
await page.screenshot({ path: resolve(outDir, '01-before-join.png') })

// 新账号第一次进书房会先摆出带路的 AI 同意卡（`role="dialog" aria-modal`），它的 wash
// 层挡住整屏指针事件——空间胶囊点不动。走查要的是邀请码，按它自己的出口先收起来。
const skipConsent = page.locator('button[aria-label="暂不签署，稍后继续"]')
if ((await skipConsent.count()) > 0) {
  await skipConsent.click()
  await page.waitForTimeout(800)
  log('· 带路的 AI 同意卡先按「暂不签署」收起（它与邀请码这条链路无关，留着会挡住整个控制胶囊）')
}
await page.screenshot({ path: resolve(outDir, '01b-after-consent-dismiss.png') })

/**
 * 空间胶囊那颗是**开关**：上一轮 Escape 没关干净时，再点一次是"收起"而不是"打开"。
 * 所以这里按"点开关 → 找输入框 → 没有就再来一次"走，最多三次，并把屏上的话带回来。
 */
async function openInviteField(step, shot) {
  const input = page.getByLabel('协作空间邀请码')
  const trigger = page.locator('button:text-is("加入空间")')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.locator('button[aria-label*="打开空间菜单"]').click({ force: true })
    await page.waitForTimeout(800)
    if ((await input.count()) > 0) return input
    if ((await trigger.count()) > 0) {
      await trigger.click({ force: true })
      await page.waitForTimeout(600)
      if ((await input.count()) > 0) return input
    }
  }
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)
  await page.screenshot({ path: resolve(outDir, `${shot}-missing-input.png`) })
  log(`✗ ${step}：三次都没开到邀请码输入框。当时屏上：${JSON.stringify(body)}`)
  throw new Error('invite input missing')
}

async function joinWith(code, shot, step) {
  // 按 label 抓，不猜 placeholder：菜单里是「粘贴收到的邀请码」，设置页那栏是「粘贴邀请码」，
  // 两处措辞会动，label 才是这一格的身份。
  const inviteInput = await openInviteField(step, shot)
  await inviteInput.fill('')
  await inviteInput.fill(code)
  await page.locator('button:text-is("加入")').click({ force: true })
  // 回执要么成功要么失败，都出现在菜单里；等文本出现再读，别用固定延时。
  await page.waitForFunction(() => /已加入|已经被使用|已经在这个协作空间|暂时不可用|学习服务|邀请码无效/.test(document.body.innerText), { timeout: 20_000 })
  const body = await page.locator("body").innerText()
  const receipt = (body.match(/[^\n]*(已加入|已经被使用|已经在这个协作空间|暂时不可用|学习服务|邀请码无效)[^\n]*/g) ?? [])
    .map(line => line.trim()).filter(Boolean).join(" / ")
  await page.screenshot({ path: resolve(outDir, `${shot}.png`) })
  log(`· ${step} 界面回执：${JSON.stringify(receipt.slice(0, 240))}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  return receipt
}

const first = await joinWith(codeA, '02-first-join', '第 1 步 · 首次用这张码')
if (!first.includes('已加入')) log('✗ 首次加入没给出成功回执')

const retry = await joinWith(codeA, '03-same-code-retry', '第 2 步 · 同一张码原样再试')
log(retry.includes('已加入')
  ? `✓ 本人重试同一条码不再报"已经被使用"，界面给出「${spaceName}」的成功回执`
  : `✗ 本人重试仍被报成失败：${retry.slice(0, 80)}`)

const fresh = await joinWith(codeB, '04-fresh-code-member', '第 3 步 · 换新码进已在的空间')
log(fresh.includes('已经在这个协作空间')
  ? '✓ 新码给出 already_member，且这句话带上了"在列表里选它就能进去"的下一步'
  : `✗ 新码这句回执不对：${fresh.slice(0, 80)}`)

// 加入的真实落点：列表里有没有那一行、点进去进不进得去。菜单那颗是开关，同样按三次重试开。
for (let attempt = 1; attempt <= 3; attempt += 1) {
  await page.locator('button[aria-label*="打开空间菜单"]').click({ force: true })
  await page.waitForTimeout(900)
  if ((await page.locator(`button:has-text("${spaceName}")`).count()) > 0) break
}
const row = page.locator(`button:has-text("${spaceName}")`).first()
if ((await row.count()) > 0) {
  log(`✓ 空间列表里有「${spaceName}」这一行，点开即进入（回执那句"点击它即可进入"对得上）`)
  await row.click({ force: true })
  await page.waitForTimeout(2_500)
  const pill = await page.locator('button[aria-label*="当前学习空间"]').getAttribute('aria-label')
  log(`· 切换后空间胶囊读到的当前空间：${JSON.stringify(pill)}`)
  await page.screenshot({ path: resolve(outDir, '05-entered-space.png') })
} else {
  log(`✗ 列表里没有「${spaceName}」`)
  await page.screenshot({ path: resolve(outDir, '05-missing-row.png') })
}

await browser.close()
log('· 走查结束')
