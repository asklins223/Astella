import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/**
 * 判据（2026-10-28 用户口径）：
 *   拆不拆由模型自己决定 —— 一条干净正文、或两条独立消息，都算对。
 *   错的只有三类：
 *     1. 一个气泡里用「第一条/第二条」冒充分条（fake split）；
 *     2. 发布之后又用正文复述「两条都发出去了」（confirmation bubble）；
 *     3. 声称分条但一条都没发（只有正文且带编号）。
 */
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
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`quality-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Split quality',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
});
const conversation = await fetch(`${base}/companion/inbox/ensure`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then(r => r.json());
const LABEL = /第[一二三四五六七八九]\s*[条点]|1[.、)]\s|2[.、)]\s/u;
const CONFIRM = /(都|已经).{0,6}(发|说)(出去|好|完)|已经(分|拆).{0,4}条/u;
const rows = [];
// 追加：dump 每轮实际 assistant 消息数、工具调用与首字延迟
for (let round = 0; round < 1; round += 1) {
  const prompt = "分两条告诉我：第一条用两三句讲清楚间隔重复为什么有效，第二条给我一个今天就能练的方法。";
  const accepted = await fetch(`${base}/companion/conversations/${conversation.id}/turns`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text: prompt }] }) }).then(r => r.json());
  const runId = accepted.runId as string;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    if (["succeeded", "failed", "cancelled"].includes(String(row?.status))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const messages = await db`select seq, blocks from companion_messages where run_id=${runId} and role='assistant' order by seq`;
  const texts = messages.map(m => (m.blocks as any[]).map(b => b.text ?? "").join(""));
  const fakeSplit = texts.some(text => LABEL.test(text));
  const confirmBubble = texts.some(text => CONFIRM.test(text));
  const calls = await db`select name, status from companion_agent_tool_calls where run_id=${runId}`;
  rows.push({ round, prompt: prompt.slice(0, 24), messages: messages.length,
    calls: calls.map(c => `${c.name}:${c.status}`),
    texts: texts.map(t => t.slice(0, 60)),
    fakeSplit, confirmBubble, ok: !fakeSplit && !confirmBubble });
}
console.log(JSON.stringify(rows, null, 1));
console.log("SUMMARY " + JSON.stringify({ rounds: rows.length, ok: rows.filter(r => r.ok).length,
  fakeSplit: rows.filter(r => r.fakeSplit).length, confirm: rows.filter(r => r.confirmBubble).length }));
await db.end();
process.exit(0);
