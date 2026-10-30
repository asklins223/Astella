import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { pngWithText } from "./companion-image-fixture.ts";
import { canonicalJsonV1 } from "@astella/shared/content-hash";

/** HTTP -> queue -> production worker -> durable messages and receipts.
 * Synthetic account only; never changes real users' settings. No model judge,
 * answer repair prompts, automatic resubmission, or plaintext reasoning logs. */
assert.equal(process.env.REAL_MODEL_BATCH, "1", "requires explicit REAL_MODEL_BATCH=1");
const root = new URL("../../../../", import.meta.url);
assert.ok(process.env.RELIABILITY_DATABASE_URL, "set RELIABILITY_DATABASE_URL to an isolated local test database");
const databaseUrl = new URL(process.env.RELIABILITY_DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "local test database only");
assert.match(databaseUrl.pathname, /^\/astella_(?:note_authoring|agent)_/u, "isolated test database name required");
const db = postgres(databaseUrl.toString(), { max: 2 });
const workspaceId = randomUUID(), userId = randomUUID();
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const outputDir = new URL("outputs/agent-reliability-2026-10-28/", root);
mkdirSync(outputDir, { recursive: true });
const label = process.env.RELIABILITY_LABEL ?? "probe";
assert.match(label, /^[a-z0-9-]+$/);
const output = new URL(`${label}-${Date.now()}.json`, outputDir);
const base = process.env.RELIABILITY_API_BASE_URL ?? "http://127.0.0.1:4000";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "local API only");
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
type Case = { newConversation?: boolean; imageIndices?: number[]; expectedImages?: number[]; history?: Array<{role:"user"|"assistant";text?:string;imageIndices?:number[]}>;
  uniqueImageTranscription?: boolean;
  createdExpected?: {title:string;paragraphs:string[]};
  qualityRubric?: string[]; cancelAfterMs?: number; editExpected?: string[]; compound?: boolean; id: string; prompt: string; tools?: string[]; messages?: number; includes?: RegExp;
  noWrites?: boolean; grounded?: "note" | "memory" };
const hiddenAnswer = `松风海盐${randomBytes(4).toString("hex")}`;
const cases: Case[] = [
  { id: "greeting", prompt: "在吗？", noWrites: true },
  { id: "casual-tired", prompt: "今天有点累。", noWrites: true },
  { id: "greeting-english", prompt: "Hey, good morning!", noWrites: true },
  { id: "casual-thanks", prompt: "谢谢你，晚安。", noWrites: true },
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
  { id: "after-task-chat", prompt: "哈哈，谢谢你。", noWrites: true },
  { id: "compound", prompt: "分两条消息发给我：第一条用计算工具算 128 乘以 7，第二条说一句晚安。",
    includes: /896/u, messages: 2, tools: ["observe.calculate", "say.publish"] },
  { id: "fresh-note-read", prompt: "读取《独立验收资料》，告诉我资料暗号是什么。",
    includes: new RegExp(hiddenAnswer, "u"), tools: ["notes.read.read"] },
  { id: "casual-return", prompt: "刚从外面回来，风好大。", noWrites: true },
  { id: "casual-success", prompt: "今天终于把拖了很久的事搞定了。", noWrites: true },
  { id: "casual-rest", prompt: "今天脑子不想转了，我就想靠这儿待会儿。不用问我问题，也别安排学习。", noWrites: true },
  { id: "coffee", prompt: "热咖啡为什么会变凉？解释一下杯内液体的流动、杯子和空气各有什么作用。", includes: /对流|下沉/u },
  { id: "newton-pair", prompt: "人推箱子，箱子用等大的力推人。为什么它们不抵消，箱子还能加速？", },
  { id: "correlation", prompt: "冰淇淋销量越多的日子溺水人数也越多，能证明吃冰淇淋导致溺水吗？", includes: /不能|不代表|不等于|无法/u },
];
cases.push({id:"quote-no-action",prompt:"朋友今天说“干脆都删掉重来”，我只是跟你吐槽，不是让你做操作。",noWrites:true});
cases.push({id:"compound-save",compound:true,prompt:"我偏爱不加糖的茉莉茶，记住这一点。另外新建《出发前检查》，只写“随身带证件”。"});
cases.push(
 {id:"quality-frame",prompt:"光滑水平冰面上，两个人质量都是80千克，开始一起向东以2米每秒滑行。互相推开后甲相对地面向西以1米每秒滑行。乙对地的速度是多少？请推导，并核对质心速度和前后总动能。"},
 {id:"quality-bayes",prompt:"一种病患病率2%，检测试剂敏感度80%，未患病者误报率10%。随机一人测出阳性，他患病的概率是多少？请把假阳性也计入，写出推导。"},
 {id:"edit-one",prompt:"把《修改验收》的第二段改成“午后去码头”，其余三段保持原样。",editExpected:["晨间看海","午后去码头","傍晚写信","夜里关灯"]},
 {id:"edit-pair",prompt:"再把《修改验收》的第二、三段分别改成“午后去图书馆”和“傍晚读两页书”。维持四段，首尾保持原文。",editExpected:["晨间看海","午后去图书馆","傍晚读两页书","夜里关灯"]},
 {id:"offer-first",prompt:"我早餐只喝燕麦奶。先别记录，你可以先问我愿不愿意把它记为偏好。",noWrites:true},
 {id:"accept-followup",prompt:"可以，帮我记住吧。"},
 {id:"after-quality-chat",prompt:"题目先放这儿吧，刚听见窗外下雨了，陪我聊聊。",noWrites:true},
);
if (process.env.RELIABILITY_DATASET) {
  const extra: Case[] = JSON.parse(readFileSync(process.env.RELIABILITY_DATASET, "utf8"));
  assert.ok(Array.isArray(extra));
  for (const c of extra) {
    assert.ok(typeof c.id === "string" && typeof c.prompt === "string" && !cases.some(existing => existing.id === c.id));
    cases.push(c);
  }
}
const selected = process.env.RELIABILITY_CASES?.split(",");
const repeats = Number(process.env.RELIABILITY_REPEATS ?? "1");
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
if (selected) assert.ok(selected.every(id => cases.some(c => c.id === id)), "unknown case");
const persist = () => writeFileSync(output, JSON.stringify({ version: 1, label, startedAt,
  workspaceId, userId, records, note: "Synthetic local HTTP acceptance; structural checks are not a semantic quality certification." }, null, 2));
let conversationId = "";
let fatal = false;
let lastSubmittedAt = 0;
const imageFixtures: Array<{ token: string; block: { type: "image"; assetId: string; url: string; label: string } }> = [];
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
  if (cases.some(c => (!selected || selected.includes(c.id)) && (c.imageIndices?.length || c.history?.some(m => m.imageIndices?.length)))) {
    await mutate(async tx => { await tx`UPDATE user_ai_settings SET data_policy=jsonb_set(data_policy,'{sendImageContent}','true'::jsonb) WHERE user_id=${userId}`; });
    for (let index = 0; index < Math.max(2, process.env.RELIABILITY_IMAGE_TOKENS?.split(',').length ?? 0); index++) {
      const imageToken = process.env.RELIABILITY_IMAGE_TOKENS?.split(',')[index] ?? randomBytes(3).toString("hex").toUpperCase();
      assert.match(imageToken,/^[A-Z0-9]{1,10}$/u,'visible fixture characters only');
      const form = new FormData();
      const pixels = process.env.RELIABILITY_IMAGE_DIR
        ? readFileSync(`${process.env.RELIABILITY_IMAGE_DIR}/${imageToken}.png`) : pngWithText(imageToken);
      form.append("file", new Blob([new Uint8Array(pixels)], { type: "image/png" }), "fixture.png");
      const response = await fetch(`${base}/uploads/companion-images`, { method: "POST", body: form,
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      assert.equal(response.ok, true, `image upload HTTP ${response.status}`);
      const uploaded = await response.json() as { assetId: string; url: string };
      assert.ok(uploaded.assetId && uploaded.url);
      imageFixtures.push({ token: imageToken, block: { type: "image", assetId: uploaded.assetId, url: uploaded.url, label: "测试图片" } });
    }
  }
  await api("/notes", { title: "独立验收资料", blocks: [{ type: "paragraph", content: `资料暗号：${hiddenAnswer}。` }] });
  await api("/notes", { title: "修改验收", blocks: ["晨间看海","中午做饭","傍晚写信","夜里关灯"].map(content=>({type:"paragraph",content})) });
  const [editNote] = await db`SELECT id FROM notes WHERE workspace_id=${workspaceId} AND title='修改验收' AND deleted_at IS NULL`;
  assert.ok(editNote?.id);
  for (let repeat = 0; repeat < repeats; repeat++) for (const c of cases.filter(c => !selected || selected.includes(c.id))) {
    if (c.newConversation) {
      await mutate(async tx => { await tx`UPDATE companion_conversations SET status='archived' WHERE id=${conversationId}`; });
      conversationId = (await api("/companion/inbox/ensure", {})).id;
    }
    if (c.history?.length) await mutate(async tx => {
      const [conversation] = await tx`SELECT next_message_seq FROM companion_conversations WHERE id=${conversationId} FOR UPDATE`;
      let seq = BigInt(conversation!.next_message_seq as string);
      for (const message of c.history!) {
        const blocks = [...(message.text ? [{ type: "text", text: message.text }] : []), ...(message.imageIndices ?? []).map(i => imageFixtures[i]!.block)];
        await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
          VALUES(${randomUUID()},${workspaceId},${userId},${conversationId},${seq.toString()},${message.role},'text',${tx.json(blocks)},${createHash("sha256").update(canonicalJsonV1(blocks)).digest("hex")})`;
        seq++;
      }
      await tx`UPDATE companion_conversations SET next_message_seq=${seq.toString()} WHERE id=${conversationId}`;
    });
    // Respect the real 12-turn/minute API limit. Pacing is outside the measured
    // request latency and never retries or hides a rejected submission.
    const paceMs = Math.max(0, lastSubmittedAt + 5_100 - Date.now());
    if (paceMs > 0) await new Promise(resolve => setTimeout(resolve, paceMs));
    const start = Date.now();
    lastSubmittedAt = start;
    const accepted = await api(`/companion/conversations/${conversationId}/turns`, {
      version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet",
      blocks: [{ type: "text", text: c.prompt }, ...(c.imageIndices ?? []).map(i => imageFixtures[i]!.block)],
    });
    active.push(accepted);
    if (c.cancelAfterMs !== undefined) {
      await new Promise(resolve => setTimeout(resolve, c.cancelAfterMs));
      await api(`/companion/runs/${accepted.runId}/cancel`, { version: 1, generation: accepted.generation, reason: "user" });
    }
    let status = "accepted";
    const deadline = start + 180_000;
    while (Date.now() < deadline) {
      const [run] = await db`SELECT status FROM companion_turn_runs WHERE id=${accepted.runId}`;
      status = String(run?.status ?? "missing");
      if (["succeeded", "failed", "cancelled", "waiting_for_confirmation"].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const [run] = await db`SELECT status,error_code,step_count,model_call_count,route,created_at,started_at,
      (SELECT count(*) FROM companion_agent_steps s WHERE s.run_id=r.id) AS actual_steps
      FROM companion_turn_runs r WHERE id=${accepted.runId}`;
    const calls = await db`SELECT name,status,risk_class FROM companion_agent_tool_calls WHERE run_id=${accepted.runId} ORDER BY created_at`;
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
    if (c.cancelAfterMs !== undefined) {
      delete checks.succeeded; delete checks.nonempty;
      checks.cancelled = status === "cancelled";
      checks.noWriteAfterCancel = !calls.some(call => call.risk_class !== "read" && call.status === "succeeded");
    }
    if (c.expectedImages) checks.actualPixels = c.expectedImages.every(i => visible.toUpperCase().includes(imageFixtures[i]!.token));
    if (c.uniqueImageTranscription && c.expectedImages) {
      const body = visible.toUpperCase();
      const tokens = c.expectedImages.map(i => imageFixtures[i]!.token);
      checks.noRepeatedImageAnswer = tokens.every(token => body.split(token).length === 2);
      const positions = tokens.map(token => body.indexOf(token));
      checks.imageOrder = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!));
    }
    if (c.noWrites) checks.noUnrequestedWrites = !calls.some(call => call.risk_class !== "read" && call.status === "succeeded");
    if (c.tools) checks.requestedTools = c.tools.every(name => [...calls, ...hostReads].some(call => call.name === name && call.status === "succeeded"));
    if (c.messages) checks.messageCount = texts.length === c.messages;
    if (c.includes) checks.smokeTermMatch = c.includes.test(visible);
    if (c.grounded === "note") {
      const [note] = await db`SELECT count(*) AS n FROM notes WHERE workspace_id=${workspaceId} AND title='可靠性验收' AND deleted_at IS NULL`;
      checks.saved = Number(note?.n) === 1;
    }
    if (c.grounded === "memory") {
      const [memory] = await db`SELECT count(*) AS n FROM assistant_memory_items WHERE workspace_id=${workspaceId} AND user_id=${userId} AND deleted_at IS NULL AND content LIKE '%湖蓝%'`;
      checks.saved = Number(memory?.n) > 0;
    }
    if(c.compound){
      const [n]=await db`SELECT id FROM notes WHERE workspace_id=${workspaceId} AND title='出发前检查' AND deleted_at IS NULL`;
      const [m]=await db`SELECT count(*)::int AS n FROM assistant_memory_items WHERE user_id=${userId} AND deleted_at IS NULL AND content LIKE '%茉莉茶%'`;
      checks.bothGoalsSaved=Boolean(n)&&Number(m?.n)>0;
      if(n)checks.noteContent=JSON.stringify(await api(`/v2/notes/${n.id}`)).includes('随身带证件');
    }
    let observedDocument: unknown = undefined;
    if(c.createdExpected){
      const [n]=await db`SELECT id FROM notes WHERE workspace_id=${workspaceId} AND title=${c.createdExpected.title} AND deleted_at IS NULL`;
      if(n){
        observedDocument=await api(`/v2/notes/${n.id}`);
        const d=observedDocument as {currentVersion:{blocks:Array<{content:string}>}};
        checks.createdDocumentExact=JSON.stringify(d.currentVersion.blocks.map(b=>b.content??''))===JSON.stringify(c.createdExpected.paragraphs);
      }else checks.createdDocumentExact=false;
    }
    if(c.editExpected){
      observedDocument=await api(`/v2/notes/${editNote.id}`);
      const response=observedDocument as {currentVersion:{blocks:Array<{content:string}>}};
      const contents=response.currentVersion.blocks.map(b=>b.content??'');
      checks.documentExact=JSON.stringify(contents)===JSON.stringify(c.editExpected);
    }
    let observedMemory: unknown=undefined;
    if(c.id==='offer-first'){
      const [m]=await db`SELECT count(*)::int AS n FROM assistant_memory_items WHERE user_id=${userId} AND deleted_at IS NULL AND content LIKE '%燕麦奶%'`;
      checks.noPrematureMemory=Number(m?.n)===0;
    }
    if(c.id==='accept-followup'){
      const [m]=await db`SELECT count(*)::int AS n FROM assistant_memory_items WHERE user_id=${userId} AND deleted_at IS NULL AND content LIKE '%燕麦奶%'`;
      checks.acceptedPreferenceSaved=Number(m?.n)>0;
      const sources=await db`SELECT m.content,m.applies_when,m.source_event_id,c.blocks AS source_blocks FROM assistant_memory_items m JOIN companion_messages c ON c.id::text=m.source_event_id WHERE m.user_id=${userId} AND m.deleted_at IS NULL AND m.content LIKE '%燕麦奶%'`;
      observedMemory=sources;
      checks.originalFactSource=sources.some(row=>String(row.content).includes('早餐')&&JSON.stringify(row.source_blocks).includes('我早餐只喝燕麦奶'));

    }
    const record = { ...(observedMemory?{observedMemory}:{}), ...(observedDocument?{observedDocument}:{}), id: c.id, repeat, prompt: c.prompt, runId: accepted.runId, ok: Object.values(checks).every(Boolean),
      checks, elapsedMs: Date.now() - start, firstVisibleMs: timing?.first_visible_at ? new Date(timing.first_visible_at).getTime() - start : null,
      run, calls, hostReads, providerCalls, texts,
      ...(c.qualityRubric ? { qualityRubric: c.qualityRubric, semanticReview: "pending" } : {}),
      ...(c.expectedImages ? { expectedPixelText: c.expectedImages.map(i => imageFixtures[i]!.token) } : {}) };
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
