import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { authRoutes } from "../modules/identity/routes.ts";
import { issueSession, revokeSession } from "../modules/identity/session-service.ts";
import { closeDatabase } from "../db/client.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const restricted = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 1 });
const owner = randomUUID(), member = randomUUID();
const personal = randomUUID(), shared = randomUUID();
const app = Fastify({ logger: false });
let ownerToken = "", memberToken = "";
const headers = () => ({ authorization: `Bearer ${ownerToken}` });
before(async () => {
  const [role] = await restricted`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
  assert.equal(role.rolbypassrls, false); assert.equal(role.rolsuper, false);
  await admin.begin(async tx => {
    await tx`INSERT INTO users (id,email,password_hash) VALUES (${owner},${`settings-owner-${owner}@ailearn.test`},'fixture'),(${member},${`settings-member-${member}@ailearn.test`},'fixture')`;
    await tx`INSERT INTO workspaces (id,owner_id,name,workspace_type) VALUES (${personal},${owner},'新账号个人空间','personal'),(${shared},${owner},'协作空间','collaborative')`;
    await tx`UPDATE users SET personal_workspace_id = ${personal} WHERE id = ${owner}`;
    await tx`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${personal},${owner},'owner'),(${shared},${owner},'owner'),(${shared},${member},'member')`;
  });
  await app.register(sensible); await app.register(authRoutes); await app.ready();
  ownerToken = (await issueSession(owner, personal)).token;
  memberToken = (await issueSession(member, shared)).token;
});
after(async () => {
  try {
    if (ownerToken) await revokeSession(ownerToken);
    if (memberToken) await revokeSession(memberToken);
    await app.close();
    await admin.begin(async tx => {
      await tx`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${owner},${member})`;
      await tx`DELETE FROM workspace_members WHERE workspace_id IN (${personal},${shared})`;
      await tx`DELETE FROM workspaces WHERE id IN (${personal},${shared})`;
      await tx`DELETE FROM users WHERE id IN (${owner},${member})`;
    });
  } finally { await Promise.all([admin.end(),restricted.end(),closeDatabase()]); }
});
test("全新账号无 AI 设置行仍可读取并保持未授权，不影响另一个账号", async () => {
  const response = await app.inject({method:"GET",url:"/me/ai-settings",headers:headers()});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().consentAt,null); assert.equal(response.json().consentVersion,null);
  assert.deepEqual(response.json().dataPolicy,{sendToExternal:false,sendImageContent:false,piiDetection:true,auditLogging:true});
  const rows = await admin`SELECT user_id FROM user_ai_settings WHERE user_id IN (${owner},${member})`;
  assert.deepEqual(rows.map(row=>row.user_id),[owner]);
});
test("受限角色可以保存自己的显示名并从会话中读回", async () => {
  const response = await app.inject({method:"PUT",url:"/auth/profile",headers:headers(),payload:{displayName:"新账号测试者"}});
  assert.equal(response.statusCode,200,response.body);
  const me = await app.inject({method:"GET",url:"/auth/me",headers:headers()});
  assert.equal(me.json().displayName,"新账号测试者");
});
test("个人空间与协作空间的所有者都可以改名，成员不能改名或预览解散", async () => {
  for (const id of [personal,shared]) {
    const response = await app.inject({method:"PATCH",url:`/workspaces/${id}/name`,headers:headers(),payload:{name:"已改名的空间"}});
    assert.equal(response.statusCode,200,response.body); assert.equal(response.json().name,"已改名的空间");
  }
  const denied = await app.inject({method:"PATCH",url:`/workspaces/${shared}/name`,headers:{authorization:`Bearer ${memberToken}`},payload:{name:"成员改名"}});
  assert.equal(denied.statusCode,403,denied.body);
  const preview = await app.inject({method:"GET",url:`/workspaces/${shared}/dissolve-preview`,headers:headers()});
  assert.equal(preview.statusCode,200,preview.body);
  assert.deepEqual(preview.json().counts,{notes:0,sources:0,cards:0,schedules:0});
  const memberPreview = await app.inject({method:"GET",url:`/workspaces/${shared}/dissolve-preview`,headers:{authorization:`Bearer ${memberToken}`}});
  assert.equal(memberPreview.statusCode,403,memberPreview.body);
});
