import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { users } from "@ailearn/shared/db-schema/identity";
import { eq } from "drizzle-orm";
import { authRoutes } from "../modules/identity/routes.ts";
import { issueSession, revokeSession } from "../modules/identity/session-service.ts";
import { closeDatabase, db } from "../db/client.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const restricted = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 1 });
const userId = randomUUID();
const workspaceId = randomUUID();
const email = `auth-restore-${userId}@ailearn.test`;
const app = Fastify({ logger: false });
let token = "";
let workspaceEpoch = 0;

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, role, display_name)
      VALUES (${userId}, ${email}, 'fixture-only', 'owner', '会话恢复测试')`;
    await tx`INSERT INTO workspaces (id, owner_id, name, workspace_type, workspace_epoch)
      VALUES (${workspaceId}, ${userId}, '会话恢复的书房', 'personal', 7)`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`UPDATE users SET personal_workspace_id = ${workspaceId} WHERE id = ${userId}`;
    const [workspace] = await tx`SELECT workspace_epoch FROM workspaces WHERE id = ${workspaceId}`;
    workspaceEpoch = Number(workspace.workspace_epoch);
  });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.ready();
  token = (await issueSession(userId, workspaceId)).token;
});

after(async () => {
  if (token) await revokeSession(token);
  await app.close();
  await admin.begin(async (tx) => {
    await tx`UPDATE users SET personal_workspace_id = NULL WHERE id = ${userId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await tx`DELETE FROM users WHERE id = ${userId}`;
  });
  await Promise.all([admin.end(), restricted.end(), closeDatabase()]);
});

test("会话恢复在受限连接上读回自己的账号和实际空间纪元", async () => {
  const [role] = await restricted`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolsuper, false);
  assert.ok(workspaceEpoch > 1);
  // Negative control: a bare read cannot see this same existing user under RLS.
  assert.equal(await db.query.users.findFirst({ where: eq(users.id, userId) }), undefined);
  const reply = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.deepEqual(reply.json(), {
    userId, workspaceId, email, role: "owner", displayName: "会话恢复测试", avatarUrl: null,
    workspaceName: "会话恢复的书房", workspaceType: "personal", isPersonal: true,
    personalWorkspaceId: workspaceId, workspaceEpoch,
  });
});

test("会话恢复仍拒绝匿名请求", async () => {
  const reply = await app.inject({ method: "GET", url: "/auth/me" });
  assert.equal(reply.statusCode, 401);
});
