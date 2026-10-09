/*
 * 两个真客户端的在场走查（共享空间「谁在读 / 谁在写」）。
 *
 * 为什么必须两个真客户端：这一件事的每一半都只在跨进程时才成立——服务端那份在场登记
 * 判的是活连接、名字要从库里解析、列表页读的是 HTTP 那一发、笔记页那一排来自 WS awareness。
 * 单侧的桩件测不到"另一个人真的出现在这一排里"。
 *
 * 做法：
 *  1. 用一次性账号在**跑着的 dev api** 上开一间协作空间、一篇已共享的笔记；
 *  2. 起一个真 Electron 窗口（临时 profile，走界面登录）作为所有者；
 *  3. 第二个客户端用成员身份连上同一篇（`--second-window` 时起第二个真窗口，
 *     否则起一个协议级 provider，两者都是真连接）；
 *  4. 读窗口里那一排的 DOM 与截图，看名字是不是库里那一份、档位对不对。
 *
 * 用法（apps/desktop-client 下）：
 *   node scripts/probe-note-presence-two-clients.mjs --setup-only     # 只把夹具建出来
 *   node scripts/probe-note-presence-two-clients.mjs                  # 窗口 + provider
 *   node scripts/probe-note-presence-two-clients.mjs --second-window  # 窗口 + 窗口
 * 夹具写到 `outputs/note-presence-two-clients/fixture.json`，证据同目录。
 *
 * 只写这一对一次性账号与它们自己的空间，不动现有账号与空间。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfigFromFile, createServer } from 'vite';
import { _electron as electron } from '@playwright/test';
import './load-capture-env.mjs';

const API = process.env.ASTELLA_PROBE_API ?? 'http://127.0.0.1:4000';
const appRoot = resolve(import.meta.dirname, '..');
const evidence = resolve(appRoot, 'outputs/note-presence-two-clients');
mkdirSync(evidence, { recursive: true });
const fixturePath = join(evidence, 'fixture.json');
const tag = Math.random().toString(36).slice(2, 7);

async function call(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text) } catch { /* 原样带回 */ }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 200)}`);
  return json ?? text;
}

async function buildFixture() {
  const owner = await call('/auth/register-v2', {
    method: 'POST',
    body: { email: `presence-owner-${tag}@astella.local`, password: `pw-${tag}-x7`, displayName: `摊主 ${tag}` },
  });
  const member = await call('/auth/register-v2', {
    method: 'POST',
    body: { email: `presence-member-${tag}@astella.local`, password: `pw-${tag}-m4`, displayName: `读伴 ${tag}` },
  });
  const space = await call('/workspaces', { method: 'POST', token: owner.token, body: { name: `在场走查 ${tag}` } });
  const ownerInSpace = await call('/auth/switch-workspace', { method: 'POST', token: owner.token, body: { workspaceId: space.workspaceId } });
  const invite = await call('/invites', { method: 'POST', token: ownerInSpace.token, body: { role: 'member' } });
  const joined = await call('/auth/join-workspace', { method: 'POST', token: member.token, body: { inviteToken: invite.token } });
  // 加入之后那发回执的 token 仍挂在成员自己的个人空间上；不切进这一间，
  // 服务端按"这篇不属于你这个空间"拒掉连接（`onAuthenticate` 那一道）。
  const memberInSpace = await call('/auth/switch-workspace', { method: 'POST', token: joined.token ?? member.token, body: { workspaceId: space.workspaceId } });
  const memberToken = memberInSpace.token;
  const shared = await call('/notes', {
    method: 'POST', token: ownerInSpace.token,
    body: { title: `这篇已经共享给空间 ${tag}`, blocks: [{ type: 'paragraph', content: `在场走查用的正文 ${tag}` }] },
  });
  await call(`/v2/notes/${shared.note.id}/share-scope`, { method: 'PATCH', token: ownerInSpace.token, body: { shareScope: 'shared' } });
  const draft = await call('/notes', {
    method: 'POST', token: ownerInSpace.token,
    body: { title: `这一篇还没共享 ${tag}`, blocks: [{ type: 'paragraph', content: '只有作者看得见' }] },
  });
  const fixture = {
    tag, spaceId: space.workspaceId, spaceName: space.workspaceName,
    owner: { email: `presence-owner-${tag}@astella.local`, password: `pw-${tag}-x7`, displayName: `摊主 ${tag}`, token: ownerInSpace.token, userId: owner.user?.userId ?? null },
    member: { email: `presence-member-${tag}@astella.local`, password: `pw-${tag}-m4`, displayName: `读伴 ${tag}`, token: memberToken },
    sharedNoteId: shared.note.id, draftNoteId: draft.note.id,
    wsUrl: API.replace(/^http/, 'ws') + '/note-doc',
  };
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 1));
  return fixture;
}

function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

/** 第二客户端：真协议连接（与桌面主进程用的是同一个 provider）。 */
async function connectProviderClient(fixture, noteId, awareness) {
  const Y = await import('yjs');
  const { HocuspocusProvider } = await import('@hocuspocus/provider');
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: fixture.wsUrl, name: `note:${noteId}`, document: doc, token: fixture.member.token });
  await new Promise((ok, bad) => {
    provider.on('synced', ok);
    provider.on('authenticationFailed', () => bad(new Error('成员连不上这一篇')));
    setTimeout(() => bad(new Error('等待同步超时')), 15_000);
  });
  provider.awareness?.setLocalState(awareness);
  return { doc, provider };
}

/**
 * 那份首次 AI 使用协议是异步挂出来的（要等会话与空间投影都到位），而且带一层全屏遮罩，
 * 没收掉就点不到任何东西。这里轮询到它出现并收掉；一直不出现就直接走下一步。
 */
async function dismissConsent(page) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await page.locator('.guide-consent').count()) {
      await page.locator('.guide-consent__close').click({ timeout: 5_000 });
      await page.waitForSelector('.guide-consent', { state: 'detached', timeout: 8_000 });
      return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

/** 起一个真窗口：临时 profile + 界面登录 + 走进那间协作空间，返回 page。 */
async function openWindow(fixture, account, label, rendererPort) {
  const { tmpdir } = await import('node:os');
  const profile = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), `astella-presence-${label}-`));
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'));
  const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: rendererPort, strictPort: true } });
  await server.listen();
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`, '--no-sandbox'],
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${rendererPort}` },
    executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  });
  const page = await app.firstWindow();
  await page.waitForSelector('input[type="email"], input[name="email"], input[autocomplete="email"]', { timeout: 60_000 });
  await page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first().fill(account.email);
  await page.locator('input[type="password"]').first().fill(account.password);
  await page.getByRole('button', { name: /登录|进入|注册/ }).first().click();
  await page.waitForSelector('.room-control-space', { timeout: 60_000 });
  // 首次进来会摊开那份 AI 使用协议（带一层遮罩，不关掉就点不到任何东西）：
  // 这一趟不碰 AI，按右上角那颗「暂不签署，稍后继续」收掉。
  await dismissConsent(page);
  await page.waitForTimeout(400);
  // 换到那一间协作空间（新账号默认落在自己的个人空间，而个人空间里没有在场这回事）。
  await page.locator('.room-control-space').click();
  await page.waitForSelector('.hud-space-row', { timeout: 20_000 });
  await page.locator('.hud-space-row', { hasText: fixture.spaceName }).first().click();
  await page.waitForFunction((name) => document.querySelector('.room-control-space__text b')?.textContent === name,
    fixture.spaceName, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  return { app, page, server, profile };
}

/** 打开那篇已共享的笔记：走笔记列表那一排，点标题。 */
async function openSharedNote(page, fixture) {
  await dismissConsent(page);
  const title = `这篇已经共享给空间 ${fixture.tag}`;
  const open = page.getByRole('button', { name: new RegExp(title) }).first();
  // 「笔记」那颗在不同状态下落点不一样（书架抽屉 / 笔记库 / 上次的册页），所以按
  // 看得见的入口一层层试：全部笔记 → 那一篇。找不到就把这一屏带回去，不猜。
  for (const step of [
    async () => page.getByRole('button', { name: '笔记' }).first().click(),
    async () => page.getByRole('button', { name: /全部笔记/ }).first().click(),
  ]) {
    await step().catch(() => undefined);
    try {
      await open.waitFor({ timeout: 8_000 });
      break;
    } catch { /* 试下一层 */ }
  }
  if (!(await open.count())) {
    // 打不开就把这一屏能点的东西带回去：这一条走查的全部价值就在"真的看见了"，
    // 猜选择器只会把结论写虚。
    await page.screenshot({ path: join(evidence, 'stuck-after-notes.png') });
    const buttons = await page.evaluate(() => [...document.querySelectorAll('button')]
      .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 60));
    throw new Error(`点「笔记」之后找不到那篇笔记。可点的按钮：${JSON.stringify(buttons)}`);
  }
  const expand = page.getByRole('button', { name: '展开笔记列表' });
  if (await expand.count()) {
    await expand.first().click();
    await page.waitForTimeout(700);
  }
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await page.waitForSelector('.notebook-desk', { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

const presenceOf = (page) => page.evaluate(() => {
  const read = (root) => root ? {
    stamps: [...root.querySelectorAll('.notebook-presence__peer')].map((n) => ({ letter: n.textContent, label: n.getAttribute('aria-label') })),
    sentence: root.querySelector('.tag')?.textContent ?? null,
  } : null;
  return {
    rack: read(document.querySelector('.notebook-desk__presence')),
    meta: read(document.querySelector('.notebook-volume__meta .notebook-presence')),
    listRow: [...document.querySelectorAll('.notebook-note-list__readers')].map((n) => ({
      visible: n.textContent, full: n.getAttribute('aria-label'),
    })),
    ribbon: read(document.querySelector('.notebook-focus-ribbon__presence')),
  };
});

if (process.argv.includes('--setup-only')) {
  console.log(JSON.stringify(await buildFixture(), null, 1));
  process.exit(0);
}

let fixture;
if (!process.argv.includes('--fresh')) {
  try { fixture = loadFixture() } catch { fixture = null }
}
fixture ??= await buildFixture();
const report = { fixture: { tag: fixture.tag, spaceName: fixture.spaceName, sharedNoteId: fixture.sharedNoteId } };

const first = await openWindow(fixture, fixture.owner, 'owner', 5231);
await openSharedNote(first.page, fixture);
await first.page.screenshot({ path: join(evidence, '01-owner-alone.png') });
report.beforePeer = await presenceOf(first.page);

if (process.argv.includes('--second-window')) {
  const second = await openWindow(fixture, fixture.member, 'member', 5232);
  await openSharedNote(second.page, fixture);
  await second.page.screenshot({ path: join(evidence, '02-member-window.png') });
  report.memberWindow = await presenceOf(second.page);
  await first.page.bringToFront();
  await first.page.waitForTimeout(1500);
  report.afterSecondWindow = await presenceOf(first.page);
  await first.page.screenshot({ path: join(evidence, '03-owner-sees-member.png') });
  await second.app.close();
  await first.page.waitForTimeout(2000);
  report.afterPeerLeft = await presenceOf(first.page);
  await second.server.close();
} else {
  const peer = await connectProviderClient(fixture, fixture.sharedNoteId, { mode: 'editing', block: 0 });
  await first.page.waitForTimeout(1800);
  report.withPeer = await presenceOf(first.page);
  await first.page.screenshot({ path: join(evidence, '03-owner-sees-peer.png') });
  // 全屏那一档：册页页眉那条 meta 在样式里是收起来的，这一排改挂常驻纸签——
  // 这一条是用户点名要的，只有真窗口能证明它真的在屏上。
  await first.page.getByRole('button', { name: /全屏笔记|全屏/ }).first().click();
  await first.page.waitForTimeout(1500);
  report.fullscreen = await presenceOf(first.page);
  report.fullscreenMetaHidden = await first.page.evaluate(() => {
    const meta = document.querySelector('.notebook-volume__meta');
    return meta ? getComputedStyle(meta).display : null;
  });
  await first.page.screenshot({ path: join(evidence, '06-fullscreen.png') });
  await first.page.keyboard.press('Escape');
  await first.page.waitForTimeout(1200);
  // 列表那一行：别人在开的那一篇，行上要多出那一格。
  await first.page.getByRole('button', { name: '展开笔记列表' }).click();
  await first.page.waitForTimeout(2200);
  report.listWithPeer = await presenceOf(first.page);
  await first.page.screenshot({ path: join(evidence, '04-list-with-peer.png') });
  await peer.provider.destroy();
  await first.page.waitForTimeout(2200);
  report.afterPeerLeft = await presenceOf(first.page);
  report.listAfterPeerLeft = await presenceOf(first.page);
  await first.page.screenshot({ path: join(evidence, '05-after-peer-left.png') });
}
await first.server.close();
await first.app.close();
writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(0);
