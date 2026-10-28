import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { companionVisibleCharacterCount } from "../handlers/turn/companion-note-length.ts";

/**
 * Replays the two real failure samples from 2026-10-25 against the current
 * production loop: a silent no-tool "saved" claim (02:52:58Z) and an
 * ACTION_NOT_EXECUTED kill (04:44:05Z). Synthetic account and notes; the
 * requests, HTTP submission, queue, worker, model and delivery are real.
 */
const root = new URL("../../../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const databaseUrl = env.DATABASE_URL_MIGRATOR ?? env.DATABASE_URL;
assert.ok(databaseUrl, "local development database configuration is required");
const url = new URL(databaseUrl);
assert.equal(url.pathname, "/astella", "this probe is for the local development database");
assert.ok(["postgres", "localhost", "127.0.0.1"].includes(url.hostname));
url.hostname = "127.0.0.1";
const db = postgres(url.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "http://127.0.0.1:4000";
const outputDir = new URL("outputs/audits/2026-10-25-failure-replay/", root);
mkdirSync(outputDir, { recursive: true });
const output = new URL(`failure-replay-${Date.now()}.json`, outputDir);
const startedAt = new Date().toISOString();
const records: Record<string, unknown>[] = [];
const events: any[] = [];
const activeRuns: { runId: string; generation: number }[] = [];
let conversationId = "", cursor = 0, stream: AbortController | undefined, ending = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined, reconnectAttempt = 0;
let eventSerial = Promise.resolve();
const mutate = <T>(work: (tx: postgres.TransactionSql) => Promise<T>) => db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
  return work(tx);
});
const persist = () => writeFileSync(output, JSON.stringify({ version: 1, startedAt, workspaceId, userId,
  conversationId, origin: base, syntheticAccount: true, records, events }, null, 2));
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
    } catch (error) { if (!controller.signal.aborted) records.push({ kind: "stream-error", error: String(error), cursor }); }
    finally { if (!controller.signal.aborted && !ending) reconnect(); }
  })();
}
function reconnect() {
  if (ending) return;
  reconnectTimer = setTimeout(() => {
    void connect().catch(error => { records.push({ kind: "stream-reconnect-error", error: String(error), cursor }); reconnect(); });
  }, Math.min(5000, 250 * 2 ** reconnectAttempt++));
}
async function waitFor<T>(read: () => T | undefined, limitMs = 240_000): Promise<T> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("replay observation timed out; this is observation, not a product deadline");
}
async function noteBody(noteId: string): Promise<string> {
  const rows = await db`select b.content from note_blocks b
    join notes n on n.current_version_id = b.version_id
    where n.id = ${noteId} order by b.ordinal`;
  return rows.map(row => String(row.content)).join("\n\n");
}
async function runEvidence(runId: string) {
  const run = (await db`select status, error_code, step_count, tool_call_count, model_call_count, route,
    started_at, finished_at from companion_turn_runs where id=${runId}`)[0];
  const calls = await db`select name, tool_version, risk_class, status, result_safe_summary
    from companion_agent_tool_calls where run_id=${runId} order by created_at`;
  return { ...run, calls };
}
async function turn(name: string, text: string) {
  const start = Date.now(), offset = events.length;
  const accepted = await api(`/companion/conversations/${conversationId}/turns`, { version: 1,
    clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text }] },
  { "Idempotency-Key": randomUUID() });
  activeRuns.push(accepted);
  const terminal = await waitFor(() => events.slice(offset).find(event =>
    event.runId === accepted.runId && ["assistant.final", "turn.completed", "turn.cancelled", "error"].includes(event.type)));
  await eventSerial;
  const selected = events.slice(offset).filter(event => event.runId === accepted.runId);
  const visible = selected.filter(event => event.type === "assistant.delta" || event.type === "assistant.utterance")
    .map(event => event.type === "assistant.utterance" ? event.payload.text : event.payload.textDelta).join("");
  const toolEvents = selected.filter(event => event.type === "agent.tool");
  const record = { name, text, runId: accepted.runId, generation: accepted.generation,
    terminal: terminal.type, elapsedMs: terminal.receivedAt - start,
    firstStatusMs: selected.find(event => event.type === "assistant.status")?.receivedAt - start || null,
    firstTextMs: selected.find(event => ["assistant.delta", "assistant.utterance"].includes(event.type))?.receivedAt - start || null,
    visible, characters: companionVisibleCharacterCount(visible),
    streamedTools: toolEvents.map(event => ({ name: event.payload?.tool?.name, status: event.payload?.tool?.status })),
    error: terminal.type === "error" ? terminal.payload : null,
    evidence: await runEvidence(accepted.runId) };
  records.push(record); persist();
  console.log(JSON.stringify({ name, terminal: record.terminal, elapsedMs: record.elapsedMs,
    firstTextMs: record.firstTextMs, tools: record.evidence.calls.map((call: any) => `${call.name}:${call.status}`) }));
  return record;
}
let noteA = "", noteB = "";
try {
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`failure-replay-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Failure replay 2026-10-25',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({ sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
  });
  conversationId = (await api("/companion/inbox/ensure", {})).id;
  await connect();
  const noteAResult = await api("/notes", { title: "周一安排", blocks: [
    { type: "heading", content: "# 周一安排" },
    { type: "list", content: "早上八点：学英语\n中午：去健身房\n晚上：整理书桌\n睡前读十页书" },
  ] });
  noteA = noteAResult.note.id;
  const initialA = await noteBody(noteA);
  assert.match(initialA, /中午：去健身房/);

  const sampleA: Record<string, any> = await turn("02:52-false-save-receipt", "周一安排里，中午改成去散步，其他不用动。");
  await new Promise(resolve => setTimeout(resolve, 3000));
  const afterA = await noteBody(noteA);
  sampleA["note"] = { noteId: noteA, before: initialA, after: afterA };
  assert.equal(sampleA.terminal, "assistant.final", "sample A must settle, not error");
  assert.match(afterA, /中午：去散步/, "sample A must actually edit the note");
  assert.match(afterA, /早上八点：学英语/, "sample A must preserve untouched lines");
  assert.doesNotMatch(afterA, /中午：去健身房/, "sample A must not leave the old value");
  assert.match(sampleA.visible, /(改好|已改|已保存|保存回执)/, "sample A must report the completed edit");
  assert.doesNotMatch(sampleA.visible, /ACTION_NOT_EXECUTED|没有执行/, "sample A must not claim execution failed");

  // The real 04:44 turn followed a question about the note just discussed.
  // Recreate that context instead of asking the model to resolve "拉伸" cold.
  const noteBResult = await api("/notes", { title: "周三散步", blocks: [
    { type: "heading", content: "# 周三散步" },
    { type: "list", content: "晚上：散步二十分钟\n回来后：拉伸五分钟" },
  ] });
  noteB = noteBResult.note.id;
  const initialB = await noteBody(noteB);
  assert.match(initialB, /拉伸五分钟/);
  await turn("04:41-context", "刚才那篇手记写了什么？");
  const sampleB: Record<string, any> = await turn("04:44-action-not-executed", "帮我把拉伸改成十分钟。");
  await new Promise(resolve => setTimeout(resolve, 3000));
  const afterB = await noteBody(noteB);
  sampleB["note"] = { noteId: noteB, before: initialB, after: afterB };
  assert.equal(sampleB.terminal, "assistant.final", "sample B must settle, not die with ACTION_NOT_EXECUTED");
  assert.match(afterB, /拉伸十分钟/, "sample B must actually edit the note");
  assert.doesNotMatch(afterB, /拉伸五分钟/, "sample B must not leave the old value");
  assert.match(sampleB.visible, /(改好|已改|已保存|保存回执)/, "sample B must report the completed edit");
  assert.doesNotMatch(sampleB.visible, /ACTION_NOT_EXECUTED|没有执行|没能完成/, "sample B must not settle as an execution failure");

  const callsA = sampleA.evidence.calls as any[], callsB = sampleB.evidence.calls as any[];
  for (const [label, calls, visible] of [["A", callsA, sampleA.visible], ["B", callsB, sampleB.visible]] as const) {
    const write = calls.find(call => ["notes.write.edit", "companion_notes_write"].includes(call.name) && call.status === "succeeded");
    assert.ok(write, `${label} must have a successful write receipt`);
    const finish = calls.find(call => call.name === "companion_finish" && call.status === "succeeded");
    assert.ok(finish || visible.trim().length > 0,
      `${label} must settle with either the finish contract or a receipt-backed host answer`);
    assert.doesNotMatch(visible, /^这次回复中断了。?$/, `${label} must not use the old interruption copy`);
  }
  console.log(JSON.stringify({ result: "pass", sampleA: { elapsedMs: sampleA.elapsedMs, tools: sampleA.evidence.calls },
    sampleB: { elapsedMs: sampleB.elapsedMs, tools: sampleB.evidence.calls } }));
} finally {
  ending = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stream?.abort();
  for (const run of activeRuns) await api(`/companion/runs/${run.runId}/cancel`, { version: 1, generation: run.generation, reason: "user" }).catch(() => undefined);
  await mutate(async tx => {
    await tx`UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id=${userId}`;
    await tx`DELETE FROM sessions WHERE user_id=${userId}`;
  });
  persist(); await db.end(); console.log(`Evidence: ${output.pathname}`);
}
