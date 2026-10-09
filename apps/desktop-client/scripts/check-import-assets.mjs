/** 真实 Electron + 本地 API/Worker/MinIO 的文档、随文图片、缓存和 Markdown 导出往返。
 * 运行：node scripts/check-import-assets.mjs；凭据与部署配置复用 load-capture-env。
 * 独立 userData/端口，不接管用户窗口；仅清理本次创建的测试笔记与来源。
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import { Document, Packer, Paragraph, ImageRun, Table, TableRow, TableCell } from 'docx'
import { zipSync, strToU8 } from 'fflate'
import { deflateSync } from 'node:zlib'
import { readFile, readdir } from 'node:fs/promises'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const output = resolve(appRoot, '../../outputs/import-assets-2026-10-09')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-document-capture-'))
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5297, strictPort: true } })
await server.listen()
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9247'],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5297' },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const page = await app.firstWindow()
const errors = []
const logs = []
const checks = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => {
  logs.push(`${message.type()}: ${message.text().slice(0, 200)}`)

})
const check = (condition, label, detail) => {
  checks.push({ ok: Boolean(condition), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const shot = async name => {
  await page.waitForTimeout(200)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, `${name}.png`), Buffer.from(png, 'base64'))
}
const room = fn => page.evaluate(async source => {
  const { useRoomStore } = await import('/src/app/room-store.ts')
  return (new Function('room', source))(useRoomStore)
}, fn)
/**
 * 采集栏那一个隐藏的文件输入：setInputFiles 给的是真文件，`arrayBuffer()` 由操作系统背书。
 *
 * 投放之前要等它**解除禁用**：来源库刚打开那几十毫秒里索引还在加载，整条采集栏是 disabled 的
 * （界面上那颗按钮也是灰的，真人点这里没反应，是诚实的）。Playwright 不等这个状态，
 * 于是它的第一次投放什么也不会发生——探针必须跟同一个门槛。
 */
const dropFile = async path => {
  await page.waitForFunction(() => document.querySelector('input.source-file-input')?.disabled === false, { timeout: 30_000 })
  await page.setInputFiles('input.source-file-input', path)
}
const titles = () => page.evaluate(async () => {
  const { createRequestMeta, unwrapGatewayResult } = await import('/src/app/desktop-client.ts')
  const list = unwrapGatewayResult(await window.astella.source.list({ meta: createRequestMeta(), limit: 50 }))
  return list.items.map(item => ({ id: item.id, title: item.title, status: item.status }))
}
)
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 810); w.show(); w.focus() })
await page.waitForFunction(() => document.querySelector('.companion-presence, .desktop-access-gate input[type="email"]'), { timeout: 40_000 })
if (!await page.locator('.companion-presence').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.ASTELLA_QA_EMAIL ?? process.env.OWNER_EMAIL)
  await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.ASTELLA_QA_PASSWORD ?? process.env.OWNER_PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
await page.waitForFunction(() => document.querySelector('.companion-presence'), { timeout: 40_000 })
await page.waitForLoadState('networkidle')
await room('room.getState().finishOnboarding()')
await room('room.getState().invoke("open-sources")')
await page.waitForFunction(() => document.querySelector('.capture-strip'), { timeout: 20_000 })

const createdSources = [], createdNotes = [], stamp = Date.now()
const ipc = (method, args = {}) => page.evaluate(async ({ method, args }) => {
  const { createRequestMeta, unwrapGatewayResult } = await import('/src/app/desktop-client.ts')
  const [namespace, member] = method.split('.')
  return unwrapGatewayResult(await window.astella[namespace][member]({ meta: createRequestMeta(), ...args }))
}, { method, args })
const select = path => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
const sources = async () => { await room('room.getState().invoke("open-sources")'); await page.waitForFunction(() => document.querySelector('input.source-file-input')?.disabled === false) }
async function parsed(title) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const row = (await titles()).find(item => item.title === title)
    if (row) {
      if (!createdSources.includes(row.id)) createdSources.push(row.id)
      const detail = await ipc('source.get', { sourceId: row.id })
      if (detail.source.status === 'ready') return detail
      if (detail.source.status === 'failed') throw new Error(`source failed: ${title}`)
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`Timed out waiting for ${title}`)
}
const textOf = detail => detail.segments.map(segment => segment.text).join('\n\n')
try {
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 100; c.height = 80; const ctx = c.getContext('2d'); ctx.fillStyle = '#527866'; ctx.fillRect(0, 0, 100, 80); ctx.fillStyle = '#f6e2ad'; ctx.fillRect(20, 20, 60, 40); return c.toDataURL('image/png').split(',')[1] })
  const image = () => new ImageRun({ type: 'png', data: Buffer.from(png, 'base64'), transformation: { width: 100, height: 80 } })
  const docxTitle = `导入回归-Word-${stamp}`, docxPath = resolve(profile, `${docxTitle}.docx`)
  await writeFile(docxPath, await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph(`图片之前的文字 ${stamp}`), new Paragraph({ children: [image()] }), new Paragraph('图片之后的文字'),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('级别')] }), new TableCell({ children: [new Paragraph('示意图')] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph('重点')] }), new TableCell({ children: [new Paragraph({ children: [image()] })] })] })] })
  ] }] })))
  await dropFile(docxPath)
  const word = await parsed(docxTitle), wordText = textOf(word)
  check(wordText.includes('/api/uploads/') && !wordText.includes('data:image'), 'Word 图片以站内地址进入来源', wordText)
  const wordKeys = [...wordText.matchAll(/\/api\/uploads\/([^\s)"<>|]+)/g)].map(match => match[1])
  check(wordKeys.length === 2 && new Set(wordKeys).size === 1, 'Word 段落和表格图片保留，重复图只上传一次')
  await page.evaluate(async id => { const { useRoomStore } = await import('/src/app/room-store.ts'); useRoomStore.getState().setActiveSourceId(id); useRoomStore.getState().invoke('open-source') }, word.source.id)
  await page.waitForFunction(() => document.querySelectorAll('.source-table img').length > 0 && [...document.querySelectorAll('.source-table img')].every(img => img.complete && img.naturalWidth > 0), { timeout: 30_000 })
  check(await page.locator('.source-table img').count() > 0, 'Word 表格内图片在真实来源页显示'); await shot('word-source')
  const pdfTitle = `导入回归-PDF-${stamp}`, pdfPath = resolve(profile, `${pdfTitle}.pdf`)
  const rgb = Buffer.alloc(100 * 80 * 3);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
    const color = x >= 20 && x < 80 && y >= 20 && y < 60 ? [246, 226, 173] : [82, 120, 102];
    rgb.set(color, (y * 100 + x) * 3);
  }
  const stream = (body, dictionary = '') => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream')]);
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 7 0 R >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 6 0 R >> >> /Contents 8 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    stream(deflateSync(rgb), '/Type /XObject /Subtype /Image /Width 100 /Height 80 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
    stream(Buffer.from(`BT /F1 14 Tf 50 760 Td (Before image ${stamp}) Tj ET\nq 100 0 0 80 50 620 cm /Im1 Do Q\nBT /F1 14 Tf 50 590 Td (After image) Tj ET`)),
    stream(Buffer.from('q 300 0 0 240 50 500 cm /Im1 Do Q')),
  ];
  const chunks = [Buffer.from('%PDF-1.7\n')], offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); chunks.push(Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')])); }
  const start = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(Buffer.from(`xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`));
  const pdf = Buffer.concat(chunks).toString('base64');
  await writeFile(pdfPath, Buffer.from(pdf, 'base64')); await sources(); await dropFile(pdfPath)
  const pdfText = textOf(await parsed(pdfTitle))
  check(pdfText.includes('Before image') && pdfText.includes('After image') && pdfText.includes('/api/uploads/'), 'PDF 文字和图像都进入来源', pdfText)
  check(pdfText.includes('PDF 第 2 页图片'), 'PDF 无文字扫描页保留图像')
  check(pdfText.indexOf('Before image') < pdfText.indexOf('![') && pdfText.indexOf('![') < pdfText.indexOf('After image'), 'PDF 图片保留在前后文字之间')
  const txtTitle = `导入回归-TXT-${stamp}`, txtPath = resolve(profile, `${txtTitle}.txt`)
  await writeFile(txtPath, Buffer.from([0xbc, 0xe4, 0xb8, 0xf4, 0xd6, 0xd8, 0xb8, 0xb4])); await sources(); await dropFile(txtPath); await page.getByRole('button', { name: '开始解析', exact: true }).click()
  check(textOf(await parsed(txtTitle)).includes('间隔重复'), 'GBK TXT 收录正常汉字')
  const bundle = resolve(profile, 'bundle'), bundleTitle = `导入回归-Markdown-${stamp}`
  await mkdir(resolve(bundle, 'assets'), { recursive: true }); await mkdir(resolve(bundle, 'notes'))
  const md = `# ${bundleTitle}\n\n![内联](../assets/中文%20图.png)\n\n![引用][图]\n\n[图]: <../assets/中文 图.png>\n\n<img src="../assets/中文 图.png" width="240" alt="带尺寸" />\n`
  await writeFile(resolve(bundle, 'assets/中文 图.png'), Buffer.from(png, 'base64')); await writeFile(resolve(bundle, `notes/${bundleTitle}.md`), md)
  await sources(); await select(bundle)
  await page.getByRole('button', { name: '采集新来源', exact: true }).click()
  await page.getByRole('radio', { name: '带图的包' }).click()
  await page.getByRole('button', { name: '选文件夹', exact: true }).click()
  await page.waitForFunction(() => document.body.innerText.includes('收下这 1 篇'))
  await shot('bundle-preview')
  check(await page.getByText('bundle', { exact: true }).count() === 1, '预览显示所选材料名称')
  for (const zoom of [1.25, 1.5, 2]) {
    await app.evaluate(({ BrowserWindow }, zoom) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 720); w.webContents.setZoomFactor(zoom) }, zoom)
    await page.getByRole('button', { name: '收下这 1 篇', exact: true }).scrollIntoViewIfNeeded()
    const fits = await page.evaluate(() => { const sheet = document.querySelector('.source-capture-sheet'), button = [...sheet.querySelectorAll('button')].find(node => node.textContent.includes('收下这')), close = sheet.querySelector('[aria-label="收起采集"]'); const s = sheet.getBoundingClientRect(), b = button.getBoundingClientRect(), c = close.getBoundingClientRect(); return { noHorizontalOverflow: sheet.scrollWidth <= sheet.clientWidth + 1, buttonReachable: b.top >= s.top && b.bottom <= s.bottom, closeReachable: c.top >= s.top && c.bottom <= s.bottom, sheetInViewport: s.left >= 0 && s.right <= innerWidth + 1 && s.top >= 0 && s.bottom <= innerHeight + 1 } })
    check(Object.values(fits).every(Boolean), `1280×720 / ${zoom * 100}% 预览无横向溢出且提交可达`, fits)
    await shot(`bundle-preview-${zoom * 100}`)
  }
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(1); w.setContentSize(1440, 810) })
  await room('room.setState({ motionMode: "off" })')
  for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: '收起采集', exact: true }).click(); await page.getByRole('button', { name: '采集新来源', exact: true }).click() }
  check(await page.getByText('bundle', { exact: true }).count() === 1, 'Off 下快速收起重开保留同一份预览')
  const preview = await ipc('source.bundleImport', { request: { version: 1, action: 'inspect', kind: 'folder' } })
  check(preview.files === 1 && preview.localizable === 1 && preview.issues.length === 0, '文件夹预览识别三处引用并去重', preview)
  await page.getByRole('button', { name: '收下这 1 篇', exact: true }).click()
  const bundled = await parsed(bundleTitle), importedText = textOf(bundled)
  check(importedText.includes('/api/uploads/') && !/!\[[^\]]*\]\(\.\.\/assets\//.test(importedText), '点击收下完成 Markdown 文件夹图片上传')
  check(importedText.includes('width="240"') && !importedText.includes('src="../'), 'HTML 图片转换保留尺寸')
  check(!importedText.includes('[图]:'), '图片引用转换后清除已无用途的路径定义')
  await page.evaluate(async id => { const { useRoomStore } = await import('/src/app/room-store.ts'); useRoomStore.getState().setActiveSourceId(id); useRoomStore.getState().invoke('open-source') }, bundled.source.id)
  await page.locator('.source-reading-paper').evaluate(async el => { el.scrollTop = el.scrollHeight })
  await page.waitForFunction(() => [...document.querySelectorAll('.source-reader img')].some(img => img.alt === '带尺寸' && img.complete && img.naturalWidth > 0))
  const sourceImage = await page.getByAltText('带尺寸', { exact: true }).boundingBox()
  check(sourceImage?.width === 240, '来源阅读保留 HTML 图片的 240px 宽度', sourceImage)
  await shot('markdown-source')
  const zipPath = resolve(profile, 'bundle.zip'); await writeFile(zipPath, zipSync({ 'notes/note.md': strToU8(md), 'assets/中文 图.png': new Uint8Array(Buffer.from(png, 'base64')) }))
  await select(zipPath); const zp = await ipc('source.bundleImport', { request: { version: 1, action: 'inspect', kind: 'zip' } })
  const zi = await ipc('source.bundleImport', { request: { version: 1, action: 'import', kind: 'zip', bundlePath: zp.bundlePath } })
  check(zi.uploaded === 1 && zi.issues.length === 0, 'ZIP 包通过同一导入链路')
  const note = await ipc('source.createNote', { sourceId: bundled.source.id }); const noteId = note.noteId ?? note.note?.id
  if (!noteId) throw new Error(`Missing note id ${JSON.stringify(note)}`); createdNotes.push(noteId)
  await page.evaluate(async noteId => { const { useRoomStore } = await import('/src/app/room-store.ts'); useRoomStore.getState().setActiveNoteRef({ noteId, noteVersionId: null, mode: "preview" }); useRoomStore.getState().invoke('open-notebook') }, noteId)
  await page.waitForFunction(() => [...document.querySelectorAll('.note-html-image img, .note-image-node img')].some(img => img.complete && img.naturalWidth > 0), { timeout: 30_000 }); await shot('markdown-note')
  const naturalImage = page.locator('.note-transcript img[alt="内联"]'), sizedImage = page.locator('.note-transcript img[alt="带尺寸"]')
  const natural = await naturalImage.boundingBox()
  check(natural?.width === 100 && natural?.height === 80, '笔记中的无尺寸小图按原大小显示', natural)
  await naturalImage.click()
  check(await page.getByRole('dialog').count() > 0, '小图点击可进入图片查看器')
  await page.keyboard.press('Escape')
  await sizedImage.scrollIntoViewIfNeeded()
  check((await sizedImage.boundingBox())?.width === 240, '笔记中的显式图片尺寸仍然保留')
  await shot('markdown-note-sized')
  await app.evaluate(() => {
    const original = globalThis.fetch; globalThis.__imageReads = [];
    globalThis.fetch = (...args) => { if (String(args[0]).includes('/uploads/')) globalThis.__imageReads.push(args[1]?.method ?? 'GET'); return original(...args) }
  })
  check((await ipc('source.getImage', { request: { version: 1, objectKey: wordKeys[0] } })).byteLength > 0, '刚上传的图片可立即读取')
  await ipc('source.getImage', { request: { version: 1, objectKey: wordKeys[0] } })
  const methods = await app.evaluate(() => globalThis.__imageReads)
  check(methods.length === 2 && methods.every(method => method === 'HEAD'), '重复读图只复核权限，不再下载图片体', methods)
  const userData = await app.evaluate(({ app }) => app.getPath('userData')), cache = await readdir(resolve(userData, 'note-images'))
  check(cache.length >= 2, '来源与笔记图片落入本机缓存', { files: cache.length })
  const exportDir = resolve(profile, 'export'); await mkdir(exportDir); await select(exportDir)
  const exported = await ipc('note.exportMarkdown'), file = (await readdir(exportDir)).find(name => name.startsWith(bundleTitle) && name.endsWith('.md'))
  if (!file) throw new Error(`Expected Markdown missing ${JSON.stringify(exported)}`)
  const roundtrip = await readFile(resolve(exportDir, file), 'utf8')
  check(roundtrip.includes('assets/') && !roundtrip.includes('/api/uploads/'), 'Markdown 导出将图片换成本地相对路径')
  check((await readdir(resolve(exportDir, 'assets'))).length > 0, '导出图片随正文落入 assets', exported)
  await sources(); await select(exportDir); const again = await ipc('source.bundleImport', { request: { version: 1, action: 'inspect', kind: 'folder' } })
  check(again.files >= 1 && again.issues.length === 0, '导出的 Markdown 和图片可再次完整识别', again.issues)
  await shot('sources-after-import')
  const brokenTitle = `导入回归-缺图-${stamp}`, broken = resolve(profile, '一份用于检查缺图提示和长文件夹名称换行的学习资料')
  await mkdir(broken)
  await writeFile(resolve(broken, `${brokenTitle}.md`), `# ${brokenTitle}\n\n${Array.from({ length: 7 }, (_, i) => `![缺图${i}](assets/未找到的图片${i}.png)`).join('\n\n')}`)
  await select(broken); await page.getByRole('button', { name: '采集新来源', exact: true }).click(); await page.getByRole('radio', { name: '带图的包', exact: true }).click(); await page.getByRole('button', { name: '选文件夹', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.capture-bundle__issues li').length === 7)
  check(await page.locator('.capture-bundle__issues li').count() === 7, '七条缺图问题完整保留在可滚动清单中')
  await shot('bundle-missing-images')
  await page.getByRole('button', { name: '收下这 1 篇', exact: true }).click(); await parsed(brokenTitle)
  check(await page.getByText('部分图片未能导入，点此查看', { exact: true }).count() === 1 && await page.getByText(/份材料未能收录/).count() === 0, '缺图收录保留正文并单独提示图片问题')
  await page.locator('.capture-report summary').click(); await shot('bundle-warning-receipt')
  const empty = resolve(profile, '没有 Markdown 的文件夹'); await mkdir(empty); await select(empty)
  await page.getByRole('button', { name: '采集新来源', exact: true }).click(); await page.getByRole('button', { name: '选文件夹', exact: true }).click()
  await page.getByText('没有找到可导入的 Markdown 正文，请选包含 .md 文件的材料。', { exact: true }).waitFor()
  check(!await page.getByRole('button', { name: '收下这 0 篇', exact: true }).isEnabled(), '空包说明下一步且禁用收录')
  await shot('bundle-empty')
  for (const preference of ['full', 'lite', 'off']) {
    await room(`room.setState({ motionMode: ${JSON.stringify(preference)}, reducedMotion: false })`)
    await page.evaluate(() => { const trigger = document.querySelector('.source-capture-trigger'); for (let i = 0; i < 8; i++) trigger.click() })
    await page.waitForFunction(() => document.querySelector('.source-capture-sheet')?.style.opacity === '1')
    check(await page.locator('.source-capture-sheet').evaluate(el => !el.inert) && await page.getByRole('button', { name: '选文件夹', exact: true }).isEnabled(), `${preference} 下快速反向开合最终保持可操作`)
  }
  await room('room.setState({ motionMode: "full", reducedMotion: true })')
  await page.waitForFunction(() => document.querySelector('.source-capture-sheet')?.style.transform === 'none')
  check(await page.locator('.source-capture-sheet').evaluate(el => el.style.transform) === 'none', '减少动态下导入附页直接就位')
  check(errors.length === 0, '无渲染进程未捕获异常', errors)
} catch (error) { check(false, '真实窗口往返', error.stack); await shot('failure').catch(() => {}) }
finally {
  if (process.env.ASTELLA_QA_HOLD === '1') { console.log('保留验收窗口 45 秒'); await page.waitForTimeout(45_000) }
  for (const noteId of createdNotes) await ipc('note.delete', { noteId }).catch(() => {})
  for (const sourceId of createdSources) await ipc('source.archive', { sourceId }).catch(() => {})
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2))
  await app.close(); await server.close()
}
if (checks.some(item => !item.ok)) process.exitCode = 1
