import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";
import postgres from "postgres";
import { resolveAllCompanionAgentTools, type AgentTurnRequest, type AgentTurnResult, type ChatMessage } from "@astella/shared";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import type { CompanionAgentLoopArgs } from "../contracts/companion-agent-loop.ts";
import { runCompanionAgentLoop } from "../handlers/agent/companion-agent-runtime.ts";
import { currentCompanionSuccessfulReceipts } from "../handlers/tools/companion-tool-receipts.ts";
import { sha256Utf8V1, stableStringify } from "@astella/shared/content-hash";
import { MockProvider } from "../lib/providers/mock.ts";
import { closeDatabase } from "../db.ts";
import { withWorkspaceTransaction, closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { createNote } from "../../../../apps/api/src/modules/note/service.ts";
import { closeNoteCollaboration } from "../../../../apps/api/src/modules/note/collaboration.ts";
const url = testDatabaseUrl("DATABASE_URL_MIGRATOR");
if (!new URL(url).pathname.startsWith("/astella_note_authoring_permission_")) throw new Error("Use an isolated completion database");
const admin = postgres(url, { max: 2 });
after(async () => { await closeNoteCollaboration(); await closeApiDatabase(); await closeDatabase(); await admin.end(); });

async function fixture(text: string) {
  const permission = "full";
  const workspaceId = randomUUID(), userId = randomUUID(), runId = randomUUID(), conversationId = randomUUID();
  const messageId = randomUUID(), jobId = randomUUID();
  const scope = { workspaceId, userId };
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return fn(tx);
  });
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`speed-${userId}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'交付合同隔离回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled,agent_settings)
      VALUES(${userId},0,true,${tx.json({ version: 1, permissionLevel: permission })})`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq,next_event_seq)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','交付合同','auto','active',2,1)`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text',
        ${tx.json([{ type: 'text', text: text }])},${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({ runId })},'running','review-lease',now())`;
    const snapshot = { version: 1, level: permission, offeredTools: resolveAllCompanionAgentTools(permission)
      .map(({ name, toolVersion, riskClass }) => ({ name, toolVersion, riskClass })) };
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id,permission_level,permission_snapshot)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,
        ${jobId},${permission},${tx.json(snapshot)})`;
  });
  const controller = new AbortController();
  const args = {
    ctx: { id: jobId, workspaceId, requestedBy: userId, leaseToken: "review-lease", payload: { runId }, signal: controller.signal },
    read: { userId, runId, conversationId, userMessageId: messageId, generation: 1, accountEpoch: 0,
      userText: text, pageContext: null, recentMessages: [], runStatus: "running", livePageView: null,
      residentMemories: [], memoryDirectory: [], playbookCatalog: [], playbookCandidates: [], deliveryObservation: null,
      organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null, factSpans: null,
      conversationSummary: null, personaProfileRevision: 1, personaExamplesRevision: 1,
      defaultExpressionVersion: "fixture", petProfile: null, nextMessageSeq: 2, nextEventSeq: 1 },
    baseMessages: [{ role: "user", content: text }], toolConstraints: {},
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as CompanionAgentLoopArgs;
  const state = () => mutate(async tx => ({
    run: (await tx`SELECT tool_call_count FROM companion_turn_runs WHERE id=${runId}`)[0]!,
    calls: await tx`SELECT tool_call_id,name,status FROM companion_agent_tool_calls WHERE run_id=${runId} ORDER BY created_at`,
    steps: await tx`SELECT status,error_code,checkpoint,runtime_checkpoint FROM companion_agent_steps WHERE run_id=${runId} ORDER BY step_no`,
    messages: await tx`SELECT m.blocks FROM companion_run_utterances u JOIN companion_messages m ON m.id=u.message_id WHERE u.run_id=${runId} ORDER BY m.seq`,
  }));
  return { args, scope, mutate, state, controller, runId, jobId };
}
type ScriptedTurn = Omit<AgentTurnResult, "usage" | "providerRequestId">;
const call = (id: string, name: string, arguments_: Record<string, unknown>): ScriptedTurn =>
  ({ content: "", toolCalls: [{ id, name, arguments: arguments_ }], finishReason: "tool_calls" });
/** Only the resource decision may call chatCompletion. A second semantic
 * reviewer in the online path throws instead of silently costing a model call. */
function providers(args: CompanionAgentLoopArgs, execute: (request: AgentTurnRequest) => Promise<ScriptedTurn> | ScriptedTurn,
  resourcePath: "chat" | "answer" | "work" = "chat") {
  let steps = 0, audits = 0;
  const make = (identity: string) => Object.assign(new MockProvider(), { id: identity, modelId: identity,
    executeAgentTurn: async (request: AgentTurnRequest) => {
      if (++steps > 12) throw new Error("fixture exceeded expected native calls");
      return { usage: { totalTokens: 1, promptTokens: 1, completionTokens: 0, requestId: null }, providerRequestId: "test-request", ...await execute(request) };
    },
    chatCompletion: async (messages: ChatMessage[]) => {
      const raw = messages.find(message => message.role === "user")?.content;
      let input: unknown;
      try { input = JSON.parse(String(raw)); } catch { throw new Error("unexpected chatCompletion input"); }
      if (input && typeof input === "object" && "phase" in input) {
        audits++;
        throw new Error("completion reviewer must stay offline");
      }
      return { content: JSON.stringify({ path: resourcePath }) };
    },
  });
  args.provider = make("completion-primary"); args.fallbackProvider = make("completion-independent");
  return { get steps() { return steps; }, get audits() { return audits; } };
}
const receiptIds = (messages: AgentTurnRequest["messages"]) => messages.filter(message => message.role === "tool"
  && JSON.parse(String(message.content)).ok === true).map(message => message.toolCallId!);
const finish = (text: string, messages: AgentTurnRequest["messages"], requirement: string) => call("finish_" + randomUUID(), "companion_finish", {
  text, actions: currentCompanionSuccessfulReceipts(messages).filter(receipt => receipt.riskClass !== "read")
    .map(receipt => ({ receiptId: receipt.id })), outcome: "completed",
  requirements: [{ requirement, fulfilled: true, evidenceCallIds: receiptIds(messages) }],
});

test("a plain reply streams before settlement without a completion reviewer", async () => {
  const f = await fixture("早上好呀。");
  const deltas: string[] = [];
  const p = providers(f.args, () => ({ content: "早上好，今天也在这里陪你。", toolCalls: [], finishReason: "stop" }));
  f.args.onProviderDelta = async delta => { deltas.push(delta); return true; };
  f.args.provider.chatCompletionStreamToolCalls = true;
  f.args.provider.chatCompletionStream = async (_messages, _options, _signal, onDelta) => {
    onDelta("早上好，今天也在这里陪你。");
    return { content: "早上好，今天也在这里陪你。", toolCalls: [], finishReason: "stop" };
  };
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.text, "早上好，今天也在这里陪你。");
  assert.equal(deltas.join(""), "早上好，今天也在这里陪你。", "text reaches the client while the turn settles");
  assert.equal(p.audits, 0); assert.equal(p.steps, 0, "the stream path did not need a second native call");
});

test("a private note is read before delivery and no reviewer runs", async () => {
  const f = await fixture("读取私人笔记，告诉我暗号。");
  const secret = "actual-" + randomUUID();
  const note = await withWorkspaceTransaction(f.scope, tx => createNote(tx, f.scope.workspaceId, f.scope.userId,
    { title: "私人笔记", blocks: [{ type: "paragraph", content: secret }] }));
  let step = 0;
  const p = providers(f.args, request => {
    step++;
    if (step === 1) return call("load_notes", "companion_load_tools", { groups: ["notes"] });
    if (step === 2) return call("real_read", "companion_notes_read", { action: "read", noteId: note!.note.id });
    return finish("暗号是 " + secret + "。", request.messages, f.args.read.userText);
  });
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status !== "completed") return;
  assert.match(result.text, new RegExp(secret)); assert.doesNotMatch(result.text, /INVENTED/);
  const state = await f.state();
  assert.equal(state.calls.filter(row => row.name === "notes.read.read" && row.status === "succeeded").length, 1);
  assert.equal(p.audits, 0);
});

test("a finish that claims a read without a receipt is rejected, then the agent reads", async () => {
  const f = await fixture("读取私人笔记，告诉我暗号。");
  const secret = "actual-" + randomUUID();
  const note = await withWorkspaceTransaction(f.scope, tx => createNote(tx, f.scope.workspaceId, f.scope.userId,
    { title: "私人笔记", blocks: [{ type: "paragraph", content: secret }] }));
  let step = 0;
  const p = providers(f.args, request => {
    step++;
    if (step === 1) return call("false_finish", "companion_finish", { text: "暗号是 INVENTED。", actions: [], evidence: [],
      outcome: "completed", requirements: [{ requirement: f.args.read.userText, fulfilled: true, evidenceCallIds: [] }] });
    if (step === 2) return call("load_notes", "companion_load_tools", { groups: ["notes"] });
    if (step === 3) return call("real_read", "companion_notes_read", { action: "read", noteId: note!.note.id });
    return finish("暗号是 " + secret + "。", request.messages, f.args.read.userText);
  });
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status !== "completed") return;
  assert.match(result.text, new RegExp(secret)); assert.doesNotMatch(result.text, /INVENTED/);
  const state = await f.state();
  assert.equal(p.steps, 4, "the rejected finish was followed by a load, a real read and a second finish");
  assert.equal(state.calls.filter(row => row.name === "notes.read.read" && row.status === "succeeded").length, 1);
  assert.equal(p.audits, 0);
});

test("a real memory write is cited once and no reviewer runs", async () => {
  const f = await fixture("记住我喜欢热茶。");
  let step = 0;
  const p = providers(f.args, request => {
    step++;
    if (step === 1) return call("load_memory", "companion_load_tools", { groups: ["memory"] });
    if (step === 2) return call("save_tea", "companion_memory_save", { kind: "preference", content: "用户喜欢热茶", sourceQuote: "我喜欢热茶" });
    return finish("已记住你喜欢热茶。", request.messages, f.args.read.userText);
  });
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status !== "completed") return;
  assert.equal(result.writesLanded, true);
  const state = await f.state();
  assert.equal(state.calls.filter(row => row.name === "memory.write.save" && row.status === "succeeded").length, 1);
  const [saved] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM assistant_memory_items WHERE workspace_id=${f.scope.workspaceId} AND content='用户喜欢热茶'`);
  assert.equal(saved.n, 1); assert.equal(p.audits, 0);
});

async function initiativeFixture() {
  const f = await fixture("");
  f.args.read.userMessageId = null;
  f.args.baseMessages = [{ role: "system", content: "你是学习伴星，根据宿主当前参与条件自然交流，来源不明的私人资料不能编造。" }];
  f.args.read.initiativeInput = { version: 1, kind: "initiative", preparationJobId: randomUUID(), observationId: null,
    attentionKey: null, attentionRevision: null, preferenceRevision: 0, parentRunId: null, deviceSessionId: randomUUID(),
    topic: "app.foreground", intent: "自然打个招呼，不编造用户的私有资料。", facts: { canSpeak: true } };
  await f.mutate(tx => tx`UPDATE companion_turn_runs SET user_message_id=NULL,input_source=${tx.json({ ...f.args.read.initiativeInput!, facts: { canSpeak: true } })} WHERE id=${f.runId}`);
  await f.mutate(tx => tx`INSERT INTO companion_awareness_sessions(workspace_id,user_id,device_session_id,app_launch_id,host,context)
    VALUES(${f.scope.workspaceId},${f.scope.userId},${f.args.read.initiativeInput!.deviceSessionId},${randomUUID()},'desktop',
      ${tx.json({ foreground: true, unlocked: true, participationAllowed: true })})`);
  return f;
}

test("initiative speech is delivered without a semantic reviewer", async () => {
  const f = await initiativeFixture();
  const p = providers(f.args, () => ({ content: "嗨，又见面了。", toolCalls: [], finishReason: "stop" }));
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status === "completed") assert.equal(result.text, "嗨，又见面了。");
  assert.equal(p.audits, 0);
});

test("a silent initiative with no output settles without a reviewer", async () => {
  const f = await initiativeFixture();
  const p = providers(f.args, () => call("quiet", "companion_finish", { silent: true }));
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status === "completed") assert.equal(result.text, "");
  assert.equal(p.audits, 0);
});

test("a settled host checkpoint is returned without a second review", async () => {
  const f = await fixture("读取私人笔记告诉我口令。");
  const p = providers(f.args, () => ({ content: "尚未取得笔记正文。", toolCalls: [], finishReason: "stop" }));
  await runCompanionAgentLoop(f.args);
  const state = await f.state();
  const envelope = state.steps.at(-1)!.runtime_checkpoint;
  const snapshot = JSON.parse(envelope.stateJson);
  assert.equal(snapshot.phase, "settled");
  snapshot.result.text = "旧版缓存正文。";
  snapshot.state.visibleSegments = [snapshot.result.text];
  snapshot.state.visibleSegmentDelivered = [false];
  const stateJson = stableStringify(snapshot);
  await f.mutate(tx => tx`UPDATE companion_agent_steps SET runtime_checkpoint=${tx.json({ ...envelope, stateJson, stateSha256: sha256Utf8V1(stateJson) })}
    WHERE id=(SELECT id FROM companion_agent_steps WHERE run_id=${f.runId} ORDER BY step_no DESC LIMIT 1)`);
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status === "completed") assert.equal(result.text, "旧版缓存正文。");
  assert.equal(p.audits, 0);
});

test("an image-only message answers without a reviewer", async () => {
  const f = await fixture("");
  f.args.turnImagesSentDirectly = true;
  const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=";
  f.args.baseMessages = [{ role: "system", content: "按当前实际提供的图片自然回复。" },
    { role: "user", content: [{ type: "image_url", image_url: { url } }] }];
  const p = providers(f.args, request => {
    assert.ok(request.messages.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type === "image_url" && part.image_url.url === url)));
    return { content: "收到这张图片了。", toolCalls: [], finishReason: "stop" };
  });
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); if (result.status === "completed") assert.equal(result.text, "收到这张图片了。");
  assert.equal(p.audits, 0);
});

test("fast opening resolves current and historical stored images and honors image policy", async t => {
  const f = await fixture("");
  const assetId = randomUUID(), objectKey = `${f.scope.workspaceId}/companion/${assetId}.png`;
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=", "base64");
  let objectReads = 0;
  const objectPaths = new Set([`/review-images/${objectKey}`]);
  // A local S3 response fixture exercises the actual SDK/byte loader. The DB
  // lookup still runs under the real Worker RLS role; no inline pixels are
  // preloaded into the agent transcript.
  const storage = createServer((request, response) => {
    if (request.method !== "GET" || !objectPaths.has(request.url?.split("?")[0] ?? "")) {
      response.writeHead(404, { Connection: "close" }); response.end(); return;
    }
    objectReads++;
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": bytes.length, Connection: "close" });
    response.end(bytes);
  });
  await new Promise<void>(resolve => storage.listen(0, "127.0.0.1", resolve));
  const port = (storage.address() as { port: number }).port;
  const settings = { STORAGE_MODE: "local", STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
    S3_BUCKET: "review-images", MINIO_ACCESS_KEY: "isolated-test", MINIO_SECRET_KEY: "isolated-test-only" };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(async () => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    storage.closeAllConnections();
    await new Promise<void>((resolve, reject) => storage.close(error => error ? reject(error) : resolve()));
  });
  await f.mutate(tx => tx`INSERT INTO note_image_assets(id,workspace_id,object_key,sha256,mime_type,byte_size,width,height,created_by)
    VALUES(${assetId},${f.scope.workspaceId},${objectKey},${createHash("sha256").update(bytes).digest("hex")},'image/png',${bytes.length},1,1,${f.scope.userId})`);
  f.args.turnImagesSentDirectly = true;
  f.args.read.userImageAttachments = [{ assetId, label: "fixture.png" }];
  f.args.baseMessages = [{ role: "system", content: "按用户实际提供的材料回复。" }, { role: "user", content: "" }];
  const p = providers(f.args, request => {
    assert.ok(request.messages.some(message => Array.isArray(message.content) && message.content.some(part =>
      part.type === "image_url" && part.image_url.url === `data:image/png;base64,${bytes.toString("base64")}`)),
    "the first native request must contain bytes loaded from the stored attachment");
    return { content: "收到原图。", toolCalls: [], finishReason: "stop" };
  });
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed"); assert.equal(p.steps, 1); assert.equal(p.audits, 0);
  assert.equal(objectReads, 1);
  const history = await fixture("再看上一轮的原图。");
  const historyAssetId = randomUUID(), historyKey = `${history.scope.workspaceId}/companion/${historyAssetId}.png`;
  objectPaths.add(`/review-images/${historyKey}`);
  await history.mutate(tx => tx`INSERT INTO note_image_assets(id,workspace_id,object_key,sha256,mime_type,byte_size,width,height,created_by)
    VALUES(${historyAssetId},${history.scope.workspaceId},${historyKey},${createHash("sha256").update(bytes).digest("hex")},'image/png',${bytes.length},1,1,${history.scope.userId})`);
  history.args.turnImagesSentDirectly = true;
  history.args.baseMessages = [{ role: "system", content: "按用户实际提供的材料回复。" },
    { role: "user", content: [{ type: "image_url", image_url: { url: `astella-image-asset:${historyAssetId}` } }] },
    { role: "assistant", content: "收到图片。" }, { role: "user", content: history.args.read.userText }];
  const historyProvider = providers(history.args, request => {
    assert.ok(request.messages.some(message => message.role === "user" && Array.isArray(message.content)
      && message.content.some(part => part.type === "image_url"
        && part.image_url.url === `data:image/png;base64,${bytes.toString("base64")}`)),
    "a text-only follow-up must still receive the historical original, not the old description");
    return { content: "已重新查看原图。", toolCalls: [], finishReason: "stop" };
  });
  await runCompanionAgentLoop(history.args);
  assert.equal(historyProvider.steps, 1); assert.equal(historyProvider.audits, 0);
  assert.equal(objectReads, 2);
  const denied = await fixture("");
  denied.args.turnImagesSentDirectly = false;
  denied.args.baseMessages = [{ role: "system", content: "按用户实际提供的材料回复。" }, { role: "user", content: "" }];
  denied.args.read.userImageAttachments = [{ assetId, label: "fixture.png" }];
  providers(denied.args, request => {
    assert.ok(!request.messages.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type === "image_url")));
    return { content: "当前没有图片内容可读取。", toolCalls: [], finishReason: "stop" };
  });
  await runCompanionAgentLoop(denied.args);
  assert.equal(objectReads, 2, "disabled image delivery must not fetch or send bytes");
});

test("three independent messages publish without a reviewer", async () => {
  const f = await fixture("分三条独立消息，依次发春、夏、秋。");
  let step = 0;
  const p = providers(f.args, request => {
    step++;
    if (step === 1) return { content: "", toolCalls: [
      { id: "spring", name: "companion_send_message", arguments: { text: "春" } },
      { id: "summer", name: "companion_send_message", arguments: { text: "夏" } },
      { id: "autumn", name: "companion_send_message", arguments: { text: "秋" } }], finishReason: "tool_calls" };
    return finish("春 夏 秋", request.messages, f.args.read.userText);
  });
  const result = await runCompanionAgentLoop(f.args);
  assert.equal(result.status, "completed");
  const state = await f.state();
  assert.deepEqual(state.messages.map(row => row.blocks[0].text), ["春", "夏", "秋"]);
  assert.equal(state.calls.filter(row => row.name === "say.publish" && row.status === "succeeded").length, 3);
  assert.equal(p.audits, 0);
});
