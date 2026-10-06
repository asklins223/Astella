import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**PRD §16.3 讲解未能解决问题**（39d W4-6 刀六；W4-6 §7）。
 *
 * §16.3 原文的验收是两句：「不无限换题或扩张课程，不判用户失败；保存困惑、已做内容
 * 和可恢复的建议」。落到今天的产品里，就是刀四那套停止规则的端到端形状：
 * 同一缺口被帮了两次、两次都没有改善 ⇒ 不再自动加题，摆四选一（换解释／补前置／
 * 回材料核对／先结束），四档里三档有真去处、一档如实说没接上。
 *
 * 为什么必须是真窗口：这一段判据的核心是"**屏上那一条**"。四选一面板出不出来由
 * 服务端从 `learning_run_events` ＋ `learning_runs.result` 现算（刀四那一半），
 * jsdom 里没有真账号、没有真库、没有 IPC 网关，"算出来的那一格真的被摆到屏幕上"
 * 这件事在替身里结构上不可能被证伪；「换一种解释」要的是"库里多一条、屏上换一条"，
 * 更要一次真回读。
 *
 * 它**自己种数据**（照 `gap-help-service.ts` 的读法逐列对齐）：
 *   - 一轮 active 的轮次（快照指向这篇的**当前版本**，解释才取得到正文）；
 *   - 两条已结算的 run（origin 带 roundId／objectiveId／noteId，`result.outcome` 落在
 *     policy 的"明说的没改善"那一类：`partial` 与 `needs_repair`）；
 *   - 每条 run 一道 `learning_tasks`（intent 与 policy 读的那一列一致：`recall`）；
 *   - 每条 run 一行 `learning_run_events`（`learning_task.hint_requested`，payload 带 taskId）
 *     ——「一次帮助」的写入类型与形状照 `run-service` 的 `request_hint`。
 * 目标读数：`gapHelp.stopped === true`（连续帮助 2 次 ≥ 阈值 2，且最近一次不是改善）。
 *
 * 收尾把这些行删干净（四张表都是 FORCE RLS：set_config 那一对 app.workspace_id／
 * app.user_id 必须和删除同一个事务；只追加那三张还要带 `app.allow_history_mutation` 口子），
 * 并打印计数证明干净。**用户可见的那篇笔记不该被动过**——正文版本行与当前版本指针
 * 前后各量一次。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-gap-help.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT ?? ''

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}
if (process.env.PROBE_ALLOW_DB !== '1' || NOTE_HINT.length === 0) {
  throw new Error('本剧本会直接改 dev 库：必须同时给 PROBE_ALLOW_DB=1 与 PROBE_NOTE_HINT')
}
if (/['";]/.test(NOTE_HINT)) {
  throw new Error('PROBE_NOTE_HINT 里不许有引号、分号或注释符')
}

const sql = (statement: string): string => execFileSync(
  'docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-tAc', statement],
  { encoding: 'utf8' },
).trim()

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, stepMs = 300): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, stepMs))
  }
}

// ─── 屏上那几句字面，从**渲染层源码**里取 ──────────────────────────────────
// 判据要的是"四档文案与 `ROUND_COPY` 一致"。在剧本里再抄一遍就等于自己给自己出题：
// 抄错了两边一起错。所以直接从源码那一段切出来读——源码换了字，剧本立刻跟着变红。
const SURFACE_SOURCE = readFileSync(
  resolve(appRoot, 'src/renderer/src/components/surfaces/notebook-surface.tsx'),
  'utf8',
)
const teachingBlock = (() => {
  const start = SURFACE_SOURCE.indexOf('  teaching: {')
  const end = SURFACE_SOURCE.indexOf('  openLine:')
  if (start < 0 || end <= start) throw new Error('没在 notebook-surface.tsx 里找到 ROUND_COPY.teaching 那一段')
  return SURFACE_SOURCE.slice(start, end)
})()
const copyLiteral = (key: string): string => {
  const match = teachingBlock.match(new RegExp(`${key}: "([^"]+)"`))
  if (!match?.[1]) throw new Error(`ROUND_COPY.teaching.${key} 没读到`)
  return match[1]
}
const stopLeadTemplate = (() => {
  const match = teachingBlock.match(/stopLead: \(count: number\) => `([^`]+)`/)
  if (!match?.[1]) throw new Error('ROUND_COPY.teaching.stopLead 没读到')
  return match[1]
})()

/** 与 policy 三分类对齐的"明说的没改善"两档（`gap-help-policy.ts` 的 `not_improved`）。 */
const NOT_IMPROVED_OUTCOMES = ['partial', 'needs_repair'] as const
/** 「一次帮助」的事件类型与 `run-service.request_hint`／`gap-help-service` 同一字符串。 */
const HINT_EVENT_TYPE = 'learning_task.hint_requested'
/** 任务意图：`learning_tasks.intent` 的合法值之一（policy 拿它当缺口身份的一半）。 */
const TASK_INTENT = 'recall'

interface Seeded {
  noteId: string
  roundId: string
  objectiveId: string
  runIds: string[]
  taskIds: string[]
  workspaceId: string
  userId: string
  noteVersionId: string
  contentHash: string
}

/** 种一轮 + 两条"帮过两次仍没改善"的 run（照 gap-help-service 读的那些列）。 */
function seedGapHelp(noteId: string, workspaceId: string, userId: string, noteVersionId: string, contentHash: string, drivingQuestion: string): Seeded {
  const roundId = randomUUID()
  const objectiveId = randomUUID()
  const runIds = [randomUUID(), randomUUID()]
  const taskIds = [randomUUID(), randomUUID()]
  const statements: string[] = [
    `BEGIN;`,
    `SELECT set_config('app.workspace_id', '${workspaceId}', true);`,
    `SELECT set_config('app.user_id', '${userId}', true);`,
    `INSERT INTO note_learning_rounds (id, workspace_id, user_id, note_id, phase, driving_question, driving_question_source,
      driving_question_revision, note_version_id, source_content_hash, max_model_calls, max_wall_clock_seconds, max_tasks, revision,
      created_at, updated_at)
      VALUES ('${roundId}', '${workspaceId}', '${userId}', '${noteId}', 'active', '${drivingQuestion}', 'user_authored',
        1, '${noteVersionId}', '${contentHash}', 8, 900, 6, 1, now() - interval '3 hours', now() - interval '3 hours');`,
  ]
  runIds.forEach((runId, index) => {
    const taskId = taskIds[index]
    const outcome = NOT_IMPROVED_OUTCOMES[index]
    // 这一条 run 的样子：已结算（`result.outcome` 落库），origin 带三格身份，
    // 一道 recall 题、一次"我要个提示"的帮助——正是刀四读侧认的那三样。
    statements.push(
      `INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase,
        time_budget_seconds, planned_active_seconds, result, revision, created_at, updated_at)
        VALUES ('${runId}', '${workspaceId}', '${userId}',
          jsonb_build_object('kind', 'note_round', 'roundId', '${roundId}', 'noteId', '${noteId}', 'objectiveId', '${objectiveId}'),
          jsonb_build_object('kind', 'note', 'noteId', '${noteId}'), 'probe:gap-help:${index + 1}', 'repair', 'completed',
          180, 180,
          jsonb_build_object('outcome', '${outcome}', 'demonstratedFacets', '[]'::jsonb, 'gapFacets', '[]'::jsonb,
            'scheduleImpact', jsonb_build_object('kind', 'none', 'reasonCode', 'probe'),
            'returnTarget', jsonb_build_object('kind', 'note', 'noteId', '${noteId}')),
          2, now() - interval '${3 - index} hours', now() - interval '${3 - index} hours');`,
      `INSERT INTO learning_tasks (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary, status, revision,
        created_at, updated_at)
        VALUES ('${taskId}', '${runId}', '${workspaceId}', '${userId}', 1, '${TASK_INTENT}',
          '说说「间隔重复」的适用边界。', '间隔重复的适用边界', 'completed', 2,
          now() - interval '${3 - index} hours', now() - interval '${3 - index} hours');`,
      `INSERT INTO learning_run_events (id, run_id, workspace_id, user_id, sequence, event_type, payload, occurred_at)
        VALUES (gen_random_uuid(), '${runId}', '${workspaceId}', '${userId}', 1, '${HINT_EVENT_TYPE}',
          jsonb_build_object('taskId', '${taskId}'), now() - interval '${3 - index} hours');`,
    )
  })
  statements.push(`COMMIT;`)
  sql(statements.join('\n'))
  return { noteId, roundId, objectiveId, runIds, taskIds, workspaceId, userId, noteVersionId, contentHash }
}

/** 收尾：按外键次序删干净（events → tasks → runs → teachings → artifacts → round）。 */
function wipe(seeded: Seeded): void {
  const runList = seeded.runIds.map((id) => `'${id}'`).join(',')
  sql([
    'BEGIN;',
    `SELECT set_config('app.allow_history_mutation', 'on', true);`,
    `SELECT set_config('app.workspace_id', '${seeded.workspaceId}', true);`,
    `SELECT set_config('app.user_id', '${seeded.userId}', true);`,
    `DELETE FROM learning_run_events WHERE run_id IN (${runList});`,
    `DELETE FROM learning_tasks WHERE run_id IN (${runList});`,
    `DELETE FROM learning_runs WHERE id IN (${runList});`,
    `DELETE FROM note_learning_round_teachings WHERE round_id = '${seeded.roundId}';`,
    `DELETE FROM note_learning_round_artifacts WHERE round_id = '${seeded.roundId}';`,
    `DELETE FROM note_learning_rounds WHERE id = '${seeded.roundId}';`,
    'COMMIT;',
  ].join('\n'))
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'astella-w46-gaphelp-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

let seeded: Seeded | null = null
let noteId = ''
let noteIntegrityBefore: string | null = null
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

  // 登录后落在书桌场景：`.note-row` 只在笔记库那一面墙上（与其它剧本同形的三步）。
  const navRail = page.getByRole('button', { name: '展开目录' })
  if ((await navRail.count()) > 0) {
    await navRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })

  // ── 起点核对：唯一命中一篇、标题在库里唯一、这一篇没有残留轮次 ──
  const hintRows = page.locator('.note-row', { hasText: NOTE_HINT })
  if ((await hintRows.count()) !== 1) {
    check('提示词只命中一篇笔记', false, `命中 ${await hintRows.count()} 行——歧义时什么都不碰`)
    report()
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  const titleCount = Number(sql(`select count(*) from notes where deleted_at is null and title = '${NOTE_HINT}'`))
  noteId = titleCount === 1 ? sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`) : ''
  readings.noteId = noteId
  readings.titleCount = titleCount
  check('这句标题在库里只对应一篇笔记', titleCount === 1 && /^[0-9a-f-]{36}$/.test(noteId), { titleCount, noteId })

  const row = sql(`select n.workspace_id, n.created_by, n.current_version_id, v.content_hash
    from notes n join note_versions v on v.id = n.current_version_id where n.id = '${noteId}'`)
  const [workspaceId, userId, noteVersionId, contentHash] = row.split('|')
  readings.noteSnapshot = { workspaceId, userId, noteVersionId, contentHash }
  const residualRounds = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  const residualRuns = Number(sql(`select count(*) from learning_runs where origin ->> 'noteId' = '${noteId}'`))
  readings.residual = { residualRounds, residualRuns }
  if (residualRounds !== 0 || residualRuns !== 0) {
    check('起点这篇没有残留的轮次与练习', false, { residualRounds, residualRuns })
    report()
    throw new Error('residual rounds/runs on the target note')
  }
  noteIntegrityBefore = sql(`select n.current_version_id || '/' || v.content_hash || '/' || (select count(*) from note_versions where note_id = n.id)
    from notes n join note_versions v on v.id = n.current_version_id where n.id = '${noteId}'`)

  // ── 种数据：这一篇当前版本上开一轮，两条"帮了两次仍没改善"的练习 ──
  const emptyBlocks = Number(sql(`select count(*) from note_blocks where version_id = '${noteVersionId}'`))
  check('快照那一版真的有正文块（解释取得到材料）', emptyBlocks > 0, emptyBlocks)
  seeded = seedGapHelp(noteId, workspaceId, userId, noteVersionId, contentHash, '间隔重复的适用边界是什么？')
  readings.seeded = { roundId: seeded.roundId, objectiveId: seeded.objectiveId, runIds: seeded.runIds }
  const seededOutcomes = sql(`select string_agg(result ->> 'outcome', ',' order by created_at) from learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`)
  readings.seededOutcomes = seededOutcomes
  check('seed 的两条 run 都落在"明说的没改善"两档', seededOutcomes === 'partial,needs_repair', seededOutcomes)

  // ── 判据 1：打开这一篇 ⇒ 教学面出现，四选一面板出现且文案与 ROUND_COPY 一致 ──
  await page.locator('.note-row', { hasText: NOTE_HINT }).first().click({ timeout: 20_000 })
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  const teachingPanelVisible = await page.locator('.notebook-round-teaching').first()
    .waitFor({ timeout: 20_000 }).then(() => true, () => false)
  check('打开这一篇之后教学面真在屏上', teachingPanelVisible)
  const roundLine = ((await page.locator('.notebook-round p.notebook-note').first().textContent().catch(() => null)) ?? '').trim()
  readings.roundLine = roundLine
  check('屏上那一轮就是 seed 的这一轮', roundLine === `这一轮：间隔重复的适用边界是什么？`, roundLine)

  const stopPanel = page.locator('.notebook-round-teaching__stop')
  const stopVisible = await stopPanel.first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
  readings.stopVisible = stopVisible
  check('四选一面板出现（服务端算出 stopped=true 才摆得出来）', stopVisible, await page.locator('.notebook-round-teaching').first().textContent().catch(() => null))
  if (!stopVisible) throw new Error('gap help stop panel is not on screen; refusing the rest')

  const stopLeadOnScreen = ((await stopPanel.locator('p').first().textContent()) ?? '').trim()
  const expectedStopLead = stopLeadTemplate.replace('${count}', '2')
  readings.stopLead = { onScreen: stopLeadOnScreen, expectedFromSource: expectedStopLead }
  check('停止那一句说读数、且与 ROUND_COPY 同字（帮了 2 次）', stopLeadOnScreen === expectedStopLead, readings.stopLead)

  const stopButtons = (await stopPanel.locator('button').allTextContents()).map((text) => text.trim())
  const expectedButtons = [
    copyLiteral('switchExplanation'),
    copyLiteral('backToMaterial'),
    copyLiteral('endRound'),
  ]
  readings.stopButtons = { onScreen: stopButtons, expectedFromSource: expectedButtons }
  check('面板上的三颗按钮与 ROUND_COPY 逐字一致', JSON.stringify(stopButtons) === JSON.stringify(expectedButtons), readings.stopButtons)

  // 「补一节前置」还没有服务端语义 ⇒ 屏上如实写着，**不是一颗按钮**。
  const addPrerequisite = copyLiteral('addPrerequisite')
  const addPrerequisiteUnavailable = copyLiteral('addPrerequisiteUnavailable')
  const expectedUnavailableLine = `${addPrerequisite}：${addPrerequisiteUnavailable}`
  const unavailableOnScreen = ((await stopPanel.locator('p').last().textContent()) ?? '').trim()
  readings.addPrerequisiteLine = { onScreen: unavailableOnScreen, expectedFromSource: expectedUnavailableLine }
  check('「补一节前置」如实写着还没接上（同一句 ROUND_COPY）', unavailableOnScreen === expectedUnavailableLine, readings.addPrerequisiteLine)
  const addPrerequisiteButtons = await page.locator('button', { hasText: addPrerequisite }).count()
  readings.addPrerequisiteButtonCount = addPrerequisiteButtons
  check('「补一节前置」那一档不是可点的按钮', addPrerequisiteButtons === 0, addPrerequisiteButtons)
  const unavailableInButton = await stopPanel.locator('button', { hasText: addPrerequisiteUnavailable }).count()
  check('那句"没接上"也没有被塞进某颗按钮里', unavailableInButton === 0, unavailableInButton)

  // ── 判据 2：已做内容还在——「这一轮练过」照着 seed 的结论显示 ──
  const practiceItems = (await page.locator('.notebook-round-teaching__practice-list li').allTextContents()).map((text) => text.trim())
  readings.practiceItems = practiceItems
  check('「这一轮练过」恰是 seed 的那两条', practiceItems.length === 2, practiceItems)
  check('两条练习说的是 seed 的结论（partial → 做出一部分；needs_repair → 还有一处要补）',
    practiceItems.some((item) => item.includes('做出一部分')) && practiceItems.some((item) => item.includes('还有一处要补')),
    practiceItems)

  // ── 判据 3：换解释 ⇒ 同一问题下落第二条（旧的留着），屏上换读新那一条 ──
  // 先真生成第一条：四选一那三档讲的是"这一轮讲过之后怎么走"，得先有一条可比。
  await page.getByRole('button', { name: copyLiteral('start'), exact: true }).click({ timeout: 20_000 })
  const firstTeachingShown = await page.locator('.notebook-round-teaching__text').first()
    .waitFor({ timeout: 25_000 }).then(() => true, () => false)
  check('点「先讲讲这一节」之后屏上出现解释（第一条）', firstTeachingShown, await page.locator('.notebook-round-teaching').first().textContent().catch(() => null))
  if (!firstTeachingShown) throw new Error('teaching was not generated; refusing the rest')
  const firstExplanationOnScreen = ((await page.locator('.notebook-round-teaching__text').first().textContent()) ?? '').trim()
  const firstExplanationInDb = sql(`select content ->> 'explanation' from note_learning_round_teachings where round_id = '${seeded.roundId}' and ordinal = 1`)
  readings.firstTeaching = { onScreen: firstExplanationOnScreen, inDb: firstExplanationInDb }
  check('屏上第一条解释就是库里存的那一条（不是本机拼的）', firstExplanationOnScreen === firstExplanationInDb, readings.firstTeaching)
  const countAfterFirst = Number(sql(`select count(*) from note_learning_round_teachings where round_id = '${seeded.roundId}'`))
  readings.teachingCountAfterFirst = countAfterFirst
  check('生成一次只落一条教学产物', countAfterFirst === 1, countAfterFirst)

  await page.getByRole('button', { name: copyLiteral('switchExplanation'), exact: true }).click({ timeout: 20_000 })
  const teachingCountAfterRegenerate = await waitFor(
    () => Promise.resolve(Number(sql(`select count(*) from note_learning_round_teachings where round_id = '${seeded.roundId}'`)) === 2),
    25_000,
  ).then(() => Number(sql(`select count(*) from note_learning_round_teachings where round_id = '${seeded.roundId}'`)))
  readings.teachingCountAfterRegenerate = teachingCountAfterRegenerate
  check('点一次「换一种解释」只多一条（1 → 2）', teachingCountAfterRegenerate === 2, teachingCountAfterRegenerate)
  const ordinals = sql(`select string_agg(ordinal::text, ',' order by ordinal) from note_learning_round_teachings where round_id = '${seeded.roundId}'`)
  const firstRowStillThere = sql(`select content ->> 'explanation' from note_learning_round_teachings where round_id = '${seeded.roundId}' and ordinal = 1`)
  readings.teachingRows = { ordinals, firstRowExplanation: firstRowStillThere }
  check('旧那一条仍在（只追加，序号 1、2 都在）', ordinals === '1,2', ordinals)
  check('旧那一条的内容没被改写', firstRowStillThere === firstExplanationInDb, { before: firstExplanationInDb, after: firstRowStillThere })

  const secondExplanationInDb = sql(`select content ->> 'explanation' from note_learning_round_teachings where round_id = '${seeded.roundId}' and ordinal = 2`)
  const screenSwitchedToNewest = await waitFor(
    () => page.locator('.notebook-round-teaching__text').first().textContent()
      .then((text) => (text ?? '').trim() === secondExplanationInDb, () => false),
    25_000,
  )
  const explanationOnScreenAfter = ((await page.locator('.notebook-round-teaching__text').first().textContent().catch(() => null)) ?? '').trim()
  readings.secondTeaching = { onScreen: explanationOnScreenAfter, inDb: secondExplanationInDb }
  check('屏上换读的是库里最新那一条（序号 2）', screenSwitchedToNewest && explanationOnScreenAfter === secondExplanationInDb, readings.secondTeaching)
  const explanationChanged = secondExplanationInDb !== firstExplanationInDb
  readings.explanationChangedAfterRegenerate = explanationChanged
  check('换解释没有开出新题、也没有扩张课程（这一轮的 run 数仍是 2）',
    Number(sql(`select count(*) from learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`)) === 2,
    sql(`select count(*) from learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`))
  // 读数（不是判据）：今天的 provider 是确定性的，同一问题同一快照两次生成的正文**逐字相同**，
  // 所以"屏上换了字"这件事在这一版里量不到差异——"换了哪一条"由序号与行数证明。
  if (!explanationChanged) {
    readings.explanationChangedNote = '确定性的 provider：两次生成的解释逐字相同（同一问题＋同一快照），差异只体现在新落的那一条（序号 2）上'
  }

  // ── 判据 4：回材料核对 ⇒ 依据那一段被带到眼前（刀二那条定位同款）──
  const referenceChips = (await page.locator('.notebook-round-teaching__references button').allTextContents()).map((text) => text.trim())
  readings.referenceChipLabels = referenceChips
  check('依据那几颗在屏上（「回材料核对」才有去处）', referenceChips.length > 0, referenceChips)
  const referenceOrdinal = Number(
    (sql(`select source_block_ordinals::text from note_learning_round_teachings where round_id = '${seeded.roundId}' and ordinal = 2`)
      .replace(/^\{|\}$/g, '').split(',')[0] ?? '').trim(),
  )
  readings.referenceOrdinal = referenceOrdinal
  await page.locator('.notebook-round-teaching__stop button', { hasText: copyLiteral('backToMaterial') }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(400)
  const focusedAfterBackToMaterial = await page.evaluate((ordinal) => {
    const node = document.querySelector(`[data-block-ordinal="${ordinal}"]`)
    return node ? { found: true, focused: node.getAttribute('data-block-focused') === 'true' } : { found: false, focused: false }
  }, referenceOrdinal)
  readings.backToMaterial = focusedAfterBackToMaterial
  check('点「回材料核对」把依据那一段带到眼前（真定位，不是只改了文案）',
    focusedAfterBackToMaterial.found === true && focusedAfterBackToMaterial.focused === true,
    focusedAfterBackToMaterial)

  // ── 判据 5：先结束 ⇒ 轮次收尾、教学面撤掉、不自动开第二轮、教学产物留着 ──
  await page.getByRole('button', { name: copyLiteral('endRound'), exact: true }).click({ timeout: 20_000 })
  const closedInDb = await waitFor(
    () => Promise.resolve(sql(`select phase || '/' || coalesce(outcome, '-') from note_learning_rounds where id = '${seeded.roundId}'`) === 'closed/partial'),
    25_000,
  )
  readings.roundAfterClose = sql(`select phase || '/' || coalesce(outcome, '-') from note_learning_rounds where id = '${seeded.roundId}'`)
  check('点「先结束这一轮」之后库里那一轮是收尾态（closed/partial）', closedInDb, readings.roundAfterClose)
  const teachingGone = await waitFor(
    () => page.locator('.notebook-round-teaching__stop').count().then((count) => count === 0, () => false),
    20_000,
  )
  readings.teachingPanelAfterClose = await page.locator('.notebook-round-teaching').count()
  check('教学面跟着那一轮一起撤掉（终态只读）', teachingGone && readings.teachingPanelAfterClose === 0, readings.teachingPanelAfterClose)
  const roundsForNote = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  readings.roundsForNoteAfterClose = roundsForNote
  check('结束后没有自动开出第二轮（这一篇的轮次数仍是 1）', roundsForNote === 1, roundsForNote)
  const teachingRowsAfterClose = Number(sql(`select count(*) from note_learning_round_teachings where round_id = '${seeded.roundId}'`))
  readings.teachingRowsAfterClose = teachingRowsAfterClose
  check('收尾不删教学产物（两条都留着）', teachingRowsAfterClose === 2, teachingRowsAfterClose)
  const runsAfterClose = Number(sql(`select count(*) from learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`))
  check('收尾不新开练习（run 数仍是 2）', runsAfterClose === 2, runsAfterClose)
  const historyLine = ((await page.locator('.notebook-round-history').first().textContent().catch(() => null)) ?? '').trim()
  readings.historyLine = historyLine.slice(0, 200)
} catch (error) {
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  if (process.env.PROBE_ALLOW_DB === '1' && seeded) {
    wipe(seeded)
    // 清场读数：自己建的那几类行必须一行不剩，全库计数回到起点。
    const runList = seeded.runIds.map((id) => `'${id}'`).join(',')
    readings.leftovers = {
      runs: Number(sql(`select count(*) from learning_runs where id IN (${runList})`)),
      tasks: Number(sql(`select count(*) from learning_tasks where run_id IN (${runList})`)),
      events: Number(sql(`select count(*) from learning_run_events where run_id IN (${runList})`)),
      roundsForNote: Number(sql(`select count(*) from note_learning_rounds where note_id = '${seeded.noteId}'`)),
      runsForNote: Number(sql(`select count(*) from learning_runs where origin ->> 'noteId' = '${seeded.noteId}'`)),
      teachingsInDev: Number(sql('select count(*) from note_learning_round_teachings')),
      artifactsInDev: Number(sql('select count(*) from note_learning_round_artifacts')),
      roundsInDev: Number(sql('select count(*) from note_learning_rounds')),
    }
    const leftovers = readings.leftovers as Record<string, number>
    check('收尾把自己建的行删干净（run／task／event／轮次／教学产物都是 0）',
      Object.values(leftovers).every((value) => value === 0), leftovers)
    if (noteId.length > 0 && noteIntegrityBefore !== null) {
      const after = sql(`select n.current_version_id || '/' || v.content_hash || '/' || (select count(*) from note_versions where note_id = n.id)
        from notes n join note_versions v on v.id = n.current_version_id where n.id = '${noteId}'`)
      readings.noteIntegrity = { before: noteIntegrityBefore, after }
      check('这一篇笔记本身没被动过（当前版本指针／正文哈希／版本行数都没变）', after === noteIntegrityBefore, readings.noteIntegrity)
    }
  }
  report()
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
