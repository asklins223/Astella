import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：学习页上那块「我学过的每一轮」（39d W4-8 刀二的最后一格证据）。
 *
 * 为什么必须真窗口：jsdom 那 4 条与主进程对账那 1 条量的是"合同与接线"，量不到
 * 她那一屏上到底画没画出**跨笔记的两行**、那句总数是不是服务端那一份、
 * 「看更早的」那颗点下去接在后面还是把上面那 10 行换掉了。这几件事都是只看得见才作数的。
 *
 * 起点判据（缺一条就不往下写）：两篇目标笔记在库里各只对应一行、且**都没有残留轮次**；
 * 屏上那一块的行数与库里的数一致，否则后面的读数全是猜谜。
 *
 * 跑法（先 `npm run build`；两篇都要是书库里唯一的标题）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<第一篇标题>" PROBE_NOTE_HINT_2="<第二篇标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-personal-record.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}
if (process.env.PROBE_ALLOW_DB !== '1') {
  throw new Error('本剧本会直接改 dev 库：必须显式给 PROBE_ALLOW_DB=1')
}
const HINT_A = (process.env.PROBE_NOTE_HINT ?? '').trim()
const HINT_B = (process.env.PROBE_NOTE_HINT_2 ?? '').trim()
if (!HINT_A || !HINT_B) throw new Error('要两篇笔记：PROBE_NOTE_HINT 与 PROBE_NOTE_HINT_2')
for (const hint of [HINT_A, HINT_B]) {
  if (/['";]|--/.test(hint)) throw new Error('标题里不许有引号、分号或注释符')
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
const report = (): void => {
  console.log('实测读数：')
  console.log(JSON.stringify(readings, null, 2))
  for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}  ${entry.detail === '' ? '' : JSON.stringify(entry.detail)}`)
}

/** 往一篇笔记上种 n 轮（`created_at` 各差一分钟，最新的在最前面）。 */
const seedRounds = (noteId: string, n: number, label: string, minuteBase: number, withTeaching: boolean): void => {
  sql(`
    insert into note_learning_rounds
      (workspace_id, user_id, note_id, phase, outcome, driving_question, driving_question_source,
       driving_question_revision, note_version_id, source_content_hash,
       max_model_calls, max_wall_clock_seconds, max_tasks, revision, closed_at, created_at, updated_at)
    select n.workspace_id, n.created_by, n.id, 'closed', 'partial',
           '${label}的问题 ' || g, 'user_authored', 1,
           n.current_version_id, v.content_hash,
           8, 900, 6, 2,
           -- 两篇**交错**排（甲在偶数分钟前、乙在奇数分钟前）：不然第一页那 10 行全是同一篇，
           -- "跨笔记"与"讲过只出现在种了的那一行"这两条判据根本无从判起（第一版就是这么错的）。
           now() - ((g * 2 + ${minuteBase}) || ' minutes')::interval,
           now() - ((g * 2 + ${minuteBase}) || ' minutes')::interval,
           now() - ((g * 2 + ${minuteBase}) || ' minutes')::interval
    from notes n
    join note_versions v on v.id = n.current_version_id
    cross join generate_series(1, ${n}) g
    where n.id = '${noteId}'
  `)
  if (withTeaching) {
    // 「讲过」那一格只能由真的教学产物行带来——种在这里，屏上才有可对照的事实。
    sql(`
      insert into note_learning_round_teachings
        (workspace_id, user_id, round_id, ordinal, kind, content, source_block_ordinals,
         snapshot_hash, driving_question_revision)
      select r.workspace_id, r.user_id, r.id, 1, 'explanation',
             '{"explanation":"统计信息过期时优化器会选全表扫"}', '{1}',
             '0f1e2d3c4b5a69788796a5b4c3d2e1f0', 1
      from note_learning_rounds r
      where r.note_id = '${noteId}'
    `)
  }
}

const noteIdByTitle = (title: string, what: string): string => {
  const id = sql(`select id from notes where deleted_at is null and title = '${title}'`)
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    check(`${what}在库里只对应一篇`, false, id)
    throw new Error(`exact-title lookup did not resolve to exactly one note for ${what}`)
  }
  return id
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w48-personal-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

const createdNoteIds: string[] = []
try {
  const loginPage = await app.firstWindow()
  await loginPage.waitForLoadState('domcontentloaded')
  const emailBox = loginPage.locator('.desktop-access-gate input[type="email"]')
  if (await emailBox.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await emailBox.fill(process.env.OWNER_EMAIL ?? '')
    await loginPage.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await loginPage.getByRole('button', { name: '登录', exact: true }).click()
  }
  await loginPage.waitForTimeout(3_000)
  await dismissBlockingDialogs(loginPage)

  const noteIdA = noteIdByTitle(HINT_A, '第一篇')
  const noteIdB = noteIdByTitle(HINT_B, '第二篇')
  createdNoteIds.push(noteIdA, noteIdB)
  readings.noteIdA = noteIdA
  readings.noteIdB = noteIdB

  for (const [id, what] of [[noteIdA, '第一篇'], [noteIdB, '第二篇']] as const) {
    const left = sql(`select count(*) from note_learning_rounds where note_id = '${id}'`)
    readings[`rowsBefore_${what}`] = Number(left)
    if (Number(left) !== 0) {
      check(`起点${what}没有残留轮次`, false, `库里有 ${left} 行——先清掉再跑`)
      throw new Error(`residual rounds on ${what}`)
    }
  }

  // 12 + 5 = 17 轮：第一页固定 10 行，剩下的 7 行只能靠「看更早的」拿。
  seedRounds(noteIdA, 12, '甲篇', 0, true)
  seedRounds(noteIdB, 5, '乙篇', 1, false)
  readings.totalInDb = Number(sql(`
    select count(*) from note_learning_rounds
    where note_id in ('${noteIdA}','${noteIdB}')
  `))
  /**
   * 那句总数按**服务端同一份谓词**算（同一空间、可见性那一条、不含回收站），
   * 不按"我创建过的笔记"凑——那是另一个数，屏上对不上时会被误判成产品坏了。
   */
  const owner = sql(`select workspace_id, created_by from notes where id = '${noteIdA}'`).split('|')
  readings.expectedTotal = Number(sql(`
    select count(*) from note_learning_rounds r
    join notes n on n.id = r.note_id
    where r.workspace_id = '${owner[0]}' and r.user_id = '${owner[1]}'
      and n.deleted_at is null
      and (n.share_scope = 'shared' or n.created_by = '${owner[1]}')
  `))

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="今日学习"]').first().click({ timeout: 20_000 })
  await page.waitForTimeout(2_500)

  const block = page.locator('[data-round-record]').first()
  check('那一块在学习页上出现了', await block.count().then((n) => n > 0), await block.count())
  check('标题是「我学过的每一轮」（不与今日那块「学习记录」撞名）',
    (await block.locator('h2 b').first().textContent())?.trim() === '我学过的每一轮',
    await block.locator('h2 b').first().textContent())

  const rowLocators = () => block.locator('[data-round-record-row]')
  const firstPageCount = await rowLocators().count()
  const firstPageText = (await rowLocators().allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())
  readings.firstPageCount = firstPageCount
  readings.firstPageSample = firstPageText.slice(0, 3)
  check('第一页正好 10 行（页大小由服务端合同定，不是屏上有多少算多少）', firstPageCount === 10, firstPageCount)
  // 跨笔记：两篇的篇名都要在第一页上出现，否则这一级还是"按一篇看"。
  const joined = firstPageText.join(' | ')
  check('第一页里两篇的行都在', joined.includes(HINT_A) && joined.includes(HINT_B), {
    hasA: joined.includes(HINT_A), hasB: joined.includes(HINT_B),
  })
  check('「讲过」只出现在真种了教学产物那一行，另一行一个字都不多',
    firstPageText.some((line) => line.includes('讲过')) && firstPageText.some((line) => !line.includes('讲过')),
    firstPageText.map((line) => line.includes('讲过')))

  const lead = (await block.locator('h2 span').first().textContent())?.trim() ?? ''
  readings.leadSentence = lead
  check('那句总数报的是服务端那份，并且说清只列了最近 10 行',
    lead === `我开过 ${readings.expectedTotal} 轮，这里列了最近 10 轮，更早的还能看。`, lead)

  const older = block.getByRole('button', { name: '看更早的几轮' })
  check('还有更早的时那颗按钮在', (await older.count()) === 1, await older.count())
  await older.first().click({ timeout: 20_000 })
  await page.waitForTimeout(2_500)
  const afterCount = await rowLocators().count()
  readings.rowsAfterOlder = afterCount
  check('点下去接在后面，不覆盖已经看到的那 10 行', afterCount === 17, afterCount)
  const leadAfter = (await block.locator('h2 span').first().textContent())?.trim() ?? ''
  readings.leadAfterOlder = leadAfter
  check('翻到底了那句换成「都在上面了」，那颗也随之消失',
    leadAfter === `我开过 ${readings.expectedTotal} 轮，都在上面了。` && (await older.count()) === 0,
    { leadAfter, button: await older.count() })
} finally {
  await app.close().catch(() => undefined)
  // 收尾：种下去的行全部撤掉（两张表都只追加，得带维护口子），并复量到 0。
  if (createdNoteIds.length > 0) {
    const ids = createdNoteIds.join("','")
    sql(`BEGIN; SELECT set_config('app.allow_history_mutation','on',true);
      DELETE FROM note_learning_round_teachings WHERE round_id IN (SELECT id FROM note_learning_rounds WHERE note_id IN ('${ids}'));
      DELETE FROM note_learning_rounds WHERE note_id IN ('${ids}');
      COMMIT;`)
  }
  readings.rowsLeft = createdNoteIds.length === 0 ? -1 : Number(
    sql(`select count(*) from note_learning_rounds where note_id in ('${createdNoteIds.join("','")}')`))
  check('收尾：种下去的轮次一行不剩', readings.rowsLeft === 0, readings.rowsLeft)
}

const failed = results.filter((entry) => !entry.ok)
report()
console.log(`\n合计 ${results.length} 条判据，失败 ${failed.length} 条`)
process.exit(failed.length > 0 ? 1 : 0)
