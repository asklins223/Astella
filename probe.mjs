import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('/Users/asklins/Documents/asklins_workspace/astella/astella_service_client/apps/desktop-client/node_modules/playwright-core/index.js');
const CHROME = '/Users/asklins/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const repo = '/Users/asklins/Documents/asklins_workspace/astella/astella-service_client';
const here = path.dirname(new URL(import.meta.url).pathname);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.json':'application/json', '.png':'image/png', '.moc3':'application/octet-stream' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = url.startsWith('/apps/') ? path.join(repo, url) : path.resolve(here, url === '/' ? 'final.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await pw.chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle'] });
const page = await browser.newPage({ viewport: { width: 520, height: 760 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 500)));
page.on('console', m => { if (!m.text().includes('[CSM][I]')) console.log('[console]', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/final.html`);
await page.waitForTimeout(8000);
console.log('ready?', await page.evaluate(() => window.__ready));
console.log('has applyForm?', await page.evaluate(() => typeof window.applyForm));
console.log('forms:', JSON.stringify(await page.evaluate(() => window.applyForm ? window.applyForm('small') : null)));
await browser.close(); server.close();
