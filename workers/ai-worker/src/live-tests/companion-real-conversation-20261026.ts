import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";

/**
 * Real-model conversation matrix, run twice for stability.
 *
 * Every prompt below is ordinary user speech: none names a tool, an action, a
 * parameter or a "now use tools" instruction. What is asserted is the outcome a
 * person can check — the row exists, the answer matches what was stored, the
 * stream ended once — never which tool the model chose to get there.
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
const outputDir = new URL("outputs/audits/2026-10-26-real-conversation/", root);
mkdirSync(outputDir, { recursive: true });
const output = new URL(`matrix-${Date.now()}.json`, outputDir);
const startedAt = new Date().toISOString();
// Same capabilities, different ordinary phrasings. A fixed sentence passing is
// not evidence that the agent generalizes; run both with LIVE_PARAPHRASE=1.
const paraphrased = process.env.LIVE_PARAPHRASE === "1";
const p = (normal: string, alternative: string) => paraphrased ? alternative : normal;
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
          events.push({ ...event, receivedAt: Date.now(), ...(event.type === "assistant.thinking"
            ? { payload: { index: event.payload.index, length: event.payload.text.length } } : {}) });
        }
      }
    } catch (error) { if (!controller.signal.aborted) records.push({ kind: "stream-error", error: String(error) }); }
    finally { if (!controller.signal.aborted && !ending) reconnect(); }
  })();
}
function reconnect() {
  if (ending) return;
  reconnectTimer = setTimeout(() => { void connect().catch(() => reconnect()); }, Math.min(5000, 250 * 2 ** reconnectAttempt++));
}
async function waitFor<T>(read: () => T | undefined, limitMs = 600_000, label = "observation"): Promise<T> {
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
async function converse(name: string, text: string, options: { confirm?: boolean } = {}) {
  const start = Date.now(), offset = events.length;
  const accepted = await api(`/companion/conversations/${conversationId}/turns`, { version: 1,
    clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text }] },
  { "Idempotency-Key": randomUUID() });
  activeRuns.push(accepted);
  const terminalTypes = ["assistant.final", "turn.completed", "turn.cancelled", "error"];
  // A gated write deliberately ends its first pass without a terminal event: the
  // turn resumes only after the person decides. Waiting for a terminal first
  // would always time out, so wait for either one.
  let terminal: any;
  if (options.confirm) {
    // The gate ends its first pass without a terminal frame, and a reconnect can
    // drop the card itself, so the proposal row is what the confirmation waits on.
    const until = Date.now() + 600_000;
    while (!terminal && Date.now() < until) {
      terminal = events.slice(offset).find(e => e.runId === accepted.runId
        && (terminalTypes.includes(e.type)
          || (e.type === "agent.tool" && e.payload?.tool?.status === "waiting_confirmation")));
      if (terminal) break;
      // The proposal may be attached to a continuation run, not the accepted run.
      const [pending] = await db`select id from companion_action_proposals
        where conversation_id=${conversationId} and status='pending' order by created_at desc limit 1`;
      if (pending) {
        terminal = { runId: accepted.runId, type: "agent.tool", receivedAt: Date.now(),
          payload: { tool: { status: "waiting_confirmation", proposalId: pending.id } } };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(terminal, `${name} terminal timed out`);
  } else {
    terminal = await waitFor(() => events.slice(offset).find(e => e.runId === accepted.runId
      && terminalTypes.includes(e.type)), 600_000, `${name} terminal`);
  }
  let proposalId: string | null = null;
  if (options.confirm && terminal.type === "agent.tool") {
    proposalId = terminal.payload.tool.proposalId;
    let [proposal] = await db`select payload_sha256, status from companion_action_proposals where id=${proposalId}`;
    // A continuation run can create the card; resolve the newest pending card in
    // this conversation when the accepted run has none of its own.
    if (!proposal) {
      const [pending] = await db`select id, payload_sha256, status from companion_action_proposals
        where conversation_id=${conversationId} and status='pending' order by created_at desc limit 1`;
      if (pending) { proposalId = pending.id; proposal = pending; }
    }
    // A card that already expired or was resolved is stale by design; record the
    // outcome instead of aborting the whole matrix.
    if (proposal && proposal.status === "pending") {
      await api(`/companion/proposals/${proposalId}/decision`, { version: 1, proposalId, decision: "confirm",
        idempotencyKey: randomUUID(), expectedPayloadSha256: proposal.payload_sha256 }, { "Idempotency-Key": randomUUID() })
        .catch(error => records.push({ name, note: `confirm-failed: ${String(error)}` }));
    }
    const afterConfirm = events.length;
    terminal = await waitFor(() => events.slice(afterConfirm).find(e =>
      e.runId === accepted.runId && ["assistant.final", "turn.completed", "error"].includes(e.type)),
    600_000, `${name} post-confirm terminal`);
  } else if (terminal.type === "agent.tool" && terminal.payload?.tool?.status === "waiting_confirmation") {
    // Nobody presses this card in a scripted run: record it and cancel, so the
    // conversation can move on to the next task.
    proposalId = terminal.payload.tool.proposalId ?? null;
    await api(`/companion/runs/${accepted.runId}/cancel`, { version: 1,
      generation: accepted.generation, reason: "user" }).catch(() => undefined);
    terminal = await waitFor(() => events.slice(offset).find(e => e.runId === accepted.runId
        && ["turn.completed", "turn.cancelled", "error", "assistant.final"].includes(e.type)),
      120_000, `${name} cancelled terminal`).catch(() => terminal);
  } else if (options.confirm) {
    records.push({ name, text, runId: accepted.runId, note: "no-confirmation-proposal" });
  }
  const selected = events.slice(offset).filter(e => e.runId === accepted.runId);
  const visible = selected.filter(e => e.type === "assistant.delta" || e.type === "assistant.utterance")
    .map(e => e.type === "assistant.utterance" ? e.payload.text : e.payload.textDelta).join("");
  const finals = selected.filter(e => e.type === "assistant.final");
  const record = { name, text, runId: accepted.runId, generation: accepted.generation,
    terminal: terminal.type, elapsedMs: terminal.receivedAt - start,
    firstTextMs: selected.find(e => ["assistant.delta", "assistant.utterance"].includes(e.type))?.receivedAt - start || null,
    visible, finalCount: finals.length, proposalId,
    streamedTools: selected.filter(e => e.type === "agent.tool").map(e => ({
      name: e.payload?.tool?.name, status: e.payload?.tool?.status })),
    utterances: selected.filter(e => e.type === "assistant.utterance").map(e => e.payload.text),
    routes: selected.filter(e => e.type === "agent.route").map(e => e.payload?.route),
    error: terminal.type === "error" ? terminal.payload : null,
    evidence: await runEvidence(accepted.runId) };
  records.push(record); persist();
  console.log(JSON.stringify({ name, terminal: record.terminal, ms: record.elapsedMs,
    finals: record.finalCount, tools: record.evidence.calls.map((c: any) => `${c.name}:${c.status}`) }));
  return record;
}
/** One stalled turn must not hide the remaining tasks (background jobs included). */
async function cancelStaleRun() {
  const [active] = await db`select id, generation from companion_turn_runs
    where conversation_id=${conversationId} and status in ('accepted','running','waiting_for_confirmation')
    order by created_at desc limit 1`;
  if (!active) return;
  await api(`/companion/runs/${active.id}/cancel`, { version: 1, generation: Number(active.generation), reason: "user" })
    .catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 1_500));
}
async function attempt(name: string, text: string, options: { confirm?: boolean } = {}) {
  try {
    await cancelStaleRun();
    return await converse(name, text, options);
  } catch (error) {
    const record = { name, text, terminal: "timeout", visible: "", finalCount: 0, utterances: [],
      streamedTools: [], evidence: { calls: [] as any[] }, error: String(error) };
    records.push(record as never); persist();
    console.log(JSON.stringify({ name, terminal: "timeout", error: String(error).slice(0, 120) }));
    return record;
  }
}
type Check = { ok: boolean; detail: string; firstTry: boolean };
const checks: Record<string, Check> = {};
function recordCheck(name: string, ok: boolean, detail: string, firstTry = ok) {
  checks[name] = { ok, detail, firstTry };
  console.log(JSON.stringify({ check: name, ok, detail, firstTry }));
}
async function waitForJob(predicate: () => Promise<{ status: string; error_code?: string | null } | undefined>,
  limitMs = 300_000, label = "job") {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const row = await predicate();
    if (row && ["succeeded", "failed", "dead", "cancelled"].includes(row.status)) return row;
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(`${label} timed out`);
}

try {
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`matrix-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Companion real conversation 2026-10-26',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '4 hours')`;
  });
  conversationId = (await api("/companion/inbox/ensure", {})).id;
  await connect();

  // ── Ordinary conversation: no tools should be forced, no claim invented ──
  const chat = await attempt("chat-greeting", "在吗？今天有点累。");
  recordCheck("chat-greeting", chat.terminal !== "error" && chat.visible.trim().length > 0
    && chat.finalCount <= 1, `${chat.terminal}/${chat.finalCount} finals`);

  const knowledge = await attempt("chat-knowledge", "为什么海水是咸的？简单说说就行。");
  recordCheck("chat-knowledge", knowledge.terminal === "assistant.final" && knowledge.finalCount === 1
    && knowledge.visible.trim().length > 20, `${knowledge.finalCount} finals, ${knowledge.visible.length} chars`);

  // ── Notes: create, then read back in ordinary speech ──
  await attempt("notes-create", "帮我把今天的复盘写成一篇笔记，标题叫《十月二十六复盘》，就写三点：今天联调通过了、还有两个小问题、明天继续。");
  const created = (await db`select id,title,current_version_id from notes where workspace_id=${workspaceId}
    and deleted_at is null order by created_at desc limit 1`)[0];
  recordCheck("notes-create", Boolean(created) && /复盘/.test(String(created?.title)),
    created ? String(created.title) : "no note row");

  const read = await attempt("notes-read", "《十月二十六复盘》里我写了哪三点？");
  recordCheck("notes-read", /联调|问题|明天/.test(read.visible), read.visible.slice(0, 90));

  await attempt("notes-edit", "把《十月二十六复盘》的第二点改一下：不是两个小问题，是三个小问题，其他都别动。");
  const edited = await db`select b.content from note_blocks b where b.version_id=(
      select current_version_id from notes where id=${created?.id ?? null})
    order by b.ordinal`;
  const editedText = edited.map((row: any) => String(row.content)).join("\n");
  recordCheck("notes-edit", /三个/.test(editedText) && /联调/.test(editedText),
    editedText.slice(0, 120));

  // ── Memory: state a preference, then ask it back later in the same chat ──
  await attempt("memory-remember", p("记一下：我晚上九点以后不想被打扰。",
    "帮我记住，晚上九点之后我想安静点。"));
  // Direct writes commit before the final event; an extractor write may land a
  // moment later. Check the durable surfaces, not the ordering of background jobs.
  let remembered: any[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    remembered = await db`select id,content,deleted_at from assistant_memory_items
      where workspace_id=${workspaceId} and user_id=${userId} and deleted_at is null order by created_at desc`;
    if (remembered.some((row: any) => /九点|打扰/.test(String(row.content)))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const memory = remembered.find((row: any) => /九点|打扰/.test(String(row.content))) ?? remembered[0];
  // "晚上九点以后不想被打扰" is also a valid participation preference. Accept
  // either durable surface; what matters is that later recall and forget use
  // the same place the preference was actually stored.
  const participationBefore = await db`select markdown,enabled from companion_participation_preferences
    where user_id=${userId}`;
  const participationHeld = participationBefore.some((row: any) =>
    row.enabled === true && /九点|打扰/.test(String(row.markdown)));
  recordCheck("memory-remember", (Boolean(memory) && /九点|打扰/.test(String(memory?.content))) || participationHeld,
    participationHeld ? "participation preference" : memory ? String(memory.content) : "no durable preference");
  // Remembering a preference is not a request for a reminder or an attention
  // plan. This negative check is the one the old matrix lacked.
  await new Promise(resolve => setTimeout(resolve, 500));
  const strayReminders = await db`select id,text,status from companion_reminders
    where workspace_id=${workspaceId} and status='pending' order by created_at`;
  const [strayPlans] = await db`select count(*)::int as n from companion_attention_plans
    where workspace_id=${workspaceId}`;
  recordCheck("memory-no-side-effects",
    strayReminders.length === 0 && Number(strayPlans?.n ?? 0) === 0,
    strayReminders.map((row: any) => `${row.status}:${row.text}`).join(" | ")
      || `reminders:0 plans:${strayPlans?.n ?? 0}`);
  // The forget must remove the rows that carried this preference. Rows the
  // extractor writes later may mention it in passing; they are not the target.
  const preferenceRows = remembered.filter((row: any) => /九点|打扰/.test(String(row.content)));
  const forgetTargets: string[] = (preferenceRows.length > 0 ? preferenceRows : [memory]).filter(Boolean)
    .map((row: any) => String(row.id));

  const recall = await attempt("memory-recall", p("我晚上几点以后不想被打扰来着？",
    "我晚上几点以后想安静来着？"));
  recordCheck("memory-recall", /九点/.test(recall.visible), recall.visible.slice(0, 90));

  // ── Reminder round trip (ambiguous time stays out of the past) ──
  const reminderDone = async () => {
    let rows: any[] = [];
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt += 1) {
      rows = await db`select id,text,status,fire_at from companion_reminders
        where workspace_id=${workspaceId} and user_id=${userId} order by created_at`;
      if (rows.length === 0) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return rows;
  };
  await attempt("reminder-create-first", p("明天上午九点提醒我复习线性代数。",
    "明早九点叫我起来复习线代。"));
  let reminderRows = await reminderDone();
  let reminderFirstTry = reminderRows.length === 1 && /线性代数|线代/.test(String(reminderRows[0]?.text)) && reminderRows[0]?.status === "pending";
  if (!reminderFirstTry) {
    await attempt("reminder-create-repair", "我第一次没看到提醒真的排上，麻烦按我刚才说的设好。");
    reminderRows = await reminderDone();
  }
  const reminderRow = reminderRows[0];
  recordCheck("reminder-create",
    reminderRows.length === 1 && /线性代数|线代/.test(String(reminderRow?.text)) && reminderRow?.status === "pending",
    reminderRows.map((row: any) => `${row.status}:${row.text}`).join(" | ") || "no reminder row", reminderFirstTry);

  const reminderList = await attempt("reminder-list", "我这两天有什么提醒吗？");
  // The host injects the pending reminder into this turn's facts, so a correct
  // answer without a fresh read is honest; only a wrong one is a failure.
  const reminderListRead = reminderList.evidence.calls.some((c: any) => c.name === "attention.read.reminders" && c.status === "succeeded");
  // With no stored reminder, an honest "我看不到，要我查一下吗" is the correct
  // answer; only inventing one would be a failure.
  const honestEmpty = !reminderRow && /看不到|没有.*提醒|要我(帮你)?查|先查/u.test(reminderList.visible);
  recordCheck("reminder-list",
    (Boolean(reminderRow) && /线性代数|线代/.test(reminderList.visible) && !/九点后|不打扰/u.test(reminderList.visible)) || honestEmpty,
    `${reminderListRead ? "read" : "host-fact"}: ${reminderList.visible.slice(0, 80)}`);

  // ── Her own records ──
  const selfNoteState = async () => {
    const row = (await db`select entry_key,title,body from companion_self_notes
      where workspace_id=${workspaceId} and user_id=${userId} and updated_at > now() - interval '3 minutes'
      order by updated_at desc limit 1`)[0];
    const [count] = await db`select count(*)::int as n from companion_self_notes
      where workspace_id=${workspaceId} and user_id=${userId}`;
    return { row, count: Number(count?.n ?? 0) };
  };
  await attempt("persona-self-note-first", "你自己记一下：我最近在准备线性代数补考，这阵子先别催我刷题。", { confirm: true });
  let selfState = await selfNoteState();
  let selfFirstTry = Boolean(selfState.row) || selfState.count > 0;
  if (!selfFirstTry) {
    await attempt("persona-self-note-repair", "第一次好像没记进你自己的记事，麻烦再记一次：我最近在准备线性代数补考，这阵子先别催我刷题。", { confirm: true });
    selfState = await selfNoteState();
  }
  const wroteSelfNote = selfState.count > 0;
  recordCheck("persona-self-note", wroteSelfNote,
    selfState.row ? String(selfState.row.entry_key) : wroteSelfNote ? "row" : "no self note row", selfFirstTry);

  // ── Observation and calculation ──
  const stats = await attempt("observe-stats", "我最近学习情况怎么样？");
  recordCheck("observe-stats", stats.terminal === "assistant.final" && stats.visible.trim().length > 0,
    stats.visible.slice(0, 90));

  const calculation = await attempt("observe-calculate", p("帮我核一下 347 乘以 29 到底是多少。",
    "347 和 29 乘一下，得多少？"));
  // The agent may calculate itself or use the tool; the outcome must be correct.
  // A wrong result is corrected by the runtime's expression check, not by forcing a tool here.
  recordCheck("observe-calculate", /10063/.test(calculation.visible), calculation.visible.slice(0, 90));

  // ── Visual: diagram from a normal description ──
  const diagram = await attempt("visual-diagram", p("把我的复习过程画成流程图：先翻错题，再做两道新题，最后写一段总结。",
    "把我复习线代的步骤画成一张图：先过一遍错题，再做两道新题，最后写点总结。"));
  const diagramCalled = diagram.evidence.calls.some((c: any) => c.name === "visual.diagram" && c.status === "succeeded");
  recordCheck("visual-diagram", diagram.terminal !== "error" && diagramCalled,
    diagramCalled ? "tool" : diagram.visible.slice(0, 70));

  // ── Navigation ──
  const navigation = await attempt("open-notes", p("帮我打开笔记库看看。",
    "带我去笔记库那边。"));
  const navigated = navigation.evidence.calls.some((c: any) => c.name === "open.page" && c.status === "succeeded");
  recordCheck("open-notes", navigation.terminal !== "error" && navigated,
    navigated ? "tool" : navigation.visible.slice(0, 70));

  // ── Multiple messages ──
  // The reply is delivered as separate chat messages by the host, not by a
  // speech tool, so the check reads the stored shape: one run, several
  // assistant messages, each with its own body.
  const speech = await attempt("say-multiple", p("分两条跟我说：先说声早，再问我想先做哪件事。",
    "别用一整段，拆成两条发我：一条打招呼，一条问我今天先做哪件事。"));
  const speechRunId = "runId" in speech ? speech.runId : null;
  const speechMessages = await db`select id, seq, blocks from companion_messages
    where run_id=${speechRunId} and role='assistant' order by seq`;
  const speechBodies = speechMessages.map((row: any) => (row.blocks as Array<{ type?: string; text?: string }>)
    .filter(block => block.type === "text").map(block => block.text ?? "").join("").trim()).filter(Boolean);
  recordCheck("say-multiple", speechBodies.length >= 2,
    `messages:${speechBodies.length} ${JSON.stringify(speechBodies).slice(0, 80)}`);

  // ── Confirmation gate on a destructive memory write ──
  await attempt("memory-forget", p("把我刚才说的九点以后不想被打扰那条忘掉。",
    "刚才那个晚上九点后想安静的偏好，删了吧。"), { confirm: true });
  const afterForget = forgetTargets.length === 0 ? [] : await db`select id,content,deleted_at from assistant_memory_items
    where workspace_id=${workspaceId} and user_id=${userId} and id in ${db(forgetTargets)}`;
  const rowsById = new Map(afterForget.map((row: any) => [String(row.id), row]));
  const targets = forgetTargets.map(id => rowsById.get(id));
  const participationAfter = participationHeld
    ? await db`select markdown,enabled from companion_participation_preferences where user_id=${userId}`
    : [];
  const participationCleared = participationHeld && participationAfter.every((row: any) =>
    row.enabled === false || !/九点|打扰/.test(String(row.markdown)));
  recordCheck("memory-forget", (forgetTargets.length > 0
      && targets.every((row: any) => row?.deleted_at !== null && row?.deleted_at !== undefined))
      || participationCleared,
    participationCleared ? "participation preference cleared"
      : targets.map((row: any) => `${row?.deleted_at ? "deleted" : "alive"}:${String(row?.content ?? "missing").slice(0, 24)}`)
        .join(" | ") || "no captured row");

  // ── Background generation: each is a real queued job run by the worker ──
  const version = (await db`select current_version_id from notes where id=${created?.id ?? null}`)[0];

  const overview = await api(`/v2/notes/${created.id}/overview-tasks`, {
    noteVersionId: version.current_version_id, requestId: randomUUID() }).catch((error: unknown) => ({ error: String(error) }));
  if ("error" in overview) recordCheck("background-overview", false, String(overview.error));
  else {
    const job = await waitForJob(async () => {
      const [row] = await db<{ status: string; last_error: string | null }[]>`select status,last_error from jobs
        where workspace_id=${workspaceId} and type='note_overview_generate' order by scheduled_at desc limit 1`;
      return row;
    }, 300_000, "overview job");
    const [saved] = await db`select id,body from note_overviews where workspace_id=${workspaceId}
      and note_id=${created.id} order by created_at desc limit 1`;
    recordCheck("background-overview", Boolean(saved) && String(saved.body).trim().length > 10,
      `${job.status} / ${saved ? String(saved.body).slice(0, 60) : "no row"}`);
  }

  const mindMap = await api(`/v2/notes/${created.id}/mind-map-tasks`, {
    noteVersionId: version.current_version_id, requestId: randomUUID() }).catch((error: unknown) => ({ error: String(error) }));
  if ("error" in mindMap) recordCheck("background-mind-map", false, String(mindMap.error));
  else {
    const job = await waitForJob(async () => {
      const [row] = await db<{ status: string; last_error: string | null }[]>`select status,last_error from jobs
        where workspace_id=${workspaceId} and type='note_mind_map_generate' order by scheduled_at desc limit 1`;
      return row;
    }, 300_000, "mind map job");
    const [saved] = await db`select id,title,content from note_mind_maps where workspace_id=${workspaceId}
      and note_id=${created.id} order by created_at desc limit 1`;
    recordCheck("background-mind-map", Boolean(saved), `${job.status} / ${saved ? String(saved.title) : "no row"}`);
  }

  const expansion = await api(`/v2/notes/${created.id}/expansion-tasks`, {
    noteVersionId: version.current_version_id, requestId: randomUUID() }).catch((error: unknown) => ({ error: String(error) }));
  if ("error" in expansion) recordCheck("background-expansion", false, String(expansion.error));
  else {
    const job = await waitForJob(async () => {
      const [row] = await db<{ status: string; last_error: string | null }[]>`select status,last_error from jobs
        where workspace_id=${workspaceId} and type='note_expansion_generate' order by scheduled_at desc limit 1`;
      return row;
    }, 300_000, "expansion job");
    const [saved] = await db`select id,jsonb_array_length(drafts) as n from note_expansion_tasks
      where workspace_id=${workspaceId} and note_id=${created.id} order by created_at desc limit 1`;
    recordCheck("background-expansion", Boolean(saved) && Number(saved.n) > 0,
      `${job.status} / drafts ${saved ? saved.n : "no row"}`);
  }

  // ── Goal handoff: an ordinary request for a durable artifact ──
  const [goalsBefore] = await db`select count(*)::int as n from agent_runs where workspace_id=${workspaceId}`;
  const [overviewsBefore] = await db`select count(*)::int as n from note_overviews
    where workspace_id=${workspaceId} and note_id=${created.id}`;
  // Starting a goal is durable at creation; the agent may keep working on it
  // afterwards, so a missing terminal frame is not a failure of this check.
  const goal = await attempt("goals-start-first", p("帮我给《十月二十六复盘》做一份速看并保存下来，以后我可能会回来看。",
    "把《十月二十六复盘》整理成以后能翻回来的速看，存着。"));
  const goalTerminalOk = goal.terminal !== "error" || goal.terminal === "timeout";
  const durableState = async () => {
    const [g] = await db`select count(*)::int as n from agent_runs where workspace_id=${workspaceId}`;
    const [o] = await db`select count(*)::int as n from note_overviews
      where workspace_id=${workspaceId} and note_id=${created.id}`;
    return { goals: Number(g?.n ?? 0), overviews: Number(o?.n ?? 0) };
  };
  let goalState = await durableState();
  let goalFirstTry = goalTerminalOk
    && (goalState.goals > Number(goalsBefore?.n ?? 0) || goalState.overviews > Number(overviewsBefore?.n ?? 0));
  if (!goalFirstTry) {
    await attempt("goals-start-repair", "刚才只是说了一下，没有真的存；请把它做成以后能回看的产物并保存。");
    goalState = await durableState();
  }
  const durable = goalState.goals > Number(goalsBefore?.n ?? 0) || goalState.overviews > Number(overviewsBefore?.n ?? 0);
  recordCheck("goals-start", durable,
    durable ? `goals:${goalsBefore?.n}->${goalState.goals} overviews:${overviewsBefore?.n}->${goalState.overviews}`
      : `no durable artifact (${goal.terminal})`, goalFirstTry);

  const passed = Object.values(checks).filter(check => check.ok).length;
  const firstTryPassed = Object.values(checks).filter(check => check.firstTry).length;
  console.log(JSON.stringify({ result: passed === Object.keys(checks).length ? "pass" : "partial",
    passed, firstTryPassed, total: Object.keys(checks).length, checks,
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
