import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { companionVisibleCharacterCount } from "../handlers/turn/companion-request-requirements.ts";

// Real local HTTP -> queue -> worker -> saved version -> SSE acceptance. The
// random personal account is synthetic. No existing account or credential is
// read, and provider reasoning is deliberately excluded from the evidence.
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
const output = new URL(`outputs/companion-agent-58/http-acceptance-${Date.now()}.json`, root);
const records: Record<string, unknown>[] = [];
const activeRuns: { runId: string; generation: number }[] = [];
let conversationId = "", cursor = 0, stream: AbortController | undefined;
let ending = false, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let eventSerial = Promise.resolve();
const events: any[] = [], previews: any[] = [];
const mutate = <T>(work: (tx: postgres.TransactionSql) => Promise<T>) => db.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
  return work(tx);
});
const persist = () => writeFileSync(output, JSON.stringify({ version: 1, startedAt, workspaceId, userId, conversationId,
  origin: base, environment: process.env.PLAN58_PROBE_ENVIRONMENT ?? "unspecified local development load",
  syntheticAccount: true, records, previews, events, accountDisabledOnExit: disabled }, null, 2));
const startedAt = new Date().toISOString();
let disabled = false;
async function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result)}`);
  return result as any;
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
          // Keep the progress signal, without retaining private reasoning text.
          events.push(event.type === "assistant.thinking" ? { ...event, receivedAt, payload: { index: event.payload.index, length: event.payload.text.length } } : { ...event, receivedAt });
          const note = event.payload?.tool?.noteCreated;
          if (event.type === "agent.tool" && event.payload.tool.status === "succeeded" && note) {
            eventSerial = eventSerial.then(async () => {
              const detail = await api(`/v2/notes/${note.noteId}?noteVersionId=${note.noteVersionId}`);
              assert.equal(detail.requestedVersion.versionId, note.noteVersionId);
              const body = detail.requestedVersion.blocks.map((row: any) => row.content).join("\n\n");
              previews.push({ runId: event.runId, noteId: note.noteId, noteVersionId: note.noteVersionId,
                title: detail.title, body, characters: companionVisibleCharacterCount(body), receivedAt, readableAt: Date.now() });
            }).catch(error => { records.push({ kind: "preview-error", error: String(error) }); });
          }
        }
      }
    } catch (error) { if (!controller.signal.aborted) records.push({ kind: "stream-error", error: String(error), cursor }); }
    finally { if (!controller.signal.aborted && !ending) reconnect(); }
  })();
}
function reconnect() {
  if (ending) return;
  reconnectTimer = setTimeout(() => {
    records.push({ kind: "stream-reconnect", cursor }); persist();
    void connect().catch(error => { records.push({ kind: "stream-reconnect-error", error: String(error), cursor }); reconnect(); });
  }, Math.min(5000, 250 * 2 ** reconnectAttempt++));
}
async function waitFor<T>(read: () => T | undefined, limitMs = 240_000): Promise<T> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("acceptance observation timed out; this is not a product task deadline");
}
const selectedCases = new Set((process.env.PLAN58_PROBE_CASES ?? "").split(",").filter(Boolean));
const repeatCount = Number(process.env.PLAN58_PROBE_REPEATS ?? 1);
assert.ok(Number.isInteger(repeatCount) && repeatCount >= 1 && repeatCount <= 20, "repeat count must be 1–20");
let repeatIndex = 0;
const minimumTurnIntervalMs = Number(process.env.PLAN58_PROBE_MIN_INTERVAL_MS ?? 5500);
assert.ok(Number.isFinite(minimumTurnIntervalMs) && minimumTurnIntervalMs >= 0);
let lastTurnStartedAt = 0;
async function turn(name: string, text: string, options: { reconnect?: boolean; cancel?: boolean } = {}) {
  if (selectedCases.size && !selectedCases.has(name)) return;
  // Leave realistic input time between turns, respecting the unchanged product
  // admission limit. This pause is not counted as model or delivery latency.
  const inputPause = Math.max(0, lastTurnStartedAt + minimumTurnIntervalMs - Date.now());
  if (inputPause) await new Promise(resolve => setTimeout(resolve, inputPause));
  lastTurnStartedAt = Date.now();
  const start = Date.now(), offset = events.length;
  let accepted: any;
  try {
    accepted = await api(`/companion/conversations/${conversationId}/turns`, { version: 1,
      clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text }] }, { "Idempotency-Key": randomUUID() });
  } catch (error) {
    records.push({ name, sample: repeatIndex + 1, text, terminal: "not_accepted", elapsedMs: Date.now() - start, error: String(error) });
    persist(); throw error;
  }
  activeRuns.push(accepted);
  const record: any = { name, sample: repeatIndex + 1, text, ...accepted, acceptedMs: Date.now() - start }; records.push(record); persist();
  try {
    if (options.reconnect) {
      await waitFor(() => events.slice(offset).find(event => event.runId === accepted.runId && event.payload?.tool?.noteCreated));
      const after = cursor; await connect(); record.reconnectedAfter = after;
    }
    if (options.cancel) {
      await waitFor(() => events.slice(offset).find(event => event.runId === accepted.runId && ["assistant.thinking", "assistant.delta", "agent.tool"].includes(event.type)));
      record.cancel = await api(`/companion/runs/${accepted.runId}/cancel`, { version: 1, generation: accepted.generation, reason: "user" });
    }
    const terminal = await waitFor(() => events.slice(offset).find(event => event.runId === accepted.runId && ["assistant.final", "turn.completed", "turn.cancelled", "error"].includes(event.type)));
    await eventSerial;
    const selected = events.slice(offset).filter(event => event.runId === accepted.runId);
    const utterances = selected.filter(event => event.type === "assistant.utterance");
    const visible = selected.filter(event => event.type === "assistant.delta" || event.type === "assistant.utterance")
      .map(event => event.type === "assistant.utterance" ? event.payload.text : event.payload.textDelta).join("");
    const saved = previews.filter(note => note.runId === accepted.runId);
    Object.assign(record, { terminal: terminal.type, elapsedMs: terminal.receivedAt - start,
      firstStatusMs: selected.find(event => event.type === "assistant.status")?.receivedAt - start || null,
      firstTextMs: selected.find(event => ["assistant.delta", "assistant.utterance"].includes(event.type))?.receivedAt - start || null,
      firstSaveMs: saved.length ? saved[0].receivedAt - start : null, savedCount: saved.length,
      savedCharacters: saved.map(note => note.characters),
      succeededTools: selected.filter(event => event.type === "agent.tool" && event.payload?.tool?.status === "succeeded").map(event => event.payload.tool.name),
      utterances: utterances.map(event => ({ messageId: event.payload.messageId, text: event.payload.text })),
      visible, characters: companionVisibleCharacterCount(visible), error: terminal.type === "error" ? terminal.payload : null });
    if (name === "utterances") {
      assert.equal(utterances.length, 2, "the two requested messages must actually be delivered separately");
      assert.equal(selected.some(event => event.type === "assistant.final"), false, "no duplicate ordinary final after the two utterances");
    }
    console.log(JSON.stringify({ name, terminal: record.terminal, elapsedMs: record.elapsedMs, firstTextMs: record.firstTextMs, firstSaveMs: record.firstSaveMs, savedCount: saved.length }));
  } catch (error) {
    record.error = String(error); console.log(JSON.stringify({ name, error: record.error }));
    // This probe stops observing a synthetic run; it does not impose a product deadline.
    await api(`/companion/runs/${accepted.runId}/cancel`, { version: 1, generation: accepted.generation, reason: "user" }).catch(() => undefined);
  }
  persist();
}
try {
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`plan58-http-${userId}@test.invalid`},'synthetic-no-login','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${workspaceId},'Plan 58 HTTP acceptance',${userId},'personal')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`UPDATE users SET personal_workspace_id=${workspaceId} WHERE id=${userId}`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${userId},'ai-consent-v1',now(),${tx.json({sendToExternal:true,sendImageContent:false,piiDetection:false,auditLogging:true})})`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${userId}`;
    await tx`INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${tokenHash},${userId},${workspaceId},'desktop',now()+interval '2 hours')`;
  });
  conversationId = (await api("/companion/inbox/ensure", {})).id;
  await connect();
  const casualCases = ["晚上好，今天学得有点累。", "我刚读完一小节，有点想歇歇。", "今天总算把难题做出来了。", "我准备再看十分钟书。", "和我随便聊一句吧。", "刚刚走了一会神，现在回来读书了。", "这段内容挺有意思。", "给我一句简短的鼓励吧。", "晚上好，你在吗？", "我打算先喝口水再继续。"];
  for (repeatIndex = 0; repeatIndex < repeatCount; repeatIndex++) {
  await turn("casual", casualCases[repeatIndex % casualCases.length]!);
  await turn("story", "写一个约400字的完整童话故事，主题是小狐狸找回星星，要有完整结尾。");
  await turn("continuation", "再讲一个新的，约400字，要有不同的角色和完整结尾。");
  await turn("three-notes-short", "生成三篇中国历史笔记，主题分别是秦朝、汉朝、唐朝。要分别保存成笔记。每篇约300字，简短但完整，包含关键事实与结尾。", { reconnect: true });
  await turn("explanation", "解释刚才保存的秦朝笔记中，郡县制和中央集权有什么关系，请依据那篇笔记的正文。");
  await turn("tool-check", "请实际使用计算工具核对347×29，再告诉我结果。");
  await turn("cancel", "写一篇一万字的完整海上冒险故事。", { cancel: true });
  await turn("topic-change", "换个话题，晚安，只说一句。");
  await turn("utterances", "分两条跟我说：第一条只跟我打个招呼，第二条问我今天想先做哪件事。这一轮请调用 companion_publish_utterance 两次，最后一条 final=true，不要用普通最终正文。");
  }
} finally {
  ending = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stream?.abort();
  for (const run of activeRuns) await api(`/companion/runs/${run.runId}/cancel`, { version: 1, generation: run.generation, reason: "user" }).catch(() => undefined);
  await mutate(async tx => {
    await tx`UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id=${userId}`;
    await tx`DELETE FROM sessions WHERE user_id=${userId}`;
  });
  disabled = true; persist(); await db.end(); console.log(`Evidence: ${output.pathname}`);
}
