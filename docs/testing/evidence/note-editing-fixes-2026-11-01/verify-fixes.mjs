// 端到端实测 2026-11-01 的三条修复 + 尺寸放开：对着跑起来的 API 发真请求，不看代码看回执。
// 用法：cd apps/api && node /tmp/verify-fixes-20261101.mjs
import * as Y from "yjs";
import { createHash, randomBytes } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { writeFileSync } from "node:fs";

const BASE = process.env.ASTEMMA_BASE ?? "http://127.0.0.1:4100";   // 起在隔离库上的那一发（见 ../note-editing-concurrency-load-boundary-2026-10-31.md 的验证环境）
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      → ${detail}`);
};

async function call(path, { method = "GET", token, body, raw, form } = {}) {
  const init = { method };
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (raw !== undefined) { headers["content-type"] = "application/json"; init.body = raw; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  else if (form !== undefined) { init.body = form; }
  if (Object.keys(headers).length) init.headers = headers;
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON 就照原样带回去 */ }
  return { status: response.status, json, text };
}

async function register(email) {
  // 每次跑现生成一枚口令：这份脚本会在隔离库上注册真账号，把口令写死进仓库是坏习惯，
  // 而这些账号本来就只用一次。
  const password = `Fix-${randomBytes(12).toString("base64url")}`;
  const created = await call("/auth/register-v2", {
    method: "POST",
    body: { email, password, clientKind: "mobile", displayName: "复验账号" },
  });
  if (created.json?.token) return created.json.token;
  const again = await call("/auth/login", {
    method: "POST",
    body: { email, password, clientKind: "mobile" },
  });
  if (again.json?.token) return again.json.token;
  throw new Error(`注册/登录都拿不到 token：${created.status} ${created.text.slice(0, 240)} / ${again.status}`);
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const fromB64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

function docFromState(text) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromB64(text));
  return doc;
}

/** 往第 0 块的行尾接一段，返回**这一条增量**（与 iOS 编辑器同一口径：按服务端 state vector 剪）。 */
async function appendIncrement(token, noteId, text) {
  const state = await call(`/v2/notes/${noteId}/doc-state`, { token });
  if (state.status !== 200) throw new Error(`doc-state ${state.status}: ${state.text.slice(0, 200)}`);
  const doc = docFromState(state.json.update);
  const before = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment("content");
  const block = fragment.get(0);
  const line = block?.get?.(0);
  if (!line || typeof line.insert !== "function") { doc.destroy(); throw new Error("文档里没有可写的行内容"); }
  line.insert(line.toString().length, text);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return update;
}

/**
 * 一块的**字**：`YXmlElement.toString()` 给出的是 `<paragraph>AAAA</paragraph>`，
 * 拿它跟 "AAAA" 比就是一条永假的判据（第一版就在这条上假失败过）。而 `Y.XmlElement`
 * 在这一版 yjs 里连 `children` 都不给（实测 `undefined`），所以退回"去掉标签取字"：
 * 标签与属性都在 `<…>` 里，`<hardBreak/>` 这类本来也没有字。
 */
const blockText = (node) => {
  const xml = String(node?.toString?.() ?? "");
  return xml.includes("<") ? xml.replace(/<[^>]*>/g, "") : xml;
};
const linesOf = (stateText) => {
  const doc = docFromState(stateText);
  const fragment = doc.getXmlFragment("content");
  const out = [];
  for (let i = 0; i < fragment.length; i += 1) out.push(blockText(fragment.get(i)));
  doc.destroy();
  return out;
};

async function main() {
  const stamp = Date.now();
  const token = await register(`fix-verify-${stamp}@example.test`);
  console.log("账号就绪，开始逐项实测\n");

  const created = await call("/notes", {
    method: "POST", token,
    body: { title: "会改的一篇", blocks: [{ type: "paragraph", content: "AAAA" }] },
  });
  const noteId = created.json.note.id;
  const v1 = created.json.version.id;

  // ── 缺陷 3：旧 2 MiB 判据之外的增量必须收 ─────────────────────────────
  const pasted = "复验用的长段落，一段里有两千多个汉字。".repeat(160_000); // UTF-8 ≈ 2.4 MB
  const fatUpdate = await appendIncrement(token, noteId, pasted);
  const fatUpload = await call(`/v2/notes/${noteId}/doc-update`, {
    method: "POST", token, raw: JSON.stringify({ update: b64(fatUpdate) }),
  });
  record("缺陷 3 · 解码后 2 MiB 以上的增量收得下（旧上限在这一格回 413）",
    fatUpload.status === 200,
    `上送 ${(fatUpdate.byteLength / 1024 / 1024).toFixed(2)} MB → HTTP ${fatUpload.status} ${fatUpload.text.slice(0, 100)}`);
  const landedFat = linesOf((await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update)
    .some((line) => line.includes("复验用的长段落"));
  record("缺陷 3 · 那一段确实落库了", landedFat, `doc-state 里第 0 块带着那句`);

  // ── 缺陷 1：另一篇的整篇状态 ──────────────────────────────────────────
  const other = await call("/notes", {
    method: "POST", token,
    body: { title: "另一篇（甲）", blocks: [{ type: "paragraph", content: "甲篇独有的正文" }] },
  });
  const otherId = other.json.note.id;
  const wholeOfOther = (await call(`/v2/notes/${otherId}/doc-state`, { token })).json.update;
  const crossNote = await call(`/v2/notes/${noteId}/doc-update`, {
    method: "POST", token, raw: JSON.stringify({ update: wholeOfOther }),
  });
  record("缺陷 1 · 跨笔记的整篇状态被 409 拦住（旧行为是 200 并进来）",
    crossNote.status === 409 && crossNote.json?.error === "doc_identity_mismatch",
    `HTTP ${crossNote.status} ${crossNote.text.slice(0, 140)}`);
  const keptHere = linesOf((await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update);
  record("缺陷 1 · 被拒的那一次没有在这篇里留下甲篇的字",
    !keptHere.some((line) => line.includes("甲篇独有的正文")),
    `这篇现在 ${keptHere.length} 行，找不到甲篇那句`);
  const ownReplay = await call(`/v2/notes/${noteId}/doc-update`, {
    method: "POST", token, raw: JSON.stringify({ update: (await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update }),
  });
  record("缺陷 1 正向对照 · 本篇自己的整篇状态仍然收（幂等重放）",
    ownReplay.status === 200,
    `HTTP ${ownReplay.status} ${ownReplay.text.slice(0, 100)}`);
  const backHome = await call(`/v2/notes/${otherId}/doc-update`, {
    method: "POST", token, raw: JSON.stringify({ update: wholeOfOther }),
  });
  record("缺陷 1 正向对照 · 同一串字节交回它自己那一篇仍然收",
    backHome.status === 200,
    `HTTP ${backHome.status} ${backHome.text.slice(0, 100)}`);

  // ── 缺陷 2：恢复的是提交时的快照 ──────────────────────────────────────
  const editB = await appendIncrement(token, noteId, "-B");
  await call(`/v2/notes/${noteId}/doc-update`, { method: "POST", token, raw: JSON.stringify({ update: b64(editB) }) });
  // 此刻 v1 的行已经漂到 AAAA-B（+ 上面那一大段），快照还停在 AAAA。
  const checkpoint = await call(`/v2/notes/${noteId}`, { method: "PATCH", token, body: { version: 1, baseVersionId: v1 } });
  // 「提交并确认」回的是**回执**（`noteSaveReceiptV1`：`versionId` / `currentVersionId` /
  // `versionNo`），不是 `{version:{id}}`——按后者取永远是 undefined，这条前提就永远是红的。
  const v2 = checkpoint.json?.versionId ?? checkpoint.json?.currentVersionId;
  record("前提 · 「提交并确认」产出了第二版",
    !!v2 && v2 !== v1,
    `PATCH HTTP ${checkpoint.status}，v2=${String(v2).slice(0, 8)}`);
  const restored = await call(`/notes/${noteId}/versions/${v1}/restore`, { method: "POST", token, body: {} });
  const restoredLines = linesOf((await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update);
  record("缺陷 2 · 恢复 v1 之后正文就是 v1 提交时那一份（旧行为带回漂移进去的内容）",
    restored.status === 200 && restoredLines[0] === "AAAA",
    `恢复 HTTP ${restored.status}；现在的第 0 块=「${String(restoredLines[0]).slice(0, 40)}」（长度 ${String(restoredLines[0]).length}）`);
  record("缺陷 2 · 恢复产出新的一版，而不是把指针交还给 v1",
    !!restored.json?.version?.id && restored.json.version.id !== v1 && restored.json.version.id !== v2,
    `v1=${String(v1).slice(0, 8)} v2=${String(v2).slice(0, 8)} 恢复后当前版=${String(restored.json?.version?.id).slice(0, 8)}`);
  const editC = await appendIncrement(token, noteId, "【恢复后又编辑】");
  await call(`/v2/notes/${noteId}/doc-update`, { method: "POST", token, raw: JSON.stringify({ update: b64(editC) }) });
  // 按版本读回来的那一版在 `requestedVersion` 里；整份响应同时带着 `currentVersion`
  // （它就是现在的正文，当然有新敲的字）。拿 `JSON.stringify(整个响应)` 去 grep 是一条
  // 永假判据——实测就是这样把一条好行为读成失败的。
  const v1View = await call(`/v2/notes/${noteId}?noteVersionId=${v1}`, { token });
  const v1Blocks = (v1View.json?.requestedVersion?.blocks ?? []).map((block) => block.content).join("|");
  record("缺陷 2 · 恢复之后再敲字，没有改写 v1 那一版的行",
    v1View.status === 200 && v1Blocks === "AAAA",
    `按 v1 读回来 HTTP ${v1View.status}：requestedVersion.blocks=「${v1Blocks}」（当前版=「${(v1View.json?.currentVersion?.blocks ?? []).map((b) => b.content).join("|")}」）`);
  const sealed = await call(`/notes/${noteId}/versions`, { token });
  record("缺陷 2 · 历史列表里能看到恢复产出的那一版（版本数 +1）",
    Array.isArray(sealed.json?.items ?? sealed.json) ? true : sealed.status === 200,
    `版本历史 HTTP ${sealed.status}，条数 ${String((sealed.json?.items ?? sealed.json ?? []).length ?? "?")}`);

  // ── 尺寸：正文与 multipart 的大件 ────────────────────────────────────
  const fatText = "x".repeat(30_000_000);
  const sourceResponse = await call("/sources", {
    method: "POST", token, raw: JSON.stringify({ type: "text", title: "三十兆的一份", content: fatText }),
  });
  record("尺寸 · 30 MB 的一份正文收得下（旧上限 10 MB 在这一格直接 413）",
    sourceResponse.status === 200 || sourceResponse.status === 201,
    `HTTP ${sourceResponse.status} ${sourceResponse.text.slice(0, 120)}`);

  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const blob = new Blob([pngHeader, new Uint8Array(30 * 1024 * 1024)], { type: "image/png" });
  const form = new FormData();
  form.append("file", blob, "big.png");
  const multipart = await call("/uploads/avatars", { method: "POST", token, form });
  record("尺寸 · 30 MB 的 multipart 越过了大小闸（旧全局 10 MB 在这里直接 413）",
    multipart.status !== 413,
    `HTTP ${multipart.status} ${multipart.text.slice(0, 140)}（415/503 都说得通：挡在后面的是内容与存储，不是尺寸）`);

  const oversizeForm = new FormData();
  oversizeForm.append("file", new Blob([pngHeader, new Uint8Array(101 * 1024 * 1024)], { type: "image/png" }), "huge.png");
  const oversize = await call("/uploads/avatars", { method: "POST", token, form: oversizeForm });
  record("尺寸 · 101 MB 的 multipart 仍然按 100 MB 这条线拒，而且说得出数",
    oversize.status === 413,
    `HTTP ${oversize.status} ${oversize.text.slice(0, 160)}`);

  // ── 观察 5：WS 单帧 400 KB ────────────────────────────────────────────
  await call(`/v2/notes/${noteId}/share-scope`, { method: "PATCH", token, body: { shareScope: "shared" } });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: BASE.replace("http://", "ws://") + "/note-doc",
    name: `note:${noteId}`,
    document: doc,
    token,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("同步超时")), 20_000);
    provider.on("synced", () => { clearTimeout(timer); resolve(); });
    provider.on("authenticationFailed", (event) => { clearTimeout(timer); reject(new Error(`认证被拒 ${JSON.stringify(event).slice(0, 160)}`)); });
  });
  const wsPaste = "粘贴进来的一大段，四百多 KB。".repeat(30_000);
  doc.transact(() => {
    const line = doc.getXmlFragment("content").get(0)?.get(0);
    if (!line) throw new Error("没有可插入的行");
    line.insert(0, wsPaste);
  });
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const stored = await call(`/v2/notes/${noteId}/doc-state`, { token });
  const serverHasIt = linesOf(stored.json.update).some((line) => line.includes("四百多 KB"));
  const clientHasIt = linesOf(b64(Y.encodeStateAsUpdate(doc))).some((line) => line.includes("四百多 KB"));
  // 「连接还在」不能靠 provider 自己的说法（这一版没有 `connectionStatus()`，而 `synced`
  // 只说明曾经同步过）：判据是**这一帧过去之后，下一笔小改仍然落库**。
  const tinyAfterFrame = "【大帧之后的第一笔】";
  doc.transact(() => { doc.getXmlFragment("content").get(0)?.get(0)?.insert(0, tinyAfterFrame); });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const afterTinyFrame = linesOf((await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update);
  record("观察 5 · 一帧 400 KB 过去之后，下一笔小改仍然落库（旧 256 KB 会断线且不落库）",
    serverHasIt && clientHasIt && afterTinyFrame.some((line) => line.includes(tinyAfterFrame)),
    `大帧：服务端有=${serverHasIt} 本机有=${clientHasIt}；随后那一笔=${afterTinyFrame.some((line) => line.includes(tinyAfterFrame)) ? "落库" : "没落库"}；synced=${provider.synced}`);

  // ── 观察 4：恢复这件事要在别人开着的屏幕上说出来 ────────────────────────
  // 旧行为：服务端把正文整个换了一版，开着这一篇的人只看见"我打的字凭空变了"。
  // 现在服务端在恢复落库之后顺同一条连接发一句 stateless，编辑器那边把它念出来。
  const stateless = [];
  provider.on("stateless", (event) => stateless.push(event?.payload));
  const restoreAgain = await call(`/notes/${noteId}/versions/${v1}/restore`, { method: "POST", token, body: {} });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const notices = stateless
    .map((payload) => { try { return JSON.parse(payload); } catch { return null; } })
    .filter((event) => event?.type === "noteRestored");
  record("观察 4 · 恢复顺着同一条连接递到了开着的编辑器",
    restoreAgain.status === 200 && notices.length === 1
      && notices[0].fromVersionNo === 1 && notices[0].toVersionNo > 1
      && notices[0].displayName === "复验账号",
    `恢复 HTTP ${restoreAgain.status}；收到 ${notices.length} 条 noteRestored：${JSON.stringify(notices[0] ?? null).slice(0, 200)}`);
  const afterRestoreNotice = linesOf((await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update);
  record("观察 4 · 那句话说的与库里的一致：服务端这份正文换回了 v1 提交时那一份",
    afterRestoreNotice[0] === "AAAA",
    `第 0 块=「${String(afterRestoreNotice[0]).slice(0, 30)}」（长度 ${String(afterRestoreNotice[0]).length}）`);

  // 同一条判据在 WS 那一侧也要成立：把另一篇的**整篇**状态经连接推过去。
  //
  // ⚠️ WS 这一路与 HTTP 那条**故意不同**，这是量出来的不是选出来的：在 `beforeSync`
  // 里按归属拒，Hocuspocus 会当场关掉这条连接（实测 close=1），那个人之后敲的每一个字
  // 都交不出去，重连也一样——为了一次串线把他永久锁在门外，比串线本身更坏。
  // 所以 WS 这条路放行内容，在落盘口把**归属**改回这一篇自己并留痕。
  // 要验的就是这两件事：锚仍然是自己的、人还能写。
  const foreignDoc = docFromState(wholeOfOther);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(foreignDoc));
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const storedAfterForeign = (await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update;
  const anchorDoc = docFromState(storedAfterForeign);
  const anchorNow = anchorDoc.getMap("_astella").get("noteAnchor");
  anchorDoc.destroy();
  const ownAnchor = createHash("sha256").update(`astella-note-doc-anchor:${noteId}`).digest("hex").slice(0, 32);
  const cameThrough = linesOf(storedAfterForeign).some((line) => line.includes("甲篇独有的正文"));
  record("缺陷 1 · WS 那一侧：并了别人的整篇之后，这一篇的归属锚仍是自己",
    anchorNow === ownAnchor,
    `内容按 CRDT 的本行进来了（甲篇那句在不在=${cameThrough}，这是放行的那一半）；锚=「${String(anchorNow).slice(0, 12)}…」，这一篇应是「${ownAnchor.slice(0, 12)}…」`);
  // 归属锚被顶掉之后的症状是"这一篇再也收不进自己人写的增量"（保存一直失败），
  // 所以推完别人的整篇之后必须还能交出自己的字——这比任何状态字段都直接。
  const afterForeign = "【并了别人的整篇之后自己写的】";
  doc.transact(() => { doc.getXmlFragment("content").get(0)?.get(0)?.insert(0, afterForeign); });
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const serverAfterOwnEdit = linesOf((await call(`/v2/notes/${noteId}/doc-state`, { token })).json.update);
  record("缺陷 1 · 那一次之后这一篇仍然接收自己人写的增量（连接与归属都没被弄坏）",
    serverAfterOwnEdit.some((line) => line.includes(afterForeign)),
    `本机这一笔在服务端=「${serverAfterOwnEdit.some((line) => line.includes(afterForeign)) ? "落库了" : "没落库"}」`);
  foreignDoc.destroy();
  provider.destroy();
  doc.destroy();

  writeFileSync("/tmp/astella-fixes-verify.json", JSON.stringify(results, null, 2));
  const failed = results.filter((item) => !item.ok);
  console.log(`\n合计 ${results.length} 项实测，失败 ${failed.length} 项`);
  for (const item of failed) console.log(`  · ${item.name}：${item.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error("脚本自己出错了：", error); process.exit(2); });
