// Real startup receipt → IPC → companion paper → local voice, in a disposable profile.
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, basename } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const output = resolve(appRoot, '../../outputs/desktop-update-20261009')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'astella-update-voice-'))
const { version } = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
await writeFile(join(profile, 'update-install.json'), JSON.stringify({ fromVersion: '1.0.0', version, status: 'pending' }))
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5199, strictPort: true } })
await server.listen()
const qaDirectory = await mkdtemp(join(appRoot, 'src/renderer/update-qa-'))
const qaUrl = `http://localhost:5199/${basename(qaDirectory)}/index.html`
await writeFile(join(qaDirectory, 'index.html'), `<html><head><meta charset="UTF-8"><base href="/"></head><body><div id="root"></div><script type="module" src="/${basename(qaDirectory)}/entry.tsx"></script></body></html>`)
await writeFile(join(qaDirectory, 'entry.tsx'), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.ts';
import { HomeV2AudioController } from '/src/components/home-v2/HomeV2AudioController.tsx';
import { CompanionNotificationCenter } from '/src/components/companion/CompanionNotificationCenter.tsx';
import { WindowLive2D } from '/src/components/companion/WindowLive2D.tsx';
import { useRoomStore } from '/src/app/room-store.ts';
useRoomStore.setState({ masterMuted: false, surface: null, windowState: 'visible' });
function Probe() {
  const [blocked, setBlocked] = useState(false);
  return <><HomeV2AudioController />
    <main style={{position:'absolute', left:160, top:120, fontSize:20}}><h1>新版启动验证</h1><button className="button" onClick={() => setBlocked(false)}>进入书房</button></main>
    <div className="companion-presence" style={{position:'fixed', inset:'auto', right:56, bottom:30, width:280, height:380}}><WindowLive2D active motionMode="full" presentation="idle" framing="full" style={{position:'absolute', inset:0, width:'100%', height:'100%'}} /></div>
    <CompanionNotificationCenter replyBusy={false} blocked={blocked} muted={false} passiveMuted={false} /></>;
}
createRoot(document.getElementById('root')).render(<Probe />);
`)
let app
const launch = () => electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: appRoot,
  env: { ...process.env, ASTELLA_DOMAIN_SCHEMA_REVISION: process.env.ASTELLA_DOMAIN_SCHEMA_REVISION || 'domain-dev-v1', ELECTRON_RENDERER_URL: qaUrl },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') })
try {
  app = await launch()
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 810); window.show(); window.focus() })
  await page.getByRole('heading', { name: `已经更新到 ${version}`, exact: true }).waitFor({ timeout: 30_000 })
  await page.getByText('正在朗读通知', { exact: true }).waitFor({ timeout: 10_000 })
  console.log('PASS: startup success paper and actual local audio playback')
  await page.screenshot({ path: join(output, 'update-success-speaking.png') })
  const receipt = JSON.parse(await readFile(join(profile, 'update-install.json'), 'utf8'))
  if (receipt.status !== 'acknowledged') throw new Error('Companion presentation did not acknowledge the main-process receipt')
  await page.getByRole('button', { name: '停止通知播报', exact: true }).waitFor({ state: 'hidden', timeout: 10_000 })
  const companionRenderer = await page.locator('.window-live2d').getAttribute('data-companion-status')
  await page.getByRole('button', { name: '朗读这条通知', exact: true }).click()
  await page.getByRole('button', { name: '停止通知播报', exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'update-success-speaking-with-companion.png') })
  await page.getByRole('button', { name: '停止通知播报', exact: true }).click()
  await page.getByRole('button', { name: '继续学习', exact: true }).click()
  console.log('PASS: replay, stop and continue-learning actions')
  await app.close()
  app = await launch()
  const next = await app.firstWindow()
  await next.waitForFunction(() => Boolean(window.astella?.update))
  const state = await next.evaluate(async () => {
    const { createRequestMeta } = await import('/src/app/desktop-client.ts')
    return (await window.astella.update.getState({ meta: createRequestMeta() })).data.state
  })
  if (state.installedUpdate) throw new Error('Success was repeated after a second startup')
  console.log('PASS: second startup does not repeat update success')
  await writeFile(join(output, 'result.json'), JSON.stringify({ version, receipt, secondStartup: state, localVoice: 'played', replay: 'played', stop: 'passed', companionRenderer }, null, 2))
} catch (error) {
  const page = await app?.firstWindow();
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined);
    console.error('Notification voice:', await page.locator('.companion-notification-paper__voice').innerText().catch(() => 'No paper'));
  }
  throw error;
} finally { await app?.close().catch(() => undefined); await server.close(); await rm(profile, { recursive: true, force: true }); await rm(qaDirectory, { recursive: true, force: true }) }
