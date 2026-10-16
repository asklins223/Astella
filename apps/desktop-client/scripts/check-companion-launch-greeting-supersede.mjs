/**
 * 真栈检查：新的一次启动收掉上一次没被看见的启动问候，并且**不吃掉这次自己的问候**。
 *
 * 用户反馈「她的问候重复、迟到、像旧消息」：问候是对某一次启动说的话，生成要十几秒。
 * 那次启动若先关了窗口，投递就停在 `queued`，下一次打开才被认领（上一句冒充这一句），
 * 而且那句没人听见的话还压着 2 分钟的跨话题地板，把这次自己的问候一起推后。
 *
 * 这个脚本按两次真实启动的观察走一遍（`POST /me/companion/awareness`，`topic=app.started`，
 * appLaunchId 各不同），断言：
 *   ① 第一次启动的问候在第二次启动观察到达后变成 `suppressed`；
 *   ② 第二次启动仍然产出自己的问候（不是 `suppressed`），且整段在 30 秒内完成
 *      —— 旧问候如果还压着地板，这里会等到 2 分钟。
 *
 * 跑法（dev 栈在起：api :4000、worker、postgres）：
 *   cd apps/desktop-client
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… node scripts/check-companion-launch-greeting-supersede.mjs
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const api = process.env.ASTELLA_PROBE_API ?? 'http://127.0.0.1:4000'
const email = process.env.ASTELLA_PROBE_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok: Boolean(ok), label })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}
const psql = (sql) => execFileSync('docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-Atc', sql]).toString().trim()

const login = await (await fetch(`${api}/auth/login`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()
if (!login.token) throw new Error(`登录失败：${JSON.stringify(login).slice(0, 120)}`)
const userId = login.ctx.userId

const observeLaunch = async (label) => {
  const launch = randomUUID()
  const res = await fetch(`${api}/me/companion/awareness`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-csrf-token': login.csrfToken },
    body: JSON.stringify({ version: 1, id: randomUUID(), appLaunchId: launch, deviceSessionId: `device:${launch}`, host: 'desktop',
      topic: 'app.started', occurredAt: new Date().toISOString(), elapsedMs: 0,
      context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: null,
        page: { key: 'home', label: '书房', revision: null, context: null } } }) })
  const body = await res.json()
  console.log(`${label}: accepted=${body.accepted}`)
  return launch
}

const newestRun = (topic = 'app.started') => psql(`select r.id from companion_turn_runs r
  where r.user_id='${userId}' and r.input_source->>'topic'='${topic}' order by r.created_at desc limit 1`)
const deliveryState = (runId) => psql(`select d.state from assistant_deliveries d
  where d.payload_ref->'initiative'->>'runId'='${runId}'`)
const waitFor = async (runId, state, attempts = 60) => {
  let seen = ''
  for (let i = 0; i < attempts; i += 1) {
    seen = deliveryState(runId)
    if (seen === state) return seen
    await new Promise(r => setTimeout(r, 1_000))
  }
  return seen
}

const startedAt = Date.now()
await observeLaunch('launch-1')
let firstRun = ''
for (let i = 0; i < 60; i += 1) {
  firstRun = newestRun()
  if (firstRun && deliveryState(firstRun) === 'queued') break
  await new Promise(r => setTimeout(r, 1_000))
}
check(Boolean(firstRun), '第一次启动产出了问候（没人看见，停在 queued）', { runId: firstRun })

await observeLaunch('launch-2')
const retired = await waitFor(firstRun, 'suppressed', 20)
check(retired === 'suppressed', '第二次启动把上一次没被看见的问候收掉', { state: retired })

let secondRun = ''
for (let i = 0; i < 60; i += 1) {
  secondRun = newestRun()
  if (secondRun && secondRun !== firstRun && deliveryState(secondRun)) break
  await new Promise(r => setTimeout(r, 1_000))
}
const secondState = secondRun ? deliveryState(secondRun) : ''
check(Boolean(secondRun) && secondRun !== firstRun && secondState !== 'suppressed',
  '第二次启动仍然产出自己的问候', { runId: secondRun, state: secondState })
const elapsed = Math.round((Date.now() - startedAt) / 1_000)
check(elapsed < 30, '整段不等待 2 分钟跨话题地板', { elapsedSeconds: elapsed })

const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
