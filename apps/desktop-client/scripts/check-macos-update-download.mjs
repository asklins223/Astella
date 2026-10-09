// Real Electron networking and electron-updater checksum/cache regression.
// Uses a loopback feed and an isolated profile; never updates the installed app.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'vite'

if (process.platform !== 'darwin') throw new Error('Run on macOS')
const appRoot = resolve(import.meta.dirname, '..')
// electron 43 起二进制改为按需安装（包上没有 postinstall，CI 的 npm ci 不会拉它）。
// `require('electron')` 返回可执行路径，缺失时由它自己触发 install.js 下载——
// 本地与 CI 因此走同一条解析路径，不再硬拼 dist 目录。
const electronExecutable = createRequire(import.meta.url)('electron')
const root = await mkdtemp(join(tmpdir(), 'astella-update-download-'))
const bytes = Buffer.alloc(64 * 1024, 'Astella verified update fixture')
const sha512 = createHash('sha512').update(bytes).digest('base64')
let downloads = 0
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname.endsWith('.yml')) {
    const bad = pathname.startsWith('/bad/')
    response.end(`version: ${bad ? '3.0.0' : '2.0.0'}\nfiles:\n  - url: astella-${bad ? '3.0.0' : '2.0.0'}-mac-${process.arch}.zip\n    sha512: ${bad ? createHash('sha512').update('wrong').digest('base64') : sha512}\n    size: ${bytes.length}\nreleaseDate: '2026-10-09T00:00:00.000Z'\n`)
  } else { downloads++; response.setHeader('Content-Length', bytes.length); response.end(bytes) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const origin = `http://127.0.0.1:${server.address().port}`
  const source = join(root, 'runner.js')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'astella-update-fixture', version: '1.0.0', main: 'out/runner.cjs' }))
  await mkdir(join(root, 'profile'))
  await writeFile(join(root, 'update.yml'), 'updaterCacheDirName: astella-update-fixture\n')
  await writeFile(source, `
import { app, autoUpdater as nativeUpdater } from 'electron';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { MacosArchiveUpdater } from ${JSON.stringify(resolve(appRoot, 'src/main/macos-archive-updater.ts'))};
async function probe() {
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
app.setPath('cache', ${JSON.stringify(root)});
await app.whenReady();
try {
  const listeners = nativeUpdater.listenerCount('error');
  const create = (feed) => {
    const updater = new MacosArchiveUpdater();
    updater.forceDevUpdateConfig = true; updater.autoDownload = false; updater.logger = null;
    updater.updateConfigPath = ${JSON.stringify(join(root, 'update.yml'))};
    updater.setFeedURL({ provider: 'generic', url: feed });
    updater.on('error', () => {});
    return updater;
  };
  const updater = create(${JSON.stringify(origin)});
  let downloaded; let progress = false;
  updater.on('update-downloaded', event => downloaded = event);
  updater.on('download-progress', () => progress = true);
  assert.equal((await updater.checkForUpdates()).updateInfo.version, '2.0.0');
  const paths = await updater.downloadUpdate();
  assert.equal(paths.length, 1);
  assert.equal(readFileSync(paths[0]).length, 65536);
  assert.equal(downloaded.version, '2.0.0');
  assert.ok(progress);
  const cached = create(${JSON.stringify(origin)});
  await cached.checkForUpdates(); await cached.downloadUpdate();
  const bad = create(${JSON.stringify(origin + '/bad/')});
  await bad.checkForUpdates();
  await assert.rejects(bad.downloadUpdate(), /checksum|sha512/i);
  assert.equal(nativeUpdater.listenerCount('error'), listeners);
  console.log('PASS: real Mac ZIP download, progress, cache, corrupt-checksum rejection; no Squirrel listener');
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }
}
void probe().catch(error => { console.error(error); app.exit(1); });
`)
  await build({ configFile: false, logLevel: 'warn', build: { ssr: source, outDir: join(root, 'out'),
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'runner.cjs' } } },
    ssr: { noExternal: true, external: ['electron'] }, esbuild: { supported: { 'top-level-await': true } } })
  const child = spawn(electronExecutable, [root], { stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error(`Electron probe exited ${code}`)
  if (downloads !== 2) throw new Error(`Expected good and corrupt downloads, with cached reuse; got ${downloads}`)
} finally { server.close(); await rm(root, { recursive: true, force: true }) }
