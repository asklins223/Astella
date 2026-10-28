import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/** HTTP -> queue -> production worker -> durable messages and receipts.
 * Synthetic account only; never changes real users' settings. No model judge,
 * answer repair prompts, automatic resubmission, or plaintext reasoning logs. */
assert.equal(process.env.REAL_MODEL_BATCH, "1", "requires explicit REAL_MODEL_BATCH=1");
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = new URL(env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL!);
assert.equal(databaseUrl.pathname, "/astella");
databaseUrl.hostname = "127.0.0.1";
const db = postgres(databaseUrl.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const outputDir = new URL("outputs/agent-reliability-2026-10-28/", root);
mkdirSync(outputDir, { recursive: true });
const label = process.env.RELIABILITY_LABEL ?? "probe";
assert.match(label, /^[a-z0-9-]+$/);
const output = new URL(`${label}-${Date.now()}.json`, outputDir);
const base = "http://127.0.0.1:4000";
const active: Array<{ runId: string; generation: number }> = [];
const records: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
const mutate = <T>(work: (tx: postgres.TransactionSql) => Promise<T>) => db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
  return work(tx);
});
async function api(endpoint: string, body?: unknown) {
  const response = await fetch(`${base}${endpoint}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.ok, true, `HTTP ${response.status} at ${endpoint}`);
  return await response.json() as { id: string; runId: string; generation: number };
}
type Case = { id: string; prompt: string; tools?: string[]; messages?: number; includes?: RegExp;
  noTools?: boolean; grounded?: "note" | "memory" };
const hiddenAnswer = `松风海盐${randomBytes(4).toString("hex")}`;
const cases: Case[] = [
  { id: "greeting", prompt: "在吗？", noTools: true },
  { id: "casual-tired", prompt: "今天有点累。", noTools: true },
  { id: "greeting-english", prompt: "Hey, good morning!", noTools: true },
  { id: "casual-thanks", prompt: "谢谢你，晚安。", noTools: true },
  { id: "split", prompt: "分两条消息发给我：先说早上好，再问我今天准备先做什么。", messages: 2,
    tools: ["say.publish"] },
  { id: "arithmetic", prompt: "用计算工具核对 347 乘以 29 是多少。", includes: /10[，, ]?063/u,
    tools: ["observe.calculate"] },
  { id: "explanation", prompt: "为什么质量不同的两个物体在真空中同时落地？讲清加速度与力的关系。",
    includes: /加速度/u },
  { id: "proof", prompt: "请严格证明根号2是无理数，不要省略关键推理。", includes: /偶数|even/iu },
  { id: "memory-write", prompt: "记住我的一个偏好：我最喜欢的颜色是湖蓝色。", grounded: "memory" },
  { id: "memory-read", prompt: "我刚才让你记住的颜色是什么？", includes: /湖蓝/u },
  { id: "note-create", prompt: "新建一篇笔记，标题《可靠性验收》，写三点：完成两章、还剩一章、明天补完。",
    grounded: "note", tools: ["notes.write.create"] },
  { id: "note-read", prompt: "读取《可靠性验收》，告诉我里面是哪三点。",
    includes: /两章|二章/u, tools: ["notes.read.read"] },
  { id: "after-task-chat", prompt: "哈哈，谢谢你。", noTools: true },
  { id: "compound", prompt: "分两条消息发给我：第一条用计算工具算 128 乘以 7，第二条说一句晚安。",
    includes: /896/u, messages: 2, tools: ["observe.calculate", "say.publish"] },
  { id: "fresh-note-read", prompt: "读取《独立验收资料》，告诉我资料暗号是什么。",
    includes: new RegExp(hiddenAnswer, "u"), tools: ["notes.read.read"] },
  { id: "casual-return", prompt: "刚从外面回来，风好大。", noTools: true },
  { id: "casual-success", prompt: "今天终于把拖了很久的事搞定了。", noTools: true },
  { id: "casual-rest", prompt: "今天脑子不想转了，我就想靠这儿待会儿。不用问我问题，也别安排学习。", noTools: true },
  { id: "coffee", prompt: "热咖啡为什么会变凉？解释一下杯内液体的流动、杯子和空气各有什么作用。", includes: /对流|下沉/u },
  { id: "newton-pair", prompt: "人推箱子，箱子用等大的力推人。为什么它们不抵消，箱子还能加速？", includes: /不同.*(?:物体|对象)|分别.*(?:物体|对象)/u },
  { id: "correlation", prompt: "冰淇淋销量越多的日子溺水人数也越多，能证明吃冰淇淋导致溺水吗？", includes: /不能|不代表|不等于|无法/u },
];
const selected = process.env.RELIABILITY_CASES?.split(",");
const repeats = Number(process.env.RELIABILITY_REPEATS ?? "1");
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
if (selected) assert.ok(selected.every(id => cases.some(c => c.id === id)), "unknown case");
const persist = () => writeFileSync(output, JSON.stringify({ version: 1, label, startedAt,
  workspaceId, userId, records, note: "Synthetic local HTTP acceptance; structural checks are not a semantic quality certification." }, null, 2));
let conversationId = "";
let fatal = false;
try {
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`reliability-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Agent reliability probe',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '1 hour')`;
  });
  conversationId = (await api("/companion/inbox/ensure", {})).id;
  await api("/notes", { title: "独立验收资料", blocks: [{ type: "paragraph", content: `资料暗号：${hiddenAnswer}。` }] });
  for (let repeat = 0; repeat < repeats; repeat++) for (const c of cases.filter(c => !selected || selected.includes(c.id))) {
    const start = Date.now();
    const accepted = await api(`/companion/conversations/${conversationId}/turns`, {
      version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet",
      blocks: [{ type: "text", text: c.prompt }],
    });
    active.push(accepted);
    let status = "accepted";
    const deadline = start + 120_000;
    while (Date.now() < deadline) {
      const [run] = await db`SELECT status FROM companion_turn_runs WHERE id=${accepted.runId}`;
      status = String(run?.status ?? "missing");
      if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const [run] = await db`SELECT status,error_code,step_count,model_call_count,route,created_at,started_at,
      (SELECT count(*) FROM companion_agent_steps s WHERE s.run_id=r.id) AS actual_steps
      FROM companion_turn_runs r WHERE id=${accepted.runId}`;
    const calls = await db`SELECT name,status FROM companion_agent_tool_calls WHERE run_id=${accepted.runId} ORDER BY created_at`;
    const hostReads = (await db`SELECT payload->'tool' AS tool FROM companion_stream_events
      WHERE run_id=${accepted.runId} AND type='agent.tool' AND payload->'tool'->>'source'='host_prefetch'`)
      .map(row => row.tool as { name: string; status: string });
    const providerCalls = await db`SELECT provider,operation,duration_ms,prompt_tokens,completion_tokens,cached_tokens,status
      FROM ai_audit_log WHERE job_id=(SELECT job_id FROM companion_turn_runs WHERE id=${accepted.runId}) ORDER BY created_at`;
    const messages = await db`SELECT blocks FROM companion_messages WHERE run_id=${accepted.runId} AND role='assistant' ORDER BY seq`;
    const texts = messages.map(row => (row.blocks as Array<{ type: string; text?: string }>).filter(b => b.type === "text").map(b => b.text ?? "").join(""));
    const visible = texts.join("\n\n");
    const [timing] = await db`SELECT min(created_at) FILTER (WHERE type IN ('assistant.delta','assistant.utterance')) AS first_visible_at
      FROM companion_stream_events WHERE run_id=${accepted.runId}`;
    const checks: Record<string, boolean> = { succeeded: status === "succeeded", nonempty: visible.trim().length > 0,
      noInternalLeak: !/companion_[a-z_]{4,}|<current_turn|<memory_data>|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(visible) };
    if (c.noTools) checks.noTools = calls.length === 0;
    if (c.tools) checks.requestedTools = c.tools.every(name => [...calls, ...hostReads].some(call => call.name === name && call.status === "succeeded"));
    if (c.messages) checks.messageCount = texts.length === c.messages;
    if (c.includes) checks.answer = c.includes.test(visible);
    if (c.grounded === "note") {
      const [note] = await db`SELECT count(*) AS n FROM notes WHERE workspace_id=${workspaceId} AND title='可靠性验收' AND deleted_at IS NULL`;
      checks.saved = Number(note?.n) > 0;
    }
    if (c.grounded === "memory") {
      const [memory] = await db`SELECT count(*) AS n FROM assistant_memory_items WHERE workspace_id=${workspaceId} AND user_id=${userId} AND deleted_at IS NULL AND content LIKE '%湖蓝%'`;
      checks.saved = Number(memory?.n) > 0;
    }
    const record = { id: c.id, repeat, prompt: c.prompt, runId: accepted.runId, ok: Object.values(checks).every(Boolean),
      checks, elapsedMs: Date.now() - start, firstVisibleMs: timing?.first_visible_at ? new Date(timing.first_visible_at).getTime() - start : null,
      run, calls, hostReads, providerCalls, texts };
    records.push(record); persist();
    console.log(JSON.stringify({ id: c.id, repeat, ok: record.ok, checks, elapsedMs: record.elapsedMs, firstVisibleMs: record.firstVisibleMs }));
    if (!["succeeded", "failed", "cancelled"].includes(status)) {
      await api(`/companion/runs/${accepted.runId}/cancel`, { version: 1, generation: accepted.generation, reason: "user" });
      // The next prompt must not race a still-active cancelled job.
      for (let wait = 0; wait < 50; wait++) {
        const [cancelled] = await db`SELECT status FROM companion_turn_runs WHERE id=${accepted.runId}`;
        if (["cancelled", "failed", "succeeded"].includes(String(cancelled?.status))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
} catch (error) {
  fatal = true;
  records.push({ fatal: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  for (const run of active) await api(`/companion/runs/${run.runId}/cancel`, {
    version: 1, generation: run.generation, reason: "user",
  }).catch(() => undefined);
  await mutate(async tx => {
    await tx`UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id=${userId}`;
    await tx`DELETE FROM sessions WHERE user_id=${userId}`;
  });
  persist();
  await db.end();
  console.log(JSON.stringify({ passed: records.filter(r => r.ok === true).length, total: records.length, evidence: output.pathname }));
  if (fatal || records.some(r => r.ok === false)) process.exitCode = 1;
}
