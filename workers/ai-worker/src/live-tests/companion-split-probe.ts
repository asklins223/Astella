import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
if (!databaseUrl) throw new Error("database configuration is required");
const url = new URL(databaseUrl); url.pathname = "/astella"; url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "http://127.0.0.1:4000";
await db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`split-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Split probe',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
});
const conversation = await fetch(`${base}/companion/inbox/ensure`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then(r => r.json());
for (let round = 0; round < 6; round += 1) {
  const prompt = round % 2 === 0
    ? "分两条跟我说：第一条打个招呼，第二条问我今天先做哪件事。"
    : "用两条消息回我，一条说晚安，一条说明天见。";
  const accepted = await fetch(`${base}/companion/conversations/${conversation.id}/turns`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text: prompt }] }) }).then(r => r.json());
  const runId = accepted.runId as string;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    if (["succeeded", "failed", "cancelled"].includes(String(row?.status))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const messages = await db`select seq, blocks from companion_messages where run_id=${runId} and role='assistant' order by seq`;
  const calls = await db`select name, status from companion_agent_tool_calls where run_id=${runId} order by created_at`;
  console.log(JSON.stringify({ round, prompt, messages: messages.length,
    texts: messages.map(m => (m.blocks as any[]).map(b => b.text).join("")),
    calls: calls.map(c => `${c.name}:${c.status}`) }));
}
await db.end();
process.exit(0);
