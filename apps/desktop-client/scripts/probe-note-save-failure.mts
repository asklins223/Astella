import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { startFaultProxy } from './fault-proxy.mts'

/**
 * 真窗口剧本（故障档）：**草稿交不出去时那两条路**（39d W4-4 第一半的最后一条欠账）。
 *
 * 成功保存那条路在 `probe-note-start-with-edits.mts` 里验（那儿那两条路根本不出现：
 * 提交完成后本就没有"未提交编辑"）。这一份验的是另一半——"保存失败"：
 *
 *   `fault-proxy` 把 API 改成"写全 503、读照常、**文档流连不上**"。文档流连不上 ⇒ 本机
 *   改的字交不出去 ⇒ `dirty` 一直留着 ⇒ 「先保存再开始／按上次已保存内容开始」**一直在**
 *   （不用抢那一次往返的窗口）。此时：
 *     1. 两条路都在、且「先保存再开始」可点；
 *     2. 点它 ⇒ 保存失败 ⇒ **不许**开轮次（PRD §3.4"不创建看似已开始的空轮次"）；
 *     3. 失败要说得出话（这一页那条保存提示），两条路仍在屏上（可以再试或走另一条）。
 *
 * 附带一条结构性的好性质可以顺便验：文档流没连上时改的字**永远到不了服务端**，
 * 所以跑完不用收尾——书库里那一篇的标题仍是原样（这一条就是本剧本的收尾判据）。
 *
 * 跑法（先 `npm run build`）：`node --experimental-strip-types scripts/probe-note-save-failure.mts`
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}

const step = (label: string): void => { process.stderr.write(`[fault-probe] ${label}\n`) }
const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

const noteHint = process.env.PROBE_NOTE_HINT ?? 'IndexTTS 2.5 让声音跨越语言 - 哔哩哔哩222'
const proxy = await startFaultProxy({ port: 4099, upstreamOrigin: 'http://127.0.0.1:4000' })
readings.faultProxyOrigin = proxy.origin
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w44-fault-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
  env: { ...process.env, DESKTOP_API_ORIGIN: proxy.origin },
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  step('1 登录（代理在 pass 档）')
  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  const gateVisible = await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)
  if (gateVisible) {
    await emailInput.fill(process.env.OWNER_EMAIL ?? '')
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  check('登录成功（读路径经代理照常）', true)

  step('2 开笔记')
  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })
  const hintRows = page.locator('.note-row', { hasText: noteHint })
  const hintCount = await hintRows.count()
  readings.noteHintMatches = hintCount
  if (hintCount !== 1) {
    check('提示词只命中一篇笔记', false, `PROBE_NOTE_HINT="${noteHint}" 命中 ${hintCount} 行`)
  } else {
    const row = hintRows.first()
    const noteTitle = ((await row.locator('strong').textContent()) ?? '').trim()
    readings.noteTitle = noteTitle
    await row.click()
    await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
    const hasObjective = (await page.locator('.notebook-objective').count()) > 0
    check('这一篇有主要动作那一行', hasObjective)

    if (hasObjective) {
      step('3 造脏（编辑态改标题）')
      await page.getByRole('button', { name: '编辑这篇笔记' }).click({ timeout: 20_000 })
      const titleInput = page.locator('#notebook-surface-title')
      const originalTitle = (await titleInput.inputValue()) || noteTitle
      const baseTitle = originalTitle.replace(/(｜探针)+$/, '').slice(0, 40)
      await titleInput.fill(`${baseTitle}｜探针`)

      step('4 翻到 writes-fail（文档流本来就连不上）')
      proxy.setMode('writes-fail')

      step('5 切回阅读态：这次保存交不出去')
      await page.evaluate(() => {
        const target = Array.from(document.querySelectorAll('button'))
          .find((button) => (button.textContent ?? '').includes('预览此版本'))
        if (target instanceof HTMLButtonElement) target.click()
      })
      const options = page.locator('.notebook-objective__choices')
      const appeared = await options.waitFor({ timeout: 10_000 }).then(() => true, () => false)
      check('交不出去时那两条路一直在屏上（不是抢窗口）', appeared)
      readings.optionsAppeared = appeared

      if (appeared) {
        const saveFirst = page.getByRole('button', { name: '先保存再开始' })
        const enabled = !(await saveFirst.isDisabled().catch(() => true))
        check('「先保存再开始」此刻可点', enabled)

        step('6 点「先保存再开始」：保存失败 ⇒ 不许开轮次')
        await saveFirst.click({ timeout: 20_000 })
        await page.waitForTimeout(3_000)
        const runSurfaceVisible = (await page.locator('h2[data-surface-initial-focus="true"]').count()) > 0
        readings.runSurfaceAfterFailedSave = runSurfaceVisible
        check('保存失败就没开轮次', !runSurfaceVisible)

        // 失败要说得出话。文案不一定就是这一句（错误分类不同、页面位置不同都可能变），
        // 所以先把**屏上实际写了什么**读下来，再判"有没有说"。
        const failureText = await page.evaluate(() => {
          const line = document.querySelector('.save-line')?.textContent ?? ''
          const block = document.querySelector('.notebook-objective')?.textContent ?? ''
          const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map((n) => n.textContent ?? '')
          return { line, block, alerts }
        })
        readings.failureText = failureText
        const said =
          /服务暂时没有返回可确认的结果|没能|失败|不可用|重试/.test(`${failureText.line} ${failureText.block} ${failureText.alerts.join(' ')}`)
        check('失败说出了口（不是静默什么都不发生）', said, failureText)

        readings.optionsStillThere = (await options.count()) > 0
        check('两条路还在（可以再试一次，或走另一条）', readings.optionsStillThere === true)
      }

      step('7 收尾：翻回 pass，看服务端那一篇的标题有没有被碰过')
      proxy.setMode('pass')
      // 文档流从来没连上 ⇒ 那几处字到不了服务端；回书库读服务端那一行来证明。
      await page.getByLabel(/关闭任务面并返回/).first().click({ timeout: 8_000 }).catch(() => undefined)
      await page.waitForTimeout(800)
      await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 15_000 }).catch(() => undefined)
      await page.waitForTimeout(1_500)
      const rowAfter = page.locator('.note-row', { hasText: noteHint }).first()
      const titleAfter = ((await rowAfter.locator('strong').textContent().catch(() => '')) ?? '').trim()
      readings.serverTitleAfter = titleAfter
      check('服务端那一篇标题没被碰过（文档流没连上⇒字没到）', titleAfter === baseTitle, { baseTitle, titleAfter })
    }
  }
} finally {
  await app.close().catch(() => undefined)
  await proxy.close().catch(() => undefined)
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
