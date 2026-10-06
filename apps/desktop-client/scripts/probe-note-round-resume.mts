import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**把停住的那一轮继续下去**（39d W4-5 ④ 的前置；恢复那一发的判据）。
 *
 * 为什么必须真窗口：这一件要证的正是"界面上真有一个出口"。集测钉的是服务端那四件
 * （恢复推进一格、旧的那一版拒掉、终态拒掉、重复是 noop），jsdom 喂的是我按合同拼的回读——
 * "屏幕上那颗按钮按下去之后，库里那一行真的回到进行中、屏上那一块真的跟着换回来"
 * 这一整条只能在真 IPC → 真网关 → 真 dev API → 真库上读一次。
 *
 * `paused` 那一行**怎么种的**：先按服务端开一轮时写的那几列插一条 active（快照锚取的就是
 * 这篇当前那一版的 `content_hash`，三项预算取的是服务端签发的那三个数），再用一句
 * `UPDATE … phase='paused', paused_at=now(), revision=revision+1` 推进它——
 * 那就是 `advanceRound(pause)` 写进库的东西（`round-service.ts:392-409`）。
 * 这张表有触发器守着（0282 那一族：身份列不可改、`revision` 只许前进），所以这里
 * **不硬插一个不合法状态**：种出来的那一行本来就占着 §6.1 那条部分唯一索引的名额，
 * 与一条真被暂停的轮次在库里没有区别。
 *
 * 屏上那一块怎么从 active 换到 paused：重新进这一篇一次（离开→回来是真实用户路径，
 * 也让第一屏是界面自己读出来的，不是我塞给它的）。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 node --experimental-strip-types scripts/probe-note-round-resume.mts
 *   （目标笔记默认是「学习科学术语定义集」，要换就带 PROBE_NOTE_HINT）
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT?.trim() || '学习科学术语定义集'
const QUESTION = '停住的那一轮要继续下去的那一句'

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

/**
 * 写语句 + `RETURNING` 时 psql 会在数据行后面再打一行命令标签（`INSERT 0 1`／`UPDATE 0 1`），
 * 所以取返回值只认第一行。整串拿去比 uuid 会红，而那句红读起来像"种失败了"。
 */
const firstValue = (raw: string): string => raw.split('\n')[0]?.trim() ?? ''

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

/** 这一族四张表都数一遍：恢复那一发只该动 `note_learning_rounds` 那一张。 */
const familyCounts = (): Record<string, number> => ({
  rounds: Number(sql('select count(*) from note_learning_rounds')),
  plans: Number(sql('select count(*) from note_learning_round_plan_revisions')),
  teachings: Number(sql('select count(*) from note_learning_round_teachings')),
  artifacts: Number(sql('select count(*) from note_learning_round_artifacts')),
})

const userDataDir = await mkdtemp(resolve(tmpdir(), 'astella-w45-resume-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

let noteId = ''
let roundId = ''
/** 开跑前那四张表的行数；`finally` 里对账要用，所以声明在 try 外面（try 里的 const 出不去）。 */
let countsBefore: Record<string, number> | null = null

/** 重新进这一篇一次：屏上那一块因此是界面自己读出来的，不是剧本塞进去的。 */
const navToNote = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.waitForTimeout(600)
  // 书架可能已经是展开状态：那时再点 `.note-shelf-all` 会一直等不到（与 history 那份同一口径）。
  if ((await page.locator('.note-shelf-all').count()) > 0) {
    await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })
    await page.waitForTimeout(600)
  }
  await page.locator('.note-row', { hasText: NOTE_HINT }).first().click({ timeout: 20_000 })
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1_500)
}

const roundQuestionLine = (page: import('@playwright/test').Page) =>
  page.locator('.notebook-round', { hasText: `这一轮：${QUESTION}` }).first()
const resumeButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '继续这一轮', exact: true })

/** 等一颗按钮出现/消失（把"在飞"与"失败"两种形状分开读，不靠固定 sleep 猜）。 */
const waitButton = async (page: import('@playwright/test').Page, want: boolean): Promise<boolean> => {
  for (let tick = 0; tick < 40; tick += 1) {
    const present = (await resumeButton(page).count()) > 0
    if (present === want) return true
    await page.waitForTimeout(500)
  }  return (await resumeButton(page).count()) > 0 === want
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

  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })

  // ── 起点：唯一一篇、这一篇零残留轮次、这一发要动的四张表各记一个基线数 ──
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
  // 种的那一行归属于这篇笔记的创建者：不是登录的那个人的话，屏上什么都不会读出来，
  // 而那条红会被读成"恢复没接上"。所以先把这个前提量掉。
  const ownerMatches = Number(sql(
    `select count(*) from notes n join users u on u.id = n.created_by
      where n.id = '${noteId}' and u.email = '${process.env.OWNER_EMAIL}'`,
  ))
  check('这一篇的创建者就是登录的那个账号（种出来的那一轮他看得见）', ownerMatches === 1, ownerMatches)
  const residual = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  readings.residualRounds = residual
  if (residual !== 0 || ownerMatches !== 1) {
    check('起点这篇没有残留的轮次', residual === 0, `库里有 ${residual} 行——先清掉再跑（别的剧本留下的也算）`)
    report()
    throw new Error('residual rounds on the target note')
  }
  countsBefore = familyCounts()
  readings.countsBefore = countsBefore

  // ── 种一条轮次：先按服务端开一轮时写的那几列插 active，再按 advanceRound 的写法推成 paused ──
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
    throw new Error('seeding the active round failed')
  }
  readings.roundId = roundId
  await navToNote(page)
  const activeBlock = await roundQuestionLine(page).waitFor({ timeout: 20_000 }).then(() => true, () => false)
  check('种出的那一轮屏上读得到（这一轮：那一句）', activeBlock, await page.locator('.notebook-round').first().textContent().catch(() => null))
  // 对照组：active 的那一轮**不该**有那颗按钮——少了这一发，"按钮出现"可以是任何东西让它出现。
  const noButtonWhileActive = (await resumeButton(page).count()) === 0
  readings.activeButtons = await page.locator('.notebook-round button').allTextContents()
  check('正在进行的那一轮不摆「继续这一轮」（对照：那颗只认停住那一档）', noButtonWhileActive, readings.activeButtons)

  const pausedRow = firstValue(sql(`
    update note_learning_rounds
       set phase = 'paused', paused_at = now(), revision = revision + 1, updated_at = now()
     where id = '${roundId}'
    returning phase || '/' || revision || '/' || coalesce(paused_at is not null, false)`))
  readings.pausedRow = pausedRow
  check('按 advanceRound 的写法把它推成 paused（身份列未动、revision 前进一步）', pausedRow.startsWith('paused/2/t'), pausedRow)

  await navToNote(page)
  const appeared = await waitButton(page, true)
  readings.buttonsWhilePaused = await page.locator('.notebook-round button').allTextContents()
  check('重新进这一篇：停住的那一轮摆出了「继续这一轮」', appeared, {
    buttons: readings.buttonsWhilePaused,
    block: await page.locator('.notebook-round').first().textContent().catch(() => null),
  })
  if (!appeared) {
    report()
    throw new Error('the resume entry point is not on screen; refusing the click')
  }

  // ── 点下去：库里那一行回到 active 且 resumed_at 有值；屏上那一块回到进行中形态 ──
  await resumeButton(page).first().click({ timeout: 20_000 })
  const gone = await waitButton(page, false)
  const inDb = firstValue(sql(`
    select phase || '/' || revision
           || '/' || coalesce(paused_at is not null, false)
           || '/' || coalesce(resumed_at is not null, false)
      from note_learning_rounds where id = '${roundId}'`))
  readings.roundInDbAfterResume = inDb
  // `psql -tA` 打的是 `true`/`false`（不是 `t`）——上一版按 `active/3/t/t` 比，
  // 于是"库里已经恢复"这条真读数被自己的字符串判成红。与上面 paused 那一格同形修掉。
  const resumed = inDb === 'active/3/true/true'
  check('点一下之后库里那一行是 active、revision 又前进一步、resumed_at 非空', resumed, inDb)
  const stillTracked = await roundQuestionLine(page).waitFor({ timeout: 20_000 }).then(() => true, () => false)
  /**
   * 「在途」那一格必须自己清掉。上一版这里只看"标签不再是「继续这一轮」"就算过——
   * 点下去之后标签立刻换成「正在继续…」，`waitButton(false)` 当场返回 true，
   * 于是"卡住在途态"在屏上根本看不出来（W4-3 那条「什么都没在跑却写着正在改写…」是同一个形状）。
   * 现在给它 6 秒落回常态；落不回来就红，并把那一刻屏上的按钮名单带出来。
   */
  let buttonsAfterResume: string[] = []
  let settledTicks = -1
  for (let tick = 0; tick < 12; tick += 1) {
    buttonsAfterResume = await page.locator('.notebook-round button').allTextContents()
    if (!buttonsAfterResume.some((label) => label.includes("正在"))) {
      settledTicks = tick
      break
    }
    await page.waitForTimeout(500)
  }
  readings.buttonsAfterResume = buttonsAfterResume
  readings.settledAfterMs = settledTicks >= 0 ? settledTicks * 500 : null
  readings.alertAfterResume = ((await page.locator('.notebook-round [role="alert"]').first().textContent().catch(() => '')) ?? '').trim()
  check('屏上那一块回到进行中形态（那一轮还在、那颗按钮撤了、在途那一格自己清掉了、没有告警句）',
    gone && stillTracked && settledTicks >= 0 && !buttonsAfterResume.includes('继续这一轮') && readings.alertAfterResume === '', {
      gone, stillTracked, settledAfterMs: readings.settledAfterMs, buttons: buttonsAfterResume, alert: readings.alertAfterResume,
    })
  check('停过这件事留在屏上读得到的那一行里（问题没被换掉、也没多一行假状态）',
    stillTracked && buttonsAfterResume.includes('先到这里'), readings.buttonsAfterResume)

  // ── §16.39 那一族的另一条腿：**别处已经推进过这一轮**时，本机这发迟到不许盖掉它 ──
  // 上一段证的是"没人动过 ⇒ 点得动"；这一段证"有人动过 ⇒ 点不动、且不动的是那一份现在的"。
  // 两件事一起才叫"两个窗口恢复的是同一轮"，只测前者会把 CAS 那条路整个漏掉。
  // 形状照 `probe-note-round-conflict.mts`：外部只推 `revision`（句子与状态都不改），
  // 于是本机手里那一版**看起来仍然可用**——这正是最容易静默覆盖的那种漂移。
  // 先把这一轮**停回去**：`phase='paused'` ＋ `paused_at` ＋ 计数器前进一步，
  // 这三件事一起写正是服务端扫描那条路的产物（`advanceRound` 的 pause 就写这些列），
  // 所以这里不是在编一个界面到不了的状态。
  sql(`update note_learning_rounds
         set phase = 'paused', paused_at = now(), revision = revision + 1, updated_at = now()
       where id = '${roundId}' and phase = 'active'`)
  await navToNote(page)
  const reappeared = await waitButton(page, true)
  check('外部把这一轮停回去之后，重进这一篇读得到那颗按钮', reappeared, roundId)
  if (reappeared) {
    // 界面手里那一版**到此不再刷新**：推进计数器必须发生在这一次读之后。
    // 顺序反了就是假绿——界面带着新版点下去会"成功"，CAS 那条路一个字都没测到。
    sql(`update note_learning_rounds set revision = revision + 5, updated_at = now() where id = '${roundId}'`)
    readings.revisionBeforeStaleClick = firstValue(sql(`select revision from note_learning_rounds where id = '${roundId}'`))
    await resumeButton(page).first().click({ timeout: 20_000 })
    await page.waitForTimeout(2_500)
    const rowAfterStale = firstValue(sql(`
      select phase || '/' || revision || '/' || coalesce(resumed_at is not null, false)
        from note_learning_rounds where id = '${roundId}'`))
    readings.rowAfterStaleClick = rowAfterStale
    // 判据两条：状态**没被这发改写**（仍是 paused、revision 还是外部那一个），
    // 且屏上留下一句如实的话（不是"什么都没发生"，也不是把别人的那一版盖掉）。
    check('迟到那一发没改成：库里仍是 paused、revision 还是别处那一个',
      rowAfterStale.startsWith(`paused/${readings.revisionBeforeStaleClick}/`), rowAfterStale)
    const staleAlert = ((await page.locator('.notebook-round [role="alert"]').first().textContent().catch(() => '')) ?? '').trim()
    readings.staleAlert = staleAlert
    check('迟到那一发在屏上有如实的一句（不许装成"已经继续了"）', staleAlert.length > 0, staleAlert)
  }
} catch (error) {
  // 剧本自己没跑完也要先把已得的读数印出来（同刀二那条教训：读数不该被抛掉）。
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  // **只收自己种的那一行**：`countsBefore` 是在"已经过了残留为零那道闸、正要写"那一刻记下的，
  // 所以它非空就等于"本次动过这一篇"。没走到那一步（歧义／残留 ⇒ 拒跑）时一行都不许碰。
  const seeded = noteId.length > 0 && countsBefore !== null
  if (seeded) {
    // 开跑前这一篇的残留是 0，所以这一篇名下的轮次行**全是本次种的**：按 note_id 收，
    // 不赌那句 `RETURNING` 取回得干不干净（取回的是脏值时按 id 删会当场报错、把读数一起带走）。
    sql(`delete from note_learning_rounds where note_id = '${noteId}'`)
    readings.roundsLeftForNote = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
    readings.countsAfter = familyCounts()
    const grew = Object.entries(readings.countsAfter as Record<string, number>)
      .filter(([table, value]) => value !== (countsBefore as Record<string, number>)[table])
      .map(([table, value]) => `${table} ${String((countsBefore as Record<string, number>)[table])}→${String(value)}`)
    check('收尾逐表对照：四张表一行都没涨（回到开跑前那份数）', grew.length === 0, grew)
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
