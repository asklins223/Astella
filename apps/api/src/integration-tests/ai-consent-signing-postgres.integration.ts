import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { authRoutes } from "../modules/identity/routes.ts";
import { issueSession, revokeSession } from "../modules/identity/session-service.ts";
import { closeDatabase } from "../db/client.ts";
import { requireAiConsent } from "../modules/identity/ai-consent-gate.ts";
import { requireSession } from "../modules/identity/middleware.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const owner = randomUUID(), member = randomUUID(), workspace = randomUUID();
const app = Fastify({ logger: false });
let token = "";
const headers = () => ({ authorization: `Bearer ${token}` });
before(async () => {
  await admin.begin(async tx => {
    await tx`INSERT INTO users (id,email,password_hash) VALUES
      (${owner},${`consent-owner-${owner}@astella.test`},'fixture'),
      (${member},${`consent-member-${member}@astella.test`},'fixture')`;
    await tx`INSERT INTO workspaces (id,owner_id,name,workspace_type) VALUES (${workspace},${owner},'同意测试','collaborative')`;
    await tx`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${workspace},${owner},'owner'),(${workspace},${member},'member')`;
    await tx`INSERT INTO user_ai_settings (user_id) VALUES (${owner})`;
  });
  await app.register(sensible); await app.register(authRoutes);
  app.post("/test/voice-access", { preHandler: [requireSession, requireAiConsent] }, async () => ({ authorized: true }));
  await app.ready();
  token = (await issueSession(member, workspace)).token;
});
after(async () => {
  try {
    if (token) await revokeSession(token);
    await app.close();
    await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspace}`;
    await admin`DELETE FROM workspaces WHERE id = ${workspace}`;
    await admin`DELETE FROM users WHERE id IN (${owner},${member})`;
  } finally { await Promise.all([admin.end(), closeDatabase()]); }
});

test("成员首次签署同时开启外发；重读不授权，重新签署保留其它数据选择", async () => {
  const unsigned = await app.inject({ method: "GET", url: "/me/ai-settings", headers: headers() });
  assert.equal(unsigned.statusCode, 200, unsigned.body);
  assert.equal(unsigned.json().consentVersion, null);
  assert.equal(unsigned.json().dataPolicy.sendToExternal, false);
  const voice = () => app.inject({ method: "POST", url: "/test/voice-access", headers: headers() });
  assert.equal((await voice()).json().error, "ai_consent_required");
  // 首次签署时没有设置行也必须成功，而不是只覆盖读取预建的行。
  await admin`DELETE FROM user_ai_settings WHERE user_id = ${member}`;
  const sign = () => app.inject({ method: "PUT", url: "/me/ai-consent", headers: headers(), payload: { consentVersion: "ai-consent-v1" } });
  const signed = await sign();
  assert.equal(signed.statusCode, 200, signed.body);
  const read = await app.inject({ method: "GET", url: "/me/ai-settings", headers: headers() });
  assert.equal(read.json().consentVersion, "ai-consent-v1");
  assert.ok(read.json().consentAt);
  assert.equal(read.json().dataPolicy.sendToExternal, true);
  assert.equal((await voice()).statusCode, 200);
  const choices = { sendToExternal: false, sendImageContent: false, piiDetection: false, auditLogging: false };
  const off = await app.inject({ method: "PUT", url: "/me/ai-data-policy", headers: headers(), payload: choices });
  assert.equal(off.statusCode, 200, off.body);
  const stillOff = await app.inject({ method: "GET", url: "/me/ai-settings", headers: headers() });
  assert.deepEqual(stillOff.json().dataPolicy, choices);
  assert.equal((await voice()).json().error, "ai_data_policy_denied");
  const invalid = await app.inject({ method: "PUT", url: "/me/ai-consent", headers: headers(), payload: { consentVersion: "" } });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal((await admin`SELECT data_policy FROM user_ai_settings WHERE user_id = ${member}`)[0].data_policy.sendToExternal, false);
  assert.equal((await sign()).statusCode, 200);
  const resumed = await app.inject({ method: "GET", url: "/me/ai-settings", headers: headers() });
  assert.deepEqual(resumed.json().dataPolicy, { ...choices, sendToExternal: true });
  const untouched = (await admin`SELECT consent_version,data_policy FROM user_ai_settings WHERE user_id = ${owner}`)[0];
  assert.equal(untouched.consent_version, null);
  assert.equal(untouched.data_policy.sendToExternal, false);
});
