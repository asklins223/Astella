import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/** One conversation, prompts that do not repeat the fixed five-sentence script. */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL ?? env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
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
  await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`varied-${userId}@test.invalid`},'synthetic-no-login','owner')`;
  await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Varied probe',${userId},'personal')`;
  await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
  await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
  await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
  await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
  await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
});
const conversation = await fetch(`${base}/companion/inbox/ensure`, { method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()) as { id: string };

type Expect = {
  id: string;
  text: string;
  noWrite?: boolean;
  tool?: RegExp;
  reply?: RegExp;
  forbid?: RegExp;
  chatFast?: boolean;
  /** Tool turns should not spend a discovery round before the real call. */
  maxSteps?: number;
};
const cases: Expect[] = [
  { id: "rain", text: "窗外雨突然大了。", chatFast: true, noWrite: true, forbid: /学习计划|复习|我去关窗/ },
  { id: "novel", text: "小说里那个编辑把封面日期印反了，我看着着急。", chatFast: true, noWrite: true, forbid: /你印|你把封面|你搞错|你的日期/ },
  { id: "activity", text: "从你开口到现在，你本人做过什么？只讲有记录的。", chatFast: true, noWrite: true, forbid: /吃饭|咽下|散步|看书|喝水|做饭|刷手机|刚睡|走路/ },
  { id: "shrug", text: "就这样吧。", chatFast: true, noWrite: true, forbid: /学习计划|复习/ },
  { id: "calc", text: "用计算工具算 186 乘 47，只要得数。", tool: /calculate/i, reply: /8742/, maxSteps: 2 },
  { id: "seat", text: "记住：我的工位在三楼靠窗。", tool: /memory\.write\.save/, maxSteps: 2 },
  { id: "recall-seat", text: "我工位在几楼？别编别的房间。", chatFast: true, noWrite: true, reply: /三楼/, forbid: /二楼|一楼|四楼/ },
  { id: "cause", text: "店里放了音乐之后营业额涨了。这能证明音乐让人多花钱吗？先回答能或不能。", chatFast: true, noWrite: true, reply: /不能/ },
  { id: "one-line", text: "别解释，别反问，只回两个字：好的。", chatFast: true, noWrite: true, reply: /^好的。?$/, forbid: /[？?]/ },
  { id: "note", text: "新建笔记，标题《明早》，正文只写一行：带耳机。别加第二段。", tool: /notes\.write/, maxSteps: 2 },
  { id: "bus", text: "我去赶车了。", chatFast: true, noWrite: true, forbid: /学习|复习|计划一下/ },
];

let lastSubmit = 0;
const results: Record<string, unknown>[] = [];
for (const item of cases) {
  const pace = Math.max(0, lastSubmit + 5_200 - Date.now());
  if (pace) await new Promise(resolve => setTimeout(resolve, pace));
  const acceptedAt = Date.now();
  lastSubmit = acceptedAt;
  const accepted = await fetch(`${base}/companion/conversations/${conversation.id}/turns`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text: item.text }] }),
  }).then(r => r.json()) as { runId?: string };
  if (!accepted.runId) {
    results.push({ id: item.id, error: `rejected ${JSON.stringify(accepted).slice(0, 240)}` });
    console.log(JSON.stringify(results.at(-1)));
    continue;
  }
  const runId = accepted.runId;
  const deadline = Date.now() + 150_000;
  let status = "accepted";
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    status = String(row?.status ?? "missing");
    if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const [run] = await db`select started_at, step_count, tool_call_count, error_code from companion_turn_runs where id=${runId}`;
  const events = await db`select type, created_at from companion_stream_events where run_id=${runId} and type in ('assistant.delta','assistant.final') order by created_at`;
  const first = events.find(event => event.type === "assistant.delta")?.created_at as Date | undefined;
  const final = events.find(event => event.type === "assistant.final")?.created_at as Date | undefined;
  const replies = await db`select blocks from companion_messages where run_id=${runId} and role='assistant' order by seq`;
  const reply = replies.map(row => (row.blocks as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text ?? "").join("")).join("\n");
  const tools = await db`select name, status from companion_agent_tool_calls where run_id=${runId} order by created_at`;
  const calls = await db`select provider, operation, duration_ms, prompt_tokens, cached_tokens, status from ai_audit_log where job_id=(select job_id from companion_turn_runs where id=${runId}) and operation like 'companion_agent%' order by created_at`;
  const problems: string[] = [];
  if (status !== "succeeded") problems.push(`status ${status}`);
  if (!reply.trim()) problems.push("empty");
  const delivered = calls.filter(call => call.status === "success");
  if (delivered.length === 0 || delivered.some(call => call.provider !== "mimo_responses")) problems.push("provider");
  if (item.noWrite && tools.some(tool => tool.status === "succeeded" && !String(tool.name).includes("read") && !String(tool.name).includes("calculate"))) problems.push("wrote");
  if (item.tool && !tools.some(tool => item.tool!.test(String(tool.name)) && tool.status === "succeeded")) problems.push(`missing ${item.tool}`);
  if (item.reply && !item.reply.test(reply)) problems.push("reply");
  if (item.forbid && item.forbid.test(reply)) problems.push("forbid");
  const startToFirstMs = first && run?.started_at ? first.getTime() - (run.started_at as Date).getTime() : null;
  if (item.chatFast && (startToFirstMs === null || startToFirstMs > 1_500)) problems.push(`slow ${startToFirstMs}`);
  const totalMs = final ? final.getTime() - acceptedAt : null;
  if (item.chatFast && totalMs !== null && totalMs > 4_000) problems.push(`long ${totalMs}`);
  if (item.maxSteps !== undefined && Number(run?.step_count) > item.maxSteps) problems.push(`steps ${run?.step_count}`);
  if (calls.length > 1 && calls.slice(1).some(call => call.cached_tokens === null || Number(call.cached_tokens) === 0)) problems.push("cache");
  const row = { id: item.id, status, steps: run?.step_count, firstMs: startToFirstMs,
    totalMs: final ? final.getTime() - acceptedAt : null,
    cached: calls.map(call => call.cached_tokens), tools: tools.map(tool => `${tool.name}:${tool.status}`),
    problems, reply: reply.slice(0, 180) };
  results.push(row);
  console.log(JSON.stringify(row));
}
const bad = results.filter(row => Array.isArray(row.problems) && (row.problems as string[]).length > 0);
console.log(`\nPROBLEMS ${bad.length}/${results.length} ${JSON.stringify(bad.map(row => ({ id: row.id, problems: row.problems, reply: row.reply })))}`);
await db.end();
process.exit(bad.length ? 2 : 0);
