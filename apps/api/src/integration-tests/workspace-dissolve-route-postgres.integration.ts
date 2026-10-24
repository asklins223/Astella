/**
 * `DELETE /workspaces/:id` 的路由层合同（doc 34 L6 的 ②，迁移 0276 的出口）。
 *
 * 这一层为什么要单独测：本文档从头到尾批评的就是"service 有实现、没人能按到"。
 * 解散这颗按钮**这一轮故意不做界面**（不可逆动作要先让人看过逐表计数再决定露不露），
 * 那就更不能让端点本身也只是"写着好看"——它必须被真 HTTP 验过：
 * 门卫翻成对的状态码、成功时把逐表计数原样带回去。
 * 等界面决定要做时，接的应该就是这条已经验过的路。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("需要 DATABASE_URL");
const admin = postgres(ADMIN, { max: 2 });

const ws = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const ownerPersonal = randomUUID();

const { authRoutes } = await import("../modules/identity/routes.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { closeDatabase } = await import("../db/client.ts");

let app: ReturnType<typeof Fastify>;
let ownerToken = "";
let memberToken = "";

before(async () => {
  app = Fastify();
  await app.register(sensible);
  await app.register(authRoutes);
  await app.ready();

  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${owner}, ${`disroute-o-${ws.slice(0, 8)}@example.test`}, 'h', 'owner'),
              (${member}, ${`disroute-m-${ws.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES (${ownerPersonal}, ${`disroute-p-${ws.slice(0, 8)}`}, ${owner}, 'personal'),
              (${ws}, ${`disroute-${ws.slice(0, 8)}`}, ${owner}, 'collaborative')`;
    await tx`UPDATE users SET personal_workspace_id = ${ownerPersonal} WHERE id = ${owner}`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${ws}, ${owner}, 'owner'), (${ws}, ${member}, 'member'),
              (${ownerPersonal}, ${owner}, 'owner')`;
  });
  ownerToken = (await issueSession(owner, ws)).token;
  memberToken = (await issueSession(member, ws)).token;
});

after(async () => {
  for (const token of [ownerToken, memberToken]) {
    if (token) await revokeSession(token).catch(() => undefined);
  }
  await app.close();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`DELETE FROM workspace_members WHERE workspace_id IN (${ws}, ${ownerPersonal})`;
    await tx`UPDATE users SET personal_workspace_id = NULL WHERE id = ${owner}`;
    await tx`DELETE FROM workspaces WHERE id IN (${ws}, ${ownerPersonal})`;
    await tx`DELETE FROM users WHERE id IN (${owner}, ${member})`;
  });
  await admin.end();
  await closeDatabase();
});

function del(url: string, token: string) {
  return app.inject({ method: "DELETE", url, headers: { authorization: `Bearer ${token}` } });
}

test("member 不能解散：403 并且说清是所有权问题", async () => {
  const res = await del(`/workspaces/${ws}`, memberToken);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "actor_is_not_active_owner");
  const still = await admin`SELECT id FROM workspaces WHERE id = ${ws}`;
  assert.equal(still.length, 1, "被拒的调用还是把空间删了");
});

test("个人空间不许解散：409", async () => {
  const res = await del(`/workspaces/${ownerPersonal}`, ownerToken);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "cannot_dissolve_personal_workspace");
});

test("不存在的空间：404，而不是把内部错误名漏出去", async () => {
  const res = await del(`/workspaces/${randomUUID()}`, ownerToken);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error, "workspace_not_found");
});

test("owner 解散协作空间：200 并带回逐表计数，空间与其成员行一起消失", async () => {
  const res = await del(`/workspaces/${ws}`, ownerToken);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().dissolved, true);
  assert.equal(res.headers["cache-control"], "private, no-store");
  const gone = await admin`SELECT id FROM workspaces WHERE id = ${ws}`;
  assert.equal(gone.length, 0, "200 了但空间还在");
  const members = await admin`SELECT user_id FROM workspace_members WHERE workspace_id = ${ws}`;
  assert.equal(members.length, 0, "成员行没跟着走");
  const tombstone = await admin`
    SELECT action FROM workspace_audit_log WHERE workspace_id = ${ownerPersonal} AND target_id = ${ws}
  `;
  assert.equal(tombstone.length, 1, "审计 tombstone 不在这次解散里（它必须活过删除）");
});

test('原生成员名册与邀请可翻过 200/100 条，邮箱搜索按字面匹配并保持真实总数', async () => {
  const room = randomUUID(), roomOwner = randomUUID();
  let token = '';
  const stem = `native-roster-${room}`;
  try {
    await admin`INSERT INTO users (id,email,password_hash,role) VALUES (${roomOwner},${stem + '-owner@example.test'},'test','owner')`;
    await admin`INSERT INTO workspaces (id,name,owner_id,workspace_type) VALUES (${room},'原生分页测试',${roomOwner},'collaborative')`;
    await admin`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${room},${roomOwner},'owner')`;
    await admin`WITH inserted AS (
      INSERT INTO users (email,password_hash,role)
      SELECT ${stem} || '-' || n || '@example.test','test','owner' FROM generate_series(1,235) n RETURNING id
    ) INSERT INTO workspace_members (workspace_id,user_id,role) SELECT ${room},id,'member' FROM inserted`;
    await admin`INSERT INTO invite_codes (workspace_id,created_by,role,token_hash,token_hint)
      SELECT ${room},${roomOwner},'member',md5(${stem} || n),'page-' || n FROM generate_series(1,105) n`;
    token = (await issueSession(roomOwner, room)).token;
    const headers = { authorization: `Bearer ${token}` };
    for (const [route, expected] of [['members', 236], ['invites', 105]] as const) {
      const seen = new Set<string>();
      for (let offset = 0; offset < expected; offset += 30) {
        const response = await app.inject({method:'GET', url:`/${route}?limit=30&offset=${offset}`, headers});
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().total, expected);
        for (const item of response.json().items as Array<{userId?:string;id?:string}>) {
          const id = item.userId ?? item.id!;
          assert.equal(seen.has(id), false, '同时间创建的成员/邀请分页仍需稳定顺序');
          seen.add(id);
        }
      }
      assert.equal(seen.size, expected);
    }
    const searched = await app.inject({method:'GET',url:'/members?' + new URLSearchParams({limit:'30',q:stem + '-235@'}),headers});
    assert.equal(searched.statusCode, 200, searched.body);
    assert.equal(searched.json().total, 1);
    assert.equal(searched.json().items[0].email, stem + '-235@example.test');
    const literal = await app.inject({method:'GET',url:'/members?q=%25',headers});
    assert.equal(literal.statusCode, 200, literal.body);
    assert.equal(literal.json().total, 0);
    assert.equal((await app.inject({method:'GET',url:'/members?offset=-1',headers})).statusCode, 400);
  } finally {
    if (token) await revokeSession(token);
    await admin`DELETE FROM invite_codes WHERE workspace_id=${room}`;
    await admin`DELETE FROM workspace_members WHERE workspace_id=${room}`;
    await admin`DELETE FROM workspaces WHERE id=${room}`;
    await admin`DELETE FROM users WHERE email LIKE ${stem + '%'}`;
  }
});

test('共同所有者可以把自己的权限交还当前主所有者，第三位所有者保持权限', async () => {
  const room = randomUUID(), primary = randomUUID(), actor = randomUUID(), third = randomUUID();
  let actorToken = '', thirdToken = '';
  try {
    await admin`INSERT INTO users (id,email,password_hash,role) VALUES
      (${primary},${`transfer-primary-${room}@example.test`},'test','owner'),
      (${actor},${`transfer-actor-${room}@example.test`},'test','owner'),
      (${third},${`transfer-third-${room}@example.test`},'test','owner')`;
    await admin`INSERT INTO workspaces (id,name,owner_id,workspace_type) VALUES (${room},'共同所有者测试',${primary},'collaborative')`;
    await admin`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${room},${primary},'owner'),(${room},${actor},'owner'),(${room},${third},'owner')`;
    actorToken = (await issueSession(actor,room)).token;
    thirdToken = (await issueSession(third,room)).token;
    const response = await app.inject({method:'POST',url:`/workspaces/${room}/transfer-ownership`,headers:{authorization:`Bearer ${actorToken}`},payload:{toUserId:primary}});
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().newOwnerUserId, primary);
    const members = await admin`SELECT user_id,role FROM workspace_members WHERE workspace_id=${room}`;
    const roles = new Map(members.map(row=>[row.user_id,row.role]));
    assert.equal(roles.get(primary),'owner');
    assert.equal(roles.get(actor),'member');
    assert.equal(roles.get(third),'owner');
    const refused = await app.inject({method:'GET',url:'/members',headers:{authorization:`Bearer ${actorToken}`}});
    assert.equal(refused.statusCode,403,'旧 token 不能保留已交出的管理权限');
    const self = await app.inject({method:'POST',url:`/workspaces/${room}/transfer-ownership`,headers:{authorization:`Bearer ${thirdToken}`},payload:{toUserId:third}});
    assert.equal(self.statusCode,409);
  } finally {
    for (const token of [actorToken,thirdToken]) if (token) await revokeSession(token);
    await admin`DELETE FROM workspace_audit_log WHERE workspace_id=${room}`;
    await admin`DELETE FROM workspace_members WHERE workspace_id=${room}`;
    await admin`DELETE FROM workspaces WHERE id=${room}`;
    await admin`DELETE FROM users WHERE id IN (${primary},${actor},${third})`;
  }
});
