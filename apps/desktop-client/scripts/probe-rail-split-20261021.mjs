// Real-window check for the 2026-10-21 companion bubble corrections:
//  1) a failed step inside a run must not paint the whole run card as failed
//  2) the reply and the process must be two separate papers
//  3) elapsed time belongs in the reply heading, not under the answer
// It renders the real components in Chromium with the real stylesheet, which is
// the only way to read computed layout for these two papers.
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const out = 'outputs/audit-rail-split-20261021'
mkdirSync(out, { recursive: true })
const report = { checks: [], skipped: [] }
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const entry = `
import { createRoot } from "react-dom/client";
import { CompanionAgentRail } from "./src/renderer/src/components/companion/hud/companion-agent-rail";
const nodes = [
  { key: "tool:1", kind: "tool", label: "正在翻你的笔记", state: "succeeded", toolName: "companion_search_notes", summary: "没有找到与「中国历史朝代历史」相关的笔记", proposalId: null },
  { key: "tool:2", kind: "tool", label: "正在写成笔记", state: "succeeded", toolName: "companion_create_note", summary: "已保存笔记《秦朝统一与中央集权制度》", proposalId: null, noteCreated: { noteId: "n1", noteVersionId: "v1", title: "秦朝统一与中央集权制度" } },
  { key: "tool:3", kind: "tool", label: "正在写成笔记", state: "not_executed", toolName: "companion_create_note", summary: "关联的笔记尚未读取、已经改版或当前不可见。先核对正文，再保存新笔记。", proposalId: null },
  { key: "tool:4", kind: "tool", label: "正在读那篇笔记", state: "succeeded", toolName: "companion_read_note", summary: "已读出《秦朝统一与中央集权制度》", proposalId: null },
  { key: "tool:5", kind: "tool", label: "正在写成笔记", state: "succeeded", toolName: "companion_create_note", summary: "已保存笔记《唐朝的繁荣与由盛转衰》", proposalId: null, noteCreated: { noteId: "n2", noteVersionId: "v2", title: "唐朝的繁荣与由盛转衰" } },
];
function App() {
  return <div className="companion-hud--floating" data-motion="full" data-placement-ready="true" style={{ position: "static" }}>
    <div className="companion-hud__head" style={{ position: "static", width: 434, padding: "0 32px 0 0", maxHeight: "none" }}>
    <div className="companion-hud__exchange">
      <CompanionAgentRail nodes={nodes} progress={{ stepCount: 5, maxSteps: 20, toolCallCount: 5, maxToolCalls: 40, runId: "run-1" }}
        turnState="done" companionName="大肥鱼" />
      <div className="companion-hud__output" data-tone="reply">
        <header className="companion-hud__reply-heading"><strong>给你的话</strong>
          <div className="companion-hud__reply-meta"><span className="companion-run-clock">12 秒</span></div>
        </header>
        <p className="companion-hud__output-body">秦朝统一后先统一度量衡，是为了让赋税征收与工程计量使用同一套尺子。</p>
      </div>
    </div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")).render(<App />);
`

const result = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', jsx: 'automatic', sourcemap: false,
  nodePaths: [resolve('node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ts': 'ts', '.tsx': 'tsx', '.css': 'css' },
})
// Load every stylesheet in the same order the app does (styles.ts is the single
// entry), otherwise base rules such as the `button` reset are missing and native
// Chromium controls appear in the screenshot.
const styleEntry = readFileSync('src/renderer/src/styles.ts', 'utf8')
const styleFiles = [...styleEntry.matchAll(/^import\s+"([^"]+\.css)";/gm)].map(match => match[1])
  .filter(file => file.startsWith('.'))
const css = styleFiles.map(file => readFileSync(resolve('src/renderer/src', file), 'utf8')).join('\n')
console.log(`stylesheets: ${styleFiles.length}`)
const html = `<!doctype html><meta charset="utf-8"><style>
:root{--hud-ink:#3d3229;--hud-soft:#7a6a5b;--hud-paper-light:#fffdf4;--hud-cream:#fbf6e4;--hud-mint:#dcecd9;--hud-green:#4c7a55;--hud-peach:#f6d9c4;--hud-line:#e2dbc6;--hud-sky:#dbe9ee;--hud-paper-deep:#f0e6cf;--hud-clay:#a85243;--hud-shadow-small:0 8px 20px #3d322918;--hud-ease-out:cubic-bezier(.2,.8,.2,1)}
body{margin:0;padding:18px;background:#efe9dc;font-family:"PingFang SC",sans-serif}
#root{width:370px}
</style><style>${css}</style><div id="root"></div><script type="module">${result.outputFiles[0].text}</script>`

const browser = await chromium.launch({ executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium` })
const page = await browser.newPage({ viewport: { width: 520, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
await page.setContent(html)
await page.waitForTimeout(900)

const facts = await page.evaluate(() => {
  const rail = document.querySelector('.companion-hud__rail')
  const output = document.querySelector('.companion-hud__output')
  const railRect = rail.getBoundingClientRect(), outputRect = output.getBoundingClientRect()
  const clock = document.querySelector('.companion-run-clock')
  const clockRect = clock.getBoundingClientRect()
  const heading = document.querySelector('.companion-hud__reply-heading')
  const headingRect = heading.getBoundingClientRect()
  const bodyRect = document.querySelector('.companion-hud__output-body').getBoundingClientRect()
  return {
    railState: rail.dataset.state,
    railBackground: getComputedStyle(rail).backgroundColor,
    railText: rail.querySelector('.companion-hud__rail-current').textContent,
    railGap: Math.round(outputRect.top - railRect.bottom),
    railLeft: Math.round(railRect.left),
    outputLeft: Math.round(outputRect.left),
    railWidth: Math.round(railRect.width),
    outputWidth: Math.round(outputRect.width),
    nameChipWidth: Math.round(heading.querySelector('strong').getBoundingClientRect().width),
    headingWidth: Math.round(headingRect.width),
    toggleButton: (() => {
      const button = [...rail.querySelectorAll('button')].find(item => item.textContent.includes('查看过程'))
      const style = getComputedStyle(button)
      return { background: style.backgroundColor, border: style.borderTopWidth, font: style.fontFamily }
    })(),
    railIsOwnPaper: getComputedStyle(rail).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(rail).borderTopWidth !== '0px',
    outputIsOwnPaper: getComputedStyle(output).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(output).borderTopWidth !== '0px',
    combinedWrapper: Boolean(document.querySelector('.companion-hud__exchange[data-combined]')),
    clockInsideHeading: heading.contains(clock),
    clockAboveBody: clockRect.bottom <= bodyRect.top,
    clockRightOfName: clockRect.left > heading.querySelector('strong').getBoundingClientRect().right,
    clockText: clock.textContent,
    outputText: document.querySelector('.companion-hud__output-body').textContent,
    usesAppFont: getComputedStyle(document.querySelector('.companion-hud__output-body')).fontFamily.includes('Serif'),
  }
})

check('运行已完成时整卡不再进入失败/未执行配色', facts.railState === 'succeeded', `data-state=${facts.railState}`)
check('整卡文案不再说「这项操作没有开始」', !facts.railText.includes('这项操作没有开始'), facts.railText.replace(/\s+/g, ' ').trim())
check('未完成的步骤数仍在整卡上如实可见', facts.railText.includes('1 项未完成'), facts.railText.replace(/\s+/g, ' ').trim())
check('过程与回复是两张独立的纸', facts.railIsOwnPaper && facts.outputIsOwnPaper && !facts.combinedWrapper, `rail bg=${facts.railBackground}, gap=${facts.railGap}px`)
check('两张纸之间保留了间距', facts.railGap >= 8, `${facts.railGap}px`)
check('等待计时在标题行内', facts.clockInsideHeading && facts.clockText === '12 秒', facts.clockText)
check('计时在正文上方、名字右侧', facts.clockAboveBody && facts.clockRightOfName, '')
check('回复正文完整可读', facts.outputText.includes('秦越'.replace('越', '朝')) || facts.outputText.includes('秦朝统一后'), facts.outputText.slice(0, 24))
check('渲染无脚本错误', errors.length === 0, errors.join(' | '))
const rows = await page.evaluate(() => [...document.querySelectorAll('.companion-hud__rail-results button')].map(button => {
  const style = getComputedStyle(button), rect = button.getBoundingClientRect()
  return { text: button.textContent.slice(0, 10), top: Math.round(rect.top), height: Math.round(rect.height), borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth, bg: style.backgroundColor }
}))
console.log('saved rows', JSON.stringify(rows))
check('两张纸左右边缘对齐', Math.abs(facts.railLeft - facts.outputLeft) <= 1 && Math.abs(facts.railWidth - facts.outputWidth) <= 1,
  `rail=${facts.railLeft}/${facts.railWidth}, output=${facts.outputLeft}/${facts.outputWidth}`)
check('名字胶囊不被拉成整条', facts.nameChipWidth < facts.headingWidth * 0.55, `${facts.nameChipWidth}/${facts.headingWidth}px`)
check('「查看过程」不是原生按钮外观', facts.toggleButton.border === '0px' && facts.toggleButton.background === 'rgba(0, 0, 0, 0)', JSON.stringify(facts.toggleButton))

await page.screenshot({ path: `${out}/bubbles.png`, fullPage: true })
writeFileSync(`${out}/report.json`, JSON.stringify({ ...report, facts, errors }, null, 2))
await browser.close()
console.log(`\n${report.checks.filter(item => item.ok).length}/${report.checks.length} checks passed`)
process.exit(report.checks.every(item => item.ok) ? 0 : 1)
