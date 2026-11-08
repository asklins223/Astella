/**
 * Paths the short chat probe does not touch: read and edit a note, forget a
 * memory, web search off and on, a long passage, cancel, a second account,
 * and guided permission that must not write before confirmation.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL ?? env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
if (!databaseUrl) throw new Error("database configuration is required");
const url = new URL(databaseUrl);
url.pathname = "/astella"; url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const base = "http://127.0.0.1:4000";

type Fixture = { workspaceId: string; userId: string; token: string; conversationId: string };

async function fixture(label: string, permission: "full" | "guided"): Promise<Fixture> {
  const workspaceId = randomUUID(), userId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`${label}-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},${label},${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}',to_jsonb(${permission}::text)) WHERE user_id=${userId}`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
  });
  const conversation = await fetch(`${base}/companion/inbox/ensure`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()) as { id?: string };
  if (!conversation.id) throw new Error(`inbox rejected ${JSON.stringify(conversation).slice(0, 200)}`);
  return { workspaceId, userId, token, conversationId: conversation.id };
}

type Turn = {
  id: string;
  text: string;
  chatFast?: boolean;
  tool?: RegExp;
  reply?: RegExp;
  forbid?: RegExp;
  maxSteps?: number;
  allowStatus?: string[];
  noWeb?: boolean;
};

async function runTurn(fx: Fixture, item: Turn, acceptedAt: number) {
  const accepted = await fetch(`${base}/companion/conversations/${fx.conversationId}/turns`, {
    method: "POST", headers: { Authorization: `Bearer ${fx.token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text: item.text }] }),
  }).then(r => r.json()) as { runId?: string };
  if (!accepted.runId) return { id: item.id, error: `rejected ${JSON.stringify(accepted).slice(0, 240)}`, problems: ["rejected"] };
  const runId = accepted.runId;
  const deadline = Date.now() + 150_000;
  let status = "accepted";
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${runId}`;
    status = String(row?.status ?? "missing");
    if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const [run] = await db`select started_at, step_count, error_code from companion_turn_runs where id=${runId}`;
  const events = await db`select type, created_at from companion_stream_events where run_id=${runId} and type in ('assistant.delta','assistant.final') order by created_at`;
  const first = events.find(event => event.type === "assistant.delta")?.created_at as Date | undefined;
  const final = events.find(event => event.type === "assistant.final")?.created_at as Date | undefined;
  const replies = await db`select blocks from companion_messages where run_id=${runId} and role='assistant' order by seq`;
  const reply = replies.map(row => (row.blocks as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text ?? "").join("")).join("\n");
  const tools = await db`select name, status from companion_agent_tool_calls where run_id=${runId} order by created_at`;
  const calls = await db`select provider, duration_ms, cached_tokens, status from ai_audit_log where job_id=(select job_id from companion_turn_runs where id=${runId}) and operation like 'companion_agent%' order by created_at`;
  const problems: string[] = [];
  const okStatus = new Set(["succeeded", ...(item.allowStatus ?? [])]);
  if (!okStatus.has(status)) problems.push(`status ${status}`);
  if (status === "succeeded" && !reply.trim()) problems.push("empty");
  const delivered = calls.filter(call => call.status === "success");
  if (status === "succeeded" && (delivered.length === 0 || delivered.some(call => call.provider !== "mimo_responses"))) problems.push("provider");
  if (item.tool && !tools.some(tool => item.tool!.test(String(tool.name)) && tool.status === "succeeded")) problems.push(`missing ${item.tool}`);
  if (item.reply && status === "succeeded" && !item.reply.test(reply)) problems.push("reply");
  if (item.forbid && item.forbid.test(reply)) problems.push("forbid");
  if (item.noWeb && tools.some(tool => /web/i.test(String(tool.name)) && tool.status === "succeeded")) problems.push("searched");
  const startToFirstMs = first && run?.started_at ? first.getTime() - (run.started_at as Date).getTime() : null;
  if (item.chatFast && (startToFirstMs === null || startToFirstMs > 1_500)) problems.push(`slow ${startToFirstMs}`);
  const totalMs = final ? final.getTime() - acceptedAt : null;
  if (item.chatFast && totalMs !== null && totalMs > 4_000) problems.push(`long ${totalMs}`);
  if (item.maxSteps !== undefined && Number(run?.step_count) > item.maxSteps) problems.push(`steps ${run?.step_count}`);
  if (calls.slice(1).some(call => call.provider === "mimo_responses" && call.cached_tokens !== null && Number(call.cached_tokens) === 0)) problems.push("cache");
  if (status === "waiting_for_confirmation") {
    const [gen] = await db`select generation from companion_turn_runs where id=${runId}`;
    await fetch(`${base}/companion/runs/${runId}/cancel`, {
      method: "POST", headers: { Authorization: `Bearer ${fx.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, generation: Number(gen?.generation ?? 1), reason: "user" }),
    });
  }
  return { id: item.id, status, steps: run?.step_count, firstMs: startToFirstMs, totalMs,
    cached: calls.map(call => call.cached_tokens), tools: tools.map(tool => `${tool.name}:${tool.status}`),
    problems, reply: reply.slice(0, 180), runId };
}

let lastSubmit = 0;
async function pace() {
  const wait = Math.max(0, lastSubmit + 5_200 - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastSubmit = Date.now();
  return lastSubmit;
}

const results: Record<string, unknown>[] = [];
function keep(row: Record<string, unknown>) {
  results.push(row);
  console.log(JSON.stringify(row));
}

const main = await fixture("gap", "full");
const harbor = "潮汐表在抽屉里";
keep(await runTurn(main, {
  id: "note-make",
  text: `新建笔记，标题《港口》，正文只写一行：${harbor}。别加第二段。`,
  tool: /notes\.write/, maxSteps: 2, reply: /潮汐表在抽屉里/,
}, await pace()));
const [note] = await db`select n.id, n.title, string_agg(b.content, '' order by b.ordinal) body
  from notes n join note_blocks b on b.version_id = n.current_version_id
  where n.workspace_id=${main.workspaceId} and n.deleted_at is null and n.title='港口'
  group by n.id, n.title`;
if (!note || !String(note.body).includes(harbor)) {
  keep({ id: "note-body", problems: ["body"], reply: String(note?.body ?? "").slice(0, 180) });
}

keep(await runTurn(main, {
  id: "note-read",
  text: "去笔记里把《港口》的正文读出来，只念原文。",
  tool: /notes\.read/, reply: /潮汐表在抽屉里/, maxSteps: 4,
}, await pace()));

const editedTurn = await runTurn(main, {
  id: "note-edit",
  text: "把笔记《港口》的正文改成一行：潮汐表在船上。不要留旧的那句。",
  tool: /notes\.write/, maxSteps: 6, reply: /潮汐表在船上|已替换/,
}, await pace());
if ((String(editedTurn.reply ?? "").match(/改好/g) ?? []).length > 1) {
  editedTurn.problems = [...(editedTurn.problems as string[] ?? []), "repeated"];
}
keep(editedTurn);
const [edited] = await db`select string_agg(b.content, '' order by b.ordinal) body
  from notes n join note_blocks b on b.version_id = n.current_version_id
  where n.workspace_id=${main.workspaceId} and n.title='港口' and n.deleted_at is null
  group by n.id`;
if (!edited || !String(edited.body).includes("潮汐表在船上") || String(edited.body).includes(harbor)) {
  keep({ id: "note-edited-body", problems: ["body"], reply: String(edited?.body ?? "").slice(0, 180) });
}

keep(await runTurn(main, {
  id: "umbrella-save",
  text: "记住：我的雨伞是黄色的。",
  tool: /memory\.write\.save/, maxSteps: 3,
}, await pace()));
const forgotten = await runTurn(main, {
  id: "umbrella-forget",
  text: "忘掉我的雨伞颜色。这条不要再留着。",
  allowStatus: ["waiting_for_confirmation"],
  maxSteps: 4,
}, await pace());
const forgetTools = (forgotten.tools as string[] | undefined) ?? [];
const forgetReply = String(forgotten.reply ?? "");
const forgetConfirmed = forgotten.status === "waiting_for_confirmation"
  || forgetTools.some(tool => /forget/.test(tool) && /waiting/.test(tool));
const forgetSearched = forgetTools.some(tool => /forget/.test(tool));
const forgetHonest = /没有保存或修改|不成立|没有取得写入回执/.test(forgetReply);
if (!forgetConfirmed && !forgetHonest && !forgetSearched) {
  forgotten.problems = [...(forgotten.problems as string[] ?? []), "claimed-without-receipt"];
}
keep(forgotten);
const [still] = await db`select count(*)::int n from assistant_memory_items
  where user_id=${main.userId} and deleted_at is null and content like '%黄色%'`;
if (Number(still?.n ?? 0) === 0) keep({ id: "umbrella-row", problems: ["deleted-before-confirm"], reply: "0" });

keep(await runTurn(main, {
  id: "web-off",
  text: "现在外滩的实时气温是多少？没有联网就直接说查不到，不要编一个度数。",
  chatFast: true, noWeb: true, forbid: /我查了|根据搜索|来源显示/, reply: /查不到|没有联网|不能查|不知道|没开/,
}, await pace()));
await db`UPDATE user_companion_account_state SET agent_settings = agent_settings || '{"webSearchEnabled": true}'::jsonb WHERE user_id=${main.userId}`;
const webOn = await runTurn(main, {
  id: "web-on",
  text: "用联网搜索查「钱塘江潮汐」这几个字在公开网页上有没有结果。有就写出一条来源标题，没有或失败就说没有，不要编标题。",
  tool: /web\.search/, maxSteps: 6,
}, await pace());
if ((String(webOn.reply ?? "").match(/有结果/g) ?? []).length > 1) {
  webOn.problems = [...(webOn.problems as string[] ?? []), "repeated"];
}
keep(webOn);

const filler = "港区灯一盏盏亮起来，缆绳还是湿的。".repeat(40);
keep(await runTurn(main, {
  id: "long",
  text: `${filler}中间那艘船的名字是青鲈。${filler}这段里船叫什么？只回答名字。`,
  reply: /青鲈/, maxSteps: 1,
}, await pace()));

await pace();
const cancelAcceptedAt = Date.now();
lastSubmit = cancelAcceptedAt;
const cancelAccepted = await fetch(`${base}/companion/conversations/${main.conversationId}/turns`, {
  method: "POST", headers: { Authorization: `Bearer ${main.token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet",
    blocks: [{ type: "text", text: "从 1 数到 400，每个数字单独成行。现在就开始。" }] }),
}).then(r => r.json()) as { runId?: string };
if (!cancelAccepted.runId) keep({ id: "cancel", problems: ["rejected"], reply: JSON.stringify(cancelAccepted).slice(0, 180) });
else {
  const [gen] = await db`select generation from companion_turn_runs where id=${cancelAccepted.runId}`;
  const cancel = await fetch(`${base}/companion/runs/${cancelAccepted.runId}/cancel`, {
    method: "POST", headers: { Authorization: `Bearer ${main.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, generation: Number(gen?.generation ?? 1), reason: "user" }),
  });
  const deadline = Date.now() + 30_000;
  let status = "accepted";
  while (Date.now() < deadline) {
    const [row] = await db`select status from companion_turn_runs where id=${cancelAccepted.runId}`;
    status = String(row?.status ?? "missing");
    if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const tools = await db`select name, status from companion_agent_tool_calls where run_id=${cancelAccepted.runId}`;
  const problems: string[] = [];
  if (status !== "cancelled" && status !== "succeeded") problems.push(`status ${status}`);
  if (tools.some(tool => tool.status === "succeeded" && /write|save|forget/i.test(String(tool.name)))) problems.push("wrote");
  keep({ id: "cancel", status, cancelHttp: cancel.status, problems, tools: tools.map(tool => `${tool.name}:${tool.status}`) });
}
keep(await runTurn(main, {
  id: "after-cancel",
  text: "只回两个字：在的。",
  chatFast: true, reply: /在的?/,
}, await pace()));

const other = await fixture("gap-other", "full");
keep(await runTurn(other, { id: "other-1", text: "杯子空了。", chatFast: true }, await pace()));
const other2 = await runTurn(other, { id: "other-2", text: "那我去倒水。", chatFast: true }, await pace());
keep(other2);
const cached = Array.isArray(other2.cached) ? other2.cached : [];
if (cached.some(value => value !== null && Number(value) === 0)) {
  keep({ id: "other-cache", problems: ["cache"], reply: JSON.stringify(cached) });
}

const guided = await fixture("gap-guided", "guided");
const guidedTurn = await runTurn(guided, {
  id: "guided-save",
  text: "记住：抽屉密码是 2468。",
  allowStatus: ["waiting_for_confirmation"],
  forbid: /已经记住|已保存|记住了/,
}, await pace());
keep(guidedTurn);
const [saved] = await db`select count(*)::int n from assistant_memory_items
  where user_id=${guided.userId} and deleted_at is null and content like '%2468%'`;
if (Number(saved?.n ?? 0) > 0) keep({ id: "guided-row", problems: ["wrote-without-confirm"], reply: String(saved?.n) });
if (guidedTurn.status === "succeeded" && !(guidedTurn.tools as string[] | undefined)?.some(tool => tool.startsWith("memory.write.save:waiting"))) {
  const tools = (guidedTurn.tools as string[] | undefined) ?? [];
  if (!tools.some(tool => /waiting/.test(tool))) keep({ id: "guided-proposal", problems: ["no-confirmation"], reply: tools.join(",") });
}

const bad = results.filter(row => Array.isArray(row.problems) && (row.problems as string[]).length > 0);
console.log(`\nPROBLEMS ${bad.length}/${results.length} ${JSON.stringify(bad.map(row => ({ id: row.id, problems: row.problems, reply: row.reply, status: row.status })))}`);
await db.end();
process.exit(bad.length ? 2 : 0);
