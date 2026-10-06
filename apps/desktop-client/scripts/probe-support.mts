import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

/**
 * 关掉**挡在侧栏前面的对话框**（探针脚本进去之前先过这一关）。
 *
 * 实测（2026-09-25）：首登之后有时会弹出「来源导入」那条模态（`source-intake-dialog`，
 * 标题「忽略这条链接」）——它的触发条件是**剪贴板里有链接**，于是它出不出现在两次运行之间
 * 会变（我这边几次"卡在开笔记那一步"就是这个）。它挡住的正是 `.hud-rail` 那颗 chip，
 * Playwright 会一直重试到超时。
 *
 * 只认那一颗"忽略这条链接"：**不瞎点**（别的对话框有它自己的语义，探针不该替他决定）。
 */
export async function dismissBlockingDialogs(page: import('@playwright/test').Page): Promise<boolean> {
  const ignoreLink = page.getByRole('button', { name: '忽略这条链接' })
  if ((await ignoreLink.count()) === 0) return false
  await ignoreLink.first().click().catch(() => undefined)
  await page.waitForTimeout(400)
  return true
}

/**
 * 写库探针的**收尾**：把标题上那枚「｜探针」后缀收干净（39d W4-4 那两份剧本共用）。
 *
 * 为什么必须跨实例、而不是在跑完的那个实例里收：主要动作那一行只在阅读态画，而运行面是
 * **盖在笔记上的面**——关掉它之后的落点随状态变（实测三次读不回输入框）；新起一个实例
 * 没有那张面，落点稳定。
 *
 * 为什么必须收：标题是 yjs 文档里那份 meta。**文档增量有两条路**——WS（协同流）与
 * **HTTP 上传**（回执 `via: "uploaded"`）——所以哪怕协同流连不上（故障档代理 501 掉了
 * 升级请求），只要代理翻回 `pass`，排队的那几处字就会被 HTTP 上传那条交上去。实测吃到过
 * 一次（库内复量 1，已收干净）——**这就是"文档流没连上⇒字到不了服务端"那句只对 WS 成立
 * 的反例**。凡是改过标题的剧本，收尾都得跑这一步，并用 SQL 复量到 0。
 *
 * 返回"还剩几行带后缀"（0 = 干净；null = 半路读不到界面，需要人工看一眼）。
 */
export async function cleanupProbeNoteTitles(): Promise<number | null> {
  const appRoot = resolve(import.meta.dirname, '..')
  const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

  const dir = await mkdtemp(resolve(tmpdir(), 'astella-probe-clean-'))
  const app = await electron.launch({
    args: ['.', '--lang=zh-CN', `--user-data-dir=${dir}`],
    cwd: appRoot,
    executablePath,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const email = page.locator('.desktop-access-gate input[type="email"]')
    if (await email.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      await email.fill(process.env.OWNER_EMAIL ?? '')
      await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.waitForTimeout(2_500)
    }
    const expand = page.getByRole('button', { name: '展开目录' })
    if ((await expand.count()) > 0) { await expand.first().click().catch(() => undefined); await page.waitForTimeout(500) }
    for (let round = 0; round < 6; round += 1) {
      await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 }).catch(() => undefined)
      await page.waitForTimeout(700)
      if ((await page.locator('.note-row').count()) === 0) {
        await page.locator('.note-shelf-all').first().click({ timeout: 20_000 }).catch(() => undefined)
        await page.waitForTimeout(700)
      }
      const suffixed = page.locator('.note-row', { hasText: '｜探针' })
      if ((await suffixed.count()) === 0) return 0
      const row = suffixed.first()
      const shown = ((await row.locator('strong').textContent()) ?? '').trim()
      const base = shown.replace(/(｜探针)+$/, '')
      await row.click()
      await page.locator('.notebook').first().waitFor({ timeout: 20_000 }).catch(() => undefined)
      await page.getByRole('button', { name: '编辑这篇笔记' }).click({ timeout: 20_000 }).catch(() => undefined)
      await page.waitForTimeout(500)
      const input = page.locator('#notebook-surface-title')
      if ((await input.count()) === 0) return null
      await input.fill(base).catch(() => undefined)
      await page.getByRole('button', { name: '预览此版本' }).click({ timeout: 20_000 }).catch(() => undefined)
      // 防抖 1.2s ＋ 一次往返；1.5s 卡边界上（实测漏过一次）。
      await page.waitForTimeout(3_200)
    }
    return await page.locator('.note-row', { hasText: '｜探针' }).count()
  } finally {
    await app.close().catch(() => undefined)
  }
}
