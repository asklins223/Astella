import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'
// 按 run id 清 run 的那份清单只有这一处；剧本与集测共用同一份，不各抄一遍表名单。
import {
  learningRunCleanupStepsV1,
  renderPsqlStatementV1,
} from '../../../apps/api/src/integration-tests/helpers/learning-run-cleanup.ts'

/**
 * 真窗口剧本：**PRD §16.2 已有基础且时间有限**里「不用先看完动画才允许作答」那一半
 * （39d W4-6 刀六；W4-6 §7）＋ 刀三「练一道」入口的正例。
 *
 * 判据：教学面里那颗「练一道」**只在目标存在时出现**，而且出现与否不看"讲没讲过"、
 * 不看动态产物有没有打开——这一篇从头到尾没有生成过任何解释、没有任何产物，
 * 那颗按钮照样在（"先试一道再听解释"这条路没有被动画堵住）。
 *
 * 为什么必须是真窗口：那颗按钮的起点是服务端从**目标主行动**签发下来的
 * （`buildRoundTeachingExtras`），"服务端签发的那一份真的被摆到屏幕上"这件事在 jsdom 里
 * 不可能被证伪（与 W4-3／W4-6 那几张表单同一条理由）。
 *
 * **09-27 起这一步真的点下去了**。此前停在按钮之前，理由不是驱动不了，是**没有清理路**：
 * "全仓没有任何按 run id 清 run 的现成顺序，集成测试那一套是 workspace 级清扫，会连 owner 的工作区一起删"。
 * 那条路现在有了（`apps/api/src/integration-tests/helpers/learning-run-cleanup.ts`，集测 `ec977047`），
 * 本剧本就按同一份清单收尾（**不另抄一份表名单**——抄了就会分叉，这一族已经错过两次）。
 * 点的这一发只**开** run、不作答、不提交：结构化那条链要花钱的是提交之后的评估，
 * 而开 run 全程是同步规划（`planV2Run`），所以这一发在活 worker 面前也不会产生任何模型调用。
 *
 * 它**自己种数据**：一轮 active 的轮次 ＋ 一个**有笔记依据**的 active 目标
 * （四张目标行 ＋ 依据五件，形状照 `apps/api/src/integration-tests/helpers/
 * v2-card-fixture.ts` 的 `insertObjectiveWithoutCard` ＋ `seedObjectiveNoteEvidence`，
 * 只有 note_id／note_version_id 指向这一篇真笔记）。收尾把这些行全删干净，
 * 并用**一张按 workspace 全表点数**的前后对照证明没有残留。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-practice-entry.mts
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
  'docker', ['exec', 'ailearn-dev-postgres-1', 'psql', '-U', 'ailearn', '-d', 'ailearn', '-tAc', statement],
  { encoding: 'utf8' },
).trim()

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

// ─── 屏上那几句字面，从渲染层源码里取（同 gap-help 那份：不自己抄一遍）──
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

/** 目标那几行用的最小合法值：逐字照 v2-card-fixture.ts 的常量（同一个夹具，不另立一套）。 */
const FIXTURE = {
  sha256Hex: 'f'.repeat(64),
  targetRevisionHash: 'e'.repeat(64),
  privatePayloadHash: 'd'.repeat(64),
  canonicalAnswer: JSON.stringify({ kind: 'text', unit: { unitId: 'u1', text: '间隔重复是把复习安排在逐渐拉长的时间间隔上' } }),
  learningSupport: JSON.stringify({ explanation: '利息加入本金继续生息' }),
  scoringRubric: JSON.stringify({
    version: 2,
    units: [{
      rubricUnitId: 'fixture-rubric-u1',
      facet: 'recall',
      criterion: '能准确回忆并说明目标知识点',
      required: true,
      answerUnitIds: ['u1'],
      evidenceRefIds: ['00000000-0000-4000-8000-000000000001'],
    }],
    passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
    rubricHash: '9'.repeat(64),
  }),
}

interface Seeded {
  noteId: string
  roundId: string
  objectiveId: string
  objectiveRevisionId: string
  evidenceSnapshotId: string
  workspaceId: string
  userId: string
}

/** 一轮 active 的轮次 ＋ 一个有笔记依据的 active 目标（无卡；照夹具那两张表的写法）。 */
function seedObjectiveAndRound(
  noteId: string, workspaceId: string, userId: string, noteVersionId: string, contentHash: string,
): Seeded {
  const roundId = randomUUID()
  const objectiveId = randomUUID()
  const objectiveRevisionId = randomUUID()
  const evidenceSnapshotId = randomUUID()
  const hex = (char: string) => char.repeat(64)
  sql([
    'BEGIN;',
    `SELECT set_config('app.workspace_id', '${workspaceId}', true);`,
    `SELECT set_config('app.user_id', '${userId}', true);`,
    // 轮次：与 A 那份同一个形状，只是这一轮**不生成任何解释**（判据要的正是这个）。
    `INSERT INTO note_learning_rounds (id, workspace_id, user_id, note_id, phase, driving_question, driving_question_source,
      driving_question_revision, note_version_id, source_content_hash, max_model_calls, max_wall_clock_seconds, max_tasks, revision)
      VALUES ('${roundId}', '${workspaceId}', '${userId}', '${noteId}', 'active', '先试一道：间隔重复的适用边界是什么？', 'user_authored',
        1, '${noteVersionId}', '${contentHash}', 8, 900, 6, 1);`,
    // 目标（无卡）：learnObjectiveSurfacesV3 要的那两行 ＋ 依据那五件。
    `INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), '${workspaceId}', '${objectiveId}', 'probe:w46-class', 'sem-id-v1',
        '${FIXTURE.sha256Hex}', 'active', 1, '${objectiveRevisionId}', 1);`,
    `INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), '${workspaceId}', '${objectiveRevisionId}', '${objectiveId}', 1,
        '间隔重复的适用边界', '间隔重复的适用边界', 'definition', ARRAY['recall'],
        '${JSON.stringify(FIXTURE.canonicalAnswer).replace(/'/g, "''")}'::jsonb,
        '${JSON.stringify(FIXTURE.learningSupport).replace(/'/g, "''")}'::jsonb,
        '${JSON.stringify(FIXTURE.scoringRubric).replace(/'/g, "''")}'::jsonb,
        '[]'::jsonb, '[]'::jsonb, '${FIXTURE.sha256Hex}', '${FIXTURE.targetRevisionHash}', '${FIXTURE.privatePayloadHash}');`,
    `INSERT INTO evidence_snapshots_v2
      (id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
       note_id, start_offset, end_offset, protected_quote_ref, modality, block_content_hash, source_content_hash)
      VALUES (gen_random_uuid(), '${workspaceId}', '${evidenceSnapshotId}', '${hex('b')}', '${randomUUID()}',
        '${noteId}', 0, 12, 'evidence://snapshot/${evidenceSnapshotId}', 'text', '${hex('e')}', '${hex('f')}');`,
    `INSERT INTO evidence_eligibility_states_v2
      (id, workspace_id, eligibility_id, evidence_snapshot_id, status, eligibility_epoch, eligibility_vector_hash)
      VALUES (gen_random_uuid(), '${workspaceId}', '${randomUUID()}', '${evidenceSnapshotId}', 'usable', 1, '${hex('a')}');`,
    `INSERT INTO learning_objective_evidence_bindings_v2
      (id, workspace_id, binding_id, objective_revision_id, target_unit_kind, target_unit_id,
       evidence_snapshot_id, relation, support_strength, semantic_support_report_id,
       semantic_support_report_hash, binding_hash)
      VALUES (gen_random_uuid(), '${workspaceId}', '${randomUUID()}', '${objectiveRevisionId}',
        'rubric', 'fixture-rubric-u1', '${evidenceSnapshotId}', 'entails', 'direct',
        '${randomUUID()}', '${hex('c')}', '${hex('d')}');`,
    // 笔记依据那一锚：`listObjectiveSurfacesV3` 的 noteId 收窄就是查这一行（EXISTS ... origin.note_id）。
    `INSERT INTO learning_objective_origins_v2
      (id, workspace_id, origin_id, objective_id, objective_revision_id, origin_kind,
       note_id, note_version_id, evidence_snapshot_ids, integrity)
      VALUES (gen_random_uuid(), '${workspaceId}', '${randomUUID()}', '${objectiveId}',
        '${objectiveRevisionId}', 'note', '${noteId}', '${noteVersionId}',
        ARRAY['${evidenceSnapshotId}']::uuid[], 'verified');`,
    'COMMIT;',
  ].join('\n'))
  return { noteId, roundId, objectiveId, objectiveRevisionId, evidenceSnapshotId, workspaceId, userId }
}

/**
 * 收尾：这一轮开出来的 run（按 run id 那份清单）＋ 目标那几行 ＋ 轮次那几行。
 * 三张表都是追加-only：带 `app.allow_history_mutation` 口子删；RLS 那一对配置同一个事务。
 */
function wipe(seeded: Seeded): void {
  // run 必须**先于**目标与轮次删：`learning_target_snapshots_v2` 对 run 是 RESTRICT，
  // 而目标那一头的删除也会被 run 挂着——顺序错了整笔事务回滚，看着像"删不掉"。
  const runIds = sql(`select id from public.learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`)
    .split('\n').map((line) => line.trim()).filter(Boolean)
  const runStatements = runIds.flatMap((runId) =>
    learningRunCleanupStepsV1().map((step) => `${renderPsqlStatementV1(step, runId)};`),
  )
  readings.runsWiped = { runIds, statements: runStatements.length }
  sql([
    'BEGIN;',
    `SELECT set_config('app.allow_history_mutation', 'on', true);`,
    `SELECT set_config('app.workspace_id', '${seeded.workspaceId}', true);`,
    `SELECT set_config('app.user_id', '${seeded.userId}', true);`,
    ...runStatements,
    `DELETE FROM learning_objective_evidence_bindings_v2 WHERE objective_revision_id = '${seeded.objectiveRevisionId}';`,
    `DELETE FROM learning_objective_origins_v2 WHERE objective_id = '${seeded.objectiveId}';`,
    `DELETE FROM learning_objective_revisions_v2 WHERE objective_id = '${seeded.objectiveId}';`,
    `DELETE FROM learning_objectives_v2 WHERE objective_id = '${seeded.objectiveId}';`,
    `DELETE FROM evidence_eligibility_states_v2 WHERE evidence_snapshot_id = '${seeded.evidenceSnapshotId}';`,
    `DELETE FROM evidence_snapshots_v2 WHERE evidence_snapshot_id = '${seeded.evidenceSnapshotId}';`,
    `DELETE FROM note_learning_round_teachings WHERE round_id = '${seeded.roundId}';`,
    `DELETE FROM note_learning_round_artifacts WHERE round_id = '${seeded.roundId}';`,
    `DELETE FROM note_learning_rounds WHERE id = '${seeded.roundId}';`,
    'COMMIT;',
  ].join('\n'))
}

/**
 * 这个工作区里**每一张带 workspace_id 的表**的点数（只回非零的）。
 *
 * 为什么要有这一格：收尾"删干净了"不能只报自己删的那几句 DELETE——留下的是别的表
 * 里的行（一张表一张表数一遍才是证据）。前后两张表逐表比，涨了的名字直接进报告。
 */
/**
 * 逐表对照里**指名道姓**豁免的那一张：伴星"她此刻在哪一屏"的上下文行，由活渲染层自己发布，
 * 不是剧本种的（它涨恰恰是"真窗口真的开过"的证据）。豁免只在"这一轮它确实涨了"时成立。
 */
const AMBIENT_GROWTH_ALLOWED_V1: Record<string, string> = {
  assistant_page_contexts: '活窗口的页面上下文簿记（伴星读页面那一族），开一次窗口必涨几行',
}

function workspaceCensus(workspaceId: string): Record<string, number> {
  const tables = sql(`select string_agg(table_name, ' ' order by table_name) from information_schema.columns
    where table_schema = 'public' and column_name = 'workspace_id'`).split(/\s+/).filter(Boolean)
  const select = tables
    .map((table) => `select '${table}' as t, count(*)::int as c from ${table} where workspace_id = '${workspaceId}'`)
    .join(' union all ')
  const map: Record<string, number> = {}
  for (const line of sql(select).split('\n')) {
    const [name, count] = line.split('|')
    if (name && Number(count) > 0) map[name] = Number(count)
  }
  return map
}

function diffCensus(before: Record<string, number>, after: Record<string, number>): Record<string, [number, number]> {
  const diff: Record<string, [number, number]> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? 0
    const to = after[key] ?? 0
    if (from !== to) diff[key] = [from, to]
  }
  return diff
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w46-practice-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

let seeded: Seeded | null = null
let noteId = ''
let censusBefore: Record<string, number> | null = null
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

  const navRail = page.getByRole('button', { name: '展开目录' })
  if ((await navRail.count()) > 0) {
    await navRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })

  const hintRows = page.locator('.note-row', { hasText: NOTE_HINT })
  if ((await hintRows.count()) !== 1) {
    check('提示词只命中一篇笔记', false, `命中 ${await hintRows.count()} 行`)
    report()
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  const titleCount = Number(sql(`select count(*) from notes where deleted_at is null and title = '${NOTE_HINT}'`))
  noteId = titleCount === 1 ? sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`) : ''
  readings.noteId = noteId
  check('这句标题在库里只对应一篇笔记', titleCount === 1 && /^[0-9a-f-]{36}$/.test(noteId), { titleCount, noteId })

  const row = sql(`select n.workspace_id, n.created_by, n.current_version_id, v.content_hash
    from notes n join note_versions v on v.id = n.current_version_id where n.id = '${noteId}'`)
  const [workspaceId, userId, noteVersionId, contentHash] = row.split('|')
  readings.noteSnapshot = { workspaceId, userId, noteVersionId, contentHash }

  // 起点必须真的**没有**任何"笔记来源的 active 目标"——这正是这条剧本要造的那一件。
  const objectivesOnNote = Number(sql(`select count(*) from learning_objective_origins_v2 o
    join learning_objectives_v2 l on l.id = o.objective_id
    where o.note_id = '${noteId}' and l.lifecycle = 'active'`))
  const residualRounds = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  readings.residual = { objectivesOnNote, residualRounds }
  if (objectivesOnNote !== 0 || residualRounds !== 0) {
    check('起点这篇没有 active 目标、也没有残留轮次', false, readings.residual)
    report()
    throw new Error('target note already carries an active note-source objective or rounds')
  }

  // ── 种数据：一轮 active ＋ 一个有笔记依据的 active 目标 ──
  // 起点先做一次逐表点数。这一格从前**从来没跑过**：`censusBefore` 声明了、收尾也读了，
  // 但整份文件里没有任何一处给它赋值 ⇒ `if (censusBefore)` 恒假，"逐表前后对照"那条判据
  // 一直是空转（而剧本头部写着它存在）。现在补上赋值，并在下面用"故意不清 run"的变异验它会红。
  censusBefore = workspaceCensus(workspaceId)
  readings.censusBaselineTables = Object.keys(censusBefore).length
  check('起点逐表点数读到了东西（这个工作区不是空的 ⇒ 那条对照判据不会空转）',
    Object.keys(censusBefore).length > 0, readings.censusBaselineTables)

  seeded = seedObjectiveAndRound(noteId, workspaceId, userId, noteVersionId, contentHash)
  readings.seeded = { roundId: seeded.roundId, objectiveId: seeded.objectiveId }
  const objectiveRowsOk = Number(sql(`select count(*) from learning_objectives_v2 where objective_id = '${seeded.objectiveId}' and lifecycle = 'active'`))
  const originRowsOk = Number(sql(`select count(*) from learning_objective_origins_v2 where objective_id = '${seeded.objectiveId}' and note_id = '${noteId}'`))
  check('seed 的目标真的落在这一篇的笔记依据上（active ＋ origin.note_id 是这一篇）', objectiveRowsOk === 1 && originRowsOk === 1, { objectiveRowsOk, originRowsOk })

  // ── 打开这一篇 ⇒ 教学面出现，且「练一道」在（这一轮**没有**任何解释／产物）──
  await page.locator('.note-row', { hasText: NOTE_HINT }).first().click({ timeout: 20_000 })
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  const teachingPanelVisible = await page.locator('.notebook-round-teaching').first()
    .waitFor({ timeout: 20_000 }).then(() => true, () => false)
  check('打开这一篇之后教学面真在屏上', teachingPanelVisible)

  const teachingTextCount = await page.locator('.notebook-round-teaching__text').count()
  const artifactFrameCount = await page.locator('.notebook-round-teaching__artifact iframe').count()
  const teachingRowsInDb = Number(sql(`select count(*) from note_learning_round_teachings where round_id = '${seeded.roundId}'`))
  readings.beforePractice = { teachingTextCount, artifactFrameCount, teachingRowsInDb }
  check('这一轮从头到尾没生成过解释、也没有产物（"不用先看完动画才允许作答"要的正例）',
    teachingTextCount === 0 && artifactFrameCount === 0 && teachingRowsInDb === 0, readings.beforePractice)

  const practiceLabel = copyLiteral('practice')
  const practiceButton = page.locator('.notebook-round-teaching button', { hasText: practiceLabel })
  const practiceCount = await practiceButton.count()
  readings.practiceButton = { label: practiceLabel, count: practiceCount }
  check('有笔记依据的 active 目标在 ⇒ 教学面里出现「练一道」', practiceCount === 1, readings.practiceButton)
  if (practiceCount === 1) {
    const enabled = await practiceButton.first().isEnabled()
    readings.practiceButtonEnabled = enabled
    check('那颗「练一道」是可点的（不是画一颗灰按钮装可用）', enabled === true, enabled)
  }

  // 正控制：这一篇的目标块也真在（那颗按钮的来源是同一个投影，两处一起出现才算读到目标）。
  const noteObjectiveVisible = await page.locator('.notebook-objective:not(.notebook-round)').count()
  readings.noteObjectiveBlock = noteObjectiveVisible
  check('这一篇的目标那一块也真在（"有目标"不是只在一处投影上成立）', noteObjectiveVisible === 1, noteObjectiveVisible)

  // 真的点下去：这一发从前是欠账（没有清理路），现在点得起——收尾按那份清单把 run 清掉。
  await practiceButton.first().click({ timeout: 20_000 })
  const runOnScreen = await page.locator('.learning-run-primary-content').first()
    .waitFor({ timeout: 25_000 }).then(() => true, () => false)
  readings.clickedPractice = true
  readings.runOnScreen = runOnScreen
  check('点「练一道」之后屏上真的出现了那一场 run 的作答面', runOnScreen === true)

  // 屏上那一发必须能在服务端读到，而且**只有这一场**挂在轮次上（多点一次就会多开一场）。
  const openRuns = sql(`select id, phase from public.learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`)
    .split('\n').map((line) => line.trim()).filter(Boolean)
  readings.openRunRows = openRuns
  check('库里挂着这一轮的 run 恰好一场（不是两场、也不是屏上有但库里没有）', openRuns.length === 1, openRuns)
  check('那一场的 origin 带的是这一轮的 roundId 与这一篇的 noteId', (() => {
    const runId = openRuns[0]?.split('|')[0]?.trim() ?? ''
    if (!runId) return false
    const matched = Number(sql(`select count(*) from public.learning_runs
      where id = '${runId}' and origin ->> 'kind' = 'note_round' and origin ->> 'noteId' = '${noteId}'`))
    return matched === 1
  })(), readings.openRunRows)
} catch (error) {
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  if (process.env.PROBE_ALLOW_DB === '1' && seeded) {
    wipe(seeded)
    const leftovers = {
      objectives: Number(sql(`select count(*) from learning_objectives_v2 where objective_id = '${seeded.objectiveId}'`)),
      origins: Number(sql(`select count(*) from learning_objective_origins_v2 where objective_id = '${seeded.objectiveId}'`)),
      revisions: Number(sql(`select count(*) from learning_objective_revisions_v2 where objective_id = '${seeded.objectiveId}'`)),
      bindings: Number(sql(`select count(*) from learning_objective_evidence_bindings_v2 where objective_revision_id = '${seeded.objectiveRevisionId}'`)),
      evidenceSnapshots: Number(sql(`select count(*) from evidence_snapshots_v2 where evidence_snapshot_id = '${seeded.evidenceSnapshotId}'`)),
      eligibilityStates: Number(sql(`select count(*) from evidence_eligibility_states_v2 where evidence_snapshot_id = '${seeded.evidenceSnapshotId}'`)),
      roundsForNote: Number(sql(`select count(*) from note_learning_rounds where note_id = '${seeded.noteId}'`)),
      runsForRound: Number(sql(`select count(*) from learning_runs where origin ->> 'roundId' = '${seeded.roundId}'`)),
    }
    readings.leftovers = leftovers
    check('收尾把自己建的行删干净（目标／依据／轮次都是 0）',
      Object.values(leftovers).every((value) => value === 0), leftovers)

    // 逐表点数：涨了的表直接进报告（这是"删干净"那半边的真证据）。
    if (censusBefore) {
      const after = workspaceCensus(seeded.workspaceId)
      const growth = diffCensus(censusBefore, after)
      readings.censusGrowth = growth
      // 有一张表的行不是剧本种的，而是**这个窗口自己在场**的簿记：伴星那条"她此刻在哪一屏"
      // 的行由活渲染层发布（W2-6 的 `readLivePageView` 读的就是它）。开一次真窗口就会涨几行，
      // 且只涨这一张——所以豁免名单是**指名道姓**的，并要求它这一轮真的出现（不再出现就得把条目删掉，
      // 免得豁免变成免检通道）。其余任何一张表涨了行数，一律红。
      const unexplained = Object.keys(growth).filter((table) => !(table in AMBIENT_GROWTH_ALLOWED_V1))
      const exemptionsUnused = Object.keys(AMBIENT_GROWTH_ALLOWED_V1).filter((table) => !(table in growth))
      check('这个工作区里没有哪张表因为这次剧本涨了行数（只有豁免名单里那一张除外）',
        unexplained.length === 0 && exemptionsUnused.length === 0, { unexplained, exemptionsUnused })
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
