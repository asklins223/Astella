import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

/**
 * 真窗口剧本：**有未提交编辑时那两条路**（39d W4-4 第一半）。
 *
 * 为什么必须真窗口：桌面单测里那两条被挂起（`notebook-surface.objective-action.test.tsx`
 * 的 `it.skip`）——夹具里那条文档传输的失败/成功时序复现不出来。真窗口里同一个状态是
 * 真的：`switchMode("read")` 会**顺手发起一次自动保存**，保存成功则 `dirty` 当场清掉、
 * 两条路只在这个保存窗口里存在；保存失败（线上真实会发生的一种）则一直留着。
 *
 * 这一份验得到的只有"窗口里那两条路确实在、且「按上次已保存内容开始」真的是按上次
 * 已保存的版本开轮次"。「先保存再开始」那一半要一次**真的保存失败**才点得到，本轮
 * 不伪造失败（不去打挂共享的 dev API）——它在台账里如实记为仍欠。
 *
 * 跑法（先 `npm run build`）：
 *   node --experimental-strip-types scripts/probe-note-start-with-edits.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w44-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

const versionLabel = (): Promise<number | null> =>
  app.windows()[0].evaluate(() => {
    const text = document.body.textContent ?? ''
    const match = text.match(/版本 v(\d+)/)
    return match ? Number(match[1]) : null
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // 1. 登录（dev owner 账号）。首屏就是登录档（`registering` 默认 false），
  //    没有"已有账号？登录"那颗（那是注册档上的切换）——所以直接填表。
  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  const gateVisible = await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)
  if (gateVisible) {
    await emailInput.fill(process.env.OWNER_EMAIL ?? '')
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  readings.gateWasVisible = gateVisible
  check('登录成功（书桌出现）', true, gateVisible ? '' : '没看到登录档（可能已登录）')

  // 2. 开一篇笔记：笔记 → 全部笔记 → 第一行。
  // 侧栏可能收着（收起时那颗 chip 被「展开目录」压住）——先展开。
  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })
  const row = page.locator('.note-row').first()
  const noteTitle = ((await row.locator('strong').textContent()) ?? '').trim()
  await row.click()
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  readings.noteTitle = noteTitle
  check('打开了一篇笔记', Boolean(noteTitle), noteTitle)

  // 3. 这一篇有没有那颗主要动作（没有目标就没有它，这一篇就验不了）。
  const hasObjective = (await page.locator('.notebook-objective').count()) > 0
  readings.hasObjectiveBlock = hasObjective
  if (!hasObjective) {
    check('这一篇有主要动作那一行', false, '读不到 .notebook-objective（这一篇没有目标）——换一篇再跑')
  } else {
    const versionBefore = await versionLabel()
    readings.versionBefore = versionBefore

    // 4. 进编辑态改一个字，再切回阅读态——**在同一帧里**看那两条路在不在
    //    （保存窗口只有一次往返那么长，分成两次调用就抓不到了）。
    await page.getByRole('button', { name: '编辑这篇笔记' }).click({ timeout: 20_000 })
    const titleInput = page.locator('#notebook-surface-title')
    const originalTitle = (await titleInput.inputValue()) || noteTitle
    await titleInput.fill(`${originalTitle.slice(0, 40)}｜探针`)

    const sawChoices = await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('button'))
        .find((button) => (button.textContent ?? '').includes('预览此版本'))
      if (!(target instanceof HTMLButtonElement)) return false
      target.click()
      return new Promise<boolean>((resolvePromise) => {
        requestAnimationFrame(() => {
          resolvePromise(Boolean(document.querySelector('.notebook-objective__choices')))
        })
      })
    })
    readings.sawChoicesInSaveWindow = sawChoices
    check('切回阅读态那一刻，两条路都在屏上', sawChoices, sawChoices ? '' : '保存窗口里没抓到（保存太快或这一篇不脏）')

    if (sawChoices) {
      const labels = await page.locator('.notebook-objective__choices button').allTextContents()
      readings.choiceLabels = labels
      check(
        '两条路的名字与设计一致',
        labels.some((text) => text.includes('先保存再开始')) && labels.some((text) => text.includes('按上次已保存内容开始')),
        labels,
      )

      // 5. 「按上次已保存内容开始」→ 真的开出轮次，且版本号不涨（那几处字没被算成新版本）。
      await page.getByRole('button', { name: '按上次已保存内容开始' }).click({ timeout: 20_000 })
      await page.locator('h2[data-surface-initial-focus="true"]').first().waitFor({ timeout: 30_000 }).catch(() => undefined)
      const runSurfaceVisible = (await page.locator('h2[data-surface-initial-focus="true"]').count()) > 0
      check('按下去真的开出了一轮（运行面出现）', runSurfaceVisible)
      await page.waitForTimeout(1_000)
      const versionAfterStart = await versionLabel()
      readings.versionAfterStart = versionAfterStart
    }
  }
} finally {
  await app.close().catch(() => undefined)
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
