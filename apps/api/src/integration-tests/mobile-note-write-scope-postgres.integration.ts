/**
 * 手机会话不能改笔记正文（0413）——真实 Postgres + 真实登录 + 真实路由。
 *
 * 为什么必须真登录、真发请求：这道规则承诺的是**凭据**，不是请求头。源码里 grep
 * 一个 preHandler 名字证明不了它挂在哪儿、也证明不了 `decodeToken` 真的把那一位
 * 读了出来（`permission-guard.test.ts` 顶部记的就是这种守卫如何失效）。所以这里
 * 按产品形状走：`POST /auth/login` 带 `clientKind:'mobile'` 拿到 token → 拿这枚
 * token 打两条正文写入口 → 断 403；同一个账号再签一枚普通（桌面）token，
 * **同一份请求体**打同一个口 → 断 200。
 *
 * 正向对照用的是真的 yjs 增量（以库里那份快照为差集基准），不是随手编的字节：
 * 编的字节只会让两条路一起 4xx，"桌面端照常"就成了假绿。
 *
 * 环境：`DATABASE_URL_MIGRATOR`（夹具写用的超户串，见 doc 34 §1.2），
 * 被测一侧仍走 `db/client.ts` 自己的池。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import * as Y from "yjs";
import postgres from "postgres";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { checkpointNote, createNote } from "../modules/note/service.ts";
import { closeNoteCollaboration } from "../modules/note/collaboration.ts";
import { docFromSnapshot, editFragmentBlockText } from "../modules/note/doc-fragment.ts";
import { hashPassword, hashToken } from "../modules/identity/credentials.ts";
import { MemoryRateLimitStore } from "../lib/rate-limit-store.ts";

const CONN = testDatabaseUrl("DATABASE_URL_MIGRATOR");
const admin = postgres(CONN, { max: 3 });

const tag = randomUUID().slice(0, 8);
const userId = randomUUID();
const workspaceId = randomUUID();
const email = `mobile-scope-${tag}@example.test`;
const password = "mobile-scope-pw";

const { authRoutes } = await import("../modules/identity/routes.ts");
const { noteRoutes } = await import("../modules/note/routes.ts");

let app: FastifyInstance;
/** doc-update 会打开 Hocuspocus 直连，收尾要先把那些文档卸载掉。 */
let mobileToken = "";
let desktopToken = "";
/** 一篇只有当前版本（测增量上送）。 */
let noteId = "";
/** 两版的那篇（测版本恢复）。 */
let restoreNoteId = "";
let restoreFirstVersionId = "";

async function login(clientKind?: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password, ...(clientKind === undefined ? {} : { clientKind }) },
  });
  assert.equal(response.statusCode, 200, `登录必须 200，实际 ${response.statusCode}：${response.body}`);
  return response.json().token as string;
}

function asBearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * 库里那份快照的**增量**：以服务端 state vector 为差集基准，真客户端算的就是这个。
 * 用整篇快照上送会踩 `identity_mismatch`，那条路 4xx 而不是 200。
 */
async function incrementalUpdateFor(id: string, text: string): Promise<string> {
  const [row] = await admin`SELECT state FROM note_document_states WHERE note_id = ${id}`;
  assert.ok(row, `笔记 ${id} 没有文档快照，增量无从起点`);
  const server = docFromSnapshot(row.state as Uint8Array);
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
  editFragmentBlockText(local, 0, text);
  const update = Y.encodeStateAsUpdate(local, Y.encodeStateVector(server));
  server.destroy();
  local.destroy();
  return Buffer.from(update).toString("base64");
}

async function storedBody(id: string): Promise<string[]> {
  const rows = await admin`
    SELECT content FROM note_blocks
    WHERE version_id = (SELECT current_version_id FROM notes WHERE id = ${id})
    ORDER BY ordinal
  `;
  return rows.map((row) => String(row.content));
}

before(async () => {
  const passwordHash = await hashPassword(password);
  await admin.begin(async (tx) => {
    // 外键是**双向**的（`users.personal_workspace_id → workspaces`、
    // `workspaces.owner_id → users`），两条都不可延迟，所以只能先插不带空间的用户、
    // 建好空间再回填这一位。teardown 反向走同一条（先置 NULL 再删空间）。
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${email}, ${passwordHash}, 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES (${workspaceId}, ${`手机范围-${tag}`}, ${userId}, 'personal')`;
    await tx`UPDATE users SET personal_workspace_id = ${workspaceId} WHERE id = ${userId}`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
  });

  app = Fastify({ logger: false });
  await app.register(sensible);
  // 内存限流桶：这一份夹具要登录三次，不该去占 Postgres 那张跨副本计数表。
  await app.register(authRoutes, { rateLimitStore: new MemoryRateLimitStore(), rateLimitMaxAttempts: 100 });
  await app.register(noteRoutes);
  await app.ready();

  mobileToken = await login("mobile");
  desktopToken = await login();

  const created = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    createNote(tx, workspaceId, userId, {
      title: `手机范围 ${tag}`,
      blocks: [{ type: "paragraph", content: `正文甲 ${tag}` }],
    }),
  );
  assert.ok(created, "createNote 返回 null：笔记没有当前版本");
  noteId = created.note.id;

  const twoVersion = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    createNote(tx, workspaceId, userId, {
      title: `手机范围两版 ${tag}`,
      blocks: [{ type: "paragraph", content: `第一版正文 ${tag}` }],
    }),
  );
  assert.ok(twoVersion, "夹具没能建出那篇两版笔记");
  restoreNoteId = twoVersion.note.id;
  restoreFirstVersionId = twoVersion.version.id;
  // 开一个新版本，好让「恢复到第一版」真的是在换正文，而不是恢复当前版本自己。
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    checkpointNote(tx, restoreNoteId, workspaceId, userId, { baseVersionId: restoreFirstVersionId }),
  );
});

after(async () => {
  await closeNoteCollaboration().catch(() => {});
  for (const token of [mobileToken, desktopToken]) {
    if (!token) continue;
    await admin`DELETE FROM sessions WHERE token = ${hashToken(token)}`;
  }
  await app?.close().catch(() => {});
  // 删除顺序有硬约束：notes 级联带走 versions/blocks，先删子表会撞外键。
  await admin`DELETE FROM note_document_states WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM search_documents WHERE workspace_id = ${workspaceId}`;
  await admin`UPDATE users SET personal_workspace_id = NULL WHERE id = ${userId}`;
  await admin`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id = ${userId}`;
  const leftover = await admin`SELECT count(*)::int AS n FROM workspaces WHERE id = ${workspaceId}`;
  assert.equal(leftover[0].n, 0, `夹具残留了工作区 ${workspaceId}，teardown 顺序需要修`);
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

test("这一位落在凭据那一行上：手机签发的会话写的是 mobile", async () => {
  const rows = await admin`
    SELECT client_kind FROM sessions WHERE token IN (${hashToken(mobileToken)}, ${hashToken(desktopToken)})
  `;
  assert.equal(rows.length, 2, "两次登录应当各有一行会话");
  assert.deepEqual(
    [...new Set(rows.map((row) => row.client_kind))].sort(),
    ["desktop", "mobile"],
    `会话行里的种类应当各占一种，实际 ${JSON.stringify(rows.map((row) => row.client_kind))}`,
  );
});

test("手机会话：增量上送与版本恢复一律 403，理由说得出口", async () => {
  const update = await incrementalUpdateFor(noteId, `手机上敲的一行 ${tag}`);

  const docUpdate = await app.inject({
    method: "POST",
    url: `/v2/notes/${noteId}/doc-update`,
    headers: asBearer(mobileToken),
    payload: { update },
  });
  assert.equal(docUpdate.statusCode, 403, `手机改正文必须 403，实际 ${docUpdate.statusCode}：${docUpdate.body}`);
  assert.equal(docUpdate.json().error, "mobile_note_edit_forbidden");
  assert.match(docUpdate.json().message, /手机上/);

  const restore = await app.inject({
    method: "POST",
    url: `/notes/${restoreNoteId}/versions/${restoreFirstVersionId}/restore`,
    headers: asBearer(mobileToken),
    payload: {},
  });
  assert.equal(restore.statusCode, 403, `恢复版本也是改正文，必须 403，实际 ${restore.statusCode}：${restore.body}`);
  assert.equal(restore.json().error, "mobile_note_edit_forbidden");

  // 被挡的那一趟一个字都不该落库：403 之后正文还是原来那句。
  assert.deepEqual(await storedBody(noteId), [`正文甲 ${tag}`]);
});

test("同一枚手机 token，换一种请求头写法也还是 403", async () => {
  // 判据来自会话行。请求头这一路本来就没参与判定——把它带上打一次，是为了让
  // "以为抹掉头就绕过"有一个可跑的对照，而不是留成一句口头承诺。
  const update = await incrementalUpdateFor(noteId, `换个头的尝试 ${tag}`);
  const response = await app.inject({
    method: "POST",
    url: `/v2/notes/${noteId}/doc-update`,
    headers: { ...asBearer(mobileToken), "x-client-kind": "desktop", "content-type": "application/json" },
    payload: { update, clientKind: "desktop" },
  });
  assert.equal(response.statusCode, 403, `实际 ${response.statusCode}：${response.body}`);
  assert.equal(response.json().error, "mobile_note_edit_forbidden");
});

test("桌面会话照常：同一份请求体在桌面 token 上是 200", async () => {
  const update = await incrementalUpdateFor(noteId, `电脑上敲的一行 ${tag}`);
  const docUpdate = await app.inject({
    method: "POST",
    url: `/v2/notes/${noteId}/doc-update`,
    headers: asBearer(desktopToken),
    payload: { update },
  });
  assert.equal(docUpdate.statusCode, 200, `桌面改正文必须 200，实际 ${docUpdate.statusCode}：${docUpdate.body}`);
  assert.ok(Number.isInteger(docUpdate.json().revision));
  const body = await storedBody(noteId);
  assert.deepEqual(body, [`电脑上敲的一行 ${tag}`], "上送的增量没有真的落盘");

  const restore = await app.inject({
    method: "POST",
    url: `/notes/${restoreNoteId}/versions/${restoreFirstVersionId}/restore`,
    headers: asBearer(desktopToken),
    payload: {},
  });
  assert.equal(restore.statusCode, 200, `桌面恢复版本必须 200，实际 ${restore.statusCode}：${restore.body}`);
  assert.deepEqual(await storedBody(restoreNoteId), [`第一版正文 ${tag}`]);
});

test("挡的是正文写入，不是这篇笔记：读、建、列都照常", async () => {
  // 「手机上人不改正文」不等于手机上看不了、也新建不了。这一条把那道闸的范围钉住：
  // 只有改正文的两条口吃 403。
  const read = await app.inject({ method: "GET", url: `/v2/notes/${noteId}`, headers: asBearer(mobileToken) });
  assert.equal(read.statusCode, 200, `手机读笔记不得被挡，实际 ${read.statusCode}：${read.body}`);

  const created = await app.inject({
    method: "POST",
    url: "/notes",
    headers: asBearer(mobileToken),
    payload: { blocks: [{ type: "paragraph", content: `手机上新建的一篇 ${tag}` }] },
  });
  assert.equal(created.statusCode, 200, `手机新建笔记不得被挡，实际 ${created.statusCode}：${created.body}`);
  const newNoteId = created.json().note?.id as string;
  assert.ok(newNoteId, `新建没有回笔记 id：${created.body}`);
  await admin`DELETE FROM note_document_states WHERE note_id = ${newNoteId}`;
  await admin`DELETE FROM notes WHERE id = ${newNoteId}`;
});

test("clientKind 填了别的值一律 400，不会被归一成 desktop", async () => {
  for (const value of ["phone", "Desktop", null, 1]) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password, clientKind: value },
    });
    assert.equal(response.statusCode, 400, `${JSON.stringify(value)} 必须 400，实际 ${response.statusCode}：${response.body}`);
    assert.match(response.json().message ?? response.body, /clientKind/);
  }
});
