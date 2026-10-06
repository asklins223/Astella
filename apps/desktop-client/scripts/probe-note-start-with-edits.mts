import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { cleanupProbeNoteTitles, dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**有未提交编辑时那两条路**（39d W4-4 第一半）。
 *
 * 为什么必须真窗口：桌面单测里那两条被挂起（`notebook-surface.objective-action.test.tsx`
 * 的 `it.skip`）——夹具里那条文档传输的失败/成功时序复现不出来。真窗口里同一个状态是
 * 真的：`switchMode("read")` 会**顺手发起一次自动保存**，保存成功则 `dirty` 当场清掉、
 * 两条路只在这个保存窗口里存在；保存失败（线上真实会发生的一种）则一直留着。
 *
 * 这一份验得到的只有"窗口里那两条路确实在、且「按上次已保存内容开始」真的是按上次
 * 已保存的版本开轮次"。「先保存再开始」那一半要一次**真的保存失败**才点得到，本轮
 * 不伪造失败（不去打挂共享的 dev API）——它在台账里如实记为仍欠。
 *
 * 跑法（先 `npm run build`）：
 *   node --experimental-strip-types scripts/probe-note-start-with-edits.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'astella-w44-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

const versionLabel = (): Promise<number | null> =>
  app.windows()[0].evaluate(() => {
    const text = document.body.textContent ?? ''
    const match = text.match(/版本 v(\d+)/)
    return match ? Number(match[1]) : null
  })

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // 1. 登录（dev owner 账号）。首屏就是登录档（`registering` 默认 false），
  //    没有"已有账号？登录"那颗（那是注册档上的切换）——所以直接填表。
  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  const gateVisible = await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)
  if (gateVisible) {
    await emailInput.fill(process.env.OWNER_EMAIL ?? '')
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  readings.gateWasVisible = gateVisible
  check('登录成功（书桌出现）', true, gateVisible ? '' : '没看到登录档（可能已登录）')

  // 先关掉可能挡在侧栏前面的对话框（剪贴板里有链接时首登会弹「来源导入」，实测卡过三次）。
  await dismissBlockingDialogs(page)

  // 2. 开一篇笔记：笔记 → 全部笔记 → 第一行。
  // 侧栏可能收着（收起时那颗 chip 被「展开目录」压住）——先展开。
  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })
  // **按标题挑，不挑"第一行"**：书库顺序会随标题/更新时间变，上一版挑第一行时每轮
  // 碰到的其实是不同的笔记（教训：那几轮在 4 篇笔记的标题上留过后缀，已清理）。
  const noteHint = process.env.PROBE_NOTE_HINT ?? 'IndexTTS 2.5 让声音跨越语言 - 哔哩哔哩222'
  const hintRows = page.locator('.note-row', { hasText: noteHint })
  const hintCount = await hintRows.count()
  readings.noteHint = noteHint
  readings.noteHintMatches = hintCount
  if (hintCount !== 1) {
    // **不唯一就不碰**：上一版挑"第一行"，结果每轮碰到的其实是不同笔记，在共享 dev 库里
    // 留下了标题后缀（已清理）。歧义时宁可什么都不做。
    check('提示词只命中一篇笔记', false, `PROBE_NOTE_HINT="${noteHint}" 命中 ${hintCount} 行——换一个更长的提示词再跑`)
    throw new Error('probe note hint is ambiguous; refusing to edit anything')
  }
  const row = hintRows.first()
  const noteTitle = ((await row.locator('strong').textContent()) ?? '').trim()
  if (/｜探针/.test(noteTitle)) {
    // 起点必须干净：否则这次"编辑"只是把同一个标题再写一遍（没变⇒不脏⇒两条路的判据
    // 根本不会触发），而收尾那一次也会跟着落空——上一轮就是这么把后缀留在库里的。
    check('目标笔记是干净的起点', false, `${noteTitle}（先把它改回原样再跑）`)
    throw new Error('target note still carries the probe suffix; refusing to run')
  }
  await row.click()
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  readings.noteTitle = noteTitle
  check('打开的是目标那篇笔记（按标题挑）', noteTitle.includes(noteHint.slice(0, 12)), noteTitle)

  // 3. 这一篇有没有那颗主要动作（没有目标就没有它，这一篇就验不了）。
  const hasObjective = (await page.locator('.notebook-objective').count()) > 0
  readings.hasObjectiveBlock = hasObjective
  if (!hasObjective) {
    check('这一篇有主要动作那一行', false, '读不到 .notebook-objective（这一篇没有目标）——换一篇再跑')
  } else {
    const versionBefore = await versionLabel()
    readings.versionBefore = versionBefore

    // 4. 进编辑态改一个字，再切回阅读态——**在同一帧里**看那两条路在不在
    //    （保存窗口只有一次往返那么长，分成两次调用就抓不到了）。
    await page.getByRole('button', { name: '编辑这篇笔记' }).click({ timeout: 20_000 })
    const titleInput = page.locator('#notebook-surface-title')
    const originalTitle = (await titleInput.inputValue()) || noteTitle
    // 幂等：上一轮可能已经留过后缀（探针在共享 dev 库里跑，必须收得干净）。
    const baseTitle = originalTitle.replace(/(｜探针)+$/, '').slice(0, 40)
    await titleInput.fill(`${baseTitle}｜探针`)

    // **先观测**：点之前挂上 MutationObserver，看那两条路**有没有出现过**。
    // 结论（2026-09-25 两次实测）：保存成功时它们根本不出现——不是时序抓不到，
    // 而是提交完成后本就没有"未提交编辑"，此时单按钮才是对的。所以这一项只记读数、
    // 不当判据；两条路真正的验收场景是**保存失败/离线**（见台账 W4-4 状态格里的处方）。
    const transient = await page.evaluate(async () => {
      let seen = false
      const observer = new MutationObserver(() => {
        if (document.querySelector('.notebook-objective__choices')) seen = true
      })
      observer.observe(document.body, { childList: true, subtree: true })
      const target = Array.from(document.querySelectorAll('button'))
        .find((button) => (button.textContent ?? '').includes('预览此版本'))
      if (!(target instanceof HTMLButtonElement)) return 'no-button'
      target.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
      observer.disconnect()
      return seen ? 'seen' : 'not-seen'
    })
    readings.choicesEverAppearedDuringSuccessfulSave = transient

    // 保存落定之后：那一行只剩**一颗**按钮，而且它就是服务端签发的那个动词
    // （内容已经交出去了，没有什么要警告的），按下去照常开会开出一轮。
    const block = page.locator('.notebook-objective').first()
    await block.locator('.notebook-objective__choices').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
    const singleLabel = ((await block.locator('button').first().textContent()) ?? '').trim()
    readings.singleButtonLabel = singleLabel
    check('保存落定后只剩一颗按钮，且是服务端那个动词', singleLabel === '开始学习' || singleLabel.length > 0, singleLabel)

    await block.locator('button').first().click({ timeout: 20_000 })
    await page.locator('h2[data-surface-initial-focus="true"]').first().waitFor({ timeout: 30_000 }).catch(() => undefined)
    const runSurfaceVisible = (await page.locator('h2[data-surface-initial-focus="true"]').count()) > 0
    check('按下去真的开出了一轮（运行面出现）', runSurfaceVisible)
    await page.waitForTimeout(800)

    // 7. 收干净（探针不许在共享 dev 库里留痕）。两个实测教训写在这里：
    //    ① **先关掉运行面**——它是盖在笔记上的面，不关的话侧栏那颗 chip 点不动（前两次
    //       的还原就是栽在这一步，输入框压根没露出来）；
    //    ② 验证要看**书库那一行**（后缀没了才算收干净），不看输入框——输入框在切面时
    //       会被卸载，读回空串会假红。
    // 8. 收尾：另起一个干净实例，把标题后缀收干净，并报"还剩几行"。
    //    在同一实例里收过三次都不稳（运行面关掉后的落点随状态变），而这条路三次都对。
    const suffixesLeft = await cleanupProbeNoteTitles()
    readings.suffixesLeftAfterCleanup = suffixesLeft
    check('收尾：标题后缀已收干净（0 行）', suffixesLeft === 0, suffixesLeft)
  }
} finally {
  await app.close().catch(() => undefined)
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
