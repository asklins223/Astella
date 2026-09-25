import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import {
  ARTIFACT_FRAME_SANDBOX,
  artifactFrameMotionMessage,
  artifactFrameUrl
} from '../src/shared/artifact-frame.ts'

/**
 * 隔离展示面的**第二层探针**：在真窗口里打一遍越权语料（39d W4-1 / D4 §7.2）。
 *
 * 为什么非要在真窗口里做：这一层要证的东西（不透明 origin、sandbox 属性、子文档 CSP、
 * 主进程请求闸与导航闸）**没有一样在 jsdom 里存在**。用假 DOM 断言"localStorage 会抛错"
 * 只会测到"我没实现 localStorage"——本仓库反复吃过的假绿就是这个形状。
 *
 * 每一类都配**负对照**（合法产物必须原样跑通：N0 加载并报到、静态分镜步数对得上），
 * 两道闸还各配一次**阳性对照**（先证明计数会动，再把计数读回来）。
 *
 * 跑法：
 *   npm run build
 *   node --experimental-strip-types scripts/probe-artifact-isolation.mts
 *
 * 它自己写夹具产物、自己起 Electron（`AILEARN_ISOLATION_PROBE=1` 下主进程会把两道闸的
 * 计数挂到 globalThis 上），跑完打印一张表，任意一条不过就退出码 1。
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

const artifactId = randomUUID()
const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-artifact-probe-'))
await mkdir(resolve(userDataDir, 'artifacts'), { recursive: true })
await writeFile(resolve(userDataDir, 'artifacts', `${artifactId}.html`), fixtureArtifact(), 'utf8')

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []
/**
 * 台账要引的读数（D4 §3 第 9 条：判据里的数字要能被同一条命令重放出来）。
 * 它只由下面各处**实测**填，不是从别处抄来的摘要。
 */
const readings: Record<string, unknown> = { artifactId }
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
}

const electronApp = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
  env: { ...process.env, AILEARN_ISOLATION_PROBE: '1' }
})

const readCounters = async (): Promise<{ blockedRequests: number; blockedNavigations: number }> =>
  electronApp.evaluate(() => {
    const counters = (globalThis as Record<string, unknown>).__ailearnIsolationProbe as
      | { blockedRequests: number; blockedNavigations: number }
      | undefined
    if (!counters) throw new Error('主进程没有挂上隔离探针计数（AILEARN_ISOLATION_PROBE 没生效？）')
    return counters
  })

try {
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // 宿主侧的监听：**只认 source 是这一个 frame** 的消息（D4 §4.3 的父侧判据），
  // 外加收集主页面自己的 CSP 违反（子 frame 的导航会不会被 frame-src 挡住，只有这里看得到）。
  await page.evaluate(() => {
    const received: Array<Record<string, unknown>> = []
    ;(window as unknown as { __artifactEvents: Array<Record<string, unknown>> }).__artifactEvents = received
    const hostViolations: Array<Record<string, string>> = []
    ;(window as unknown as { __hostViolations: Array<Record<string, string>> }).__hostViolations = hostViolations
    document.addEventListener('securitypolicyviolation', (event) => {
      hostViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI })
    })
    window.addEventListener('message', (event) => {
      const frame = document.getElementById('ailearn-artifact-probe-frame')
      if (!(frame instanceof HTMLIFrameElement)) return
      if (event.source !== frame.contentWindow) {
        received.push({ rejected: true, phase: (event.data as { phase?: string })?.phase })
        return
      }
      received.push({ rejected: false, ...(event.data as Record<string, unknown>) })
    })
  })

  await page.evaluate(({ sandbox, url }) => {
    const frame = document.createElement('iframe')
    frame.id = 'ailearn-artifact-probe-frame'
    frame.setAttribute('sandbox', sandbox)
    frame.style.cssText = 'position:absolute;left:200px;top:200px;width:480px;height:320px'
    frame.src = url
    document.body.appendChild(frame)
  }, { sandbox: ARTIFACT_FRAME_SANDBOX, url: artifactFrameUrl(artifactId) })

  const frame = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = page.frames().find((entry) => entry.url().startsWith('ailearn-app://artifact/'))
      if (candidate) return candidate
      await page.waitForTimeout(100)
    }
    throw new Error('产物 frame 一直没出现（子 frame 的首次加载被拒了？看 __ailearnIsolationProbe.blockedNavigations）')
  })()

  // N0：负对照——合法产物必须原样跑通，并把 ready 报到宿主。
  const fixtureState = await frame.evaluate(() => ({
    stepCount: (window as unknown as { __artifact?: { stepCount?: number } }).__artifact?.stepCount ?? 0,
    hasRoot: Boolean(document.getElementById('ailearn-artifact-root'))
  }))
  check('N0 合法产物加载', fixtureState.stepCount === 3 && fixtureState.hasRoot, fixtureState)

  const hostEvents = await (async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = await page.evaluate(
        () => (window as unknown as { __artifactEvents: Array<Record<string, unknown>> }).__artifactEvents
      )
      if (events.some((entry) => entry.phase === 'ready')) return events
      await page.waitForTimeout(100)
    }
    return []
  })()
  const ready = hostEvents.find((entry) => entry.phase === 'ready')
  check('N0b 宿主收到 ready（source 校验通过）', Boolean(ready), hostEvents.slice(0, 3))

  // CSP 是不是真的套上了：产物策略没有 `'unsafe-eval'`，所以 eval 必须抛 EvalError。
  // 这一条是**别的每一条 T3 判据的前提**——CSP 不在，"被挡"就只是别的东西碰巧在挡
  //（第一轮实测正是这个形状：CSP 没注入，fetch 被请求闸取消，违反事件一条都没有）。
  /**
   * 脚本策略的**对照**（不是"eval 会不会被拒"）：
   *
   * 第一轮这里写的是 `eval`／`new Function`，读数全是 `allowed`——**那是探针自己的错**：
   * Playwright 的 `evaluate` 走 CDP，而 CDP 的求值上下文按设计不受页面 CSP 约束，
   * 在那里调 `eval` 当然放行（连违反事件都不产生）。这类"工具侧绕过"会把
   * "策略根本没生效"读成"策略生效了"。
   *
   * 换成一个真正归文档管的动作：往 DOM 里注入一段内联脚本。
   * 产物策略 `script-src 'unsafe-inline'` ⇒ 该跑；主页面策略（生产构建没有
   * `'unsafe-inline'`）⇒ 该被挡。两边各测一次，才分得开"哪份策略在管这一份文档"。
   */
  const artifactInline = await frame.evaluate(() => {
    const injected = document.createElement('script')
    injected.textContent = 'window.__artifactInlineRan = 1'
    document.body.appendChild(injected)
    return (window as unknown as { __artifactInlineRan?: number }).__artifactInlineRan === 1
      ? 'ran'
      : 'blocked'
  })
  const hostInline = await page.evaluate(() => {
    const injected = document.createElement('script')
    injected.textContent = 'window.__hostInlineRan = 1'
    document.body.appendChild(injected)
    return (window as unknown as { __hostInlineRan?: number }).__hostInlineRan === 1
      ? 'ran'
      : 'blocked'
  })
  check(
    '产物文档用的是产物策略（内联放行），主页面用的是主策略（同一手法被挡）',
    artifactInline === 'ran' && hostInline === 'blocked',
    { artifactInline, hostInline, hostViolations: await page.evaluate(
      () => (window as unknown as { __hostViolations: Array<Record<string, string>> }).__hostViolations
    ) }
  )

  // T1a：读父文档。
  const parentDom = await frame.evaluate(() => {
    try {
      window.parent.document.body.innerHTML
      return 'no-error'
    } catch (error) {
      return (error as Error).name
    }
  })
  check('T1a 读父文档抛 SecurityError', parentDom === 'SecurityError', parentDom)

  // T2a：preload 桥不许出现在产物 frame 里。
  const bridges = await frame.evaluate(() => [
    typeof (window as unknown as { ailearnDesktop?: unknown }).ailearnDesktop,
    typeof (window as unknown as { ailearn?: unknown }).ailearn
  ])
  check('T2a 产物 frame 里没有 IPC 桥', bridges[0] === 'undefined' && bridges[1] === 'undefined', bridges)

  // T3a：外部请求（CSP 先挡；违反事件必须真的记到，且**记的是哪一份策略**要读出来——
  // "有违反"这两个字在主策略与产物策略下都成立，只有 `originalPolicy` 分得开）。
  const externalRequest = await frame.evaluate(async () => {
    const violations: Array<{ directive: string; blockedURI: string; policy: string }> = []
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        policy: event.originalPolicy
      })
    })
    let fetchOutcome = 'resolved'
    try {
      await fetch('https://example.com/probe.json')
    } catch {
      fetchOutcome = 'rejected'
    }
    const image = new Image()
    image.src = 'https://example.com/probe.png'
    await new Promise((resolve) => setTimeout(resolve, 300))
    return {
      violations,
      fetchOutcome,
      policies: [...new Set(violations.map((entry) => entry.policy))]
    }
  })
  check(
    'T3a fetch / 外链图被挡，且记到的是产物策略（不是主页面那份）',
    externalRequest.fetchOutcome === 'rejected' &&
      externalRequest.violations.some((entry) => entry.directive.includes('connect-src')) &&
      externalRequest.violations.some((entry) => entry.directive.includes('img-src')) &&
      externalRequest.policies.some((policy) =>
        policy.includes("connect-src 'none'") && policy.includes("script-src 'unsafe-inline'")),
    externalRequest
  )

  // T4：表单与弹窗。
  const windowsBefore = electronApp.windows().length
  const formAndPopup = await frame.evaluate(() => {
    const form = document.createElement('form')
    form.action = 'https://example.com/submit'
    form.method = 'POST'
    const input = document.createElement('input')
    form.appendChild(input)
    document.body.appendChild(form)
    let formOutcome = 'submitted'
    try {
      form.submit()
    } catch (error) {
      formOutcome = (error as Error).name
    }
    let popup = 'opened'
    try {
      popup = String(window.open('https://example.com/'))
    } catch (error) {
      popup = (error as Error).name
    }
    return { formOutcome, popup }
  })
  await page.waitForTimeout(400)
  check(
    'T4 表单提交与 window.open 都被拦',
    formAndPopup.popup === 'null' && electronApp.windows().length === windowsBefore,
    { ...formAndPopup, windows: electronApp.windows().length }
  )

  // T5：存储（不透明 origin：不是"我们禁了"，是那个 origin 没有存储）。
  const storage = await frame.evaluate(() => {
    const outcome: Record<string, string> = {}
    try {
      window.localStorage.setItem('a', '1')
      outcome.localStorage = 'wrote'
    } catch (error) {
      outcome.localStorage = (error as Error).name
    }
    try {
      document.cookie = 'a=1'
      outcome.cookie = document.cookie
    } catch (error) {
      outcome.cookie = (error as Error).name
    }
    try {
      window.indexedDB.open('probe')
      outcome.indexedDB = 'opened'
    } catch (error) {
      outcome.indexedDB = (error as Error).name
    }
    return outcome
  })
  check(
    'T5 存储 API 不可用（不透明 origin 下三个都抛 SecurityError）',
    storage.localStorage !== 'wrote'
      && storage.indexedDB !== 'opened'
      && (storage.cookie === '' || storage.cookie === 'SecurityError'),
    storage
  )

  // T8：产物里的覆盖层只在它自己的框里有效。
  const overlay = await frame.evaluate(() => {
    const node = document.createElement('div')
    node.id = 'probe-overlay'
    node.setAttribute('style', 'position:fixed;inset:0;background:rgba(255,0,0,0.2)')
    document.body.appendChild(node)
    return document.getElementById('probe-overlay') !== null
  })
  const hostTopLeft = await page.evaluate(() => {
    const element = document.elementFromPoint(4, 4)
    return element ? element.tagName : 'none'
  })
  check('T8 覆盖层出不了 frame（主页面左上角不受影响）', overlay && hostTopLeft !== 'IFRAME', {
    overlay,
    hostTopLeft
  })

  // §5.1：静态分镜——关掉动效后步数不许少。
  const motionSent = await page.evaluate(
    (message) => {
      const frameElement = document.getElementById('ailearn-artifact-probe-frame')
      if (!(frameElement instanceof HTMLIFrameElement) || !frameElement.contentWindow) return false
      frameElement.contentWindow.postMessage(message, '*')
      return true
    },
    artifactFrameMotionMessage('reduced')
  )
  await page.waitForTimeout(400)
  const storyboard = await frame.evaluate(() => ({
    panes: document.querySelectorAll('#ailearn-artifact-root [data-artifact-step]').length,
    stepCount: (window as unknown as { __artifact?: { stepCount?: number } }).__artifact?.stepCount ?? 0
  }))
  check(
    '§5.1 静态分镜步数 == 产物登记步数',
    motionSent && storyboard.panes === storyboard.stepCount && storyboard.panes === 3,
    storyboard
  )

  // ── 子 frame 自导航 ────────────────────────────────────────────────────────
  const delta = (
    before: { blockedRequests: number; blockedNavigations: number; frameNavigateEvents: number },
    after: { blockedRequests: number; blockedNavigations: number; frameNavigateEvents: number }
  ): Record<string, number> => ({
    blockedRequests: after.blockedRequests - before.blockedRequests,
    blockedNavigations: after.blockedNavigations - before.blockedNavigations,
    frameNavigateEvents: after.frameNavigateEvents - before.frameNavigateEvents
  })

  const hostViolations = async (): Promise<Array<Record<string, string>>> =>
    page.evaluate(() => (window as unknown as { __hostViolations: Array<Record<string, string>> }).__hostViolations)

  /**
   * T4b：产物把自己导航到**另一个产物 id**——这一条 `frame-src` 是放行的（host 相同），
   * 所以它是 `will-frame-navigate` 那道闸**唯一能自己作主**的形态：CSP 管不到，
   * 只有"发起者是不是这个 frame 自己"这条判据拦得住。它同时是那道闸的阳性对照。
   */
  const beforeArtifactHop = await readCounters()
  await frame.evaluate(() => {
    try {
      window.location.href = 'ailearn-app://artifact/11111111-2222-4333-8444-555555555555'
    } catch {
      /* 被拦下就是被拦下 */
    }
  })
  await page.waitForTimeout(800)
  const afterArtifactHop = await readCounters()
  readings.navigationGate = {
    selfNavigationToArtifact: delta(beforeArtifactHop, afterArtifactHop),
    eventsSeen: afterArtifactHop.frameNavigateEvents
  }
  check(
    'T4b 产物自导航到另一个产物 id 被拒（闸自己作主的那一发）',
    frame.url().startsWith('ailearn-app://artifact/') &&
      !frame.url().includes('11111111-2222-4333-8444-555555555555') &&
      afterArtifactHop.frameNavigateEvents > beforeArtifactHop.frameNavigateEvents &&
      afterArtifactHop.blockedNavigations > beforeArtifactHop.blockedNavigations,
    { url: frame.url(), delta: delta(beforeArtifactHop, afterArtifactHop) }
  )

  // T3b：外部导航（这一发 frame-src 与请求闸都会管，读的是"哪一层先挡"）。
  const beforeExternal = await readCounters()
  await frame.evaluate(() => {
    try {
      window.location.href = 'https://example.com/'
    } catch {
      /* 同上 */
    }
  })
  await page.waitForTimeout(800)
  const afterExternal = await readCounters()
  readings.externalNavigation = {
    frameUrl: frame.url(),
    delta: delta(beforeExternal, afterExternal),
    hostViolations: await hostViolations()
  }
  check(
    'T3b 产物没能把自己导航到外站',
    !frame.url().startsWith('https://example.com'),
    readings.externalNavigation
  )

  // T1b：把自己导航到主页面 origin（那一份文档带着 preload 桥，是探针要打的那一发）。
  const beforeBundle = await readCounters()
  await frame.evaluate(() => {
    try {
      window.location.href = 'ailearn-app://bundle/index.html'
    } catch {
      /* 同上 */
    }
  })
  await page.waitForTimeout(800)
  const afterBundle = await readCounters()
  readings.bundleNavigation = {
    frameUrl: frame.url(),
    delta: delta(beforeBundle, afterBundle),
    hostViolations: await hostViolations()
  }
  readings.gateCountersAtExit = afterBundle
  check(
    'T1b 产物没能把自己导航到主页面 origin',
    !frame.url().startsWith('ailearn-app://bundle'),
    readings.bundleNavigation
  )
} finally {
  await electronApp.close().catch(() => undefined)
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1

/**
 * 夹具产物：三个步骤 + 违规收集器 + 一个覆盖层。
 * 它刻意**不**温和——探针要证的就是"这样一份产物也出不了自己的框"。
 */
function fixtureArtifact(): string {
  return `<h1>Pareto 前沿</h1>
<div id="ailearn-probe-figure">第 1 步</div>
<div id="probe-overlay"></div>
<script>
window.__artifactViolations = [];
document.addEventListener('securitypolicyviolation', function (event) {
  window.__artifactViolations.push(event.violatedDirective + ' ' + event.blockedURI);
});
window.__artifact = {
  stepCount: 3,
  render: function (step) {
    var root = document.getElementById('ailearn-artifact-root');
    if (!root) return;
    var panes = root.querySelectorAll('[data-artifact-step]');
    if (panes.length > 0) return;
    root.innerHTML = '<figure data-artifact-figure="' + step + '"><figcaption>第 ' + (step + 1) + ' 步：' +
      ['先看约束', '再看取舍', '最后看结论'][step] + '</figcaption></figure>';
  }
};
</script>`
}
