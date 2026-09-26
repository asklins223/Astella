import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**这一轮冻的正文后来又保存过一版**——那一行说得出来，那颗也真按得下去
 * （39d D3 刀二 上／下 两格，加上 §4.3 后半件）。
 *
 * 为什么必须真窗口：这两格要证的都在"跨层"那一段上——HTTP 那一层多出来的
 * `contentMoved` 要穿过主进程那道**输出校验**（`installHandler(…, noteLearningRoundViewV1Schema)`）、
 * 过 IPC、过 preload、才被渲染层拆出来用。集测钉的是服务端，jsdom 喂的是我按合同自己拼的回读；
 * "信封在主进程被判成非法"这种形状只有真桥跑一次才看得见。
 *
 * **"下一版"怎么来的**：用 SQL 建（版本行＋那一版的块行＋把指针挪过去），
 * 形状与 `checkpointNote` 写的三件事一致（`note/service.ts:626-652`）。
 * 没在真窗口里改正文再点「提交并确认」，是因为笔记的正文事实源是那份 CRDT 文档——
 * 真改一次就把这篇笔记永久改了，剧本没有把它原样还回来的办法；而"开始之前先对齐正文"
 * 那一族自己在 `probe-note-round-form.mts` 与 W4-4 那份剧本里各钉过一次。
 * 这份只负责一件事：**已经保存过下一版之后**，屏上说不说、那颗走不走。
 *
 * 跑法（先 `npm run build`，桌面端吃的是 `out/` 里的产物）：
 *   PROBE_ALLOW_DB=1 node --experimental-strip-types scripts/probe-note-round-content-moved.mts
 *   （目标笔记默认是「学习科学术语定义集」，要换就带 PROBE_NOTE_HINT）
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT?.trim() || '学习科学术语定义集'
const QUESTION = '这一轮冻的正文后来又保存过一版'

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}
if (process.env.PROBE_ALLOW_DB !== '1') {
  throw new Error('本剧本会直接改 dev 库：必须给 PROBE_ALLOW_DB=1')
}
for (const [label, value] of [['PROBE_NOTE_HINT', NOTE_HINT], ['OWNER_EMAIL', process.env.OWNER_EMAIL ?? '']] as const) {
  if (/['";]|--/.test(value)) throw new Error(`${label} 里不许有引号、分号或注释符`)
}

const sql = (statement: string): string => execFileSync(
  'docker', ['exec', 'ailearn-dev-postgres-1', 'psql', '-U', 'ailearn', '-d', 'ailearn', '-tAc', statement],
  { encoding: 'utf8' },
).trim()

/** 写语句带 RETURNING 时 psql 会在数据行后再打一行命令标签，取返回值只认第一行。 */
const firstValue = (raw: string): string => raw.split('\n')[0]?.trim() ?? ''

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

const familyCounts = (): Record<string, number> => ({
  rounds: Number(sql('select count(*) from note_learning_rounds')),
  plans: Number(sql('select count(*) from note_learning_round_plan_revisions')),
  teachings: Number(sql('select count(*) from note_learning_round_teachings')),
  artifacts: Number(sql('select count(*) from note_learning_round_artifacts')),
})
/** 这一发的另一族改动面：版本行与块行（收尾要对账回开跑前那两个数）。 */
const noteShape = (noteId: string): Record<string, number> => ({
  versions: Number(sql(`select count(*) from note_versions where note_id = '${noteId}'`)),
  blocks: Number(sql(`select count(*) from note_blocks b join note_versions v on v.id = b.version_id
                       where v.note_id = '${noteId}'`)),
})

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-d3-content-moved-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

let noteId = ''
let roundId = ''
let versionB = ''
let pointerBefore = ''
let countsBefore: Record<string, number> | null = null
let shapeBefore: Record<string, number> | null = null

type Page = import('@playwright/test').Page

/**
 * 重新进这一篇一次：屏上那一块因此是界面自己读出来的，不是剧本塞进去的。
 *
 * 这里比 `probe-note-round-resume.mts` 那份多了一层"先看行在不在"的循环：本剧本会在
 * **已经停在这一篇上**的时候再走一次这段导航（要的是"重新读一遍"，不是"从别处进来"），
 * 而那时点那颗导航片会把书架收起来——照固定顺序点下去就会等不到那一行（实测红过一次，
 * 报的是 `.note-row` 超时，看着像功能没接上，其实是剧本自己把入口关掉了）。
 */
const navToNote = async (page: Page): Promise<void> => {
  const row = page.locator('.note-row', { hasText: NOTE_HINT })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await row.count()) > 0) {
      await row.first().click({ timeout: 20_000 })
      await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(1_500)
      return
    }
    if ((await page.locator('.note-shelf-all').count()) > 0) {
      await page.locator('.note-shelf-all').first().click({ timeout: 20_000 }).catch(() => undefined)
    } else {
      await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
    }
    await page.waitForTimeout(800)
  }
  throw new Error(`那一行笔记在书架里始终读不到（导航形状变了，得改这段而不是拉长超时）：${JSON.stringify({
    noteRows: await page.locator('.note-row').count(),
    shelfAll: await page.locator('.note-shelf-all').count(),
    notebook: await page.locator('.notebook').count(),
    alert: ((await page.locator('[role="alert"]').first().textContent().catch(() => '')) ?? '').slice(0, 120),
    body: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240),
  })}`)
}

const roundBlock = (page: Page) => page.locator('.notebook-round', { hasText: `这一轮：${QUESTION}` }).first()
const movedLine = (page: Page) => page.locator('[data-round-content-moved]')
const reopenButton = (page: Page) => page.locator('[data-round-reopen-current]')

/** 等一格出现/消失：把"在飞"与"根本没接上"两种形状分开读，不靠固定 sleep 猜。 */
const waitUntil = async (page: Page, probe: () => Promise<boolean>, want: boolean): Promise<boolean> => {
  for (let tick = 0; tick < 40; tick += 1) {
    if (await probe() === want) return true
    await page.waitForTimeout(500)
  }
  return await probe() === want
}

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
  // 等 HUD 真的挂上再点：登录后那一屏是异步读出来的，刚跑完 `npm run build` 的第一次
  // 启动尤其慢（本轮就撞过一次：2.5 秒后导航条还不存在，剧本红在"点不到那颗片"上，
  // 看着像功能坏了）。超时要说清是"没挂上"，不是"点得慢"。
  await page.locator('.hud-rail .nav-chip').first().waitFor({ timeout: 40_000 })

  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })

  // ── 起点：唯一一篇、这一篇零残留轮次、指针与版本/块数各记一个基线 ──
  const hintRows = page.locator('.note-row', { hasText: NOTE_HINT })
  if ((await hintRows.count()) !== 1) {
    check('提示词只命中一篇笔记', false, `命中 ${await hintRows.count()} 行——歧义时什么都不碰`)
    report()
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  noteId = sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`)
  if (!/^[0-9a-f-]{36}$/.test(noteId)) {
    check('这句标题在库里只对应一篇', false, noteId)
    report()
    throw new Error('exact-title lookup did not resolve to exactly one note')
  }
  readings.noteId = noteId
  const ownerMatches = Number(sql(
    `select count(*) from notes n join users u on u.id = n.created_by
      where n.id = '${noteId}' and u.email = '${process.env.OWNER_EMAIL}'`,
  ))
  const residual = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  if (residual !== 0 || ownerMatches !== 1) {
    check('起点干净（这一篇零残留轮次，且创建者就是登录的那个账号）', false, { residual, ownerMatches })
    report()
    throw new Error('the target note is not clean; refusing to write')
  }
  pointerBefore = sql(`select coalesce(current_version_id::text, 'none') from notes where id = '${noteId}'`)
  countsBefore = familyCounts()
  shapeBefore = noteShape(noteId)
  readings.baseline = { pointerBefore, countsBefore, shapeBefore }

  // ── 种一轮：冻在**当前那一版**上，所以此刻那一格应该是「没动过」 ──
  roundId = firstValue(sql(`
    insert into note_learning_rounds
      (workspace_id, user_id, note_id, phase, outcome, driving_question, driving_question_source,
       driving_question_revision, note_version_id, source_content_hash,
       max_model_calls, max_wall_clock_seconds, max_tasks, revision, created_at, updated_at)
    select n.workspace_id, n.created_by, n.id, 'active', null, '${QUESTION}', 'user_authored', 1,
           n.current_version_id, v.content_hash, 8, 900, 6, 1, now(), now()
      from notes n join note_versions v on v.id = n.current_version_id
     where n.id = '${noteId}'
    returning id`))
  if (!/^[0-9a-f-]{36}$/.test(roundId)) {
    check('按服务端那一份形状种出了一轮', false, roundId)
    report()
    throw new Error('seeding the round failed')
  }
  readings.roundId = roundId
  await navToNote(page)
  const lineShown = await roundBlock(page).waitFor({ timeout: 20_000 }).then(() => true, () => false)
  check('种出的那一轮屏上读得到', lineShown, await roundBlock(page).textContent().catch(() => null))
  // 对照：还没保存过下一版时，那一行与那颗都不该出现——少了这一发，"出现"可以是任何东西让它出现。
  check('对照：正文没动过时，屏上不说「后来又保存过一版」，那颗也不摆出来',
    (await movedLine(page).count()) === 0 && (await reopenButton(page).count()) === 0,
    { moved: await movedLine(page).count(), button: await reopenButton(page).count() })

  // ── 保存出下一版（三件事与 checkpointNote 一致：版本行、那一版的块行、指针挪过去） ──
  versionB = firstValue(sql(`
    insert into note_versions (note_id, workspace_id, version_no, content_json, content_hash, created_by)
    select '${noteId}', workspace_id,
           (select max(version_no) from note_versions where note_id = '${noteId}') + 1,
           content_json, md5(random()::text), created_by
      from note_versions where id = '${pointerBefore}'
    returning id`))
  if (!/^[0-9a-f-]{36}$/.test(versionB)) {
    check('建出了下一版', false, versionB)
    report()
    throw new Error('seeding version B failed')
  }
  // 那一版的哈希必须是**真 md5 十六进制**：`noteDetailV1` 那一层按形状校验，
  // 拼一个带字母外的前缀（上一版写的 `probe-moved-…`）会被判成 ZodError ⇒ 500，
  // 屏上读到的就是"笔记库暂时不可用"，看着像功能坏了，其实是剧本造了个非法值。
  sql(`insert into note_blocks (version_id, workspace_id, ordinal, type, content)
       select '${versionB}', workspace_id, ordinal, type, content from note_blocks
        where version_id = '${pointerBefore}'`)
  sql(`update notes set current_version_id = '${versionB}' where id = '${noteId}'`)
  readings.versionB = versionB

  await navToNote(page)
  const appeared = await waitUntil(page, async () => (await movedLine(page).count()) > 0, true)
  const movedText = ((await movedLine(page).first().textContent().catch(() => '')) ?? '').trim()
  readings.movedText = movedText
  readings.buttonsAfterMove = await page.locator('.notebook-round button').allTextContents()
  check('重新进这一篇：那一行说得出来（屏幕上读得到那一句原话，不是只看有个元素）',
    appeared && movedText.includes('这一轮当时用的正文'), {
      appeared, moved: movedText, block: await roundBlock(page).textContent().catch(() => null),
    })
  check('那一行的旁边摆出了「按当前内容新开一轮」',
    (await reopenButton(page).count()) > 0, readings.buttonsAfterMove)

  // ── 点下去：旧的那一条封存成 superseded、新的那一条冻在**当前那一版**、屏上那一行撤掉 ──
  await reopenButton(page).first().click({ timeout: 20_000 })
  const settled = await waitUntil(page, async () => (await movedLine(page).count()) === 0, true)
  const rows = sql(`
    select 'old=' || (select phase || '/' || coalesce(outcome, '-') || '/'
                           || coalesce(cast(note_version_id as text) = '${pointerBefore}', false)
                        from note_learning_rounds where id = '${roundId}')
         || ' new=' || (select phase || '/' || coalesce(cast(note_version_id as text) = '${versionB}', false)
                          || '/' || driving_question from note_learning_rounds
                         where note_id = '${noteId}' and phase <> 'closed')
  `).trim()
  readings.rowsAfterReopen = rows
  check('旧的那一条进了终态、原因写着被取代，且冻的还是开它那一版（历史没被重写）',
    rows.startsWith('old=closed/superseded/true'), rows)
  check('新的那一条进行中、冻在刚保存的那一版，且本轮问题沿用同一句',
    rows.includes(`new=active/true/${QUESTION}`), rows)
  check('点过之后屏上撤掉了那一行（新轮冻的就是当前那一版，说不出"动过"才是诚实）',
    settled, { settled, buttons: await page.locator('.notebook-round button').allTextContents() })
  const alertAfter = ((await page.locator('.notebook-round [role="alert"]').first().textContent().catch(() => '')) ?? '').trim()
  check('整个过程屏上没有告警句', alertAfter === '', alertAfter)
} catch (error) {
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  if (countsBefore !== null && shapeBefore !== null) {
    sql(`delete from note_learning_rounds where note_id = '${noteId}'`)
    if (versionB.length === 36) {
      sql(`update notes set current_version_id = ${pointerBefore === 'none' ? 'null' : `'${pointerBefore}'`} where id = '${noteId}'`)
      sql(`delete from note_blocks where version_id = '${versionB}'`)
      sql(`delete from note_versions where id = '${versionB}'`)
    }
    readings.countsAfter = familyCounts()
    readings.shapeAfter = noteShape(noteId)
    readings.pointerAfter = sql(`select coalesce(current_version_id::text, 'none') from notes where id = '${noteId}'`)
    const grew = Object.entries(readings.countsAfter as Record<string, number>)
      .filter(([table, value]) => value !== (countsBefore as Record<string, number>)[table])
      .map(([table, value]) => `${table} ${String((countsBefore as Record<string, number>)[table])}→${String(value)}`)
    const shapeChanged = Object.entries(readings.shapeAfter as Record<string, number>)
      .filter(([table, value]) => value !== (shapeBefore as Record<string, number>)[table])
      .map(([table, value]) => `${table} ${String((shapeBefore as Record<string, number>)[table])}→${String(value)}`)
    check('收尾逐表对照：轮次族四张表回到开跑前，这一篇的版本/块数与指针也都还回去',
      grew.length === 0 && shapeChanged.length === 0
      && readings.pointerAfter === pointerBefore,
      { grew, shapeChanged, pointerAfter: readings.pointerAfter, pointerBefore })
  }
  report()
}

function report(): void {
  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
    process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
  }
  process.stdout.write(`\n合计 ${results.length} 条判据，失败 ${failed.length} 条\n`)
  process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
  if (failed.length > 0) process.exitCode = 1
}
