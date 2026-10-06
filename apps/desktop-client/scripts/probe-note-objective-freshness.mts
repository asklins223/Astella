import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import type { Page } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**同一篇笔记上，"这一篇又保存过一版"这件事在两处各说一句话，且不许合成一句**
 * （39d W4-2 第 6 种的构造场景／样本 ＋ D3 §5.1 后果②的第一次实机证明）。
 *
 * 两句分别住在两个面上：
 * - 目标那一格 `来源已有更新`（`objective-state-copy.freshnessLabel`，服务端 `freshness` 签发）；
 * - 轮次那一格 `这一轮当时用的正文，这一篇后来又保存过一版。`（D3 刀二，`contentMoved`）。
 * D3 §5.1 后果② 明令两者不许合成一句：徽标说的是**这一篇有新版**，那句说的是**这一轮冻的正文**。
 * 此前两格各自有测试，但**没有任何一次实机把两句同时摆在同一屏上**——所以"不合成"一直只是注释。
 *
 * 为什么还要专门跑一次：W4-2 状态格记着"第 6 种的徽标读服务端 `freshness`，其真窗口样本还欠一次"。
 * 那次欠账的根子是一个**错的读数**：D3 §3.3 曾写"26 条 note 型 objective origin、当前版不一致 0 条
 * ⇒ 徽标今天没有任何可达样本"。本轮复算：同一个分母上是 **6 条不一致（5 条 active）**，都在一篇
 * `无标题笔记` 上——那句"没有可达样本"当场作废。只是那一片同名笔记有 9 篇，屏上按标题定位会歧义，
 * 所以这里仍用**构造**：挑一篇标题唯一、挂着 active 笔记型目标的笔记，SQL 造出下一版。
 *
 * 「下一版」用 SQL 建（版本行＋那一版的块行＋把指针挪过去），形状与 `checkpointNote` 写的三件事一致
 * （`note/service.ts:626-652`）。没在真窗口里改正文再点「提交并确认」，是因为正文事实源是那份 CRDT
 * 文档——真改一次就把这篇永久改了，剧本没有把它原样还回来的办法。
 *
 * 这份**不点任何会改状态的东西**：只读屏、只造版、只种一行轮次，收尾全部按开跑前的数还回去。
 *
 * 跑法（先 `npm run build`，桌面端吃的是 `out/` 里的产物）：
 *   PROBE_ALLOW_DB=1 node --experimental-strip-types scripts/probe-note-objective-freshness.mts
 *   （目标笔记默认是「消防疏散与灭火器使用」，要换就带 PROBE_NOTE_HINT）
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT?.trim() || '消防疏散与灭火器使用'
const QUESTION = '这一篇的目标锚在哪一版'
const BADGE_TEXT = '来源已有更新'
const ROUND_TEXT = '这一轮当时用的正文，这一篇后来又保存过一版。'

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
  'docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-tAc', statement],
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

const userDataDir = await mkdtemp(resolve(tmpdir(), 'astella-w42-freshness-'))
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

try {
  // ── 闸门先跑在库里：这一篇必须标题唯一、是登录者本人的、零残留轮次、且**确实挂着 active 的笔记型目标** ──
  // 最后那一条是本剧本的"有东西可亮"阳性对照：目标不在，屏上没有那一格，后面的"没亮"就什么都不是。
  const titleRows = Number(sql(`select count(*) from notes where deleted_at is null and title = '${NOTE_HINT}'`))
  if (titleRows !== 1) {
    check('这句标题在库里只对应一篇（歧义时什么都不碰）', false, titleRows)
    report()
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  noteId = sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`)
  const ownerMatches = Number(sql(
    `select count(*) from notes n join users u on u.id = n.created_by
      where n.id = '${noteId}' and u.email = '${process.env.OWNER_EMAIL}'`,
  ))
  const residualRounds = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  const activeAnchored = Number(sql(`
    select count(distinct o.objective_id)
      from learning_objective_origins_v2 o
      join learning_objectives_v2 ob on ob.objective_id = o.objective_id and ob.workspace_id = o.workspace_id
     where o.note_id = '${noteId}' and o.origin_kind = 'note' and o.note_version_id is not null
       and ob.lifecycle = 'active'`))
  if (ownerMatches !== 1 || residualRounds !== 0 || activeAnchored === 0) {
    check('起点可用（本人、零残留轮次、且挂着 active 的笔记型目标）', false,
      { ownerMatches, residualRounds, activeAnchored })
    report()
    throw new Error('the target note cannot show the badge; refusing to write')
  }
  pointerBefore = sql(`select coalesce(current_version_id::text, 'none') from notes where id = '${noteId}'`)
  countsBefore = familyCounts()
  shapeBefore = noteShape(noteId)
  readings.baseline = { noteId, pointerBefore, activeAnchored, countsBefore, shapeBefore }

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
  // 等 HUD 真的挂上再点：登录后那一屏是异步读出来的，刚跑完 `npm run build` 的第一次启动尤其慢。
  await page.locator('.hud-rail .nav-chip').first().waitFor({ timeout: 40_000 })

  const navToNote = async (): Promise<void> => {
    const row = page.locator('.note-row', { hasText: NOTE_HINT })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hits = await row.count()
      if (hits > 1) {
        // 书架上命中多行时**不许**点 first()：那可能进的不是刚被改动的那一篇。
        throw new Error(`书架上这句提示命中 ${hits} 行，歧义时不点（要换 PROBE_NOTE_HINT 或给行加可定位的标识）`)
      }
      if (hits === 1) {
        await row.first().click({ timeout: 20_000 })
        await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
        await page.waitForTimeout(1_500)
        return
      }
      const expandRail = page.getByRole('button', { name: '展开目录' })
      if ((await expandRail.count()) > 0) {
        await expandRail.first().click().catch(() => undefined)
        await page.waitForTimeout(500)
      }
      if ((await page.locator('.note-shelf-all').count()) > 0) {
        await page.locator('.note-shelf-all').first().click({ timeout: 20_000 }).catch(() => undefined)
      } else {
        await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
      }
      await page.waitForTimeout(800)
    }
    throw new Error(`那一行笔记在书架里始终读不到（导航形状变了，得改这段而不是拉长超时）：${NOTE_HINT}`)
  }

  const objectiveBlock = page.locator('.notebook-objective:not(.notebook-round)').first()
  /**
   * 必须带 `:not(.notebook-round)`：轮次那一格的容器写的是 `notebook-objective notebook-round`
   * 两个 class（它复用同一个纸面容器）。第一版按 `.notebook-objective p` 数，把轮次那句
   * 也算进了"目标那一格"，两条挂载点判据同时红——**红的是选择器，不是界面**。
   */
  const objectiveParagraphs = (host: Page) => host.locator('.notebook-objective:not(.notebook-round) p')
  const badgeLine = (host: Page) => host.locator('.notebook-objective:not(.notebook-round) p', { hasText: BADGE_TEXT })
  const movedLine = (host: Page) => host.locator('[data-round-content-moved]')

  // 两句的**挂载点**各数一次：只看"屏上有这句话"会放过"两句挤在同一格里"那种形状。
  const saysIn = async (block: string, phrase: string): Promise<number> => {
    const texts = await page.locator(`${block} p`).allTextContents()
    return texts.filter((text) => text.includes(phrase)).length
  }

  // ── 对照：正文没开新版时，那一格摆得出主动作、但不说「来源已有更新」 ──
  await navToNote(page)
  const blockVisible = await objectiveBlock.waitFor({ timeout: 20_000 }).then(() => true, () => false)
  const actionLabels = await objectiveBlock.locator('button').allTextContents()
  check('这一篇的学习区读得出来（有主动作才谈得上"没亮"）',
    blockVisible && actionLabels.length > 0, { blockVisible, actionLabels })
  check('对照：还没保存出下一版时，屏上不说那句「来源已有更新」',
    (await badgeLine(page).count()) === 0, await objectiveParagraphs(page).allTextContents())

  // ── 种一轮（冻在当前那一版）：此刻那一格也还不该说"后来又保存过一版" ──
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
  await navToNote(page)
  check('对照：这一轮冻的就是当前那一版时，轮次那一格也不说话',
    (await movedLine(page).count()) === 0 && (await badgeLine(page).count()) === 0,
    { moved: await movedLine(page).count(), badge: await badgeLine(page).count() })

  // ── 保存出下一版：版本行＋那一版的块行＋把指针挪过去（与 checkpointNote 同形） ──
  // 那一版的哈希必须是**真 md5 十六进制**：带非十六进制字符会被 `noteDetailV1` 判成 ZodError ⇒ 500，
  // 屏上读到的就是"笔记库暂时不可用"，看着像功能坏了，其实是剧本造了个非法值（上一份剧本踩过）。
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
  sql(`insert into note_blocks (version_id, workspace_id, ordinal, type, content)
       select '${versionB}', workspace_id, ordinal, type, content from note_blocks
        where version_id = '${pointerBefore}'`)
  sql(`update notes set current_version_id = '${versionB}' where id = '${noteId}'`)
  readings.versionB = versionB
  readings.anchorsNowStale = Number(sql(`
    select count(*) from learning_objective_origins_v2 o join notes n on n.id = o.note_id
     where o.note_id = '${noteId}' and o.origin_kind = 'note'
       and o.note_version_id is not null and o.note_version_id <> n.current_version_id`))

  // ── 重进这一篇：两句同时上屏，各挂各的面 ──
  await navToNote(page)
  const badgeText = ((await badgeLine(page).first().textContent().catch(() => '')) ?? '').trim()
  const roundText = ((await movedLine(page).first().textContent().catch(() => '')) ?? '').trim()
  check('保存出下一版之后，目标那一格说得出「来源已有更新」（读屏上那句原话）',
    badgeText === BADGE_TEXT, { badgeText, badgeRows: await badgeLine(page).count() })
  check('同一屏上，轮次那一格也说得出它那一句（两句说的是两件事）',
    roundText === ROUND_TEXT, roundText)
  check('两句各挂各的面：徽标只在目标格里、轮次那句只在轮次格里',
    (await saysIn('.notebook-objective:not(.notebook-round)', BADGE_TEXT)) === 1
    && (await saysIn('.notebook-objective:not(.notebook-round)', ROUND_TEXT)) === 0
    && (await saysIn('.notebook-round', ROUND_TEXT)) === 1
    && (await saysIn('.notebook-round', BADGE_TEXT)) === 0,
    {
      badgeInObjective: await saysIn('.notebook-objective:not(.notebook-round)', BADGE_TEXT),
      badgeInRound: await saysIn('.notebook-round', BADGE_TEXT),
      roundInObjective: await saysIn('.notebook-objective:not(.notebook-round)', ROUND_TEXT),
      roundInRound: await saysIn('.notebook-round', ROUND_TEXT),
    })
  const thirdVoice = [...await objectiveParagraphs(page).allTextContents(),
    ...await page.locator('.notebook-round p').allTextContents()]
    .filter((text) => /来源已有更新|后来又保存过一版|有内容更新/.test(text))
  check('这件事在这一屏上只有两处说（没有第三个词表冒出来）',
    thirdVoice.length === 2, thirdVoice)

  const alerts = [...await objectiveBlock.locator('[role="alert"]').allTextContents(),
    ...await page.locator('.notebook-round [role="alert"]').allTextContents()].join('／')
  check('整个过程屏上没有告警句', alerts === '', alerts)
} catch (error) {
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  const seeded = noteId.length > 0 && countsBefore !== null
  if (seeded) {
    sql(`delete from note_learning_rounds where note_id = '${noteId}'`)
    if (versionB.length === 36) {
      sql(`update notes set current_version_id = '${pointerBefore}' where id = '${noteId}'`)
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
      grew.length === 0 && shapeChanged.length === 0 && readings.pointerAfter === pointerBefore,
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
