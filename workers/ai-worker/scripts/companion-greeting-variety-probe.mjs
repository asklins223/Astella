/**
 * 真栈检查：连续几次启动问候还在不在说同一句（2026-10-16）。
 *
 * 用户反馈「主动说的话空、重复、没依据」。真窗口与真库读数：三小时内她的主动开口**全是**
 * 启动问候，正文几乎是同一句换时间词——「周五晚上好，又见面了。今天过得咋样？」那一族。
 * 历史就在她的上下文里，但提示里没有一句禁止复用，反而把「问问他今天怎么样」当范本递给她。
 *
 * 这个脚本按真实启动观察连造 N 次（`POST /me/companion/awareness`，`topic=app.started`，
 * appLaunchId 各不同），取每一条正文，算两两最长公共子串（LCS）、结尾复用条数，以及几句
 * 被复用的套话出现次数；同时对照修前历史。反重复那一句由
 * `companion-initiative-observation.ts` 从回放历史里引出，见那里的注释。
 *
 * 跑法（dev 栈在起：api :4000、worker、postgres）：
 *   cd workers/ai-worker
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… ROUNDS=5 node scripts/companion-greeting-variety-probe.mjs
 *
 * 2026-10-16 实测（同一账号，连造 5 次）：
 *   修前 8 条：LCS 19 字（「周五晚上了，又见面了。今儿个过得咋样？」），结尾复用 6/8。
 *   修后 5 条：LCS 7 字，结尾复用 0/5，套话「今天过得咋样/又见面了/又来了」0 次。
 *   首版修法漏了一处：提示里逐字引用的反面例句被抄成了台词（第 2 次输出
 *   「我去吃饭了，你先忙你的。」）——现在禁止项不复述原话，同时钉住提示里不再出现它们。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const api = process.env.ASTELLA_PROBE_API ?? 'http://127.0.0.1:4000'
const email = process.env.ASTELLA_PROBE_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')
const rounds = Number(process.env.ROUNDS ?? 5)
const psql = (sql) => execFileSync('docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-Atc', sql]).toString().trim()
const say = (...parts) => console.log(...parts)

const login = await (await fetch(`${api}/auth/login`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()
if (!login.token) throw new Error(`登录失败：${JSON.stringify(login).slice(0, 120)}`)
const userId = login.ctx.userId

const observeLaunch = async () => {
  const launch = randomUUID()
  const res = await fetch(`${api}/me/companion/awareness`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-csrf-token': login.csrfToken },
    body: JSON.stringify({ version: 1, id: randomUUID(), appLaunchId: launch, deviceSessionId: `device:${launch}`, host: 'desktop',
      topic: 'app.started', occurredAt: new Date().toISOString(), elapsedMs: 0,
      context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: null,
        page: { key: 'home', label: '书房', revision: null, context: null } } }) })
  return res.json()
}

const latestGreeting = () => psql(`select left(regexp_replace(coalesce(m.blocks->0->>'text',''), E'\\s+', ' ', 'g'), 200)
  from companion_messages m join companion_turn_runs r on r.id=m.run_id
  where r.user_id='${userId}' and r.input_source->>'topic'='app.started' and m.role='assistant' and m.kind<>'error'
  order by m.created_at desc limit 1`)

const lcs = (a, b) => {
  let best = ''
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + best.length + 1; j <= a.length; j += 1) {
      const piece = a.slice(i, j)
      if (b.includes(piece)) best = piece
      else break
    }
  }
  return best
}

const pairStats = (texts) => {
  let max = ''
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const piece = lcs(texts[i], texts[j])
      if (piece.length > max.length) max = piece
    }
  }
  const tail = (t) => t.replace(/[。！？!?]$/, '').slice(-6)
  return { longestShared: max, longestSharedLen: max.length, tailReuse: texts.length - new Set(texts.map(tail)).size }
}

const CLICHES = ['今天过得咋样', '又见面了', '又来了', '晚上好，来了']
const clicheCounts = (texts) => Object.fromEntries(CLICHES.map(mark => [mark, texts.filter(t => t.includes(mark)).length]))

const before = psql(`select left(regexp_replace(coalesce(m.blocks->0->>'text',''), E'\\s+', ' ', 'g'), 120)
  from companion_messages m join companion_turn_runs r on r.id=m.run_id
  where r.user_id='${userId}' and r.input_source->>'topic'='app.started' and m.role='assistant' and m.kind<>'error'
    and m.created_at < now() - interval '30 seconds'
  order by m.created_at desc limit 8`).split('\n').filter(Boolean)
say(`修前历史（同账号，最近 ${before.length} 条）：`)
before.forEach(t => say(`  · ${t}`))
say(`修前：${JSON.stringify(pairStats(before))} 套话=${JSON.stringify(clicheCounts(before))}`)

const produced = []
for (let round = 1; round <= rounds; round += 1) {
  const previous = latestGreeting()
  await observeLaunch()
  let text = ''
  for (let i = 0; i < 90; i += 1) {
    await new Promise(r => setTimeout(r, 1_000))
    const current = latestGreeting()
    if (current && current !== previous) { text = current; break }
  }
  if (!text) { say(`第 ${round} 次：没等到新的问候`); continue }
  produced.push(text)
  say(`第 ${round} 次：${text}`)
}

say(`修后：${JSON.stringify(pairStats(produced))} 套话=${JSON.stringify(clicheCounts(produced))}`)
const leaked = produced.filter(t => /我去吃饭了|你先忙你的|本轮不发言|我先不打扰你/.test(t))
say(leaked.length === 0 ? 'PASS 没有把提示里的反面例句抄成台词' : `FAIL 反面例句被抄成了台词：${JSON.stringify(leaked)}`)
/**
 * 她看不到的环境不许说成看见：2026-10-16 实测换由头之后她说出「你房间里光线偏暗」
 * 「你那台灯搁左边还是右边」。这里按词面粗筛，只判"有没有出现"，不判语气。
 */
const fabricated = produced.filter(t => /你房间|你那台灯|你的桌子|光线偏|桌上摆|你窗外/.test(t))
say(fabricated.length === 0 ? 'PASS 没有编造看到他的房间或摆设' : `FAIL 编造了看不到的环境：${JSON.stringify(fabricated)}`)
process.exit(leaked.length === 0 && fabricated.length === 0 ? 0 : 1)
