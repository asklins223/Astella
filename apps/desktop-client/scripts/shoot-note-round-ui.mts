import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * **看一眼**用的截图脚本（不是断言剧本）：把笔记页那三块被我这轮改出来的东西拍下来——
 * 轻量定向表单、从结构另选那几颗、以及那一块轮次记录。
 *
 * 为什么要有这一份：`probe-note-round-form.mts` 里那条"三格在同一行"是**数字代理**
 * （数 `getClientRects()` 里不同的 top），它绿不等于那一块能看。UI 的判据是有人看过。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" SHOT_DIR=... \
 *     node --experimental-strip-types scripts/shoot-note-round-ui.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT ?? ''
const outDir = process.env.SHOT_DIR ?? resolve(homedir(), 'Downloads', 'ailearn-ui-shots')
if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD || NOTE_HINT.length === 0) {
  throw new Error('需要 OWNER_EMAIL / OWNER_PASSWORD / PROBE_NOTE_HINT')
}
mkdirSync(outDir, { recursive: true })

const sql = (statement: string): string => execFileSync(
  'docker', ['exec', 'ailearn-dev-postgres-1', 'psql', '-U', 'ailearn', '-d', 'ailearn', '-tAc', statement],
  { encoding: 'utf8' },
).trim()

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-shoot-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})
const noteIdOf = (): string => sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`)

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  if (await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await emailInput.fill(process.env.OWNER_EMAIL)
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  await dismissBlockingDialogs(page)
  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) { await expandRail.first().click().catch(() => undefined); await page.waitForTimeout(500) }
  // 进这一篇：书架那颗要等列表渲染出来才在（上一版这里 `count()` 读 0 就没点，
  // 于是"没有行"被读成"找不到这篇笔记"）——和起点判据同一条"没赶上 vs 没有"。
  const openNote = async (): Promise<void> => {
    await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
    for (let tick = 0; tick < 12; tick += 1) {
      if ((await page.locator('.note-row', { hasText: NOTE_HINT }).count()) > 0) break
      if ((await page.locator('.note-shelf-all').count()) > 0) {
        await page.locator('.note-shelf-all').first().click({ timeout: 5_000 }).catch(() => undefined)
      }
      await page.waitForTimeout(500)
    }
    await page.locator('.note-row', { hasText: NOTE_HINT }).first().click({ timeout: 20_000 })
    await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
    await page.locator('.notebook-objective').first().waitFor({ timeout: 15_000 }).catch(() => undefined)
    await page.waitForTimeout(1_200)
  }
  await openNote()

  const shot = async (name: string, scope?: string): Promise<void> => {
    const target = scope ? page.locator(scope).first() : page.locator('.hud-surface').first()
    await target.screenshot({ path: resolve(outDir, `${name}.png`) }).catch(async () => {
      await page.screenshot({ path: resolve(outDir, `${name}.png`) })
    })
    process.stdout.write(`写出 ${name}.png\n`)
  }
  const whole = async (name: string): Promise<void> => {
    await page.screenshot({ path: resolve(outDir, `${name}.png`) })
    process.stdout.write(`写出 ${name}.png（整窗 ${page.viewportSize()?.width ?? "?"}px）\n`)
  }

  // ① 表单本来的样子（还没点任何东西）
  await whole('01-form-plain')
  await shot('01b-form-block', '.notebook-round')

  // ② 点了预设 + 结构那几颗在的样子
  await page.getByRole('button', { name: '我完全不熟', exact: true }).click({ timeout: 20_000 })
  await page.waitForTimeout(400)
  await shot('02-form-preset-filled', '.notebook-round')

  // ③ 开一轮之后那一行（含那颗「先到这里」）
  await page.getByRole('button', { name: '开始这一轮', exact: true }).click({ timeout: 20_000 })
  await page.locator('.notebook-round', { hasText: '这一轮：' }).first().waitFor({ timeout: 25_000 })
  await page.waitForTimeout(600)
  await shot('03-round-open', '.notebook-round')
  await whole('03b-round-open-whole')

  // ④ 那一块轮次记录：先收尾，再补几行历史（要"看一眼"就得让它真的有得看）
  await page.getByRole('button', { name: '先到这里', exact: true }).click({ timeout: 20_000 })
  await page.waitForTimeout(1_200)
  if (process.env.PROBE_ALLOW_DB === '1') {
    const noteId = noteIdOf()
    sql(`
      insert into note_learning_rounds
        (workspace_id, user_id, note_id, phase, outcome, driving_question, driving_question_source,
         driving_question_revision, note_version_id, source_content_hash,
         max_model_calls, max_wall_clock_seconds, max_tasks, revision, closed_at, created_at, updated_at)
      select n.workspace_id, n.created_by, n.id, 'closed', 'partial',
             '先弄清「' || case g % 4 when 0 then '间隔重复' when 1 then '提取练习' when 2 then '必要难度' else '一个特别长的小节标题用来看看这一行到底会不会挤爆排版布局规则' end
             || '」这一节在讲什么，以及它和整篇的关系', 'user_authored', 1,
             n.current_version_id, v.content_hash, 8, 900, 6, 2,
             now() - (g || ' hours')::interval, now() - ((g + 400) || ' hours')::interval, now()
      from notes n join note_versions v on v.id = n.current_version_id
      cross join generate_series(1, 11) as g
      where n.id = '${noteId}'`)
  }
  // 重新进这一篇一次（让那一块由界面自己读出来，不是我塞的）
  await openNote()
  await page.locator('.notebook-round-history').first().waitFor({ timeout: 25_000 })
  await page.waitForTimeout(800)
  await shot('04-history-block', '.notebook-round-history')
  await whole('04b-history-whole')

  // ⑤ 翻页之后（那句总数与那颗撤掉的样子）
  await page.getByRole('button', { name: '看更早的几轮', exact: true }).click({ timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(1_500)
  await shot('05-history-paged', '.notebook-round-history')

  // ⑥ 窄屏（我那条 CSS 只写了 flex-wrap，没量过挤不挤）
  await page.setViewportSize({ width: 720, height: 900 })
  await page.waitForTimeout(900)
  await whole('06-narrow')
  await shot('06b-narrow-block', '.notebook-round-history')
} finally {
  await app.close().catch(() => undefined)
  if (process.env.PROBE_ALLOW_DB === '1') {
    sql('delete from note_learning_rounds')
    process.stdout.write(`收尾：dev 库剩 ${sql('select count(*) from note_learning_rounds')} 行\n`)
  }
  process.stdout.write(`图在 ${outDir}\n`)
}
