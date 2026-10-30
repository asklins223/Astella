// 手机与桌面按空间权限自由编辑：真实登录、CRDT 增量、保存和只读成员。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import * as Y from "yjs";
import postgres from "postgres";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { checkpointNote, createNote } from "../modules/note/service.ts";
import { closeNoteCollaboration, openNotePresenceSlot, closeNotePresenceSlot } from "../modules/note/collaboration.ts";
import { canReadAvatarObject } from "../modules/upload/avatar-access.ts";
import { docFromSnapshot, editFragmentBlockText } from "../modules/note/doc-fragment.ts";
import { hashPassword, hashToken } from "../modules/identity/credentials.ts";
import { MemoryRateLimitStore } from "../lib/rate-limit-store.ts";

const CONN = testDatabaseUrl("DATABASE_URL_MIGRATOR");
const admin = postgres(CONN, { max: 3 });

const tag = randomUUID().slice(0, 8);
const userId = randomUUID();
const workspaceId = randomUUID();
const memberId = randomUUID();
const memberEmail = `mobile-member-${tag}@example.test`;
const email = `mobile-scope-${tag}@example.test`;
const password = "mobile-scope-pw";

const { authRoutes } = await import("../modules/identity/routes.ts");
const { noteRoutes } = await import("../modules/note/routes.ts");

let app: FastifyInstance;
/** doc-update 会打开 Hocuspocus 直连，收尾要先把那些文档卸载掉。 */
let mobileToken = "";
let desktopToken = "";
let memberToken = "";
/** 一篇只有当前版本（测增量上送）。 */
let noteId = "";
/** 两版的那篇（测版本恢复）。 */
let restoreNoteId = "";
let restoreFirstVersionId = "";

async function login(clientKind?: string, accountEmail = email): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: accountEmail, password, ...(clientKind === undefined ? {} : { clientKind }) },
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
async function incrementalUpdateFor(id: string, text: string, ordinal = 0): Promise<string> {
  const [row] = await admin`SELECT state FROM note_document_states WHERE note_id = ${id}`;
  assert.ok(row, `笔记 ${id} 没有文档快照，增量无从起点`);
  const server = docFromSnapshot(row.state as Uint8Array);
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
  editFragmentBlockText(local, ordinal, text);
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
    await tx`INSERT INTO users (id, email, password_hash, role, personal_workspace_id)
      VALUES (${memberId}, ${memberEmail}, ${passwordHash}, 'member', ${workspaceId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${memberId}, 'member')`;
  });

  app = Fastify({ logger: false });
  await app.register(sensible);
  // 内存限流桶：这一份夹具要登录三次，不该去占 Postgres 那张跨副本计数表。
  await app.register(authRoutes, { rateLimitStore: new MemoryRateLimitStore(), rateLimitMaxAttempts: 100 });
  await app.register(noteRoutes);
  await app.ready();

  mobileToken = await login("mobile");
  desktopToken = await login();
  memberToken = await login("mobile", memberEmail);

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
  for (const token of [mobileToken, desktopToken, memberToken]) {
    if (!token) continue;
    await admin`DELETE FROM sessions WHERE token = ${hashToken(token)}`;
  }
  await app?.close().catch(() => {});
  // 删除顺序有硬约束：notes 级联带走 versions/blocks，先删子表会撞外键。
  await admin`DELETE FROM note_document_states WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM search_documents WHERE workspace_id = ${workspaceId}`;
  await admin`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${userId}, ${memberId})`;
  await admin`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id IN (${userId}, ${memberId})`;
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

test("mobile owner can edit the CRDT body and restore saved versions", async () => {
  const update = await incrementalUpdateFor(noteId, `手机上敲的一行 ${tag}`);

  const docUpdate = await app.inject({
    method: "POST",
    url: `/v2/notes/${noteId}/doc-update`,
    headers: asBearer(mobileToken),
    payload: { update },
  });
  assert.equal(docUpdate.statusCode, 200, docUpdate.body);
  assert.deepEqual(await storedBody(noteId), [`手机上敲的一行 ${tag}`]);
  const metadata = await app.inject({ method: "GET", url: `/v2/notes/${noteId}/editing-state`, headers: asBearer(mobileToken) });
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.equal(metadata.json().canEdit, true);
  assert.equal(metadata.json().lastEditor.userId, userId);


  const beforeVersions = await admin`SELECT count(*)::int AS n FROM note_versions WHERE note_id = ${restoreNoteId}`;
  const restore = await app.inject({
    method: "POST",
    url: `/notes/${restoreNoteId}/versions/${restoreFirstVersionId}/restore`,
    headers: asBearer(mobileToken), payload: {},
  });
  assert.equal(restore.statusCode, 200, `mobile owner saved-version restore must succeed: ${restore.body}`);
  const [current] = await admin`SELECT current_version_id FROM notes WHERE id = ${restoreNoteId}`;
  const afterVersions = await admin`SELECT count(*)::int AS n FROM note_versions WHERE note_id = ${restoreNoteId}`;
  assert.equal(current.current_version_id, restoreFirstVersionId);
  assert.equal(afterVersions[0].n, beforeVersions[0].n, "restore switches the pointer without making a new version");


});

test("mobile members cannot restore a note version", async () => {
  const restore = await app.inject({ method: "POST", url: `/notes/${restoreNoteId}/versions/${restoreFirstVersionId}/restore`, headers: asBearer(memberToken), payload: {} });
  assert.equal(restore.statusCode, 403);
  assert.equal(restore.json().error, "owner role required");
});

test("mobile owner restore retains the version conflict guard", async () => {
  const response = await app.inject({ method: "POST", url: `/notes/${restoreNoteId}/versions/${restoreFirstVersionId}/restore`, headers: asBearer(mobileToken), payload: { baseVersionId: randomUUID() } });
  assert.equal(response.statusCode, 409);
});

test("手机成员即使自报 desktop 也不能写", async () => {
  // 判据来自会话行。请求头这一路本来就没参与判定——把它带上打一次，是为了让
  // "以为抹掉头就绕过"有一个可跑的对照，而不是留成一句口头承诺。
  const update = await incrementalUpdateFor(noteId, `换个头的尝试 ${tag}`);
  const response = await app.inject({
    method: "POST",
    url: `/v2/notes/${noteId}/doc-update`,
    headers: { ...asBearer(memberToken), "x-client-kind": "desktop", "content-type": "application/json" },
    payload: { update, clientKind: "desktop" },
  });
  assert.equal(response.statusCode, 403, `实际 ${response.statusCode}：${response.body}`);
  assert.equal(response.json().error, "owner role required");
  const metadata = await app.inject({ method: "GET", url: `/v2/notes/${noteId}/editing-state`, headers: asBearer(memberToken) });
  assert.equal(metadata.statusCode, 404, "a private note's collaboration metadata stays private");
});

test("shared-note metadata carries published avatars and author-only sharing controls", async () => {
  const path = `avatars/${userId}/${randomUUID()}.png`;
  await admin`UPDATE workspaces SET workspace_type = 'collaborative' WHERE id = ${workspaceId}`;
  await admin`UPDATE users SET avatar_url = ${"/api/uploads/" + path} WHERE id = ${userId}`;
  await admin`UPDATE notes SET last_edited_by = ${userId}, last_edited_at = now() WHERE id = ${noteId}`;
  openNotePresenceSlot({ noteId, workspaceId, userId, displayName: "最近编辑者" });
  try {
    const share = await app.inject({ method: "PATCH", url: `/v2/notes/${noteId}/share-scope`, headers: asBearer(mobileToken), payload: { shareScope: "shared" } });
    assert.equal(share.statusCode, 200, share.body);
    const owner = await app.inject({ method: "GET", url: `/v2/notes/${noteId}/editing-state`, headers: asBearer(mobileToken) });
    assert.equal(owner.json().canManageSharing, true);
    assert.equal(owner.json().workspaceType, "collaborative");
    assert.equal(owner.json().lastEditor.avatarUrl, "/api/uploads/" + path);
    const member = await app.inject({ method: "GET", url: `/v2/notes/${noteId}/editing-state`, headers: asBearer(memberToken) });
    assert.equal(member.statusCode, 200, member.body);
    assert.equal(member.json().canManageSharing, false);
    assert.equal(member.json().canEdit, false);
    assert.equal(member.json().viewers.find((person: { userId: string }) => person.userId === userId).avatarUrl, "/api/uploads/" + path);
    const denied = await app.inject({ method: "PATCH", url: `/v2/notes/${noteId}/share-scope`, headers: asBearer(memberToken), payload: { shareScope: "private" } });
    assert.equal(denied.statusCode, 404);
    const unshare = await app.inject({ method: "PATCH", url: `/v2/notes/${noteId}/share-scope`, headers: asBearer(mobileToken), payload: { shareScope: "private" } });
    assert.equal(unshare.statusCode, 200, unshare.body);
    const hidden = await app.inject({ method: "GET", url: `/v2/notes/${noteId}/editing-state`, headers: asBearer(memberToken) });
    assert.equal(hidden.statusCode, 404);
  } finally {
    closeNotePresenceSlot(noteId, userId);
    await admin`UPDATE notes SET share_scope = 'private' WHERE id = ${noteId}`;
    await admin`UPDATE users SET avatar_url = NULL WHERE id = ${userId}`;
    await admin`UPDATE workspaces SET workspace_type = 'personal' WHERE id = ${workspaceId}`;
  }
});

test("room avatars expose only a current member's currently published picture", async () => {
  const path = `avatars/${userId}/${randomUUID()}.png`, scope = { userId: memberId, workspaceId };
  await admin`UPDATE users SET avatar_url = ${"/api/uploads/" + path} WHERE id = ${userId}`;
  try {
    assert.equal(await canReadAvatarObject(scope, path), false, "personal rooms do not publish another user's avatar");
    await admin`UPDATE workspaces SET workspace_type = 'collaborative' WHERE id = ${workspaceId}`;
    assert.equal(await canReadAvatarObject(scope, path), true);
    assert.equal(await canReadAvatarObject(scope, `avatars/${userId}/old.png`), false);
    assert.equal(await canReadAvatarObject({ ...scope, userId: randomUUID() }, path), false);
    await admin`UPDATE workspace_members SET left_at = now() WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
    assert.equal(await canReadAvatarObject(scope, path), false);
  } finally {
    await admin`UPDATE workspace_members SET left_at = NULL WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
    await admin`UPDATE users SET avatar_url = NULL WHERE id = ${userId}`;
    await admin`UPDATE workspaces SET workspace_type = 'personal' WHERE id = ${workspaceId}`;
  }
});

test("new rich-text notes expose readable automatic titles and library snippets", async () => {
  for (const [content, title, snippet] of [
    ["| | |\n| --- | --- |\n| | |", "无标题笔记", null],
    ["**实际标题** [链接](https://example.test)", "实际标题 链接", "实际标题 链接"],
  ] as const) {
    const response = await app.inject({ method: "POST", url: "/notes", headers: asBearer(mobileToken), payload: { blocks: [{ type: "paragraph", content }] } });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().note.id;
    assert.equal(response.json().note.title, title);
    const list = await app.inject({ method: "GET", url: "/notes", headers: asBearer(mobileToken) });
    const row = list.json().items.find((item: { id: string }) => item.id === id);
    assert.equal(row?.snippet, snippet);
    assert.equal(row?.hasBody, snippet !== null);
  }
});

test("paragraph rewrite locks reject conflicting saves, allow other paragraphs and release after every terminal outcome", async () => {
  const created = await withWorkspaceTransaction({ workspaceId, userId }, tx => createNote(tx, workspaceId, userId, {
    title: "段落锁实际调用链", blocks: [{ type: "paragraph", content: "正在改写的原文" }, { type: "paragraph", content: "仍可编辑的原文" }],
  }));
  assert.ok(created);
  const target = created.note.id, conversationId = randomUUID(), messageId = randomUUID(), runId = randomUUID();
  await admin`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq,next_event_seq,next_generation)
    VALUES(${conversationId},${workspaceId},${userId},'dialogue','段落改写','user','active',2,1,2)`;
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
    VALUES(${messageId},${workspaceId},${userId},${conversationId},1,'user','text','[]'::jsonb,${'0'.repeat(64)})`;
  await admin`INSERT INTO companion_turn_runs(id,workspace_id,user_id,conversation_id,user_message_id,generation,status,idempotency_key_hash,request_body_hash)
    VALUES(${runId},${workspaceId},${userId},${conversationId},${messageId},1,'running',${'1'.repeat(64)},${'2'.repeat(64)})`;
  try {
    for (const status of ["succeeded", "failed", "cancelled"]) {
      await admin`UPDATE companion_turn_runs SET status='running' WHERE id=${runId}`;
      const lockId = randomUUID();
      const held = await app.inject({ method: "POST", url: `/v2/notes/${target}/edit-locks`, headers: asBearer(mobileToken),
        payload: { id: lockId, startBlock: 0, endBlock: 0, expectedBlocks: ["正在改写的原文"] } });
      assert.equal(held.statusCode, 200, held.body);
      assert.equal(held.json().positions.length, 1);
      const bound = await app.inject({ method: "PATCH", url: `/v2/notes/${target}/edit-locks/${lockId}`, headers: asBearer(mobileToken), payload: { runId } });
      assert.equal(bound.statusCode, 200, bound.body);
      const [saved] = await admin`SELECT rewrite_locks FROM note_document_states WHERE note_id=${target}`;
      assert.equal(saved.rewrite_locks[0].runId, runId, "a running rewrite must survive an API restart");
      if (status === "succeeded") {
        // A new process has no lock cache. It must load the durable relative
        // positions before it can accept a conflicting manual update.
        const probe = `
          import assert from 'node:assert/strict';
          import { pruneCompletedRewriteLocks, activeRewriteLocks, assertUnlockedUpdate } from './src/modules/note/edit-locks.ts';
          import { withWorkspaceTransaction, closeDatabase } from './src/db/client.ts';
          import { docFromSnapshot, editFragmentBlockText } from './src/modules/note/doc-fragment.ts';
          import { noteDocumentStates } from '@astella/shared/db-schema/note';
          import { eq } from 'drizzle-orm';
          import * as Y from 'yjs';
          const workspaceId=${JSON.stringify(workspaceId)}, userId=${JSON.stringify(userId)}, noteId=${JSON.stringify(target)};
          try {
            await pruneCompletedRewriteLocks(workspaceId,noteId,userId);
            assert.equal(activeRewriteLocks(noteId)[0]?.id,${JSON.stringify(lockId)});
            const row=await withWorkspaceTransaction({workspaceId,userId}, tx=>tx.query.noteDocumentStates.findFirst({where:eq(noteDocumentStates.noteId,noteId)}));
            const doc=docFromSnapshot(row.state), local=docFromSnapshot(row.state);
            editFragmentBlockText(local,0,'rejected after restart');
            assert.throws(()=>assertUnlockedUpdate(noteId,doc,Y.encodeStateAsUpdate(local,Y.encodeStateVector(doc))),{statusCode:423});
            doc.destroy(); local.destroy();
          } finally { await closeDatabase(); }
        `;
        await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { timeout: 30_000 });
      }
      const lockedRestore: { statusCode: number } = await app.inject({ method: "POST", url: `/notes/${target}/versions/${created.version.id}/restore`, headers: asBearer(mobileToken), payload: {} });
      assert.equal(lockedRestore.statusCode, 423, "version restore must also respect a running paragraph rewrite");
      const conflict = await app.inject({ method: "POST", url: `/v2/notes/${target}/doc-update`, headers: asBearer(mobileToken), payload: { update: await incrementalUpdateFor(target, "不能覆盖") } });
      assert.equal(conflict.statusCode, 423, conflict.body);
      assert.equal((await storedBody(target))[0], "正在改写的原文");
      const other = await app.inject({ method: "POST", url: `/v2/notes/${target}/doc-update`, headers: asBearer(mobileToken), payload: { update: await incrementalUpdateFor(target, `另一段仍能编辑 ${status}`, 1) } });
      assert.equal(other.statusCode, 200, other.body);
      await admin`UPDATE companion_turn_runs SET status=${status} WHERE id=${runId}`;
      const state = await app.inject({ method: "GET", url: `/v2/notes/${target}/editing-state`, headers: asBearer(mobileToken) });
      assert.equal(state.statusCode, 200, state.body);
      assert.deepEqual(state.json().locks, [], `${status} must release the paragraph`);
      const [released] = await admin`SELECT rewrite_locks FROM note_document_states WHERE note_id=${target}`;
      assert.deepEqual(released.rewrite_locks, [], "terminal unlock must also be durable");
    }
    const resumed = await app.inject({ method: "POST", url: `/v2/notes/${target}/doc-update`, headers: asBearer(mobileToken), payload: { update: await incrementalUpdateFor(target, "完成后可以继续编辑") } });
    assert.equal(resumed.statusCode, 200, resumed.body);
  } finally { await admin`DELETE FROM companion_conversations WHERE id=${conversationId}`; }
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

test("手机拥有者可以读取和新建笔记", async () => {
  // 「手机上人不改正文」不等于手机上看不了、也新建不了。这一条把那道闸的范围钉住：
  // 自由正文编辑口仍为 403；已保存版本的恢复按 owner 权限单独判断。
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
