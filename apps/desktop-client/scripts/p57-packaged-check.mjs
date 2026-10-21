import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dir = await mkdtemp(resolve(tmpdir(), 'astella-p57-manual-'))
const app = await electron.launch({
  executablePath: resolve('release/mac-arm64/Astella.app/Contents/MacOS/Astella'),
  args: [`--user-data-dir=${dir}`, '--remote-debugging-port=9333'],
  env: { ...process.env },
})
const w = await app.firstWindow()
const errors = []
w.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
w.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)))
const text = async () => (await w.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))).slice(0, 600)
try {
  await w.waitForFunction(() => Boolean(document.querySelector('.action-rail, .home-v2-objects')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')), undefined, { timeout: 30_000 })
  if (await w.locator('.desktop-access-gate input[type="email"]').count()) {
    await w.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
    await w.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
    await w.getByRole('button', { name: '登录', exact: true }).click()
  }
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline && await w.locator('.action-rail, .home-v2-objects').count() === 0) {
    const buttons = w.locator('.desktop-access-gate__workspace-list button')
    if (await buttons.count()) {
      const owner = buttons.filter({ hasText: '所有者' }).first()
      await (await owner.count() ? owner : buttons.first()).click()
    }
    await w.waitForTimeout(300)
  }
  await w.locator('.action-rail, .home-v2-objects').first().waitFor({ timeout: 20_000 })
  console.log('home:', (await text()).slice(0, 160))

  await w.locator('.hud-rail button[aria-label="笔记"]').first().evaluate(el => el.click())
  await w.waitForFunction(() => Boolean(document.querySelector('.task-surface--note-library, .note-library')), undefined, { timeout: 20_000 })
  const note = w.getByRole('button', { name: /^打开笔记/ }).first()
  await note.waitFor({ state: 'visible', timeout: 20_000 })
  await note.click()
  await w.waitForFunction(() => {
    const s = document.querySelector('.task-surface[data-surface="notebook"]')
    return Boolean(s && (s.innerText ?? '').trim().length > 80)
  }, undefined, { timeout: 20_000 })
  console.log('note ok')

  await w.getByRole('tab', { name: '学习卡', exact: true }).first().click()
  await w.waitForFunction(() => Boolean(document.querySelector('.note-learning-card')), undefined, { timeout: 20_000 })
  await w.waitForFunction(() => {
    const card = document.querySelector('.note-learning-card')
    if (!card) return false
    if (document.querySelector('.note-learning-card__grounding')) return true
    return [...card.querySelectorAll('button')].some(b => /^(生成学习卡|开始学习|再练一次|继续作答)$/.test((b.textContent ?? '').trim()))
  }, undefined, { timeout: 30_000 })
  const hasGenerate = await w.getByRole('button', { name: '生成学习卡', exact: true }).count()
  console.log('card action:', { hasGenerate })
  if (hasGenerate) {
    console.log('generating card...')
    await w.getByRole('button', { name: '生成学习卡', exact: true }).first().click()
  }
  let started = false
  const cardDeadline = Date.now() + 300_000
  while (Date.now() < cardDeadline) {
    const groundedNow = await w.locator('.note-learning-card__grounding').count()
    if (groundedNow >= 4) { console.log('grounded', groundedNow); break }
    if (!started) {
      const start = w.getByRole('button', { name: /^(开始学习|再练一次|继续作答)$/ }).first()
      if (await start.count()) {
        console.log('starting attempt...')
        await start.click()
        started = true
      }
    }
    await w.waitForTimeout(3000)
  }
  await w.screenshot({ path: '/tmp/p57-packaged-card.png' })
  const grounded = await w.locator('.note-learning-card__grounding').count()
  await w.screenshot({ path: '/tmp/p57-packaged-card.png' })
  console.log(JSON.stringify({ grounded, body: (await text()).slice(0, 400), errors }, null, 2))
  if (grounded < 4 || grounded > 8) process.exitCode = 2
} finally {
  await app.close().catch(() => {})
  await rm(dir, { recursive: true, force: true })
}
