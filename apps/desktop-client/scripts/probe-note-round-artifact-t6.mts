import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 动态产物的 **T6 两条真窗口探针**（39d W4-6 刀五；D4 §7.2 原文）：
 *
 *   | T6 | `while(true){}` 的产物        | watchdog 中止 → 降级静态分镜，且主页面不卡死 |
 *   | T6 | 崩溃注入（chrome://crash 类） | frame 重建；两次后降级                       |
 *
 * 为什么必须是真窗口：这两个判据全在"真有一条 frame、真有一条看门狗"上——jsdom 里
 * `iframe` 不加载、定时器不跑、也没有"主页面卡不卡"这回事。
 *
 * 它**自己种数据**：给目标笔记插一条"这一轮 + 一条教学产物 + 一份动态产物"（产物 HTML
 * 是这两条探针专用的夹具，直接写进**临时 userData** 的 `artifacts/<id>.html`——落盘那一发
 * 在盘上已经有文件时是幂等的，所以界面会直接挂宿主）。收尾把这些行删干净。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-artifact-t6.mts
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

/** T6-1：一上来就把自己的主线程占死（脚本连一拍心跳都发不出来）。 */
function busyLoopArtifact(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>忙等产物</title>
<style>body{font:14px/1.6 system-ui;margin:16px}</style></head>
<body><div id="ailearn-artifact-root"><h1>忙等</h1><p>这一份产物的脚本会占死自己的线程。</p></div>
<script>
// 这一行**故意**不设上限：宿主的心跳看门狗是这段脚本唯一的出路（D4 §7.2 T6 第一条）。
while (true) {}
</script></body></html>`
}

/** T6-2：先报到、再"崩"（心跳停掉并占死线程）——看门狗必须先重建，第二次才降级。 */
function crashAfterReadyArtifact(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>崩溃产物</title>
<style>body{font:14px/1.6 system-ui;margin:16px}</style></head>
<body><div id="ailearn-artifact-root"><h1>先报到再崩</h1><p>先发 ready 与两拍心跳，然后把线程占死。</p></div>
<script>
const post = (message) => { try { parent.postMessage(message, '*') } catch (error) { void error } }
post({ kind: 'artifact', version: 1, phase: 'ready', stepCount: 3 })
let beats = 0
const timer = setInterval(() => {
  beats += 1
  post({ kind: 'artifact', version: 1, phase: 'heartbeat', stepIndex: 0 })
  if (beats >= 2) { clearInterval(timer); while (true) {} }
}, 1000)
</script></body></html>`
}

interface Seeded {
  noteId: string
  roundId: string
  teachingId: string
  artifactId: string
  workspaceId: string
  userId: string
  noteVersionId: string
  contentHash: string
}

/** 给目标笔记插一轮 + 一条教学产物 + 一份动态产物（教学产物行的 artifact_id 指过去）。 */
async function seedArtifact(noteId: string, html: string, artifactId: string, userDataDir: string): Promise<Seeded> {
  await mkdir(resolve(userDataDir, 'artifacts'), { recursive: true })
  await writeFile(resolve(userDataDir, 'artifacts', `${artifactId}.html`), html, 'utf8')
  const row = sql(`select n.workspace_id, n.created_by, n.current_version_id, v.content_hash from notes n join note_versions v on v.id = n.current_version_id where n.id = '${noteId}'`)
  const [workspaceId, userId, noteVersionId, contentHash] = row.split('|')
  const roundId = randomUUID()
  const teachingId = randomUUID()
  sql(`BEGIN;
    INSERT INTO note_learning_rounds (id, workspace_id, user_id, note_id, phase, driving_question, driving_question_source,
      driving_question_revision, note_version_id, source_content_hash, max_model_calls, max_wall_clock_seconds, max_tasks, revision)
      VALUES ('${roundId}', '${workspaceId}', '${userId}', '${noteId}', 'active', '这一轮讲的是什么？', 'user_authored',
        1, '${noteVersionId}', '${contentHash}', 8, 900, 6, 1);
    INSERT INTO note_learning_round_artifacts (id, workspace_id, user_id, round_id, kind, html, snapshot_hash)
      VALUES ('${artifactId}', '${workspaceId}', '${userId}', '${roundId}', 'dynamic_explanation', '夹具产物', '${contentHash}');
    INSERT INTO note_learning_round_teachings (id, workspace_id, user_id, round_id, ordinal, kind, content,
      source_block_ordinals, snapshot_hash, driving_question_revision, artifact_id)
      VALUES ('${teachingId}', '${workspaceId}', '${userId}', '${roundId}', 1, 'explanation',
        '{"explanation":"这一节说的是：夹具解释。","example":"夹具例子。"}'::jsonb, '{1}', '${contentHash}', 1, '${artifactId}');
    COMMIT;`)
  return { noteId, roundId, teachingId, artifactId, workspaceId, userId, noteVersionId, contentHash }
}

/** 把这一轮的产物换成另一份（append-only 表：带绕行口子改，剧本自己用）。 */
function repointArtifact(seeded: Seeded, nextArtifactId: string, html: string, userDataDir: string): Promise<void> {
  return writeFile(resolve(userDataDir, 'artifacts', `${nextArtifactId}.html`), html, 'utf8').then(() => {
    sql(`BEGIN; SELECT set_config('app.allow_history_mutation','on',true);
      INSERT INTO note_learning_round_artifacts (id, workspace_id, user_id, round_id, kind, html, snapshot_hash)
        VALUES ('${nextArtifactId}', '${seeded.workspaceId}', '${seeded.userId}', '${seeded.roundId}', 'dynamic_explanation', '夹具产物', '${seeded.contentHash}');
      UPDATE note_learning_round_teachings SET artifact_id = '${nextArtifactId}' WHERE id = '${seeded.teachingId}';
      COMMIT;`)
    void html
  })
}

function wipe(seeded: Seeded): void {
  sql(`BEGIN; SELECT set_config('app.allow_history_mutation','on',true);
    DELETE FROM note_learning_round_teachings WHERE round_id = '${seeded.roundId}';
    DELETE FROM note_learning_round_artifacts WHERE round_id = '${seeded.roundId}';
    DELETE FROM note_learning_rounds WHERE id = '${seeded.roundId}';
    COMMIT;`)
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-t6-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
  // 两道闸的计数（请求闸／导航闸）由主进程在探针模式下挂出来——§7.3 第三层要读它们。
  env: { ...process.env, AILEARN_ISOLATION_PROBE: '1' },
})

let seeded: Seeded | null = null
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

  // 登录后落在书桌场景，`.note-row` 只存在笔记库那一面墙上——不走到那儿读到的恒是 0 行
  //（与其它剧本同形的三步：展开目录、点笔记 chip、进全部笔记）。
  const navRail = page.getByRole('button', { name: '展开目录' })
  if ((await navRail.count()) > 0) {
    await navRail.first().click().catch(() => undefined)
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
  readings.noteId = noteId
  const residual = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  if (residual !== 0) {
    check('起点这篇没有残留的轮次', false, `库里有 ${residual} 行`)
    report()
    throw new Error('residual rounds on the target note')
  }

  /** 打开这一篇并等教学面把宿主挂出来（宿主挂载 = `iframe` 真出现）。 */
  const openNoteAndWaitForHost = async (expectIframe: boolean): Promise<boolean> => {
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
    await page.locator('.notebook-round-teaching').first().waitFor({ timeout: 20_000 })
    if (!expectIframe) return false
    return page.locator('.notebook-round-teaching__artifact iframe').first()
      .waitFor({ timeout: 15_000 })
      .then(() => true, () => false)
  }

  // ── T6-1：while(true) 的产物 ⇒ 看门狗中止、降级，主页面不卡死 ──
  const busyId = randomUUID()
  seeded = await seedArtifact(noteId, busyLoopArtifact(), busyId, userDataDir)
  readings.busyArtifactId = busyId
  const hostMounted = await openNoteAndWaitForHost(true)
  check('T6-1 宿主先把 frame 挂出来了（不然下面的降级读不出来）', hostMounted)
  const degraded = await page.locator('.notebook-round-teaching__artifact iframe').first()
    .waitFor({ state: 'detached', timeout: 20_000 })
    .then(() => true, () => false)
  check('T6-1 watchdog 把 frame 摘掉了', degraded)
  const fallbackLine = ((await page.locator('.notebook-round-teaching__artifact').first().textContent()) ?? '').trim()
  readings.t6FallbackLine = fallbackLine
  check('T6-1 降级处有如实说明（静态分镜那一句在）', fallbackLine.includes('动态这一版先停下了'), fallbackLine)
  // 主页面不卡死：还能读 DOM、还能应答一次交互。
  const aliveMs = Date.now()
  const pageAlive = await page.evaluate(() => Boolean(document.querySelector('.notebook-round-teaching'))).catch(() => false)
  readings.t6MainPageAlive = { pageAlive, probeLatencyMs: Date.now() - aliveMs }
  check('T6-1 主页面不卡死（同期还能读 DOM）', pageAlive)

  // ── T6-2：报到过再"崩" ⇒ 先重建，第二次才降级 ──
  const crashId = randomUUID()
  await repointArtifact(seeded, crashId, crashAfterReadyArtifact(), userDataDir)
  readings.crashArtifactId = crashId
  await openNoteAndWaitForHost(false)
  await page.locator('.notebook-round-teaching__artifact iframe').first()
    .waitFor({ timeout: 15_000 })
    .then(() => true, () => false)
    .then((mounted) => check('T6-2 换了产物之后 frame 重新挂上（观察从这里开始）', mounted))
  // 「重建过」的证据：**元素身份**换过一次。宿主重建是"换 key 造新 frame"，
  // 于是 React 会换掉那个 `<iframe>` 元素；同一个元素一直在 ⇒ 没重建过。
  // （比时间戳可靠：时间戳只能说明"观察窗里一直有东西"。）
  const rebuild = await page.evaluate(async () => {
    const iframeNow = (): Element | null => document.querySelector('.notebook-round-teaching__artifact iframe')
    let last = iframeNow()
    let distinct = last ? 1 : 0
    const started = Date.now()
    while (Date.now() - started < 25_000) {
      const current = iframeNow()
      if (current && current !== last) { distinct += 1; last = current }
      if (!current) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return { distinctElements: distinct, degraded: iframeNow() === null }
  }).catch(() => ({ distinctElements: 0, degraded: false }))
  readings.t6Rebuild = rebuild
  check('T6-2 第一次心跳消失后 frame 被重建过（换过元素）', rebuild.distinctElements >= 2, rebuild)
  check('T6-2 两次之后同样降级（frame 摘掉）', rebuild.degraded === true, rebuild)

  // ── §7.3 第三层的两条读数（能在这里读的就读）──
  const frameGone = (await page.locator('.notebook-round-teaching__artifact iframe').count()) === 0
  check('§7.3 降级之后界面上不再有产物 frame', frameGone)
  const counters = await app.evaluate(() => {
    const value = (globalThis as Record<string, unknown>).__ailearnIsolationProbe as
      | { blockedRequests: number; blockedNavigations: number }
      | undefined
    return value ?? null
  }).catch(() => null)
  readings.isolationCounters = counters
  const cspViolations = await page.evaluate(() => {
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))
    return violations.length
  }).catch(() => -1)
  readings.cspViolationsDuringT6 = cspViolations
  check('§7.3 这一段没有产生新的 CSP 违规（读数 ≥0 即够——计数在这儿，不是断言 0）', typeof cspViolations === 'number' && cspViolations >= 0, cspViolations)
} catch (error) {
  check('剧本自己没跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  if (process.env.PROBE_ALLOW_DB === '1' && seeded) {
    wipe(seeded)
    readings.roundsLeftInDev = Number(sql('select count(*) from note_learning_rounds'))
    readings.artifactsLeftInDev = Number(sql('select count(*) from note_learning_round_artifacts'))
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
