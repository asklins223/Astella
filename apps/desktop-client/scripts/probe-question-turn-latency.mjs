// 伴星问题轮的真实端到端探针：打开气泡轻聊 → 依次发送问题 → 用库内事件判定完成。
// 用法：
//   node scripts/probe-question-turn-latency.mjs peek [port]
//   node scripts/probe-question-turn-latency.mjs send [port]
// 计时口径以 companion_stream_events / companion_turn_runs 为准（服务端时间戳），
// 脚本自身只负责发送与等待，不把 DOM 时刻当判据。
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const mode = process.argv[2] ?? 'peek'
const port = process.argv[3] ?? '9222'
const repoRoot = resolve(import.meta.dirname, '../../..')

const psql = sql => execFileSync('docker', ['compose', '-f', 'docker-compose.dev.yml', 'exec', '-T', 'postgres',
  'sh', '-lc', `psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F '|' -c "${sql.replaceAll('"', '\\"')}"`],
  { cwd: repoRoot, encoding: 'utf8' }).trim()

const questions = (process.env.PROBE_QUESTIONS ?? [
  '请用一句话解释为什么白天的天空呈蓝色，并提到瑞利散射。',
  '请用两句话说明冰块为什么能浮在水面上。',
  '请用一句话解释月亮为什么有时白天也能看见。',
].join('\n')).split('\n').filter(Boolean)

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)

if (mode === 'peek') {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const url = page.url()
      if (!url.includes('localhost') && !url.includes('astella-app')) continue
      const info = await page.evaluate(() => ({
        presence: Boolean(document.querySelector('.companion-presence')),
        hud: Boolean(document.querySelector('.hud-rail')),
        gate: Boolean(document.querySelector('.desktop-access-gate')),
        textarea: Boolean(document.querySelector('textarea')),
        placeholder: document.querySelector('textarea')?.placeholder ?? null,
        bodyHead: document.body.innerText.slice(0, 160).replace(/\n+/g, ' | '),
      })).catch(error => ({ error: String(error).slice(0, 120) }))
      console.log(JSON.stringify({ url, ...info }, null, 1))
    }
  }
}

if (mode === 'send') {
  const pages = browser.contexts().flatMap(ctx => ctx.pages())
  const page = pages.find(p => p.url().includes('localhost'))
  if (!page) throw new Error('no localhost page on this CDP port')
  await page.bringToFront()
  // 渲染层改动靠 dev 服务器的 HMR 生效；跨多个模块的 hook 改动不一定被热更接住，
  // 所以每次测量前先重载一次，保证界面跑的是当前代码。
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
  await page.waitForTimeout(2_500)
  // worker/api 重启会让窗口停在「暂时连接不上学习服务」；先点重新连接再等界面。
  const reconnect = page.getByRole('button', { name: /重新连接|再试一次/ })
  if (await reconnect.count()) {
    await reconnect.first().click()
    console.log('clicked reconnect')
  }
  await page.waitForSelector('.companion-presence, .hud-rail', { timeout: 30_000 })

  // 气泡轻聊会在一会儿后自动收起：每次发送前重新确认文本域在。
  const ensureBubble = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const area = page.locator('textarea[placeholder*="想聊什么"]')
      if (await area.count()) return area
      await page.getByRole('button', { name: /气泡轻聊/ }).first().click().catch(() => undefined)
      await page.waitForTimeout(600)
    }
    throw new Error('bubble chat textarea did not appear')
  }
  await ensureBubble()

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const latestRunId = () => {
    const row = psql('select id from companion_turn_runs order by created_at desc limit 1')
    return row || null
  }
  // 等待期间盯住气泡：第一个"有内容"的时刻由界面自己回答，而不是由库里的时间戳推。
  // 记的是每一类语气第一次出现非空文本的时刻（相对发送），以及思考那一档
  // **逐拍的字数序列**——"丝滑不丝滑"看的是相邻两拍跳了多少字，不是首字时刻。
  const sampleBubble = async (page, startedAt, samples, thinkingSeries) => {
    const shot = await page.evaluate(() => {
      const bubble = document.querySelector('.companion-hud__output')
      if (!bubble) return null
      const body = bubble.querySelector('.companion-hud__output-body')
      return { tone: bubble.getAttribute('data-tone') ?? '?', chars: (body?.textContent ?? '').length }
    }).catch(() => null)
    if (!shot || shot.chars === 0) return
    const seenAt = Date.now() - startedAt
    if (shot.tone === 'thinking') thinkingSeries.push([seenAt, shot.chars])
    const prior = samples.find(item => item.tone === shot.tone)
    if (!prior) samples.push({ tone: shot.tone, firstCharsAtMs: seenAt, chars: shot.chars })
    else if (shot.chars > prior.chars) prior.chars = shot.chars
  }
  const waitRunSettled = async (previousRunId, page, timeoutMs = 180_000) => {
    const samples = []
    const thinkingSeries = []
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    while (Date.now() < deadline) {
      const row = psql(`select id||'|'||status||'|'||coalesce(agent_elapsed_ms::text,'-') from companion_turn_runs order by created_at desc limit 1`)
      const [id, status, elapsed] = row.split('|')
      if (id !== previousRunId && status !== 'accepted' && status !== 'running' && status !== 'waiting_for_confirmation') {
        return { id, status, elapsed, samples, thinkingSeries }
      }
      await sampleBubble(page, startedAt, samples, thinkingSeries)
      await sleep(50)
    }
    throw new Error(`run did not settle within ${timeoutMs}ms after run ${previousRunId}`)
  }

  for (const [index, question] of questions.entries()) {
    const previousRunId = latestRunId()
    const sentAt = new Date().toISOString()
    const textarea = await ensureBubble()
    await textarea.fill(question)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    console.log(`#${index + 1} sent at ${sentAt} :: ${question}`)
    const run = await waitRunSettled(previousRunId, page)
    console.log(`#${index + 1} run ${run.id} ${run.status} elapsed=${run.elapsed}ms`)
    console.log(`#${index + 1} bubble ${JSON.stringify(run.samples)}`)
    // 相邻两拍之间跳了多少字：跳得小才是"铺"，跳一大截就是"卡"。
    const jumps = run.thinkingSeries.slice(1).map((item, i) => item[1] - run.thinkingSeries[i][1])
      .filter(jump => jump !== 0)
    const sorted = [...jumps].sort((a, b) => a - b)
    console.log(`#${index + 1} thinking cadence samples=${run.thinkingSeries.length} `
      + `first=${run.thinkingSeries[0]?.[0] ?? '-'}ms last=${run.thinkingSeries.at(-1)?.[0] ?? '-'}ms `
      + `medianJump=${sorted[Math.floor(sorted.length / 2)] ?? '-'} maxJump=${Math.max(0, ...jumps)} `
      + `backwards=${jumps.filter(jump => jump < 0).length}`)
    const timeline = psql(`select type||' '||to_char(created_at, 'HH24:MI:SS.MS') from companion_stream_events where run_id = '${run.id}' and type in ('turn.accepted','assistant.status','assistant.thinking','assistant.delta','assistant.final','voice.segment.ready','error') order by seq`)
    const lines = timeline.split('\n')
    const firstOf = type => (lines.find(line => line.startsWith(type)) ?? `${type} -`).split(' ')[1]
    const thinking = psql(`select count(*)::text||'|'||coalesce(sum(length(payload->>'text')),0)::text||'|'||coalesce(left((array_agg(payload->>'text' order by seq))[1],60),'') from companion_stream_events where run_id='${run.id}' and type='assistant.thinking'`)
    console.log(`#${index + 1} thinking rows ${thinking.slice(0, 200)}`)
    console.log(`#${index + 1} first accepted=${firstOf('turn.accepted')} status=${firstOf('assistant.status')} thinking=${firstOf('assistant.thinking')} delta=${firstOf('assistant.delta')} final=${firstOf('assistant.final')} voice=${firstOf('voice.segment.ready')}`)
    await sleep(2_000)
  }
}

await browser.close()
