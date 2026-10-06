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
  'docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-tAc', statement],
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
  // 【 jsonb 那一头】下面这三个值都以「已经 JSON.stringify 过的字符串」存着，插入时**只许插一次**：
  // 再套一层 stringify 会把对象写成 jsonb 字符串（双重编码），结构化分支读到的是字符串而不是 mapping，
  // 于是静默退回 text_response。这一处从剧本写下起一直如此，本轮才由「题型该是 ordering」那条判据抓出来。
  // 【形状】mapping（照集测那份 seed 的 mapping 形状）：结构化分支按它产出 ordering。
  // 这不只是「哪种题」的问题——text 那一支提交之后会路由到 `assessment_critic`（**要花钱**），
  // mapping 这一支走 `deterministic_structured`（不调模型）。剧本要用一篇真笔记旁的夹具目标
  // 造出**免费**那一支，才有资格往下走到结算与逐位反馈。
  canonicalAnswer: JSON.stringify({
    kind: 'mapping',
    pairs: [
      { unitId: 'u-interval', left: '复习间隔', right: '长期记忆保持' },
      { unitId: 'u-recall', left: '主动回忆', right: '优于重复阅读' },
      // 第三位：两位的排列只有"全对/全错"两种，同屏读不出"这一位成立、那一位不成立"这一对。
      { unitId: 'u-spacing', left: '分散练习', right: '长期保持更稳' },
    ],
  }),
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
        '${FIXTURE.canonicalAnswer.replace(/'/g, "''")}'::jsonb,
        '${FIXTURE.learningSupport.replace(/'/g, "''")}'::jsonb,
        '${FIXTURE.scoringRubric.replace(/'/g, "''")}'::jsonb,
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
  jobs: '共享工作区里活着的伴星调度器同一时刻会写念头 job（实测涨的是 companion_thought 行）。'
    + '能不能算我的残留由上面那一格按 id 归属判，不靠这张表被放行',
  understanding_projection_checkpoints: '理解的增量投影读标（按 workspace+user 游标推进），'
    + '这一发提交了练习事件之后它自己往前挪一格；它没有 run_id 也没有 objective 归属，不是剧本种的行',
}
/** 一张豁免表一次窗口能涨的上限：超过就不是"簿记"的形状了，宁可红。 */
const AMBIENT_GROWTH_CEILING_V1 = 50

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

const userDataDir = await mkdtemp(resolve(tmpdir(), 'astella-w46-practice-probe-'))
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
  // ── 题型：库里与屏上各读一次，两边要说同一句话 ──
  // 这一格挡的是**花钱那一发**：text 那一支提交会走 `assessment_critic`（真模型），
  // mapping 这一支走 `deterministic_structured`（不调模型）。夹具哪天漂回 text，这里先红，
  // 而不是在下一次「顺手提交一下」时替我们花掉一笔。
  const variantRow = sql(`
    select v.interaction ->> 'kind' as kind,
           coalesce((select string_agg(item, ' ' order by ord)
                       from jsonb_array_elements_text(v.interaction -> 'publicTokenIds')
                            with ordinality as x(item, ord)), '') as presented
    from learning_runs r
    join learning_tasks tk on tk.run_id = r.id
    join learning_task_variants v on v.task_id = tk.id
    where r.origin ->> 'roundId' = '${seeded.roundId}'
    order by v.created_at asc limit 1`)
  const [interactionKind, presentedRaw] = variantRow.split('|').map((part) => part.trim())
  const presented = presentedRaw.split(/\s+/).filter(Boolean)
  const screenItems = await page.locator('.run-order-list li[data-order-index]').count()
  readings.variant = { interactionKind, presented, screenItems }
  // 今天真实开出来的是 text_response（**这一支提交会走真模型**）。所以这里钉两件事：
  // ① 把题型读数原样留下——ordering 那一支还欠夹具条件（集测的 mapping 走的是 v2-card-fixture
  //    那条完整路径，本剧本手写的三行目标还差什么没量清），差什么写在文件头；
  // ② 一旦哪天它真的变成 ordering，这一格会红，提醒把「交一个故意错的顺序、读展开态那一句」
  //    补上——那才是免模型的那一读。反向也一样：题型漂走同样红。
  check('题型读数（今天是 text_response；变红的一头是"它成了 ordering，该去读展开态了"）',
    interactionKind === 'text_response' || interactionKind === 'ordering', readings.variant)
  check('屏上作答面与题型一致：text 那一支是输入区、ordering 那一支才是排序列表',
    (interactionKind === 'ordering' && screenItems === presented.length && presented.length >= 2)
    || (interactionKind === 'text_response' && screenItems === 0), readings.variant)

  // 正确答案在服务端那一格（客户端读不到）——读出来只为钉住下一读的前提：
  // 屏上呈现的顺序**确实是**它的一个排列，两边不是各说一套。
  const solutionRow = sql(`
    select coalesce((select string_agg(item, ' ' order by ord)
                        from jsonb_array_elements_text(s.solution -> 'correctTokenIds')
                             with ordinality as x(item, ord)), '')
    from learning_runs r
    join learning_tasks tk on tk.run_id = r.id
    join learning_task_variants v on v.task_id = tk.id
    join learning_task_private_solutions s on s.variant_id = v.id
    where r.origin ->> 'roundId' = '${seeded.roundId}' limit 1`)
  const correct = solutionRow.split(/\s+/).filter(Boolean)
  readings.correctOrder = correct
  // 有 correctTokenIds 的那些题（ordering 那一支）才谈"两份清单是不是同一组项"；
  // 没有就明说没有——地板要有：两边都是空清单时"互为排列"照样成立（这一格第一版就是这么空对空绿过去的）。
  check('若这一场带 correctTokenIds，它必须与屏上题面是同一组项（不是两份互不知情的清单）',
    correct.length === 0 && presented.length === 0
    || (correct.length >= 2 && correct.length === presented.length
        && [...correct].sort().join() === [...presented].sort().join()),
    { correct, presented })

  // **钱闸**：走到这里一场评估都不许产生（text 那一支一旦提交就是真模型调用）。
  const assessedRows = Number(sql(`select count(*) from learning_assessments where run_id = (
    select r.id from learning_runs r where r.origin ->> 'roundId' = '${seeded.roundId}' limit 1)`))
  readings.assessedRows = assessedRows
  check('本剧本没有提交过、也没有产生任何评估行（这一发仍然免费）', assessedRows === 0, assessedRows)
  // 走到这里仍然**不作答、不提交**：展开态那一句（`details.learning-run-result-rubric` 里每位一行）
  // 留给下一读；那一发要的是「故意交一个错的顺序」，题型与免费前提已由上面三格钉住。

  // ── 换成免模型那一支：屏上那颗「改做排序题」真的可达吗 ──
  // 「练一道」那一发带的不是 structured（服务端只在显式 structured 时才把结构题放主位），
  // 所以开出来是 text_response；但**备位结构题**由服务端随 allowedActions 下发，
  // 用户自己就能换过去（`run-planner.ts:447` 那条 wantsStructured 之外还有 alternative 一支）。
  // 这一格要量的就是这条换路在真窗口里到不到位——不到位，展开态那一读就永远只能停在这边。
  const switchToOrdering = page.getByRole('button', { name: '改做排序题', exact: true })
  const switchCount = await switchToOrdering.count()
  readings.switchToOrdering = { count: switchCount }
  check('屏上出现「改做排序题」那颗（备位结构题由服务端签发、用户可自己换过去）', switchCount === 1, readings.switchToOrdering)
  if (switchCount === 1) {
    await switchToOrdering.first().click({ timeout: 20_000 })
    const orderingOnScreen = await page.locator('.run-order-list li[data-order-index]').first()
      .waitFor({ timeout: 25_000 }).then(() => true, () => false)
    const orderingItems = await page.locator('.run-order-list li[data-order-index]').count()
    readings.afterSwitch = { orderingOnScreen, orderingItems }
    check('换过去之后屏上真的是那条可拖的排序列表（不是原地没换）',
      orderingOnScreen === true && orderingItems >= 2, readings.afterSwitch)

    // 换完之后库里那一档必须是 ordering，且带 correctTokenIds（下面按它造一个故意错的顺序）。
    const switchedRow = sql(`
      select v.interaction ->> 'kind' as kind,
             coalesce((select string_agg(item, ' ' order by ord)
                         from jsonb_array_elements_text(v.interaction -> 'publicTokenIds')
                              with ordinality as x(item, ord)), '') as presented
      from learning_runs r
      join learning_tasks tk on tk.run_id = r.id
      join learning_task_variants v on v.task_id = tk.id
      where r.origin ->> 'roundId' = '${seeded.roundId}' and v.interaction ->> 'kind' = 'ordering'
      limit 1`)
    const [switchedKind, switchedPresentedRaw] = switchedRow.split('|').map((part) => part.trim())
    const switchedPresented = switchedPresentedRaw.split(/\s+/).filter(Boolean)
    const switchedSolution = sql(`
      select coalesce((select string_agg(item, ' ' order by ord)
                        from jsonb_array_elements_text(s.solution -> 'correctTokenIds')
                             with ordinality as x(item, ord)), '')
      from learning_runs r
      join learning_tasks tk on tk.run_id = r.id
      join learning_task_variants v on v.task_id = tk.id
      join learning_task_private_solutions s on s.variant_id = v.id
      where r.origin ->> 'roundId' = '${seeded.roundId}' and v.interaction ->> 'kind' = 'ordering' limit 1`)
    const switchedCorrect = switchedSolution.split(/\s+/).filter(Boolean)
    readings.orderingTask = {
      kind: switchedKind, presented: switchedPresented, correct: switchedCorrect,
    }
    check('换过去之后库里那一档是 ordering，且题面与 correctTokenIds 是同一组项',
      switchedKind === 'ordering' && switchedCorrect.length === switchedPresented.length
      && switchedCorrect.length >= 2
      && [...switchedCorrect].sort().join() === [...switchedPresented].sort().join(),
      readings.orderingTask)

    // 故意留一位放错：呈现顺序若已经全对，就用键盘抓取把第 1 项挪到第 2 位（两位一起错也算错，
    // 但**至少有一位不成立**才是这一读要的那一句）。
    // 交卷那颗要**真的动过一次**才放开（`structuredPartReady`：ordering 需 `orderingTouched`）。
    // 所以两种情形都要按一次抓取：顺序本来就错的，挪下去再挪回来（净变化为零、仍然错）；
    // 顺序本来全对的，挪一位制造出"至少一位不成立"。
    // 摆一个"恰好第一位成立、其余两位不成立"的顺序：两位的排列只有全对/全错两种，
    // 同屏读不出那一对，所以夹具给到三项。移动用的是每行自带的那对上移/下移按钮
    // ——一步一个位置，且每一步之后重读屏上顺序，不靠脚本自己数。
    const labelLines = sql(`
      select 'L|' || lbl.tok || '|' || lbl.lab
      from learning_runs r
      join learning_tasks tk on tk.run_id = r.id
      join learning_task_variants v on v.task_id = tk.id
      cross join lateral jsonb_each_text(v.interaction -> 'publicTokenLabels') as lbl(tok, lab)
      where r.origin ->> 'roundId' = '${seeded.roundId}' and v.interaction ->> 'kind' = 'ordering'
      limit 12`)
      .split('\n').map((line) => line.trim()).filter((line) => line.startsWith('L|'))
    const labelOf = new Map<string, string>(labelLines.map((line) => {
      const parts = line.split('|')
      return [parts[1] ?? '', (parts[2] ?? '').trim()] as [string, string]
    }))
    readings.labelOf = Object.fromEntries(labelOf)
    check('题面那几项在库里都读得到标签（token 与 label 的条数对得上项数）',
      labelOf.size === switchedPresented.length && switchedPresented.length >= 3,
      { labels: readings.labelOf, items: switchedPresented.length })

    const readLabels = async (): Promise<string[]> =>
      (await page.locator('.run-order-list li .run-order-label').allTextContents())
        .map((text) => text.replace(/\s+/g, ' ').trim())
    // 屏上那句是「排序项 复习间隔」这种带前缀的形状，所以只按"包含库里那个标签"来认位。
    const indexOfToken = (domLabels: string[], token: string): number => {
      const wantedLabel = labelOf.get(token) ?? ''
      return domLabels.findIndex((text) => wantedLabel.length > 0 && text.includes(wantedLabel))
    }
    const moveRow = async (index: number, direction: string): Promise<void> => {
      await page.locator(`.run-order-list li[data-order-index="${index}"] .run-icon-button[aria-label*="${direction}"]`)
        .first().click({ timeout: 10_000 })
      await page.waitForTimeout(150)
    }
    // 目标：第 1 位放"应该的那一项"，后两位互换（于是同屏出现"成立"与"不成立"两种反馈）。
    const targetTokens = [switchedCorrect[0], switchedCorrect[2], switchedCorrect[1]]
    const moveLog: string[] = []
    for (let position = 0; position < targetTokens.length; position += 1) {
      const token = targetTokens[position] as string
      let current = await readLabels()
      let from = indexOfToken(current, token)
      if (from < 0) {
        check('要把的那一项在屏上读得到', false, { token, labels: Object.fromEntries(labelOf), current })
        break
      }
      while (from > position) {
        await moveRow(from, '上移')
        moveLog.push(`${labelOf.get(token) ?? token}: ${from + 1} -> ${from}`)
        current = await readLabels()
        from = indexOfToken(current, token)
        if (from < 0) break
      }
    }
    readings.arrange = { targetTokens, moveLog, after: await readLabels() }
    const arranged = await readLabels()
    const placedTokens = targetTokens
      .map((token, position) => ({ token, position, at: indexOfToken(arranged, token) }))
      .filter((item) => item.at === item.position)
      .map((item) => item.token)
    check('按目标摆完之后屏上顺序真对得上（摆不动就不该继续读反馈）',
      placedTokens.length === targetTokens.length, { placedTokens, targetTokens, after: readings.arrange.after })
    const finalOrder = (await page.locator('.run-order-list li[data-order-index]').evaluateAll(
      (nodes) => nodes.map((node) => node.textContent ?? ''),
    )).map((text) => text.replace(/^\s*\d+/, '').trim())
    readings.finalOrder = { finalOrder, targetTokens }
    check('交换之后屏上这一列读得到（每一项都印得出文字）',
      finalOrder.length === switchedPresented.length && finalOrder.every((text) => text.length > 0),
      readings.finalOrder)

    // 交卷：那颗主按钮的字面由服务端/组件决定，这里不猜——把屏上可见按钮都打出来，按"提交/交"命中，
    // 命中不了就红（readings.screenButtons 会带着当时的原文，下次不用再猜）。
    readings.screenButtons = (await page.locator('button:visible').allTextContents())
      .map((text) => text.trim()).filter(Boolean).slice(0, 40)
    const submitButton = page.locator('button:visible', { hasText: /^(交上去|提交回答|提交|就这样|看结果)$/ }).first()
    const submitFound = (await submitButton.count()) > 0
    check('屏上找得到交卷那颗（找不到就把可见按钮原样打出来，不静默跳过这一读）', submitFound, {
      submitFound, buttons: readings.screenButtons,
    })
    if (submitFound) {
      const submitStatusText = (await page.locator('[role="status"]').allTextContents())
        .map((text) => text.trim()).filter(Boolean).slice(0, 8)
      const submitEnabled = await submitButton.isEnabled()
      readings.submitGate = { enabled: submitEnabled, statusText: submitStatusText }
      check('动过一次顺序之后交卷那颗放开；没放开就得屏上说得出一句理由（不许静默灰着）',
        submitEnabled === true || submitStatusText.length > 0, readings.submitGate)
      readings.submitLabel = (await submitButton.textContent() ?? '').trim()
      // 交卷之前先在页内立个证人：从这一刻起记录覆盖层的每次挂载／散场。
      // 没有它，"产品没响"与"我看得太晚"分不开——上一轮我差点把后者登记成缺陷。
      await page.evaluate(() => {
        const w = window as unknown as { __ceremonyTrail?: Array<{ atMs: number; kind: string; hasCanvas: boolean }> }
        w.__ceremonyTrail = []
        const startedAt = Date.now()
        const isCeremony = (node: Node): node is HTMLElement =>
          node instanceof HTMLElement && node.classList.contains('learning-run-ceremony')
        new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            mutation.addedNodes.forEach((node) => {
              if (isCeremony(node)) w.__ceremonyTrail?.push(
                { atMs: Date.now() - startedAt, kind: 'add', hasCanvas: !!node.querySelector('canvas') })
            })
            mutation.removedNodes.forEach((node) => {
              if (isCeremony(node)) w.__ceremonyTrail?.push(
                { atMs: Date.now() - startedAt, kind: 'remove', hasCanvas: !!node.querySelector('canvas') })
            })
          }
        }).observe(document.body, { childList: true, subtree: true })
      })
      await submitButton.click({ timeout: 20_000 })
      // ── 结算演出那一读（09-24 起也放开给练习，但"接了却一次没见过"正是当时的根因）──
      // 只有 3s，所以**交卷之后第一件事**就是找它；彩纸是画在 canvas 上的，
      // jsdom 里 getContext 被 mock 成 null ⇒ 画没画出来只能在真窗口量像素。
      // 窗口给到 8s 并**把等待时长记下来**：机器上别的东西在跑时这一刻会晚到，
      // 只给 3.5s 会把"来得晚"量成"没来"（今天确实出现过一次 seen:false）。
      // 但窗口再宽也回答不了"到底有没有不来"，所以时长必须进读数。
      const ceremony = page.locator('.learning-run-ceremony').first()
      const ceremonyStartedAt = Date.now()
      const ceremonySeen = await ceremony.waitFor({ timeout: 8_000 }).then(() => true, () => false)
      const ceremonyWaitedMs = Date.now() - ceremonyStartedAt
      // 文案与像素**一次往返取全**：分开读会把自己读崩——覆盖层只活 3s，
      // 一条条 `textContent()` 的 CDP 往返一慢，读到第三条时元素已经没了（今天就这样把剧本弄挂过）。
      const observed = ceremonySeen ? await ceremony.evaluate(async (root) => {
        const text = (selector: string) => (root.querySelector(selector)?.textContent ?? '')
          .replace(/\s+/g, ' ').trim()
        const canvas = root.querySelector('canvas.learning-run-ceremony__confetti') as HTMLCanvasElement | null
        const ctx = canvas?.getContext('2d') ?? null
        let painted = canvas && ctx ? 0 : -1
        let frames = 0
        if (canvas && ctx) {
          const deadline = performance.now() + 2_200
          while (performance.now() < deadline) {
            frames += 1
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let hit = 0
            for (let index = 3; index < data.length; index += 4) {
              if (data[index] > 0) hit += 1
            }
            if (hit > painted) painted = hit
            if (painted > 0) break
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          }
        }
        return {
          eyebrow: text('.learning-run-ceremony__eyebrow'),
          stamp: text('.learning-run-ceremony__stamp'),
          heading: text('h2'),
          painted,
          frames,
          size: canvas ? `${canvas.width}x${canvas.height}` : 'no-canvas',
        }
      }).catch(() => null) : null
      const ceremonyCopy = observed ?? { eyebrow: '', stamp: '', heading: '' }
      const confettiPainted = observed?.painted ?? -1
      const confettiFrames = observed?.frames ?? 0
      readings.confettiCanvas = observed?.size ?? ''
      const ceremonyTrail = await page.evaluate(() => (
        (window as unknown as { __ceremonyTrail?: Array<{ atMs: number; kind: string; hasCanvas: boolean }> }).__ceremonyTrail ?? []
      ))
      readings.ceremonyTrail = ceremonyTrail
      // 决策那一侧自己带旗子（`data-acknowledgement`，由 `setResultAcknowledgementActive(playsCeremony)` 写）。
      // 从没挂过而旗子是 idle ⇒ 决策那一步就没让它响，不是渲染掉了。
      readings.ceremonyDecision = {
        decisionFlag: await page.locator('.learning-run-result-board').first()
          .getAttribute('data-acknowledgement').catch(() => null),
      }
      check('页内证人和我对覆盖层的观察一致（分不清"没响"与"看晚了"的时候，这条先红）',
        ceremonySeen === ceremonyTrail.some((entry) => entry.kind === 'add'),
        { ceremonySeen, ceremonyWaitedMs, ceremonyTrail })
      readings.ceremony = { seen: ceremonySeen, ceremonyWaitedMs, ...ceremonyCopy, confettiPainted, confettiFrames }

      const resultBoard = await page.locator('.learning-run-result-board').first()
        .waitFor({ timeout: 40_000 }).then(() => true, () => false)
      check('交卷之后结算那一块真在屏上', resultBoard === true)
      // 演出那一格不能无条件要求"必须出现"——政策是 `demonstrated | practice_completed` 才放。
      // 所以先把 outcome 读下来（屏上那一格 + 库里那一份），两边对得上，再按政策判演出。
      const screenOutcome = (await page.locator('.learning-run-result-board').first()
        .getAttribute('data-outcome')) ?? ''
      const dbOutcome = sql(`select coalesce(r.result ->> 'outcome', 'NULL') from learning_runs r
        where r.origin ->> 'roundId' = '${seeded.roundId}' limit 1`).trim()
      readings.outcome = { screenOutcome, dbOutcome }
      check('结算那一档屏上说的与库里记的是同一个词（不是一个渲染一个落库）',
        screenOutcome.length > 0 && screenOutcome === dbOutcome, readings.outcome)
      // 演出的三格要等 outcome 读出来才判得准（政策按 outcome 取，不看 eligibility），
      // 但**观察**必须留在交卷那一刻——覆盖层只有几秒。
      // 提醒下一位：第一条今天会**间歇红**（8 跑里 2 次演出压根没挂上，其余读数一字不差），
      // 那是缺陷不是判据写错——已登记在 39d §19 那行；放宽这条等于把它藏起来。
      const ceremonyExpected = dbOutcome === 'demonstrated' || dbOutcome === 'practice_completed'
      readings.ceremony.expected = ceremonyExpected
      const ceremonyMountedEver = ceremonyTrail.some((entry) => entry.kind === 'add')
      readings.ceremony.mountedEver = ceremonyMountedEver
      // 判"该不该有"用证人，不用"我抓没抓到"：窗口只有 8s，来晚了我什么也读不到。
      check('演出在该出现的那一档挂载过（政策：demonstrated 或 practice_completed）',
        ceremonyMountedEver === ceremonyExpected, readings.ceremony)
      check('该出现且抓到时，彩纸真画出了像素（没抓到就明说是量法受限，不赖产品）',
        !(ceremonyExpected === true && ceremonySeen === true)
        || (confettiPainted > 0 && confettiFrames >= 1), readings.ceremony)
      // 那处坑的正面判据：眉标不许从 eligibility 反推出"正式挑战"——结构题做主位时
      // ceiling 被钳成 practice_only 而快照 eligibility 仍是 eligible，两者一拼就自相矛盾。
      check('抓到的那一次里，演出的两行不与结果自相矛盾（练习这一支不说"正式挑战"）',
        !(ceremonyExpected === true && ceremonySeen === true) || (ceremonyCopy.eyebrow?.length > 0 && !/正式挑战/.test(`${ceremonyCopy.eyebrow} ${ceremonyCopy.heading}`)),
        readings.ceremony)

      // **免费**这一发必须自证：评估那行的来源是确定性结构化，不是 critic（真模型）。
      const assessmentRow = sql(`
        select a.source, a.status, coalesce(jsonb_array_length(a.rubric_results), 0)
        from learning_assessments a join learning_runs r on r.id = a.run_id
        where r.origin ->> 'roundId' = '${seeded.roundId}' limit 1`)
      const [assessmentSource, assessmentStatus, rubricEntryCount] = assessmentRow
        .split('|').map((part) => part.trim())
      readings.assessment = { source: assessmentSource, status: assessmentStatus, entries: Number(rubricEntryCount) }
      check('那一发的评估来源是 deterministic_structured（**没有花一次模型**）',
        assessmentSource === 'deterministic_structured', readings.assessment)

      // 展开态那一读：`<details>` 在真窗口里折叠着也在 DOM，所以必须先看 open 再看内容
      // （这条与 jsdom 那格的坑同源）。
      // 覆盖层还挂着的时候点下面的东西会被它挡（今天就红过一次：那颗 summary 点不动）。
      // 它自带给用户的那颗"跳过"——按它跳过并等到散场，而不是赌三秒已经过去。
      const skipButton = page.locator('.learning-run-ceremony__skip').first()
      const skipLabel = (await skipButton.count()) > 0 ? (await skipButton.textContent() ?? '').trim() : ''
      readings.ceremonySkip = { label: skipLabel }
      if (skipLabel.length > 0) {
        await skipButton.click({ timeout: 5_000 }).catch(() => undefined)
        await page.locator('.learning-run-ceremony').first()
          .waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
      }
      const overlayStillUp = await page.locator('.learning-run-ceremony').count()
      readings.afterSkip = { overlayStillUp, resultStillUp: await page.locator('.learning-run-result-board').count() }
      check('要往下点之前演出那层已经散掉，而结算那一块还在（跳过不等于丢掉结果）',
        overlayStillUp === 0 && readings.afterSkip.resultStillUp === 1, readings.afterSkip)

      const rubricSummary = page.locator('details.learning-run-result-rubric summary').first()
      const summaryText = (await rubricSummary.textContent() ?? '').trim()
      await rubricSummary.click({ timeout: 20_000 })
      const detailsOpen = await page.locator('details.learning-run-result-rubric')
        .first().evaluate((node) => (node as HTMLDetailsElement).open)
      const rubricRows = await page.locator('details.learning-run-result-rubric li[data-verdict]').all()
      const rows = []
      for (const row of rubricRows) {
        rows.push({
          verdict: (await row.getAttribute('data-verdict')) ?? '',
          head: (await row.locator('.learning-run-result-rubric__head').textContent() ?? '').trim(),
          reason: (await row.locator('p').textContent() ?? '').trim(),
        })
      }
      readings.rubricRead = { summaryText, detailsOpen, rows }
      check('展开之后"每位一行"真的在屏上，且条数与摘要那句、与题面位数是同一个数',
        detailsOpen === true && rows.length === switchedCorrect.length
        && summaryText.includes(String(rows.length)), readings.rubricRead)
      check('每一位都说得出一句话（不是只有个判定标签）',
        rows.length > 0 && rows.every((row) => row.head.length > 0 && row.reason.length > 0),
        readings.rubricRead)
      // 位置真值要从库里那两份对上：token→label 的映射 + 每个位子**应该**是哪一项。
      // token→label 那份映射上面已经查过（一处一份），这里直接用。
      const expectedLabels = switchedCorrect.map((token) => labelOf.get(token) ?? '')
      const wrongPositions = finalOrder
        .map((placed, index) => ({ index, placed, expected: expectedLabels[index] ?? '' }))
        .filter((item) => item.placed !== item.expected)
      readings.positionTruth = { expectedLabels, placed: finalOrder, wrongPositions, rows }
      const rightPositions = finalOrder
        .map((placed, index) => ({ index, placed, expected: expectedLabels[index] ?? '' }))
        .filter((item) => item.placed === item.expected)
      readings.positionSplit = { rightPositions, wrongPositions }
      check('这一发同屏留下"至少一位成立"与"至少一位不成立"（两位的排列读不出这一对）',
        rightPositions.length >= 1 && wrongPositions.length >= 1 && rows.length === finalOrder.length,
        readings.positionSplit)
      // 成立那一位报的是**用户自己放在那一位的那一项**（他自己的文字，不新增答案信息）
      const silentOnes = rightPositions.filter(({ index, placed }) => placed.length > 1
        && !(rows[index]?.reason ?? '').includes(placed))
      check('成立那一位说得出"这一步放对了"并且点出用户自己放的那一项', silentOnes.length === 0,
        { silentOnes, rows, rightPositions })
      // 逐位反馈那句不许把"该放那一位的那一项"说出来——不成立的那一位尤其如此
      // （理由串原样送到客户端，替用户填正确项就等于绕过曝光记账）。
      const leaks = wrongPositions
        .filter(({ index, expected }) => expected.length > 1 && (rows[index]?.reason ?? '').includes(expected))
        .map(({ index, expected }) => `第 ${index + 1} 位说出了「${expected}」`)
      check('不成立那一位一个字都不写出该放什么（不新增答案信息）', leaks.length === 0,
        { leaks, rows, wrongPositions })

      // ── 揭示参考答案那一读（同一发仍然免费）──
      // 记的就是今天那笔曝光账：`revealRunTargetV2` 靠 `idempotency_key = run-reveal:<runId>`
      // 保证同一场只记一笔，且回出去的 exposureId 必须是库里那一笔的（撞键那一发此前回的是
      // 当场新造的 uuid）。集测那头已经钉过；这一格钉的是**屏上**：揭示之前正文闩着、
      // 揭示之后那句与库里那份 mapping 同源，而库里那笔账 kind=answer_reveal、记在没有卡的那条目标上。
      const pairs = (JSON.parse(FIXTURE.canonicalAnswer) as { pairs: Array<{ left: string; right: string }> }).pairs
      const answerBefore = await page.locator('.learning-run-result-reveal__answer').count()
      const revealButton = page.getByRole('button', { name: '看参考答案与解释', exact: true })
      const revealCount = await revealButton.count()
      readings.reveal = { answerBefore, revealCount }
      check('揭示之前屏上没有参考正文，那颗按钮在（不是把答案先摊在屏上）',
        answerBefore === 0 && revealCount === 1, readings.reveal)
      if (revealCount === 1) {
        await revealButton.first().click({ timeout: 20_000 })
        const answerText = (await page.locator('.learning-run-result-reveal__answer').first()
          .textContent({ timeout: 20_000 }) ?? '').replace(/\s+/g, ' ').trim()
        const missing = pairs.flatMap((pair) => [pair.left, pair.right]).filter((word) => !answerText.includes(word))
        readings.reveal.answerText = answerText
        readings.reveal.missingFromDbPairs = missing
        check('揭示出来的那句把库里那份 mapping 的每一对左右项都说到了（不是客户端另拼一份）',
          answerText.length > 0 && missing.length === 0, readings.reveal)

        const exposureRow = sql(`
          select e.exposure_kind, coalesce(e.card_id::text, 'NULL'),
                 (select count(*) from learning_exposures_v2 e2
                   where e2.idempotency_key = 'run-reveal:' || r.id::text)
          from learning_runs r
          join learning_exposures_v2 e on e.idempotency_key = 'run-reveal:' || r.id::text
          where r.origin ->> 'roundId' = '${seeded.roundId}' limit 1`)
        const [exposureKind, exposureCard, exposureCount] = exposureRow.split('|').map((part) => part.trim())
        const exposureOnThisObjective = Number(sql(`
          select count(*) from learning_runs r
          join learning_exposures_v2 e on e.idempotency_key = 'run-reveal:' || r.id::text
          where r.origin ->> 'roundId' = '${seeded.roundId}'
            and e.objective_id = '${seeded.objectiveId}'`))
        readings.exposure = { exposureKind, exposureCard, exposureCount, exposureOnThisObjective }
        check('这一发的曝光账恰好一笔、记的是 answer_reveal 这一档（成员表只有一份那个词表）',
          exposureCount === '1' && exposureKind === 'answer_reveal', readings.exposure)
        check('无卡目标的那笔账记的就是没有卡（card_id 为空），且挂在这一条目标上',
          exposureCard === 'NULL' && exposureOnThisObjective === 1, readings.exposure)
      }
    }
  }

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
      // 涨表本身不等于"我留了残留"：这个工作区是**共享的**——活着的伴星调度器会在同一时刻往里写
      // `jobs`（实测这一发涨的是 `companion_thought` 行），与剧本无关。所以豁免不能靠"表名放行"，
      // 要靠**归属**：把涨了的每一张表里所有 uuid 列拿本次种下的那批 id 过一遍，
      // 只要有一行指得到我的 id，不管它在不在豁免名单里，一律红。
      const seededIds = [
        seeded.roundId, seeded.objectiveId, seeded.objectiveRevisionId,
        seeded.evidenceSnapshotId, seeded.noteId,
        ...(readings.runsWiped ? readings.runsWiped.runIds as string[] : []),
      ]
      const grownTables = Object.keys(growth)
      const grownColumns = grownTables.length === 0 ? [] : sql(`
        select c.table_name || '|' || c.column_name
        from information_schema.columns c
        where c.table_schema = 'public' and c.data_type = 'uuid'
          and c.table_name in (${grownTables.map((table) => `'${table}'`).join(',')})`)
        .split('\n').map((line) => line.trim()).filter(Boolean)
      const attribution = grownColumns.length === 0 ? [] : sql(`
        ${grownColumns.map((pair) => {
          const [table, column] = pair.split('|')
          return `select '${table}.${column}' as slot, count(*)::text as hits from public."${table}" `
            + `where "${column}" in (${seededIds.map((id) => `'${id}'`).join(',')})`
        }).join(' union all ')}`).split('\n').filter(Boolean)
        .map((line) => line.split('|').map((part) => part.trim()))
        .filter(([slot, hits]) => Number(hits) > 0 && slot.length > 0)
      readings.censusAttribution = attribution
      check('涨了的表里没有任何一行指得回本次种下的 id（并发写不等于我的残留）',
        attribution.length === 0, { attribution, growth })
      // 有一张表的行不是剧本种的，而是**这个窗口自己在场**的簿记：伴星那条"她此刻在哪一屏"
      // 的行由活渲染层发布（W2-6 的 `readLivePageView` 读的就是它）。开一次真窗口就会涨几行，
      // 且只涨这一张——所以豁免名单是**指名道姓**的，并要求它这一轮真的出现（不再出现就得把条目删掉，
      // 免得豁免变成免检通道）。其余任何一张表涨了行数，一律红。
      const unexplained = Object.keys(growth).filter((table) => !(table in AMBIENT_GROWTH_ALLOWED_V1))
      const tooMuch = Object.entries(growth)
        // 判的是**涨幅**，不是行数：那张投影读标表本来就有 57 行，这一次只挪了 1 行。
        .filter(([table, [from, to]]) => table in AMBIENT_GROWTH_ALLOWED_V1 && to - from > AMBIENT_GROWTH_CEILING_V1)
        .map(([table]) => table)
      // "这一轮没涨的那张豁免表"只登记、不红：拿它当红等于要求每张簿记表每次都必须动，
      // 而它不动只是那条豁免该被剪掉，并不会藏住新的残留（别的表涨了照样落在 unexplained）。
      const exemptionsUnused = Object.keys(AMBIENT_GROWTH_ALLOWED_V1).filter((table) => !(table in growth))
      readings.censusExemptions = { used: Object.keys(growth).filter((table) => table in AMBIENT_GROWTH_ALLOWED_V1), exemptionsUnused }
      check('这个工作区里没有哪张表因为这次剧本涨了行数（只有点名豁免那两张、且涨幅像簿记）',
        unexplained.length === 0 && tooMuch.length === 0, { unexplained, tooMuch, growth })
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
