import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**两个窗口对同一轮**（39d W4-5 ④；PRD §3.2 与 §16.39 那句
 * "没有其他活跃端时标记可恢复暂停，不新增轮次"）。
 *
 * 为什么必须是**两个真窗口**，而不是集测里插两行租约：这条链上唯一有价值的判据是
 * "扫描吃的那份租约，是渲染层真发布出来的那一种"。集测夹具自己写的 `assistant_page_contexts`
 * 行，形状由夹具作者决定——本仓库已经两次把"假来源＋假夹具＝两条都绿"当成教训
 * （39d §19 记过 W2-6 那一族）。这里让两个实例各自 publish、各自每 10 秒续租，
 * 停与不停都由那一份真行决定。
 *
 * 四段判据（顺序就是产品的顺序）：
 *   1. 两台同开同一篇 ⇒ 读到的是**同一轮**（库里该篇仍只有 1 行；§6.1 名额按人算）。
 *   2. 两台都活着 ⇒ 等了超过一个扫描间隔＋宽限期，那一行**仍是 active**；
 *      并把"当时有几行 live 租约"读出来当证据（没有这两行，第 3 段的停就只是巧合）。
 *   3. 两台都关掉 ⇒ 租约过期后再等一个间隔 ⇒ 那一行**变成 paused**（`paused_at` 有值），
 *      且**没有**开出第二轮（库里该篇仍 1 行）。
 *   4. 重开一台 ⇒ 「继续这一轮」出现，点一下 ⇒ 回到 active、`resumed_at` 有值。
 *
 * 时间账（都从生产那一份常量来，不在这里另写一套数字）：
 *   租约 30 秒（`CONTEXT_LEASE_SECONDS`，续租每 10 秒一次）；宽限期 = 30×3 = 90 秒
 *   （`ROUND_IDLE_PAUSE_GRACE_MS_V1`）；扫描间隔默认 60 秒（`NOTE_ROUND_IDLE_PAUSE_SWEEP_MS`）。
 *   所以"都走了"之后最多等 90（宽限）＋60（间隔）＋30（租约过期）≈ 150 秒，
 *   剧本给它 200 秒的**轮询**上限，不是固定 sleep——提前达成就提前继续。
 *
 * 它自己种数据（一条 `updated_at` 拨到 10 分钟前的 active 轮次：宽限期立刻成立，
 * 这样第 2 段的"仍不停"才真的在考验租约那一格，而不是在考验时钟），
 * 收尾删干净并逐表对账。**用户可见的那篇笔记本身不动**。
 *
 * 跑法（先 `npm run build`；要 dev 栈在跑——扫描是 API 进程里那条定时对账）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-two-windows.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT ?? ''
const QUESTION = '两个窗口的这一轮'

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

/** 写语句 + RETURNING 时 psql 还会追打一行命令标签，取返回值只认第一行。 */
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

/** 扫描认的就是这一格：未过期且未撤销。表达式与 `round-activity-sweep.ts` 那条读法同形。 */
const liveLeaseCount = (): number =>
  Number(sql("select count(*) from assistant_page_contexts where revoked_at is null and expires_at > now()"))

const roundRow = (id: string): string => firstValue(sql(`
  select phase || '/' || revision
         || '/' || coalesce(paused_at is not null, false)
         || '/' || coalesce(resumed_at is not null, false)
    from note_learning_rounds where id = '${id}'`))

/** 起一个实例并走到"这一篇"：返回 page，登录与关对话框都在这里面。 */
const launchIntoNote = async (tag: string) => {
  const dir = await mkdtemp(resolve(tmpdir(), `ailearn-two-windows-${tag}-`))
  const app = await electron.launch({
    args: ['.', '--lang=zh-CN', `--user-data-dir=${dir}`],
    cwd: appRoot,
    executablePath,
  })
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
  const rail = page.getByRole('button', { name: '展开目录' })
  if ((await rail.count()) > 0) {
    await rail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
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
  await page.waitForTimeout(1_500)
  return { app, page }
}

/** 屏上那一行的问题句（两屏各读一次，用来对"是不是同一轮"）。 */
const questionOnScreen = async (page: import('@playwright/test').Page): Promise<string> => {
  const block = page.locator('.notebook-round', { hasText: '这一轮：' }).first()
  const text = ((await block.textContent().catch(() => '')) ?? '').trim()
  return text
}

/** 轮询到某个条件成立（不是固定 sleep：提前达成就提前继续）。 */
const waitUntil = async (label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 2_000))
  }
  readings[`${label}TimedOut`] = true
  return false
}

const resumeButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '继续这一轮', exact: true })

let noteId = ''
let roundId = ''
let countsBefore: Record<string, number> | null = null
const launched: Array<{ app: Awaited<ReturnType<typeof electron.launch>> }> = []

try {
  countsBefore = familyCounts()
  noteId = firstValue(sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`))
  check('这句标题在库里只对应一篇笔记', /^[0-9a-f-]{36}$/.test(noteId), noteId)
  const residual = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  check('起点这篇没有残留的轮次', residual === 0, residual)
  const leaseBefore = liveLeaseCount()
  readings.leaseBefore = leaseBefore

  // 种一条**已过宽限期**的 active 轮次：`updated_at` 拨到 10 分钟前。
  // 这样第 2 段"仍不停"考验的是租约那一格，而不是考验 90 秒的钟。
  roundId = randomUUID()
  const seeded = firstValue(sql(`
    INSERT INTO note_learning_rounds (id, workspace_id, user_id, note_id, phase, driving_question,
      driving_question_source, driving_question_revision, note_version_id, source_content_hash,
      max_model_calls, max_wall_clock_seconds, max_tasks, revision, updated_at)
    SELECT '${roundId}', n.workspace_id, n.created_by, n.id, 'active', '${QUESTION}', 'user_authored',
           1, n.current_version_id, v.content_hash, 8, 900, 6, 1, now() - interval '10 minutes'
      FROM notes n JOIN note_versions v ON v.id = n.current_version_id
     WHERE n.id = '${noteId}'
    RETURNING id || '/' || phase`))
  check('种出了已过宽限期的那一轮', seeded === `${roundId}/active`, seeded)

  // ── 第 1 段：两台同开同一篇 ⇒ 同一轮 ──
  const a = await launchIntoNote('a'); launched.push(a)
  const b = await launchIntoNote('b'); launched.push(b)
  const lineA = await questionOnScreen(a.page)
  const lineB = await questionOnScreen(b.page)
  check('两屏读到的是同一轮（同一句问题、两份屏上读数）',
    lineA.includes(QUESTION) && lineB.includes(QUESTION), { lineA, lineB })
  const roundsForNote = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  check('两屏同开没有开出第二轮（§6.1 名额按人算）', roundsForNote === 1, roundsForNote)

  // ── 第 2 段：两台都活着 ⇒ 扫描不许停 ──
  const leasesWhileBothOpen = liveLeaseCount()
  readings.leasesWhileBothOpen = leasesWhileBothOpen
  check('两台各自真发布了 live 租约（扫描吃的那一格是真行，不是夹具）',
    leasesWhileBothOpen >= 2, { before: leaseBefore, now: leasesWhileBothOpen })
  // 一个间隔 60 秒 + 宽限 90 秒：给它 150 秒，中途每 2 秒看一次库。
  await new Promise((r) => setTimeout(r, 150_000))
  const rowWhileAlive = roundRow(roundId)
  readings.rowWhileBothAlive = rowWhileAlive
  check('两台都活着 ⇒ 那一行仍是 active（过了间隔与宽限期也没被停）',
    rowWhileAlive.startsWith('active/'), rowWhileAlive)

  // ── 第 3 段：两台都关掉 ⇒ 租约过期后应当被停 ──
  await Promise.all(launched.map((entry) => entry.app.close().catch(() => undefined)))
  const pausedInTime = await waitUntil('pauseAfterBothClosed',
    async () => roundRow(roundId).startsWith('paused/'), 200_000)
  const rowAfterClose = roundRow(roundId)
  readings.rowAfterBothClosed = rowAfterClose
  readings.leasesAfterClose = liveLeaseCount()
  check('两台都走了 ⇒ 那一行被标成可恢复暂停（paused_at 有值）',
    pausedInTime && rowAfterClose.startsWith('paused/') && rowAfterClose.split('/')[2] === 'true',
    { row: rowAfterClose, liveLeases: readings.leasesAfterClose })
  const roundsAfterPause = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  check('停住这一件事没有新增轮次（PRD §3.2 明令）', roundsAfterPause === 1, roundsAfterPause)

  // ── 第 4 段：重开一台 ⇒ 那发恢复真能用 ──
  const c = await launchIntoNote('c'); launched.push(c)
  const appeared = await resumeButton(c.page).first()
    .waitFor({ timeout: 20_000 }).then(() => true, () => false)
  check('重开一台之后屏上摆出「继续这一轮」（不是把用户留在死路）', appeared, await questionOnScreen(c.page))
  if (appeared) {
    await resumeButton(c.page).first().click({ timeout: 20_000 })
    const resumedInTime = await waitUntil('resumeFromScreen',
      async () => roundRow(roundId).startsWith('active/'), 30_000)
    const rowAfterResume = roundRow(roundId)
    readings.rowAfterResume = rowAfterResume
    check('点一下接回去了：库里 active、resumed_at 有值、还是那一轮',
      resumedInTime && rowAfterResume.split('/')[2] === 'true' && rowAfterResume.split('/')[3] === 'true',
      rowAfterResume)
  }
} catch (error) {
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  for (const entry of launched) await entry.app.close().catch(() => undefined)
  if (process.env.PROBE_ALLOW_DB === '1' && roundId.length === 36) {
    sql(`BEGIN; SELECT set_config('app.allow_history_mutation','on',true);
      DELETE FROM note_learning_round_teachings WHERE round_id = '${roundId}';
      DELETE FROM note_learning_round_plan_revisions WHERE round_id = '${roundId}';
      DELETE FROM note_learning_rounds WHERE id = '${roundId}'; COMMIT;`)
    readings.countsAfter = familyCounts()
    readings.roundsLeftForNote = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
    if (countsBefore) {
      check('收尾逐表对账：四张表回到开跑前那份数',
        JSON.stringify(readings.countsAfter) === JSON.stringify(countsBefore),
        { before: countsBefore, after: readings.countsAfter })
    }
  }
  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
    process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
  process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
  if (failed.length > 0) process.exitCode = 1
}
