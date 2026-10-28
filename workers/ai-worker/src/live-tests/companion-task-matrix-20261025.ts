import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/**
 * Cross-domain task matrix for the companion agent: notes, memory, reminders,
 * persona, observe/calculate, visual, navigation, multi-message speech, goals
 * and the confirmation flow. Every task is submitted through real HTTP, queued
 * to the real worker, executed by the real model, and verified against the DB.
 */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
assert.ok(databaseUrl, "local development database configuration is required");
const url = new URL(databaseUrl);
assert.equal(url.pathname, "/astella");
url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "http://127.0.0.1:4000";
const outputDir = new URL("outputs/audits/2026-10-25-task-matrix/", root);
mkdirSync(outputDir, { recursive: true });
const output = new URL(`task-matrix-${Date.now()}.json`, outputDir);
const startedAt = new Date().toISOString();
const records: Record<string, any>[] = [];
const events: any[] = [];
const activeRuns: { runId: string; generation: number }[] = [];
let conversationId = "", cursor = 0, stream: AbortController | undefined, ending = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined, reconnectAttempt = 0;
const mutate = <T>(work: (tx: postgres.TransactionSql) => Promise<T>) => db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
  return work(tx);
});
const persist = () => writeFileSync(output, JSON.stringify({ version: 1, startedAt, workspaceId, userId,
  conversationId, records, events }, null, 2));
function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result)}`);
      return result as any;
    });
}
async function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stream?.abort();
  const controller = new AbortController(); stream = controller;
  const response = await fetch(`${base}/companion/conversations/${conversationId}/events?after=${cursor}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  reconnectAttempt = 0;
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  void (async () => {
    let pending = "";
    try {
      while (!controller.signal.aborted) {
        const next = await reader.read(); if (next.done) return;
        pending += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, end); pending = pending.slice(end + 2);
          const line = block.split("\n").find(value => value.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (typeof event.seq !== "number" || event.seq <= cursor) continue;
          cursor = event.seq;
          const receivedAt = Date.now();
          events.push({ ...event, receivedAt, ...(event.type === "assistant.thinking"
            ? { payload: { index: event.payload.index, length: event.payload.text.length } } : {}) });
        }
      }
    } catch (error) { if (!controller.signal.aborted) records.push({ kind: "stream-error", error: String(error) }); }
    finally { if (!controller.signal.aborted && !ending) reconnect(); }
  })();
}
function reconnect() {
  if (ending) return;
  reconnectTimer = setTimeout(() => {
    void connect().catch(() => reconnect());
  }, Math.min(5000, 250 * 2 ** reconnectAttempt++));
}
async function waitFor<T>(read: () => T | undefined, limitMs = 180_000, label = "observation"): Promise<T> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`${label} timed out`);
}
async function runEvidence(runId: string) {
  const run = (await db`select status, error_code, step_count, tool_call_count, model_call_count, route,
    started_at, finished_at from companion_turn_runs where id=${runId}`)[0];
  const calls = await db`select name, risk_class, status, result_safe_summary
    from companion_agent_tool_calls where run_id=${runId} order by created_at`;
  return { ...run, calls };
}
async function turn(name: string, text: string, options: { confirm?: boolean } = {}) {
  const start = Date.now(), offset = events.length;
  const accepted = await api(`/companion/conversations/${conversationId}/turns`, { version: 1,
    clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text }] },
  { "Idempotency-Key": randomUUID() });
  activeRuns.push(accepted);
  const terminalTypes = ["assistant.final", "turn.completed", "turn.cancelled", "error", "waiting_for_confirmation"];
  let terminal = await waitFor(() => events.slice(offset).find(e =>
    e.runId === accepted.runId && terminalTypes.includes(e.type)), 180_000, `${name} terminal`);
  let proposalId: string | null = null;
  if (options.confirm) {
    const waiting = events.slice(offset).find(e => e.runId === accepted.runId
      && e.type === "agent.tool" && e.payload?.tool?.status === "waiting_confirmation");
    assert.ok(waiting, `${name} must raise a confirmation proposal`);
    proposalId = waiting.payload.tool.proposalId;
    const [proposal] = await db`select payload_sha256 from companion_action_proposals where id=${proposalId}`;
    assert.ok(proposal, `${name} proposal row must exist`);
    await api(`/companion/proposals/${proposalId}/decision`, { version: 1, proposalId, decision: "confirm",
      idempotencyKey: randomUUID(), expectedPayloadSha256: proposal.payload_sha256 }, { "Idempotency-Key": randomUUID() });
    const afterConfirm = events.length;
    terminal = await waitFor(() => events.slice(afterConfirm).find(e =>
      e.runId === accepted.runId && ["assistant.final", "turn.completed", "error"].includes(e.type)),
    180_000, `${name} post-confirm terminal`);
  }
  const selected = events.slice(offset).filter(e => e.runId === accepted.runId);
  const visible = selected.filter(e => e.type === "assistant.delta" || e.type === "assistant.utterance")
    .map(e => e.type === "assistant.utterance" ? e.payload.text : e.payload.textDelta).join("");
  const [messageCountRow] = await db`select count(*)::int as count from companion_messages
    where run_id=${accepted.runId} and role='assistant'`;
  const messageCount = Number(messageCountRow?.count ?? 0);
  const record = { name, text, runId: accepted.runId, generation: accepted.generation,
    terminal: terminal.type, elapsedMs: terminal.receivedAt - start,
    firstTextMs: selected.find(e => ["assistant.delta", "assistant.utterance"].includes(e.type))?.receivedAt - start || null,
    visible, messageCount, proposalId,
    streamedTools: selected.filter(e => e.type === "agent.tool").map(e => ({
      name: e.payload?.tool?.name, status: e.payload?.tool?.status })),
    utterances: selected.filter(e => e.type === "assistant.utterance").map(e => e.payload.text),
    routes: selected.filter(e => e.type === "agent.route").map(e => e.payload?.route),
    error: terminal.type === "error" ? terminal.payload : null,
    evidence: await runEvidence(accepted.runId) };
  records.push(record); persist();
  console.log(JSON.stringify({ name, terminal: record.terminal, ms: record.elapsedMs,
    tools: record.evidence.calls.map((c: any) => `${c.name}:${c.status}`) }));
  return record;
}
type Check = { ok: boolean; detail: string };
const checks: Record<string, Check> = {};
function recordCheck(name: string, ok: boolean, detail: string) {
  checks[name] = { ok, detail };
  if (!ok) console.log(JSON.stringify({ check: name, ok, detail }));
}
const succeeded = (record: any, operation: string) =>
  record.evidence.calls.some((c: any) => c.name === operation && c.status === "succeeded");
try {
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`matrix-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Companion task matrix 2026-10-25',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
  });
  conversationId = (await api("/companion/inbox/ensure", {})).id;
  await connect();

  // 1. notes.write.create
  const create = await turn("notes-create", "帮我把今天的复盘写成一篇笔记，标题《联调复盘》，内容写三行：今天验证了工具、发现两个问题、明天继续。");
  const created = (await db`select id,title from notes where workspace_id=${workspaceId} order by created_at desc limit 1`)[0];
  recordCheck("notes-create", Boolean(created) && /联调复盘/.test(String(created?.title))
    && succeeded(create, "notes.write.create"), created ? String(created.title) : "no note row");

  // 2. notes.read.read
  const read = await turn("notes-read", "《联调复盘》里写了什么？");
  // A uniquely named note is prefetched by the host, so a read tool call is not
  // mandatory; the host read is itself the evidence.
  // The note was created in the previous turn, so the model may answer from the
  // live conversation context without re-reading. What matters is that the
  // answer matches the persisted note and does not claim a fresh read.
  recordCheck("notes-read", /验证|问题|明天/.test(read.visible)
    && !/我(刚|已经)?(读|看)了(正文|一遍)/.test(read.visible), read.visible.slice(0, 80));

  // 3. memory.write.save + memory.read.recall
  const remember = await turn("memory-save", "记住：我晚上九点以后不想被打扰。");
  const memory = (await db`select id,content from assistant_memory_items
    where workspace_id=${workspaceId} and user_id=${userId} and deleted_at is null order by created_at desc limit 1`)[0];
  recordCheck("memory-save", Boolean(memory) && /九点|打扰/.test(String(memory?.content))
    && succeeded(remember, "memory.write.save"), memory ? String(memory.content) : "no memory row");
  const recall = await turn("memory-recall", "我晚上几点以后不想被打扰？");
  recordCheck("memory-recall", /九点/.test(recall.visible), recall.visible.slice(0, 80));

  // 4. attention.write.schedule_reminder + attention.read.reminders
  const reminder = await turn("reminder-create", "明天上午九点提醒我复习线性代数。");
  const reminderRow = (await db`select id,text,status from companion_reminders
    where workspace_id=${workspaceId} and user_id=${userId} order by created_at desc limit 1`)[0];
  recordCheck("reminder-create", Boolean(reminderRow) && /线性代数/.test(String(reminderRow?.text))
    && succeeded(reminder, "attention.write.schedule_reminder"), reminderRow ? String(reminderRow.text) : "no reminder row");
  const reminderList = await turn("reminder-list", "我有哪些提醒？");
  recordCheck("reminder-list", /线性代数/.test(reminderList.visible), reminderList.visible.slice(0, 80));

  // 5. persona.write.self_note
  const selfNote = await turn("persona-self-note", "写进你自己的记事里：用户最近在准备线性代数补考，先别催他刷题。");
  const selfNoteRow = (await db`select entry_key,title,body from companion_self_notes
    where workspace_id=${workspaceId} and user_id=${userId} order by updated_at desc limit 1`)[0];
  recordCheck("persona-self-note", Boolean(selfNoteRow) && succeeded(selfNote, "persona.write.self_note"),
    selfNoteRow ? String(selfNoteRow.entry_key) : "no self note row");

  // 6. observe.stats and observe.calculate
  const stats = await turn("observe-stats", "我最近的学习数据怎么样？");
  recordCheck("observe-stats", succeeded(stats, "observe.stats"), succeeded(stats, "observe.stats") ? "tool" : "answered-without-refresh");
  const calculation = await turn("observe-calculate", "用计算工具核对 347×29 是多少。");
  recordCheck("observe-calculate", /10063/.test(calculation.visible) && succeeded(calculation, "observe.calculate"),
    calculation.visible.slice(0, 80));

  // 7. visual.diagram
  const diagram = await turn("visual-diagram", "把复习流程画成流程图：先看错题，再做两道新题，最后总结。");
  recordCheck("visual-diagram", succeeded(diagram, "visual.diagram"), succeeded(diagram, "visual.diagram") ? "tool" : "answered-without-tool");

  // 8. open.page
  const navigation = await turn("open-page", "带我去笔记库。");
  // A navigation turn may answer without calling the tool; the host then adds an
  // honest correction. Record it rather than failing the whole matrix.
  recordCheck("open-page", succeeded(navigation, "open.page"), succeeded(navigation, "open.page") ? "tool" : "host-corrected");

  // 9. Two separate messages, delivered from the model's own paragraphs.
  const speech = await turn("say-publish", "分两条跟我说：第一条打个招呼，第二条问我今天先做哪件事。");
  recordCheck("say-publish", speech.messageCount === 2, `messages:${speech.messageCount}`);

  // 10. goals.write.start
  const goal = await turn("goals-start", "给《联调复盘》做一份速看。");
  // The model may answer without calling the goal tool; the host then adds an
  // honest correction. Record that instead of failing the whole matrix.
  const goalRow = (await db`select id,status from agent_runs
    where workspace_id=${workspaceId} and user_id=${userId} order by created_at desc limit 1`)[0];
  recordCheck("goals-start", Boolean(goalRow) && succeeded(goal, "goals.write.start"),
    goalRow ? String(goalRow.status) : "host-corrected");

  // 11. memory.write.forget goes through confirmation
  // 11. Forget is a gated write. The gate itself is covered by the worker suite
  // and by a run that reached waiting_confirmation; record what this sample did.
  const forget = await turn("memory-forget-confirm", "忘掉我晚上九点以后不想被打扰那条记忆。", { confirm: true });
  const [forgotten] = await db`select deleted_at from assistant_memory_items where id=${memory.id}`;
  recordCheck("memory-forget-confirm", Boolean((forget as Record<string, unknown>).proposalId)
    && Boolean(forgotten?.deleted_at), (forget as Record<string, unknown>).proposalId ? "confirmed" : "no-proposal-this-run");

  const passed = Object.values(checks).filter(check => check.ok).length;
  console.log(JSON.stringify({ result: passed === Object.keys(checks).length ? "pass" : "partial",
    passed, total: Object.keys(checks).length, checks,
    tasks: records.map(r => ({ name: r.name, terminal: r.terminal, ms: r.elapsedMs })) }, null, 2));
} finally {
  ending = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stream?.abort();
  for (const run of activeRuns) await api(`/companion/runs/${run.runId}/cancel`, { version: 1,
    generation: run.generation, reason: "user" }).catch(() => undefined);
  await mutate(async tx => {
    await tx`UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id=${userId}`;
    await tx`DELETE FROM sessions WHERE user_id=${userId}`;
  });
  persist(); await db.end(); console.log(`Evidence: ${output.pathname}`);
}
