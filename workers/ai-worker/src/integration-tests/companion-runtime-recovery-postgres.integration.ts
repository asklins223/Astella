/** Regression for the Oct 3 stale-turn and pre-provider snapshot failures. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { ChatMessage, ChatOptions } from "@astella/shared";

delete process.env.AI_PLATFORMS_CONFIG;
delete process.env.TOKENRHYTHM_API_KEY;
process.env.NODE_ENV = "production";
const admin = postgres(process.env.DATABASE_URL!, { max: 2 });
const { closeDatabase, withWorkerWorkspaceTransaction } = await import("../db.ts");
const { MockProvider } = await import("../lib/providers/mock.ts");
const { registerFactory } = await import("../lib/provider-factory.ts");
const { runCompanionMemoryExtract } = await import("../handlers/companion-memory-extractor.ts");
const { runCompanionSummarizer } = await import("../handlers/companion-summarizer.ts");
const { runCompanionThought } = await import("../handlers/companion-thought.ts");
const { readCompanionHistoryRows, countCompanionHistoryMessages, companionHistoryText } = await import("../handlers/companion-dialogue-store.ts");

const userId = randomUUID(), workspaceId = randomUUID(), conversationId = randomUUID();
const orphanWorkspaceId = randomUUID(), departedWorkspaceId = randomUUID();
const userMessageId = randomUUID(), runId = randomUUID();
let extractSourceId = userMessageId;
let extractSourceQuote = "以后解释概念都先给我一个例子";
let extractSourceBasis = "direct_statement";
const calls: Array<{ messages: ChatMessage[]; temperature: number | undefined }> = [];
class RecoveryProvider extends MockProvider {
  override async chatCompletion(messages: ChatMessage[], options: ChatOptions) {
    calls.push({ messages, temperature: options.temperature });
    const prompt = messages.map((message) => String(message.content)).join("\n");
    let output: unknown;
    if (prompt.includes("记忆整理器")) {
      output = { candidates: [{
        kind: "preference", content: "用户以后希望先看例子再看定义。", confidence: 0.95,
        sourceMessageId: extractSourceId, sourceSpeaker: "user", sourceBasis: extractSourceBasis,
        sourceQuote: extractSourceQuote, binding: "portable",
      }] };
    } else if (prompt.includes("会话摘要器")) {
      output = { title: "依次讨论两段不同原文", topics: ["间隔重复", "检索练习"] };
    } else if (options.maxTokens === 500) {
      output = { thoughts: [{ text: "窗边安静下来了，想歇会儿就陪你坐着。", urgency: 85, topic: "休息" }] };
    } else if (options.maxTokens === 400) {
      output = { variants: ["窗边安静下来了，想歇会儿就陪你坐着。"] };
    } else {
      throw new Error("unexpected recovery provider request");
    }
    return { content: JSON.stringify(output), usage: { promptTokens: 30, completionTokens: 20 } };
  }
}
registerFactory("mock", "agent_turn", () => new RecoveryProvider());

await admin`INSERT INTO users (id,email,password_hash,role) VALUES (${userId},${`recovery-${userId}@x.test`},'h','owner')`;
await admin`INSERT INTO workspaces (id,name,owner_id) VALUES
  (${workspaceId},'runtime recovery',${userId}),(${departedWorkspaceId},'departed fixture',${userId})`;
await admin`INSERT INTO workspace_members (workspace_id,user_id,role,left_at) VALUES
  (${workspaceId},${userId},'owner',NULL),(${departedWorkspaceId},${userId},'owner',now())`;
await admin`INSERT INTO pet_profiles (workspace_id,user_id,familiarity) VALUES (${workspaceId},${userId},0.7)`;
await admin`INSERT INTO companion_conversations (id,workspace_id,user_id,kind,title,title_source,status)
  VALUES (${conversationId},${workspaceId},${userId},'dialogue','fixture','auto','active')`;

async function message(seq: number, text: string, role: "user" | "assistant" = "user", id = randomUUID(), messageRunId: string | null = null) {
  await admin`INSERT INTO companion_messages (id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256,run_id)
    VALUES (${id},${conversationId},${workspaceId},${userId},${role},${seq},'text',
      ${admin.json([{ type: "text", text }])},${"0".repeat(64)},${messageRunId})`;
  return id;
}
async function turn(id: string, messageId: string, generation: number, selection: string | null, status = "succeeded") {
  await admin`INSERT INTO companion_turn_runs
    (id,conversation_id,workspace_id,user_id,user_message_id,generation,status,idempotency_key_hash,request_body_hash,page_context)
    VALUES (${id},${conversationId},${workspaceId},${userId},${messageId},${generation},${status},
      ${id.replaceAll("-", "").repeat(2)},${"b".repeat(64)},
      ${admin.json({ version: 1, context: { pageKind: "note" }, selection: selection ? { text: selection } : null })})`;
}
await turn(randomUUID(), await message(1,"解释这段"), 1,"间隔重复：在快忘记时复习。");
await message(2,"第一段解释", "assistant");
await turn(randomUUID(), await message(3,"解释这段"), 2,"检索练习：合上笔记自己回忆。");
await message(4,"第二段解释", "assistant");
await turn(randomUUID(), await message(5,"不要再回答的已取消问题"), 3,null,"cancelled");
await message(6,"以后解释概念都先给我一个例子", "user", userMessageId);
await turn(runId,userMessageId,4,null);
await message(7,"好，我会按这个顺序解释。","assistant",randomUUID(),runId);
await message(8,"FUTURE：这条不能污染较早轮次的记忆抽取");
for (let seq=9; seq<=36; seq++) await message(seq,`后续普通对话 ${seq}`,seq%2 ? "user" : "assistant");

async function job(type: string, payload: Record<string, unknown>) {
  const id=randomUUID(), leaseToken=randomUUID();
  await admin`INSERT INTO jobs (id,type,workspace_id,requested_by,payload,status,started_at,lease_token)
      VALUES (${id},${type},${workspaceId},${userId},${JSON.stringify(payload)}::jsonb,'running',now(),${leaseToken})`;
  return { id,workspaceId,requestedBy:userId,payload,leaseToken,signal:new AbortController().signal };
}

after(async () => {
  try {
    await admin`DELETE FROM companion_turn_runs WHERE conversation_id=${conversationId}`;
    await admin`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
    await admin`DELETE FROM companion_conversations WHERE id=${conversationId}`;
    await admin`DELETE FROM jobs WHERE requested_by=${userId}`;
    await admin`DELETE FROM workspaces WHERE id IN (${workspaceId},${departedWorkspaceId})`;
    await admin`DELETE FROM users WHERE id=${userId}`;
  } finally {
    await admin.end({ timeout: 2 });
    await closeDatabase();
  }
});

test("真 worker 读取历史：每个问题保留自己的选区，取消与未来消息不进入当前轮", async () => {
  const result = await withWorkerWorkspaceTransaction({workspaceId,userId},async tx => ({
    rows: await readCompanionHistoryRows(tx,conversationId,{beforeSeq:"6",limit:20}),
    count: await countCompanionHistoryMessages(tx,conversationId,"6"),
  }));
  assert.equal(result.count,4n);
  assert.deepEqual(result.rows.map(row=>row.seq),["4","3","2","1"]);
  assert.match(companionHistoryText(result.rows[1]),/检索练习：合上笔记自己回忆/);
  assert.match(companionHistoryText(result.rows[3]),/间隔重复：在快忘记时复习/);
});

test("记忆 handler 携小数参数真正调用 provider 并写入可检索记忆，延迟任务不读取未来消息", async () => {
  const fixture=await job("companion_memory_extract",{runId,userId});
  await runCompanionMemoryExtract(fixture as Parameters<typeof runCompanionMemoryExtract>[0]).catch((error: unknown) => {
    let cause = error;
    while (cause instanceof Error && cause.cause) cause = cause.cause;
    throw cause;
  });
  const call=calls.find(call=>call.messages.some(message=>String(message.content).includes("记忆整理器")));
  assert.equal(call?.temperature,0.2);
  assert.ok(call && !JSON.stringify(call.messages).includes("FUTURE"));
  const memory=await admin`SELECT candidate,source_session_id,content FROM assistant_memory_items WHERE user_id=${userId}`;
  assert.equal(memory.length,1);
  assert.equal(memory[0].candidate,false);
  assert.equal(memory[0].source_session_id,conversationId);
});

test("摘要 handler 携小数参数落库，摘要输入区分相邻两次划选并排除已取消问题", async () => {
  const fixture=await job("companion_summarizer",{conversationId,userId});
  await runCompanionSummarizer(fixture as Parameters<typeof runCompanionSummarizer>[0]);
  const call=calls.find(call=>call.messages.some(message=>String(message.content).includes("会话摘要器")));
  assert.equal(call?.temperature,0.2);
  const transcript=JSON.stringify(call?.messages);
  assert.match(transcript,/间隔重复：在快忘记时复习/);
  assert.match(transcript,/检索练习：合上笔记自己回忆/);
  assert.ok(!transcript.includes("已取消问题"));
  const rows=await withWorkerWorkspaceTransaction({workspaceId,userId},tx=>tx.execute(sql`
    SELECT coverage_through_seq FROM conversation_summaries WHERE conversation_id=${conversationId}`));
  assert.equal(rows.length,1);
});

test("念头 handler 携小数参数调用生成与表达，并实际写出念头", async () => {
  const start=calls.length;
  const fixture=await job("companion_thought",{userId});
  await runCompanionThought(fixture as Parameters<typeof runCompanionThought>[0]);
  assert.ok(calls.slice(start).length>=2,"候选生成和表达都须到达 provider，不能回退掩盖失败");
  assert.ok(calls.slice(start).every(call=>call.temperature===0.9));
  const rows=await admin`SELECT source,status FROM assistant_thoughts WHERE workspace_id=${workspaceId} AND source='llm'`;
  assert.ok(rows.length>0);
  assert.ok(rows.some(row=>row.status==='delivered'));
});

test("有限归纳的记忆能写入新作者词表，数据库默认值也不再违反自己的约束", async () => {
  extractSourceQuote = "这本书在定义之前给了例子，这个顺序让我更容易理解";
  extractSourceId = await message(37, extractSourceQuote);
  extractSourceBasis = "inferred_from_statement";
  const inferredRunId = randomUUID();
  await turn(inferredRunId, extractSourceId, 5, null);
  await message(38, "先看具体情形再看定义。", "assistant", randomUUID(), inferredRunId);
  const fixture = await job("companion_memory_extract", { runId: inferredRunId, userId });
  await runCompanionMemoryExtract(fixture as Parameters<typeof runCompanionMemoryExtract>[0]);
  const rows = await admin`SELECT author_type,user_stated,candidate FROM assistant_memory_items
    WHERE user_id=${userId} AND source_event_id=${extractSourceId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].author_type, "extractor");
  assert.equal(rows[0].user_stated, false);
  assert.equal(rows[0].candidate, false);
  await withWorkerWorkspaceTransaction({ workspaceId, userId }, tx => tx.execute(sql`
    INSERT INTO assistant_memory_items (workspace_id,user_id,kind,content,source_type)
    VALUES (${workspaceId},${userId},'preference','数据库默认作者回归夹具','model_inferred')`));
});

test("全局整理入队跳过孤立记忆与已退出成员，且重复调用返回真实新增数", async () => {
  for (const ws of [workspaceId,orphanWorkspaceId,departedWorkspaceId]) {
    await admin`INSERT INTO assistant_memory_items (workspace_id,user_id,kind,content,candidate,source_event_id,updated_at,author_type)
      VALUES (${ws},${userId},'preference','旧的待整理夹具',false,${`organizer-${ws}`},now()-interval '31 days','user')`;
  }
  const enqueue=()=>withWorkerWorkspaceTransaction({workspaceId,userId},tx=>tx.execute<{n:number}>(sql`
    SELECT public.astella_enqueue_companion_memory_organize() AS n`));
  assert.equal((await enqueue())[0].n,1);
  assert.equal((await enqueue())[0].n,0);
  const jobs=await admin`SELECT workspace_id FROM jobs WHERE type='companion_memory_organize' AND requested_by=${userId}`;
  assert.deepEqual(jobs.map(job=>job.workspace_id),[workspaceId]);
});
