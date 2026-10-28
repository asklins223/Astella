import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/** Measures the fast-chat first-token path against the real dev stack. */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
if (!databaseUrl) throw new Error("database configuration is required");
const url = new URL(databaseUrl);
url.pathname = "/astella"; url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "http://127.0.0.1:4000";

await db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`first-token-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'First token probe',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
});
const conversation = await fetch(`${base}/companion/inbox/ensure`, { method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then(r => r.json());

const prompts = ["在吗？", "今天有点累。", "随便聊聊，我最近有点焦虑。", "累了，说点轻松的。", "今天状态一般。"];
const results: Record<string, unknown>[] = [];
for (const text of prompts) {
  const acceptedAt = Date.now();
  const accepted = await fetch(`${base}/companion/conversations/${conversation.id}/turns`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text }] }),
  }).then(r => r.json());
  const runId = accepted.runId as string;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    if (["succeeded", "failed", "cancelled"].includes(String(row?.status))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const [run] = await db`select started_at, finished_at, step_count, tool_call_count from companion_turn_runs where id=${runId}`;
  const events = await db`select type, created_at, payload from companion_stream_events
    where run_id=${runId} and type in ('assistant.delta','assistant.final') order by created_at`;
  const deltas = events.filter(event => event.type === "assistant.delta");
  const first = deltas[0]?.created_at as Date | undefined;
  const final = events.find(event => event.type === "assistant.final")?.created_at as Date | undefined;
  const [stored] = await db`select count(*)::int as count from companion_messages where run_id=${runId} and role='assistant'`;
  results.push({ text, runId, steps: run?.step_count, tools: run?.tool_call_count, messages: stored?.count,
    acceptedToStartMs: run?.started_at ? (run.started_at as Date).getTime() - acceptedAt : null,
    startToFirstMs: first && run?.started_at ? first.getTime() - (run.started_at as Date).getTime() : null,
    firstToFinalMs: first && final ? final.getTime() - first.getTime() : null,
    totalMs: final ? final.getTime() - acceptedAt : null,
    deltas: deltas.length, firstChars: deltas[0] ? String((deltas[0].payload as any)?.textDelta ?? "").length : 0 });
  console.log(JSON.stringify(results.at(-1)));
}
console.log(`\nSUMMARY ${JSON.stringify(results)}`);
await db.end();
process.exit(0);
