/*
 * 渲染后端 A/B 实测（呈现层判据版，2026-10-09）。
 *
 * 上一版用两把尺子，都不够用：
 * - 帧字节数骤降判「空白帧」：被自己的正对照判了无效——人为把整张纸藏掉都抓不到。
 * - rAF 帧间隔：这台机器 144Hz，滚动由合成线程驱动，两种后端都是中位 6.9ms、0 次掉帧。
 *   它测不到「图块还没栅格化就先呈现平色/空白」，而那正是「像全局刷新了一次」和「很卡」。
 *
 * 现在对真实合成帧（`Page.startScreencast`）在页面里解码成 256x144 灰度，逐帧统计：
 * - `uniform`：最大一色块占画面的比例。纸面画满时不会有大片平色，图块缺失时会有。
 * - `jump`：与上一帧的平均亮度差。整屏剧变对应「全局刷新一下」。
 * 仪器自己先过关：跑一趟「人为把整张纸藏 140ms」的正对照，抓不到就判定判据无效，
 * 本次所有 0 值都不作为证据。rAF 间隔继续采，但只作为「主线程有没有被拖住」的辅证。
 *
 * 顺带压一趟 3D 上下文（`perspective/transform-style` 全压平）：常驻的 `preserve-3d`
 * 书房场景在每个页面都保持整窗合成，这笔代价与后端选择无关，本来就该单独量出来。
 *
 * 用法：npm run build && node scripts/measure-rendering-backend-cost.mjs
 *   ASTELLA_MEASURE_MODES=default,compatible  ASTELLA_MEASURE_TICKS=40
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { resolve, join } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(appRoot, 'outputs/rendering-backend-cost-20261009')
mkdirSync(outDir, { recursive: true })
const notesPath = join(outDir, 'notes.md')
writeFileSync(notesPath, `# 渲染后端 A/B（呈现层判据）${new Date().toISOString()}\n\n`, 'utf8')
const log = (line) => { console.log(line); appendFileSync(notesPath, `${line}\n`, 'utf8') }

const modes = (process.env.ASTELLA_MEASURE_MODES ?? 'default,compatible').split(',')
const ticks = Number(process.env.ASTELLA_MEASURE_TICKS ?? 40)
const step = Number(process.env.ASTELLA_MEASURE_STEP ?? 260)
const dwell = Number(process.env.ASTELLA_MEASURE_DWELL ?? 33)
// 窗口尺寸是可以自己长的变量：Ganesh 的代价按像素面积涨，用户日常用的窗口比 1440x810 宽得多。
const [width, height] = (process.env.ASTELLA_MEASURE_SIZE ?? '1440x810').split('x').map(Number)
const rendererPort = process.env.ASTELLA_MEASURE_RENDERER_PORT ?? '5211'
const email = process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local'
const password = process.env.ASTELLA_PROBE_PASSWORD ?? 'probe-c37bpcz4'

const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))

/** 逐帧解码统计。必须在页面里做：Node 这边没有图像解码器。 */
const analyseFrames = async (frames) => {
  const width = 256, height = 144;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];
  let previous = null;
  for (const base64 of frames) {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const data = context.getImageData(0, 0, width, height).data;
    const luma = new Float32Array(width * height);
    const buckets = new Map();
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      const value = Math.round((data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) / 8) * 8;
      luma[index] = value;
      buckets.set(value, (buckets.get(value) ?? 0) + 1);
    }
    let modalCount = 0;
    for (const count of buckets.values()) if (count > modalCount) modalCount = count;
    const uniform = Math.round((modalCount / (width * height)) * 1000) / 10;
    let jump = 0;
    if (previous) {
      let sum = 0;
      for (let index = 0; index < luma.length; index += 4) sum += Math.abs(luma[index] - previous[index]);
      jump = Math.round((sum / (luma.length / 4)) * 10) / 10;
    }
    previous = luma;
    out.push({ uniform, jump });
  }
  return out;
}


/**
 * GPU / 渲染进程侧的 CPU 时间。前面所有尺子都是主线程的，而「所有操作都慢、像慢动作」
 * 最可能出在合成与栅格化那一侧——不采进程 CPU 就永远看不见它。
 */
const processCpu = async (rootPid) => {
  const { stdout } = await execFileAsync('/bin/ps', ['-eo', 'pid=,ppid=,time=,args='])
  const rows = stdout.split('\n').map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length >= 4)
  const children = rows.filter((cells) => Number(cells[1]) === rootPid)
  const seconds = (clock) => {
    const parts = clock.split(':').map(Number)
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
  }
  const pick = (needle) => children.find((cells) => cells.slice(3).join(' ').includes(needle))
  const gpu = pick('--type=gpu-process')
  const renderer = children.filter((cells) => cells.slice(3).join(' ').includes('--type=renderer'))
    .reduce((best, cells) => (best && seconds(best[2]) >= seconds(cells[2]) ? best : cells), null)
  const sum = children.reduce((total, cells) => total + seconds(cells[2]), 0)
  return {
    gpuSeconds: gpu ? seconds(gpu[2]) : 0,
    rendererSeconds: renderer ? seconds(renderer[2]) : 0,
    treeSeconds: sum,
    children: children.length,
  }
}

async function runMode(mode) {
  // 两个后端共用同一个持久 profile：只有首次跑要登录，之后每趟从同一个已进场状态出发，
  // 后端是唯一变量。
  const profile = resolve(outDir, 'profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'desktop-rendering.json'), JSON.stringify({ version: 1, mode }), { mode: 0o600 })
  // 每趟都重新登录：存下来的会话可能撞上「工作区已更新，请同步」那道重认证门，
  // 那时候窗口既没有书房也没有登录表单，采集会莫名起跑失败。
  rmSync(join(profile, 'session-credential-local-v1.txt'), { force: true })

  const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: Number(rendererPort), strictPort: true } })
  await server.listen()
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=0'],
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${rendererPort}` },
    executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  })
  try {
    const page = await app.firstWindow()
    try {
      await page.waitForFunction(
        () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate')),
        undefined, { timeout: 90_000 },
      )
    } catch {
      await page.screenshot({ path: join(outDir, `no-entry-${mode}.png`) }).catch(() => {})
      const scene = await page.evaluate(() => ({
        url: location.href.slice(0, 50),
        hudPage: document.querySelector('.desktop-app')?.dataset.hudPage ?? null,
        surfaceOpen: document.querySelector('.desktop-app')?.dataset.surfaceOpen ?? null,
        text: (document.body.innerText ?? '').slice(0, 200),
        consoleTail: window.__bootErrors ?? null,
      })).catch((error) => ({ evaluateFailed: String(error).slice(0, 120) }))
      log(`✗ ${mode} 起跑就没见到书房或登录门：${JSON.stringify(scene)}`)
      throw new Error('no entry surface')
    }
    // 重认证门那种「再试一次」的落点也走一遍，避免把仪器的一次抖动当成结论。
    for (let attempt = 0; attempt < 3 && !(await page.locator('.desktop-access-gate input[type="email"]').count()); attempt += 1) {
      const retry = page.getByRole('button', { name: '再试一次' })
      if (!(await retry.count())) break
      await retry.first().click({ force: true }).catch(() => {})
      await page.waitForTimeout(2500)
    }
    if (await page.locator('.desktop-access-gate').count()) {
      await page.locator('.desktop-access-gate input[type="email"]').fill(email)
      await page.locator('.desktop-access-gate input[type="password"]').first().fill(password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.waitForSelector('.hud-rail', { timeout: 90_000 })
    }
    await page.screenshot({ path: join(outDir, `home-${mode}.png`) }).catch(() => {})
    // 这段跑在主进程里，尺寸只能当参数传进去。
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(size.width, size.height)
      window.show()
      window.focus()
    }, { width, height })

    // 轨道条目会被伴星气泡与覆盖层拦住 pointer events，Playwright 的 click 会一直重试。
    // 采的是渲染代价不是点击可达性，所以直接触发 DOM。
    const click = async (matcher, { exact = false } = {}) => {
      const hit = await page.evaluate(({ matcher, exact }) => {
        const nodes = [...document.querySelectorAll('button, a[href], [role="button"]')]
        const labeled = (node) => `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`.trim()
        const found = nodes.find((node) => exact
          ? (node.getAttribute('aria-label') ?? '').trim() === matcher
          : labeled(node).includes(matcher))
        if (!found) return null
        found.click()
        return labeled(found).slice(0, 28)
      }, { matcher, exact })
      if (hit) log(`  点了「${hit}」`)
      return Boolean(hit)
    }
    if (!(await page.evaluate(() => Boolean(document.querySelector('.notebook-desk__scroll'))))) {
      await click('展开目录', { exact: true })
      await page.waitForTimeout(900)
      await click('笔记', { exact: true })
      await page.waitForTimeout(3500)
      // 名下有笔记就打开它；探测账号可能一篇都没有，那就新建一篇——
      // 采集要的是真实纸面（desk / 滚动容器 / 模糊层 / 伴星画布），内容随后注入。
      for (const matcher of ['打开笔记', '新建笔记']) {
        if (await page.evaluate(() => Boolean(document.querySelector('.notebook-desk__scroll')))) break
        await click(matcher)
        await page.waitForTimeout(3000)
      }
    }
    if (!(await page.locator('.notebook-desk__scroll').count())) {
      await page.screenshot({ path: join(outDir, `stuck-${mode}.png`) }).catch(() => {})
      const scene = await page.evaluate(() => ({
        hudPage: document.querySelector('.desktop-app')?.dataset.hudPage ?? null,
        text: (document.querySelector('.hud-surface')?.innerText ?? document.body.innerText).slice(0, 240),
      }))
      log(`✗ ${mode} 没进到有正文的笔记页：${JSON.stringify(scene)}`)
      throw new Error('note desk unreachable')
    }
    await page.waitForTimeout(2000)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Page.enable')

    const content = await page.evaluate(() => {
      const paper = document.querySelector('.notebook-desk__page')
      paper.querySelectorAll('[data-cost-probe]').forEach((node) => node.remove())
      const make = (tag, text) => {
        const node = document.createElement(tag)
        node.setAttribute('data-cost-probe', 'true')
        node.textContent = text
        return node
      }
      for (let index = 0; index < 20; index += 1) {
        paper.append(make('h2', `小节 ${index + 1}`), make('p', '用来撑高纸面的正文，滚动经过表格边界时最容易看到整屏重画。'.repeat(5)))
      }
      for (let block = 0; block < 3; block += 1) {
        const table = document.createElement('table')
        table.setAttribute('data-cost-probe', 'true')
        table.style.width = '100%'
        table.style.borderCollapse = 'collapse'
        const head = table.insertRow()
        for (let column = 0; column < 6; column += 1) head.insertCell().textContent = `列 ${column + 1}`
        for (let row = 0; row < 40; row += 1) {
          const line = table.insertRow()
          for (let column = 0; column < 6; column += 1) line.insertCell().textContent = `第 ${row + 1} 行 · 格 ${column + 1}`
        }
        paper.append(table)
      }
      return { scrollHeight: document.querySelector('.notebook-desk__scroll').scrollHeight, cells: paper.querySelectorAll('td, th').length }
    })

    /** 合成层清单：多少个整窗尺寸的层，各自为什么被提升。 */
    const devicePixels = await page.evaluate(() => devicePixelRatio ** 2)
    const layerStats = async () => {
      let snapshot = null
      const onTree = (event) => { if (event.layers) snapshot = event.layers }
      await cdp.send('LayerTree.enable')
      cdp.on('LayerTree.layerTreeDidChange', onTree)
      await new Promise((done) => setTimeout(done, 900))
      cdp.off('LayerTree.layerTreeDidChange', onTree)
      try { await cdp.send('LayerTree.disable') } catch { /* 关不掉不影响计数 */ }
      const all = snapshot ?? []
      const full = all.filter((layer) => layer.width * layer.height > 1200 * 700 * devicePixels)
      const reasons = new Map()
      for (const layer of full.slice(0, 24)) {
        try {
          const answer = await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId })
          for (const reason of answer.compositingReasons ?? []) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
        } catch { /* 层可能已重建 */ }
      }
      return { total: all.length, fullWindow: full.length, reasons: Object.fromEntries(reasons) }
    }


    /**
     * 直接打 Skia 绘制路径的微基准：rAF 节奏测不出两个后端的差别（合成线程驱动的滚动
     * 在 144Hz 上总是 6.9ms），但 2D canvas 的模糊、文本与位图拷贝都是 Skia 干的活，
     * Graphite 与 Ganesh 在这里会分开。每项跑固定轮次取总耗时。
     */
    const paintCost = async () => page.evaluate(async () => {
      const time = (label, runs, work) => {
        const started = performance.now()
        for (let index = 0; index < runs; index += 1) work()
        const elapsed = performance.now() - started
        return { label, runs, ms: Math.round(elapsed * 10) / 10, msPerRun: Math.round((elapsed / runs) * 100) / 100 }
      }
      const size = 900
      const canvas = new OffscreenCanvas(size, size)
      const context = canvas.getContext('2d')
      const source = new OffscreenCanvas(size, size)
      const sourceContext = source.getContext('2d')
      sourceContext.fillStyle = '#f6f1e2'
      sourceContext.fillRect(0, 0, size, size)
      for (let row = 0; row < 40; row += 1) {
        sourceContext.fillStyle = row % 2 ? '#c9d6b4' : '#7f9a72'
        sourceContext.fillRect(0, row * 22, size, 12)
      }
      const bitmap = source.transferToImageBitmap()
      const output = {}
      const flush = () => context.getImageData(0, 0, 1, 1)
      output.blur = time('canvas filter blur', 40, () => {
        context.filter = 'blur(18px)'
        context.drawImage(bitmap, 0, 0)
        context.filter = 'none'
        flush()
      }).msPerRun
      output.text = time('canvas fillText 200 行', 20, () => {
        context.clearRect(0, 0, size, size)
        context.font = '15px sans-serif'
        for (let row = 0; row < 200; row += 1) context.fillText('滚动经过表格边界时最容易看到整屏重画', 8, 12 + row * 4)
        flush()
      }).msPerRun
      output.blit = time('canvas drawImage 全屏', 60, () => {
        context.drawImage(bitmap, 0, 0)
        flush()
      }).msPerRun
      // CSS 模糊层重绘：backdrop-filter 是这个界面的主要合成负担。
      const host = document.createElement('div')
      host.setAttribute('data-cost-probe', 'true')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;backdrop-filter:blur(22px) saturate(1.2);background:rgba(255,255,255,0.02)'
      document.body.append(host)
      const cssBlur = await new Promise((resolve) => {
        const stamps = []
        let previous = performance.now()
        let frames = 0
        const tick = (now) => {
          stamps.push(now - previous)
          previous = now
          frames += 1
          if (frames < 30) requestAnimationFrame(tick)
          else resolve(stamps.slice(4).sort((a, b) => a - b)[Math.floor((stamps.length - 4) / 2)])
        }
        requestAnimationFrame(tick)
      })
      host.remove()
      output.cssBackdropBlurFrameMs = Math.round(cssBlur * 10) / 10
      return output
    })

    const before = await layerStats()
    log(`· ${mode}：内容高 ${content.scrollHeight}px / 表格单元格 ${content.cells}；合成层 ${before.total}，整窗级 ${before.fullWindow}，原因 ${JSON.stringify(before.reasons)}`)

    const runs = []
    for (const condition of ['positive-control', 'scroll', 'scroll-no3d']) {
      const frames = []
      const onFrame = (event) => {
        frames.push(event.data)
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
      }
      const cpuBefore = condition === 'scroll' ? await processCpu(app.process().pid) : null
      cdp.on('Page.screencastFrame', onFrame)
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 1024 })
      await page.waitForTimeout(300)
      const mainThread = await page.evaluate(async ({ ticks, condition, step, dwell }) => {
        const scroll = document.querySelector('.notebook-desk__scroll')
        scroll.scrollTop = 0
        if (condition === 'scroll-no3d') {
          const style = document.createElement('style')
          style.id = 'flatten-3d'
          style.textContent = '*, *::before, *::after { perspective: none !important; transform-style: flat !important; }'
          document.head.append(style)
        } else document.getElementById('flatten-3d')?.remove()
        const deltas = []
        let last = performance.now()
        let stop = false
        const tick = (now) => {
          if (stop) return
          deltas.push(Math.round((now - last) * 10) / 10)
          last = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        for (let index = 0; index < ticks; index += 1) {
          scroll.scrollTop += step
          if (condition === 'positive-control' && index === Math.floor(ticks / 2)) {
            // 对仪器自己的考卷：让整个窗口真的变平一块（不是只藏掉纸面——纸面只占画面
            // 一小块，藏掉它平色占比几乎不动，上一版就是这么漏掉对照的）。
            const app = document.querySelector('.desktop-app')
            app.style.outline = ''
            app.style.setProperty('background', '#ffffff', 'important')
            for (const child of Array.from(app.children)) {
              child.dataset.costHidden = child.style.visibility
              child.style.visibility = 'hidden'
            }
            await new Promise((done) => setTimeout(done, 220))
            for (const child of Array.from(app.children)) {
              child.style.visibility = child.dataset.costHidden ?? ''
              delete child.dataset.costHidden
            }
            app.style.removeProperty('background')
          }
          await new Promise((done) => setTimeout(done, dwell))
        }
        stop = true
        return deltas
      }, { ticks, condition, step, dwell })
      await page.waitForTimeout(250)
      await cdp.send('Page.stopScreencast')
      cdp.off('Page.screencastFrame', onFrame)

      const cpuAfter = condition === 'scroll' ? await processCpu(app.process().pid) : null
      const analysed = await page.evaluate(analyseFrames, frames)
      const uniforms = analysed.map((entry) => entry.uniform).sort((a, b) => a - b)
      const jumps = analysed.map((entry) => entry.jump).filter((value) => value > 0).sort((a, b) => a - b)
      const medianUniform = uniforms[Math.floor(uniforms.length / 2)] ?? 0
      const medianJump = jumps[Math.floor(jumps.length / 2)] ?? 0
      const ascending = mainThread.filter((value) => value > 0 && value < 500).sort((a, b) => a - b)
      const summary = {
        condition,
        window: `${width}x${height}`,
        frames: analysed.length,
        medianUniform,
        p95Uniform: uniforms[Math.floor(uniforms.length * 0.95)] ?? 0,
        maxUniform: uniforms.at(-1) ?? 0,
        // 平色比例比这一趟中位数高出一大截：图块没画出来时就是这样。
        blankFrames: analysed.filter((entry) => entry.uniform > medianUniform + 20).length,
        medianJump,
        maxJump: jumps.at(-1) ?? 0,
        // 与上一帧平均亮度剧变：对应「整屏像刷新了一次」。
        globalJumps: analysed.filter((entry) => entry.jump > Math.max(10, medianJump * 4)).length,
        rafMedianMs: ascending[Math.floor(ascending.length / 2)] ?? 0,
        rafOver34ms: ascending.filter((value) => value > 34).length,
      }
      log(`· ${mode} / ${condition}: 帧 ${summary.frames} · 平色 中位 ${summary.medianUniform}% p95 ${summary.p95Uniform}% 峰值 ${summary.maxUniform}% · 空白帧 ${summary.blankFrames} · 剧变 中位 ${summary.medianJump} 峰值 ${summary.maxJump} · 整屏剧变帧 ${summary.globalJumps} · rAF 中位 ${summary.rafMedianMs}ms >34ms ${summary.rafOver34ms}`)
      if (condition === 'scroll-no3d') {
        const after = await layerStats()
        summary.layersAfterFlatten = after
        log(`  ${mode} 压平 3D 后：合成层 ${after.total}，整窗级 ${after.fullWindow}（压平前 ${before.fullWindow}）`)
      }
      if (cpuBefore && cpuAfter) {
        summary.cpu = {
          gpuSeconds: Math.round((cpuAfter.gpuSeconds - cpuBefore.gpuSeconds) * 100) / 100,
          rendererSeconds: Math.round((cpuAfter.rendererSeconds - cpuBefore.rendererSeconds) * 100) / 100,
          treeSeconds: Math.round((cpuAfter.treeSeconds - cpuBefore.treeSeconds) * 100) / 100,
        }
        log(`  ${mode} / ${condition} 进程 CPU（这一趟滚动）: GPU ${summary.cpu.gpuSeconds}s · 渲染 ${summary.cpu.rendererSeconds}s · 整棵进程树 ${summary.cpu.treeSeconds}s`)
      }
      summary.paint = await paintCost()
      log(`  ${mode} / ${condition} 绘制路径: canvas 模糊 ${summary.paint.blur}ms/次 · fillText200 行 ${summary.paint.text}ms/次 · 整屏位图拷贝 ${summary.paint.blit}ms/次 · 全屏背景模糊层下帧间隔 ${summary.paint.cssBackdropBlurFrameMs}ms`)
      runs.push(summary)
      writeFileSync(join(outDir, `stats-${mode}-${condition}.json`), JSON.stringify(analysed), 'utf8')
      await page.evaluate(() => { document.getElementById('flatten-3d')?.remove() })
    }

    const control = runs.find((run) => run.condition === 'positive-control')
    // 对照的「整屏变平」在画面里表现为剧变值与平色占比同时跳高；用相对倍数判定，
    // 绝对阈值会被窗口里其余还亮着的区域压住（实测峰值 44.4%）。
    const baseline = runs.find((run) => run.condition === 'scroll')
    const instrumentValid = control.maxJump > Math.max(20, (baseline?.medianJump ?? 0) * 3) && control.maxUniform > control.medianUniform + 15
    log(instrumentValid
      ? `✓ ${mode} 正对照抓到整屏变平（平色峰值 ${control.maxUniform}%），这一趟的帧统计判据可用`
      : `✗ ${mode} 正对照没拉开（剧变峰值 ${control.maxJump} 对滚动中位 ${baseline?.medianJump}，平色 ${control.medianUniform}% → ${control.maxUniform}%），本次所有 0 值都不作为证据`)

    const trace = readFileSync(join(profile, 'boot-trace.log'), 'utf8').split('\n').filter((line) => line.includes('rendering-runtime')).at(-1) ?? ''
    return {
      mode,
      instrumentValid,
      backend: /"backend":"([^"]+)"/.exec(trace)?.[1] ?? null,
      graphite: /"skia_graphite":"([^"]+)"/.exec(trace)?.[1] ?? null,
      contentHeight: content.scrollHeight,
      layersBefore: before,
      runs,
    }
  } finally {
    await app.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

const results = []
for (const mode of modes) results.push(await runMode(mode))
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1), 'utf8')
log('\n## 汇总')
for (const entry of results) {
  const scroll = entry.runs.find((run) => run.condition === 'scroll')
  const no3d = entry.runs.find((run) => run.condition === 'scroll-no3d')
  log(`- ${entry.mode}（${entry.backend}，判据${entry.instrumentValid ? '有效' : '无效'}）：整窗层 ${entry.layersBefore.fullWindow}/${entry.layersBefore.total}；滚动 平色中位 ${scroll?.medianUniform}% 峰值 ${scroll?.maxUniform}% 空白帧 ${scroll?.blankFrames} 整屏剧变 ${scroll?.globalJumps} rAF ${scroll?.rafMedianMs}ms · GPU ${scroll?.cpu?.gpuSeconds}s 渲染 ${scroll?.cpu?.rendererSeconds}s 进程树 ${scroll?.cpu?.treeSeconds}s；压平 3D 后整窗层 ${no3d?.layersAfterFlatten?.fullWindow}、空白帧 ${no3d?.blankFrames}、整屏剧变 ${no3d?.globalJumps}`)
}
log(`✓ 证据在 ${outDir}`)
