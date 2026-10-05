import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { createGovernedApiRequester } from "../lib/ai-governance.ts";
import { productionAiGovernancePorts } from "../governance/ai-governance-runtime.ts";
import { closeDatabase } from "../db/client.ts";

// Real settings, RLS, shared persistent buckets and audit. Only HTTP is a local
// double: exhausting a quota must not spend model calls to prove the gate.
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const userId = randomUUID(), otherUserId = randomUUID(), spaces = [randomUUID(), randomUUID()];
await admin.begin(async tx => {
  for (const id of [userId, otherUserId]) await tx`INSERT INTO users(id,email,password_hash,role)
    VALUES(${id},${`api-quota-${id}@test.invalid`},'fixture','owner')`;
  for (const id of spaces) {
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${id},'API Agent quota fixture',${userId})`;
    for (const member of [userId, otherUserId]) await tx`INSERT INTO workspace_members(workspace_id,user_id,role)
      VALUES(${id},${member},${member === userId ? 'owner' : 'member'})`;
  }
  for (const id of [userId, otherUserId]) await tx`INSERT INTO user_ai_settings(user_id,consent_at,consent_version,data_policy)
    VALUES(${id},now(),'public-fixture',${tx.json({sendToExternal:true,sendImageContent:false,piiDetection:true,auditLogging:true})})`;
});
after(async () => {
  try {
    await admin`DELETE FROM auth_rate_limits WHERE bucket_key IN (${`ai-model:${userId}:minute`},${`ai-model:${userId}:hour`},
      ${`ai-model:${otherUserId}:minute`},${`ai-model:${otherUserId}:hour`})`;
    for (const id of spaces) await admin`DELETE FROM workspaces WHERE id=${id}`;
    await admin`DELETE FROM users WHERE id IN (${userId},${otherUserId})`;
  } finally { await Promise.all([admin.end(), closeDatabase()]); }
});

test("parallel API callers share one account quota across spaces, and only reserved attempts reach HTTP", async () => {
  await admin`INSERT INTO auth_rate_limits(bucket_key,count,reset_at,updated_at)
    VALUES(${`ai-model:${userId}:minute`},29,now()+interval '1 minute',now())`;
  let attempts = 0;
  const requesters = spaces.map(workspaceId => createGovernedApiRequester({ workspaceId, userId }, "quota_probe", ["user_answer"], {
    // 查设置与写审计走生产的真实实现（这条用例要的就是真库、RLS 与审计行）。
    ...productionAiGovernancePorts,
    requester: async () => { attempts++; return { status: 200, statusText: "OK", body: { usage: { total_tokens: 7 } } }; },
  }));
  const results = await Promise.allSettled(Array.from({length: 4}, (_, index) => requesters[index % 2]!(
    "https://example.com/v1/chat/completions", {}, { model: "quota-fixture", messages: [{role:"user",content:"public fixture"}] },
  )));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "AI_CALL_RATE_LIMITED");
  assert.equal(attempts, 1);
  const [minute] = await admin`SELECT count FROM auth_rate_limits WHERE bucket_key=${`ai-model:${userId}:minute`}`;
  assert.equal(minute.count, 33);
  const audits = await admin`SELECT status,cost_tokens,error_message FROM ai_audit_log WHERE user_id=${userId} AND operation='quota_probe'`;
  assert.equal(audits.filter(row => row.status === "success" && row.cost_tokens === 7).length, 1);
  assert.equal(audits.filter(row => row.status === "error" && row.error_message === "AI_CALL_RATE_LIMITED").length, 3);
});

test("hourly exhaustion survives a fresh requester; another account keeps its own allowance", async () => {
  await admin`UPDATE auth_rate_limits SET reset_at=now()-interval '1 second' WHERE bucket_key=${`ai-model:${userId}:minute`}`;
  await admin`UPDATE auth_rate_limits SET count=120,reset_at=now()+interval '1 hour' WHERE bucket_key=${`ai-model:${userId}:hour`}`;
  let attempts = 0;
  const requester = async () => { attempts++; return { status: 200, statusText: "OK", body: {} }; };
  const current = createGovernedApiRequester({ workspaceId: spaces[1]!, userId }, "quota_probe", ["user_answer"], { ...productionAiGovernancePorts, requester });
  await assert.rejects(current("https://example.com/v1/chat/completions", {}, {model:"quota-fixture"}),
    (error: unknown) => (error as {code:string}).code === "AI_CALL_RATE_LIMITED");
  const other = createGovernedApiRequester({ workspaceId: spaces[0]!, userId: otherUserId }, "quota_probe", ["user_answer"], { ...productionAiGovernancePorts, requester });
  await other("https://example.com/v1/chat/completions", {}, {model:"quota-fixture"});
  assert.equal(attempts, 1);
  const [minute] = await admin`SELECT count FROM auth_rate_limits WHERE bucket_key=${`ai-model:${userId}:minute`}`;
  assert.equal(minute.count, 1, "the expired minute window resets without resetting the hourly bucket");
});
