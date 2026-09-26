import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**轮次记录翻页**（PRD §10.3「完整分页历史」；39d W4-5 第四刀的第二半）。
 *
 * 为什么必须真窗口：jsdom 那几条喂的是我按合同拼的回读，"游标真的被送出去、
 * 第二页真的接在第一页后面"这件事在替身里可以两边都自洽。这一份走真 IPC → 真网关 →
 * 真 dev API → 真库，屏幕上的行数就是库里那 12 轮被翻出来的样子。
 *
 * 造 12 轮而不是一颗颗点 12 次：默认页宽是 10，要点满 12 次就得点 12 次"开始／先到这里"，
 * 而那两发的判据另有剧本管（`probe-note-round-form.mts`）。这里 INSERT 之后**重新进这一篇**，
 * 让第一屏是被界面自己读出来的。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-history.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}
if (process.env.PROBE_ALLOW_DB !== '1' || !process.env.PROBE_NOTE_HINT?.trim()) {
  throw new Error('本剧本会直接改 dev 库：必须同时给 PROBE_ALLOW_DB=1 与 PROBE_NOTE_HINT')
}
if (/['";]|--/.test(process.env.PROBE_NOTE_HINT)) {
  throw new Error('PROBE_NOTE_HINT 里不许有引号、分号或注释符')
}

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

const sql = (statement: string): string => execFileSync(
  'docker', ['exec', 'ailearn-dev-postgres-1', 'psql', '-U', 'ailearn', '-d', 'ailearn', '-tAc', statement],
  { encoding: 'utf8' },
).trim()

const NOTE_HINT = process.env.PROBE_NOTE_HINT as string
const FIRST_PAGE_ROWS = 10
const SEEDED_ROUNDS = 12

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w45-history-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

// 重新进这一篇一次：让第一屏由界面自己读出来（而不是我塞给它的）。
// 注意书架可能已经是展开状态——那时再点 `.note-shelf-all` 会一直等不到，
// 所以那一发只在它真在屏幕上的时候才点。
const navToNote = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.waitForTimeout(600)
  if ((await page.locator('.note-shelf-all').count()) > 0) {
    await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })
    await page.waitForTimeout(600)
  }
  await page.locator('.note-row', { hasText: NOTE_HINT }).first().click({ timeout: 20_000 })
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1_500)
}

const historyRows = (page: import('@playwright/test').Page) =>
  page.locator('.notebook-round-history__list > li')
const historyLead = (page: import('@playwright/test').Page) =>
  page.locator('.notebook-round-history p').first()

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  if (await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await emailInput.fill(process.env.OWNER_EMAIL ?? '')
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  await dismissBlockingDialogs(page)

  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })
  const hintRows = page.locator('.note-row', { hasText: NOTE_HINT })
  if ((await hintRows.count()) !== 1) {
    check('提示词只命中一篇笔记', false, `命中 ${await hintRows.count()} 行——歧义时什么都不碰`)
    report()
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  const noteId = sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`)
  if (!/^[0-9a-f-]{36}$/.test(noteId)) {
    check('这句标题在库里只对应一篇', false, noteId)
    report()
    throw new Error('exact-title lookup did not resolve to exactly one note')
  }
  readings.noteId = noteId

  // 起点必须干净：残留的行会让"屏上 10 行"这件事变成猜谜。
  const left = sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`)
  readings.rowsBeforeSeed = Number(left)
  if (Number(left) !== 0) {
    check('起点这篇没有残留的轮次', false, `库里有 ${left} 行——先清掉再跑（别的剧本留下的也算）`)
    report()
    throw new Error('residual rounds on the target note')
  }

  // 12 轮：`created_at` 各差一分钟（同一瞬间的形状由集测那条夹具守，这里要的是"能翻页"）。
  const seeded = sql(`
    insert into note_learning_rounds
      (workspace_id, user_id, note_id, phase, outcome, driving_question, driving_question_source,
       driving_question_revision, note_version_id, source_content_hash,
       max_model_calls, max_wall_clock_seconds, max_tasks, revision, closed_at, created_at, updated_at)
    select n.workspace_id, n.created_by, n.id, 'closed', 'partial',
           '翻页用的那一句问题 ' || g, 'user_authored', 1,
           n.current_version_id, v.content_hash,
           8, 900, 6, 2,
           now() - (g || ' minutes')::interval,
           now() - ((g + 100) || ' minutes')::interval,
           now() - (g || ' minutes')::interval
    from notes n
    join note_versions v on v.id = n.current_version_id
    cross join generate_series(1, ${SEEDED_ROUNDS}) as g
    where n.id = '${noteId}'
    returning id`)
  readings.seededRows = seeded.split('\n').filter((line) => /^[0-9a-f-]{36}$/.test(line.trim())).length
  check('12 轮已按真实形状写进库（含终态与快照锚）', readings.seededRows === SEEDED_ROUNDS, readings.seededRows)

  await navToNote(page)
  await historyLead(page).waitFor({ timeout: 20_000 })
  const firstPageCount = await historyRows(page).count()
  readings.firstPageRows = firstPageCount
  readings.firstPageLead = (await historyLead(page).textContent() ?? '').trim()
  check('第一屏只给一页那么多（不是把 12 轮一次摊完）', firstPageCount === FIRST_PAGE_ROWS, firstPageCount)
  check('还没翻完时那句不替整篇报总数', /列到这里/.test(readings.firstPageLead) && !/开过/.test(readings.firstPageLead), readings.firstPageLead)

  await page.getByRole('button', { name: '看更早的几轮', exact: true }).click({ timeout: 20_000 })
  // 行数直接数（`waitFor` 落在"匹配多个"的定位器上是 strict violation，那不是产品的事）。
  // 先等行数离开 10 或等到超时，把"在飞"与"失败"两种形状分开读。
  for (let tick = 0; tick < 20; tick += 1) {
    await page.waitForTimeout(500)
    if ((await historyRows(page).count()) !== FIRST_PAGE_ROWS) break
  }
  readings.rowsAfterPaging = await historyRows(page).count()
  readings.buttonsAfterPaging = await page.locator('.notebook-round-history button').allTextContents()
  readings.alertAfterPaging = ((await page.locator('.notebook-round-history [role="alert"]').first().textContent().catch(() => '')) ?? '').trim()
  readings.leadAfterPaging = (await historyLead(page).textContent() ?? '').trim()
  check('翻一页之后是接在后面（10 + 2 = 12 行，一屏不少一屏不多）', readings.rowsAfterPaging === SEEDED_ROUNDS, readings.rowsAfterPaging)
  check('翻到底之后那句改口成总数', readings.leadAfterPaging.includes(`这一篇开过 ${SEEDED_ROUNDS} 轮。`), readings.leadAfterPaging)
  const buttonStillThere = (await page.getByRole('button', { name: '看更早的几轮', exact: true }).count()) > 0
  check('到底之后那颗按钮撤掉（留着就是骗人再点一次）', !buttonStillThere, {
    buttons: readings.buttonsAfterPaging, alert: readings.alertAfterPaging,
  })
} finally {
  await app.close().catch(() => undefined)
  if (typeof readings.noteId === 'string') {
    sql(`delete from note_learning_rounds where note_id = '${readings.noteId}'`)
  }
  readings.roundsLeftInDev = Number(sql('select count(*) from note_learning_rounds'))
}

function report(): void {
  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
}
report()
