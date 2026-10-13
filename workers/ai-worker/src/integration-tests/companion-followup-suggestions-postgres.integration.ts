/**
 * 可选追问的后台补写链路（worker 侧，真实 Postgres + 真实受限角色）。
 *
 * 为什么必须有这支：追问是**回复终态之后**才补写的一条展示元数据，它踩的三样东西
 * 都没法在源码守卫里证明——
 *   1. worker 对 `companion_messages` 到底有没有 UPDATE（2026-10-13 真窗口实测：
 *      只写迁移不写 roles.sql，任务连撞两次 dead，用户那边只是"她没给追问"）；
 *   2. 写入会不会抬 `context_revision`（抬了就作废会话摘要、撤回反思证据）；
 *   3. 迟到与重试的幂等（事件表里那条 `assistant.followups.ready` 是唯一标记）。
 * provider 走 mock（显式不给平台配置），验的是 DB 编排与围栏，不验模型内容。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const ADMIN_URL = testDatabaseUrl("DATABASE_URL_MIGRATOR");
const WORKER_URL = testDatabaseUrl("DATABASE_URL_WORKER");

// handler 自己的连接（db.ts 读 DATABASE_URL）必须是**受限的 worker 角色**：
// 用超户跑等于绕过 grant 与 RLS，权限回退会全绿。
process.env.DATABASE_URL = WORKER_URL;
// 强制 mock：集成测试不产生外呼，也不该被宿主机上的真实平台配置影响。
delete process.env.AI_PLATFORMS_CONFIG;
delete process.env.TOKENRHYTHM_API_KEY;
delete process.env.AI_REQUIRE_CONFIGURED_PROVIDER;

const admin = postgres(ADMIN_URL, { max: 3 });
const workerReader = postgres(WORKER_URL, { max: 2 });

after(async () => {
  await admin.end({ timeout: 5 }).catch(() => {});
  await workerReader.end({ timeout: 5 }).catch(() => {});
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase().catch(() => {});
});

const { runCompanionFollowupSuggestions } = await import("../handlers/companion-followup-suggestions-job.ts");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface TurnFixture {
  workspaceId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  runId: string;
  jobId: string;
  leaseToken: string;
}

/**
 * 造一轮"她已经答完"的现场：succeeded 的 run + 用户消息 + 纯文本回复 + 待领的追问任务。
 *
 * 夹具全部落在超户连接上（它拥有这些表），但**断言的读**走 worker 角色并带上
 * `app.workspace_id`／`app.user_id`，这样"读到一行"同时证明写了和看得见。
 */
async function seedTurn(options: {
  marker: string;
  runStatus?: string;
  deleteConversation?: boolean;
  preexistingPrompts?: string[];
  preexistingEvent?: boolean;
}): Promise<TurnFixture> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const leaseToken = `lease-${randomUUID()}`;
  const tag = userId.slice(0, 8);

  await admin`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`followup-${tag}@example.test`}, 'h', 'owner')`;
  await admin`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES (${workspaceId}, ${`followup-${tag}`}, ${userId}, 'personal')`;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  await admin`INSERT INTO user_companion_account_state
    (user_id, epoch, global_enabled, presence, suggestion_pause, suppression,
     animation_voice_off, notification_boundary, quiet_hours)
    VALUES (${userId}, 0, true, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
  await admin`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '追问集测', 'placeholder', 'active')`;
  await admin`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
    VALUES (${userMessageId}, ${workspaceId}, ${userId}, ${conversationId}, 1, 'user', 'text',
            ${admin.json([{ type: "text", text: "为什么水结冰之后更占地方？" }])}, ${runId}, ${HASH_A})`;
  await admin`INSERT INTO jobs (id, type, workspace_id, requested_by, payload, status, priority, resource_class, lease_token, started_at, idempotency_key)
    VALUES (${jobId}, 'companion_followup_suggestions', ${workspaceId}, ${userId},
            ${admin.json({ runId, userId, assistantMessageId })}, 'running', 20, 'interactive_ai', ${leaseToken}, now(),
            ${`companion-followups:${assistantMessageId}`})`;
  await admin`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256, follow_up_prompts)
    VALUES (${assistantMessageId}, ${workspaceId}, ${userId}, ${conversationId}, 2, 'assistant', 'text',
            ${admin.json([{ type: "text", text: `结冰时分子排成空的六方格子。${options.marker}` }])},
            ${runId}, ${HASH_B}, ${admin.json(options.preexistingPrompts ?? [])})`;
  await admin`INSERT INTO companion_turn_runs
    (id, workspace_id, user_id, conversation_id, user_message_id, assistant_message_id, job_id,
     generation, status, idempotency_key_hash, request_body_hash, prompt_hash, last_event_seq)
    VALUES (${runId}, ${workspaceId}, ${userId}, ${conversationId}, ${userMessageId}, ${assistantMessageId}, ${jobId},
            1, ${options.runStatus ?? "succeeded"}, ${HASH_A}, ${HASH_B}, ${HASH_A}, 0)`;
  if (options.preexistingEvent) {
    await admin`INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
      VALUES (${conversationId}, 1, ${workspaceId}, ${userId}, ${runId}, 1, 0, 'assistant.followups.ready',
              ${admin.json({ messageId: assistantMessageId, messageContentSha256: HASH_B, followUpPrompts: [] })},
              now() + interval '1 day')`;
  }
  if (options.deleteConversation) {
    // 生产的连续历史清理就是删会话（run 与消息按 FK 级联）。单删消息会被
    // `companion_turn_runs_assistant_message_id_fkey` 挡住，那不是现实形状。
    await admin`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
  }
  return { workspaceId, userId, conversationId, assistantMessageId, runId, jobId, leaseToken };
}

function jobFor(turn: TurnFixture) {
  return {
    id: turn.jobId,
    workspaceId: turn.workspaceId,
    requestedBy: turn.userId,
    payload: { runId: turn.runId, userId: turn.userId, assistantMessageId: turn.assistantMessageId },
    leaseToken: turn.leaseToken,
  };
}

/** 受限角色 + 作用域 GUC 的读：既证明写了，也证明这个人真看得见。 */
async function readAsWorker<T>(turn: TurnFixture, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const scoped = await workerReader.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${turn.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${turn.userId}, true)`;
    return fn(tx);
  });
  // begin 的返回类型对泛型 T 收不拢（postgres.js 的已知形状），运行时就是 fn 的返回值。
  return scoped as unknown as T;
}

async function snapshot(turn: TurnFixture) {
  return readAsWorker(turn, async (tx) => {
    const [message] = await tx`SELECT follow_up_prompts, blocks, content_sha256 FROM companion_messages WHERE id = ${turn.assistantMessageId}`;
    const [run] = await tx`SELECT last_event_seq, model_call_count FROM companion_turn_runs WHERE id = ${turn.runId}`;
    const [conversation] = await tx`SELECT next_event_seq, context_revision FROM companion_conversations WHERE id = ${turn.conversationId}`;
    const events = await tx`SELECT payload FROM companion_stream_events
      WHERE run_id = ${turn.runId} AND type = 'assistant.followups.ready' ORDER BY seq`;
    return {
      prompts: (message?.follow_up_prompts ?? null) as unknown,
      blocks: message?.blocks as unknown,
      contentSha256: message?.content_sha256 as string | undefined,
      lastEventSeq: Number(run?.last_event_seq ?? -1),
      modelCallCount: Number(run?.model_call_count ?? -1),
      nextEventSeq: Number(conversation?.next_event_seq ?? -1),
      contextRevision: Number(conversation?.context_revision ?? -1),
      events,
    };
  });
}

async function cleanup(turn: TurnFixture): Promise<void> {
  await admin`DELETE FROM companion_stream_events WHERE run_id = ${turn.runId}`;
  await admin`DELETE FROM companion_turn_runs WHERE id = ${turn.runId}`;
  await admin`DELETE FROM companion_messages WHERE conversation_id = ${turn.conversationId}`;
  await admin`DELETE FROM jobs WHERE id = ${turn.jobId}`;
  await admin`DELETE FROM companion_conversations WHERE id = ${turn.conversationId}`;
  await admin`DELETE FROM user_companion_account_state WHERE user_id = ${turn.userId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${turn.workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${turn.workspaceId}`;
  await admin`DELETE FROM users WHERE id = ${turn.userId}`;
}

test("追问由 worker 角色写回元数据列，并且不动正文与摘要修订号", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:3】" });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const after = await snapshot(turn);
    assert.deepEqual(after.prompts, ["这条追问方向一", "这条追问方向二", "这条追问方向三"]);
    // 正文一字未动：哈希与 blocks 都还是原来那份，所以摘要与反思证据不作废。
    assert.equal(after.contentSha256, HASH_B);
    assert.match(JSON.stringify(after.blocks), /六方格子/);
    assert.equal(after.contextRevision, 1, "写追问抬起了 context_revision：会话摘要会被判过期");
    // 事件带的是这条回复的内容校验值，客户端据此拒绝张冠李戴的迟到结果。
    assert.equal(after.events.length, 1);
    assert.deepEqual((after.events[0] as { payload: unknown }).payload, {
      messageId: turn.assistantMessageId, messageContentSha256: HASH_B,
      followUpPrompts: ["这条追问方向一", "这条追问方向二", "这条追问方向三"],
    });
    assert.equal(after.lastEventSeq, 1);
    assert.equal(after.nextEventSeq, 2);
    assert.equal(after.modelCallCount, 1, "这一次外呼没记进本轮的模型调用预算");
  } finally {
    await cleanup(turn);
  }
});

test("模型多给一条时收进上限，而不是撞约束或整批丢掉", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:4】" });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const after = await snapshot(turn);
    assert.deepEqual(after.prompts, ["这条追问方向一", "这条追问方向二", "这条追问方向三"]);
  } finally {
    await cleanup(turn);
  }
});

test("重试不重复补写：事件只有一条，计数器也只推一次", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:2】" });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const first = await snapshot(turn);
    await runCompanionFollowupSuggestions(jobFor(turn));
    const second = await snapshot(turn);
    assert.equal(second.events.length, 1);
    assert.deepEqual(second.prompts, first.prompts);
    assert.equal(second.nextEventSeq, first.nextEventSeq);
    assert.equal(second.modelCallCount, first.modelCallCount);
  } finally {
    await cleanup(turn);
  }
});

test("AI 决定不给时也落一条空事件，作为不再重跑的凭据", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:0】" });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const after = await snapshot(turn);
    assert.deepEqual(after.prompts, []);
    assert.equal(after.events.length, 1);
    assert.deepEqual((after.events[0] as { payload: { followUpPrompts: unknown } }).payload.followUpPrompts, []);
    assert.equal(after.modelCallCount, 1);
  } finally {
    await cleanup(turn);
  }
});

test("围栏：本轮已被接替时不补写，也不留事件", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:3】", runStatus: "superseded" });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const after = await snapshot(turn);
    assert.deepEqual(after.prompts, []);
    assert.equal(after.events.length, 0);
    assert.equal(after.nextEventSeq, 1, "没写事件却推进了会话事件计数器");
  } finally {
    await cleanup(turn);
  }
});

test("迟到时那段历史已经被清掉：安静收场，不炸也不留半条事件", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:3】", deleteConversation: true });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const events = await admin`SELECT 1 FROM companion_stream_events WHERE run_id = ${turn.runId}`;
    assert.equal(events.length, 0);
  } finally {
    await cleanup(turn);
  }
});

test("已有事件标记时不再重跑生成（追问不该为同一回复出现两次）", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:3】", preexistingEvent: true });
  try {
    await runCompanionFollowupSuggestions(jobFor(turn));
    const after = await snapshot(turn);
    assert.equal(after.events.length, 1);
    assert.deepEqual(after.prompts, []);
    assert.equal(after.modelCallCount, 0, "已经有标记了还又打了一次外呼");
  } finally {
    await cleanup(turn);
  }
});

test("任务的作用域与 payload 里的本人不符时直接失败", async () => {
  const turn = await seedTurn({ marker: "【mock:followup-prompts:3】" });
  try {
    await assert.rejects(runCompanionFollowupSuggestions({
      ...jobFor(turn),
      payload: { ...jobFor(turn).payload, userId: randomUUID() },
    }));
    const events = await admin`SELECT 1 FROM companion_stream_events WHERE run_id = ${turn.runId}`;
    assert.equal(events.length, 0);
  } finally {
    await cleanup(turn);
  }
});
