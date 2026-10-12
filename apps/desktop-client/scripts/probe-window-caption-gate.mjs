import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import './load-capture-env.mjs';

// Exercise the built renderer and real window IPC in an isolated Electron profile.
// macOS supplies the native host; only the probe preload's platform is set to win32.
const desktop = resolve(import.meta.dirname, '..');
const output = resolve(desktop, 'outputs/windows-fix-20261012');
const profile = await mkdtemp(resolve(tmpdir(), 'astella-caption-gate-'));
await mkdir(output, { recursive: true });
const preload = (await readFile(resolve(desktop, 'out/preload/index.js'), 'utf8'));
if (!preload.includes('platform: process.platform')) throw new Error('Cannot locate preload platform');
const probePreload = resolve(profile, 'preload.cjs');
await writeFile(probePreload, preload.replace('platform: process.platform', 'platform: "win32"'));
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`], cwd: desktop,
  executablePath: resolve(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
});
try {
  const original = await app.firstWindow();
  await original.waitForLoadState('domcontentloaded');
  const targetUrl = original.url();
  await app.evaluate(async ({ BrowserWindow }, { targetUrl, probePreload }) => {
    const primary = BrowserWindow.getAllWindows()[0];
    primary.hide();
    const probe = new BrowserWindow({
      width: 1280, height: 800, frame: false, show: true,
      webPreferences: { ...primary.webContents.getLastWebPreferences(), preload: probePreload },
    });
    globalThis.__captionProbeId = probe.id;
    await probe.loadURL(targetUrl);
  }, { targetUrl, probePreload });
  const page = (await app.windows()).find(candidate => candidate !== original);
  if (!page) throw new Error('Probe window missing');
  await page.waitForSelector('.desktop-access-gate input[type="email"]', { timeout: 45000 });
  await page.getByRole('button', { name: '登录', exact: true }).waitFor({ state: 'visible' });
  await page.waitForTimeout(1200);
  const inspect = () => page.evaluate(() => {
    const gate = document.querySelector('.desktop-access-gate');
    const caption = document.querySelector('.window-caption');
    return {
      platform: window.astellaDesktop.platform,
      gateZ: getComputedStyle(gate).zIndex,
      captionZ: getComputedStyle(caption).zIndex,
      controls: Array.from(caption.querySelectorAll('button')).map(button => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { label: button.getAttribute('aria-label'), width: rect.width, height: rect.height, clickable: button.contains(hit) };
      }),
    };
  });
  const report = [];
  for (const [width, height, zoom] of [[1280, 800, 1], [1280, 720, 1.25], [1440, 900, 1]]) {
    await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
      const probe = BrowserWindow.fromId(globalThis.__captionProbeId);
      probe.webContents.setZoomFactor(zoom);
      probe.setContentSize(width, height);
    }, { width, height, zoom });
    const state = await inspect();
    if (state.controls.length !== 3 || state.controls.some(control => !control.clickable || control.width <= 0))
      throw new Error(`Caption covered: ${JSON.stringify(state)}`);
    report.push({ width, height, zoom, ...state });
    await page.screenshot({ path: resolve(output, `login-caption-${width}-${height}-${zoom}.png`) });
  }
  await page.getByRole('button', { name: '最小化', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__captionProbeId).isMinimized())))
    throw new Error('Minimize IPC did not reach the native window');
  await app.evaluate(({ BrowserWindow }) => { const probe = BrowserWindow.fromId(globalThis.__captionProbeId); probe.restore(); probe.show(); });
  await page.getByRole('button', { name: '最大化', exact: true }).click();
  await page.waitForTimeout(150);
  if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__captionProbeId).isMaximized())))
    throw new Error('Maximize IPC did not reach the native window');
  await page.locator('.window-caption__button').nth(1).click();
  await page.waitForTimeout(150);
  if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.fromId(globalThis.__captionProbeId).isMaximized()))
    throw new Error('Restore IPC did not reach the native window');
  const closed = page.waitForEvent('close');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await closed;
  await writeFile(resolve(output, 'caption-probe.json'), JSON.stringify({ host: process.platform, simulatedRendererPlatform: 'win32', report, nativeActions: ['minimize', 'maximize', 'restore', 'close'] }, null, 2));
  console.log(JSON.stringify({ report, nativeActions: 'passed', output }, null, 2));
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
