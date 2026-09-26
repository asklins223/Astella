import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**这一轮在别处被改过之后，这一扇窗口拿到的还是现在那一版**（39d W4-5 §16.39 那一族）。
 *
 * 为什么必须真窗口：服务端那一半已经有集测钉过（`stale_revision` 返 409 且**带一份现在那一版**），
 * 但"带回来了"不等于"用户看得见"——渲染层失败之后只做了一件事：把错误写上屏。
 * 这一篇的判据是**用户视角**的那句：换不到现在那一版，她眼前留着的就是**已经被淘汰的那一句**。
 *
 * 怎么在不并发两扇窗口的情况下造出"别处改过"：这台机器上直接改库
 * （`PROBE_ALLOW_DB=1` 才允许，且只改 `note_learning_rounds` 里 `note_id` 等于目标那一篇的行）——
 * 这一发 UPDATE 就是"另一端先交上去的那一次改写"，`revision` 一并前移，
 * 于是本机手里那个 `expectedRevision` 当场过期。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-conflict.mts
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

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

/** 只跑一条 SQL，并把输出原样带回来当读数（本剧本的每一步都可回退：收尾会把那篇的轮次删干净）。 */
const sql = (statement: string): string => {
  const out = execFileSync('docker', ['exec', 'ailearn-dev-postgres-1', 'psql', '-U', 'ailearn', '-d', 'ailearn', '-tAc', statement], {
    encoding: 'utf8',
  })
  return out.trim()
}

/** 标题是从环境里传进来的：这一台子只往**本地 dev 库**发单条语句，带引号或分号的输入一律拒绝。 */
const assertLiteral = (value: string, what: string): string => {
  if (/['";]|--/.test(value)) throw new Error(`${what} 里不许有引号、分号或注释符`)
  return value
}

const NOTE_HINT = assertLiteral(process.env.PROBE_NOTE_HINT as string, 'PROBE_NOTE_HINT')
const STALE_TEXT = '这一句是另一端改过的那一版'

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-39-conflict-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

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
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  const noteTitle = ((await hintRows.first().locator('strong').textContent()) ?? '').trim()
  readings.noteTitle = noteTitle
  await hintRows.first().click()
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })

  const roundBlock = page.locator('.notebook-round').first()
  const lines = async (): Promise<string[]> => (await roundBlock.locator('p.notebook-note').allTextContents()).map((t) => t.trim())
  const preLines = await lines().catch(() => [])
  readings.preexistingRoundLines = preLines
  check('起点没有进行中的轮次（不接着别人的那一轮改）', !preLines.some((line) => line.startsWith('这一轮：')), preLines)
  if (preLines.some((line) => line.startsWith('这一轮：'))) throw new Error('an open round already exists on this note')

  const noteIdLookup = sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`)
  if (noteIdLookup.includes('\n') || noteIdLookup.length === 0) {
    check('这句标题在库里也只对应一篇', false, noteIdLookup)
    throw new Error('exact-title lookup did not resolve to exactly one note')
  }
  const noteId = assertLiteral(noteIdLookup, '查出来的 note_id')
  readings.noteId = noteId

  // 本机先开一轮（走界面，不走 SQL）：这样 `expectedRevision` 是界面自己读到的那一份。
  await page.getByRole('button', { name: '我完全不熟', exact: true }).click({ timeout: 20_000 })
  const input = page.locator('#notebook-round-question')
  const mine = (await input.inputValue()).trim()
  await page.getByRole('button', { name: '开始这一轮', exact: true }).click({ timeout: 20_000 })
  const opened = await page.locator('.notebook-round', { hasText: '这一轮：' }).first()
    .waitFor({ timeout: 25_000 }).then(() => true, () => false)
  readings.localLinesAfterOpen = await lines()
  check('本机先真的开出了一轮', opened && readings.localLinesAfterOpen.includes(`这一轮：${mine}`), readings.localLinesAfterOpen)

  // 「别处改过」：直接改库——句子换掉、revision 前移，本机手里那份当场过期。
  const bumped = sql(`update note_learning_rounds
                        set driving_question = '${STALE_TEXT}', driving_question_revision = driving_question_revision + 1,
                            revision = revision + 4, updated_at = now()
                      where note_id = '${noteId}'
                    returning revision`)
  readings.revisionAfterRemoteEdit = bumped
  readings.remoteEditApplied = Number(bumped.split('\n')[0] ?? '0')
  if (Number(bumped.split('\n')[0] ?? '0') < 5) throw new Error('the remote edit did not land; the conflict cannot be produced')

  // 界面上什么都不知道：她按原来的那一版继续改。
  await page.getByRole('button', { name: '换一个问题', exact: true }).click({ timeout: 20_000 })
  const edit = page.locator('#notebook-round-question')
  await edit.waitFor({ timeout: 20_000 })
  const stalePrefill = (await edit.inputValue()).trim()
  readings.stalePrefill = stalePrefill
  await edit.fill(`${stalePrefill.slice(0, 10)}，本机这一发是迟到的`)
  await page.locator('.notebook-round button.primary').first().click({ timeout: 20_000 })
  await page.waitForTimeout(2_500)

  const afterConflict = await lines()
  const alertText = ((await roundBlock.locator('[role="alert"]').first().textContent().catch(() => '')) ?? '').trim()
  const lostText = ((await roundBlock.locator('[data-round-lost]').first().textContent().catch(() => '')) ?? '').trim()
  const openLine = ((await roundBlock.locator('[data-round-open-line]').first().textContent().catch(() => '')) ?? '').trim()
  readings.linesAfterConflict = afterConflict
  readings.alertAfterConflict = alertText
  readings.lostLineAfterConflict = lostText
  const staleSentence = `${stalePrefill.slice(0, 10)}，本机这一发是迟到的`
  // 这一条原来写的是"屏上不许留本机那句"（整块判断）。§16.39 要的是两件一起成立：
  // **那一行**不许说作废的话，而那一句本身必须还在屏上——所以判据收到那一格上，
  // 整块的反向判断留着会继续钉住一个合同不要的行为（顶掉草稿与拼进新版本是同一种画法）。
  check('那一行不带本机那句（它只说现在的事实）',
    !openLine.includes('本机这一发是迟到的') && openLine === `这一轮：${STALE_TEXT}`, openLine)
  check('她交出去那一句明确留在屏上（§16.39「保留为冲突」）',
    lostText === `这一句没有交上去，先替你留着：${staleSentence}`, lostText)
  // 这一条是本剧本要钉的产品判据：失败之后屏上留下的**应该是服务端现在那一版**，
  // 不是本机那份已被淘汰的草稿（只写一句"失败了"，她眼前还是一句已经不作数的问题）。
  check('失败之后屏上换成服务端现在那一版',
    afterConflict.includes(`这一轮：${STALE_TEXT}`),
    { nowShown: afterConflict, alert: alertText })

  // 第三腿：「把这一句改到新版本上」——句子回输入框、那一行收掉；服务端那一行不动。
  await page.getByRole('button', { name: '把这一句改到新版本上', exact: true }).click({ timeout: 20_000 })
  await page.waitForTimeout(600)
  const reopened = page.locator('#notebook-round-question')
  await reopened.waitFor({ timeout: 20_000 })
  readings.reappliedValue = (await reopened.inputValue()).trim()
  readings.lostLineAfterReapply = ((await roundBlock.locator('[data-round-lost]').count()) ?? 0)
  check('那一句交回她手上：输入框里就是她原来打的那句',
    (await reopened.inputValue()).trim() === staleSentence, readings.reappliedValue)
  check('改到新版本上之后那一行收掉（不留两份）',
    readings.lostLineAfterReapply === 0, readings.lostLineAfterReapply)
} finally {
  await app.close().catch(() => undefined)
  // 收尾：这一篇的轮次全部撤掉（探针不在共享 dev 库里留痕），并复量到 0。
  if (typeof readings.noteId === 'string' && readings.noteId.length === 36) {
    const removed = sql(`delete from note_learning_rounds where note_id = '${readings.noteId}' returning id`)
    // 只数 uuid 那一形状：psql 还会在行尾多打一条命令状态（`DELETE n`），把它算进去就是假的"留痕数"。
    // 这个数是**这一篇名下**清掉的行数——别的剧本（如那张表单的剧本）在同一篇上留下的也会一起被清，
    // 所以它不等于"本剧本写了几行"。真正的判据是最后那一个 `rowsLeft`。
    readings.rowsRemoved = removed.split('\n').filter((line) => /^[0-9a-f-]{36}$/.test(line.trim())).length
  }
  readings.rowsLeft = sql('select count(*) from note_learning_rounds')
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
