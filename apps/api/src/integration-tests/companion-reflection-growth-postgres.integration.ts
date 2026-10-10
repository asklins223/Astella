/**
 * 方案 50 §16 首批闭环的真库验收：她说错了一次 → 用户明确纠正 → 后台回顾留下经验与
 * 一版待生效的自我描述 → 下一条被接受的新用户消息采用 → 隔天正常接话；
 * 而用户把那句原话删掉之后，这一版**不会**被采用。
 *
 * 用真库与受限角色跑，是因为这一环的每一条规矩都住在库里：
 * 0355 的 CHECK（排队一定比当前新）、0400 的唯一约束（同一段不落两次）、
 * RLS（两个空间的回顾读不到彼此的行）、以及采用与入队在同一笔事务里。
 * 模型用 `MockProvider` 固定输出：这里测的是**接线与围栏**，不是自然度——
 * 自然度另由配对样本与真人评阅判（§15.2），不能靠这几条断言冒充。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { MockProvider } from "../../../../workers/ai-worker/src/lib/providers/mock.ts";
import { runCompanionReflectionJob, companionReflectionDedupeKey }
  from "../../../../workers/ai-worker/src/handlers/companion-reflection.ts";
import { applyAssistantPersonaEdit }
  from "../../../../workers/ai-worker/src/handlers/companion-persona-self-edit.ts";
import { closeDatabase as closeWorkerDatabase, withWorkerWorkspaceTransaction }
  from "../../../../workers/ai-worker/src/db.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { getPetProfileState, stagePetProfileRevision }
  from "../modules/companion-conversation/pet-profile-service.ts";
import { personaFromDefaultPreset } from "@astella/shared/pet-persona-merge";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import { createCompanionTurn } from "../modules/companion-conversation/turn/turn-service.ts";

// 让 `agent_turn` 解析不到平台 → 走 mock provider（与日记那一份集成测试同一手法）。
process.env.AI_PLATFORMS_CONFIG = "/nonexistent/companion-reflection-fixture.json";

const admin = postgres(testDatabaseUrl("DATABASE_URL_TEST_ADMIN"), { max: 2 });
const HASH = "0".repeat(64);

after(async () => {
  try {
    await admin`DELETE FROM companion_reflection_checkpoints WHERE job_id IS NOT NULL`;
    await admin`DELETE FROM companion_reflection_sources WHERE TRUE`;
    await admin`DELETE FROM companion_reflections WHERE TRUE`;
    await admin`DELETE FROM jobs WHERE TRUE`;
  } finally {
    await Promise.all([admin.end({ timeout: 5 }), closeDatabase(), closeWorkerDatabase()]);
  }
});

interface Fixture {
  readonly userId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  /** 段内每条消息的 id（按插入顺序）。 */
  readonly messageIds: string[];
  readonly correctionMessageId: string;
  runReflection: (jobFields?: { fromSeq?: number; toSeq?: number }) => Promise<void>;
  readReflection: () => Promise<Record<string, unknown>[]>;
  readEdges: (relation: string) => Promise<Record<string, unknown>[]>;
  persona: () => Promise<Awaited<ReturnType<typeof getPetProfileState>>>;
  newTurn: (text: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * 一段真实的相处：早啊 → 她盘点了笔记 → 用户明确纠正 → 她接住 → 用户再说一句。
 * 三条用户发言、两条她的回复，末尾是她说出去的那一句（门要求"段落已经落定"）。
 */
async function fixture(options: { userMessages?: number; intervalBlocked?: boolean } = {}): Promise<Fixture> {
  const userId = randomUUID(), workspaceId = randomUUID(), conversationId = randomUUID();
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return fn(tx);
  });
  await mutate(async (tx) => {
    await tx`INSERT INTO users(id,email,password_hash,role)
      VALUES(${userId},${`reflect-${userId}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'回顾回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,global_enabled) VALUES(${userId},true)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','回顾回归','system','active')`;
  });

  const script: { role: "user" | "assistant"; text: string }[] = [
    { role: "user", text: "早啊" },
    { role: "assistant", text: "早！昨天那篇三篇笔记我们还没看完，我先给你数一遍？" },
    { role: "user", text: "以后打招呼别盘点笔记" },
    { role: "assistant", text: "好，那就不数了。" },
    { role: "user", text: "嗯，就先这样" },
    { role: "assistant", text: "好。" },
  ];
  const messageIds: string[] = [];
  let correctionMessageId = "";
  for (const [index, line] of script.entries()) {
    const id = randomUUID();
    if (line.text === "以后打招呼别盘点笔记") correctionMessageId = id;
    messageIds.push(id);
    await mutate(async (tx) => {
      await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256)
        VALUES(${id},${workspaceId},${userId},${conversationId},${line.role},${index + 1},'text',
          ${tx.json([{ type: "text", text: line.text }])},${HASH})`;
    });
  }
  for (let extra = script.length; extra < (options.userMessages ?? 0); extra += 1) {
    const id = randomUUID();
    messageIds.push(id);
    await mutate(async (tx) => {
      await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256)
        VALUES(${id},${workspaceId},${userId},${conversationId},'user',${extra + 1},'text',
          ${tx.json([{ type: "text", text: "再补一句" }])},${HASH})`;
    });
  }

  // 回合服务按 `companion_conversations.next_message_seq` 原子分配 seq；夹具直接插的消息
  // 不会推这个计数器，不补上就等于下一条真实回合撞进已经用掉的 seq。
  const seededSeq = Math.max(messageIds.length, options.userMessages ?? 0);
  await mutate(async (tx) => {
    await tx`UPDATE companion_conversations
              SET next_message_seq = ${seededSeq + 1}, next_event_seq = ${seededSeq + 1},
                  next_generation = 1
            WHERE id=${conversationId}`;
  });

  let jobSerial = 0;
  const jobs: string[] = [];
  return {
    userId, workspaceId, conversationId, messageIds, correctionMessageId,
    async runReflection(jobFields) {
      const jobId = randomUUID(), leaseToken = randomUUID();
      jobSerial += 1;
      jobs.push(jobId);
      const fromSeq = jobFields?.fromSeq ?? 0;
      const toSeq = jobFields?.toSeq ?? messageIds.length;
      await mutate(async (tx) => {
        await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at,resource_class,priority)
          VALUES(${jobId},'companion_reflection',${workspaceId},${userId},
            ${tx.json({ userId, workspaceId, conversationId, fromSeq, toSeq })},
            'running',${leaseToken},now(),'maintenance',30)`;
      });
      await runCompanionReflectionJob({
        id: jobId, workspaceId, requestedBy: userId, leaseToken,
        payload: { userId, workspaceId, conversationId, fromSeq, toSeq },
      });
    },
    readReflection: () => mutate(tx => tx`
      SELECT decision, decision_summary, baseline_persona_revision, pending_persona_revision,
             input_from_seq, input_to_seq, dedupe_key, strategy_version
        FROM companion_reflections WHERE user_id=${userId} ORDER BY created_at`),
    readEdges: (relation) => mutate(tx => tx`
      SELECT source_kind, source_id, source_revision FROM companion_reflection_sources
       WHERE user_id=${userId} AND relation=${relation} ORDER BY source_kind, source_id`),
    persona: () => withWorkspaceTransaction({ workspaceId, userId }, tx => getPetProfileState(tx, { workspaceId, userId })),
    async newTurn(text) {
      jobSerial += 1;
      const runId = randomUUID();
      await mutate(async (tx) => {
        await tx`UPDATE companion_turn_runs SET status='succeeded', finished_at=now()
                  WHERE conversation_id=${conversationId}`;
      });
      const result = await createCompanionTurn({
        workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
        body: { version: 1, clientMessageId: runId, inputKind: "text",
          blocks: [{ type: "text", text }], sourceSurface: "pet" },
      });
      assert.equal(result.statusCode, 202, `新用户回合应当被接受（${text}）`);
    },
    async deleteMessage(id) { await mutate(tx => tx`DELETE FROM companion_messages WHERE id=${id}`); },
    cleanup: async () => {
      await mutate(async (tx) => {
        await tx`DELETE FROM companion_reflection_sources WHERE user_id=${userId}`;
        await tx`DELETE FROM companion_reflections WHERE user_id=${userId}`;
        await tx`DELETE FROM assistant_memory_items WHERE user_id=${userId}`;
        await tx`DELETE FROM companion_procedural_playbooks WHERE user_id=${userId}`;
        await tx`DELETE FROM companion_agent_tool_calls WHERE user_id=${userId}`;
        await tx`DELETE FROM companion_turn_runs WHERE conversation_id=${conversationId}`;
        await tx`DELETE FROM companion_stream_events WHERE conversation_id=${conversationId}`;
        await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
        await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
        await tx`DELETE FROM companion_persona_profiles WHERE user_id=${userId}`;
        await tx`DELETE FROM companion_persona_profile_versions WHERE user_id=${userId}`;
        await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
        await tx`DELETE FROM user_companion_account_state WHERE user_id=${userId}`;
        await tx`DELETE FROM users WHERE id=${userId}`;
      });
      void jobSerial;
    },
  };
}

/** 固定她这一次回顾的产出：一条判断、一条方法、一句自我描述修订。 */
function reflectionModelFixture(
  body: { judgments?: unknown[]; experiences?: unknown[]; persona?: unknown; summary?: string },
  onCall: (messages: Parameters<MockProvider["chatCompletion"]>[0]) => void | Promise<void> = () => {}, 
) {
  const original = MockProvider.prototype.chatCompletion;
  MockProvider.prototype.chatCompletion = async function (messages, options, signal) {
    if (!String(messages[0]?.content ?? "").includes("你是她自己，正在回顾刚发生的一段相处")) {
      return original.call(this, messages, options, signal);
    }
    await onCall(messages);
    return {
      content: JSON.stringify({
        decision: "proposals",
        summary: body.summary ?? "对方明确说过招呼不要盘点笔记。",
        judgments: body.judgments ?? [],
        experiences: body.experiences ?? [],
        persona: body.persona ?? null,
      }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  };
  return () => { MockProvider.prototype.chatCompletion = original; };
}

test("§16 一条完整路径：回顾留下经验与待生效自我描述，下一条被接受的回合才采用", async () => {
  const f = await fixture();
  let calls = 0;
  const restore = reflectionModelFixture({
    judgments: [{ text: "打招呼时她把读过的笔记数了一遍，对方不要这个。",
      epistemicStatus: "tentative", appliesWhen: "只招呼、没点名要接续时",
      sourceMessageIds: [f.correctionMessageId] }],
    experiences: [{ title: "招呼只接眼前这句", triggerCondition: "对方只说了一句招呼",
      steps: ["先接住这一句，不盘点读过的东西"], exceptions: ["对方点名要接着昨天那篇时照常接续"],
      sourceMessageIds: [f.correctionMessageId] }],
    persona: { selfDescription: "我容易一上来就把读过的东西数一遍，被说过一次，正在改。",
      reason: "对方明确说过招呼不要盘点笔记", sourceMessageIds: [f.correctionMessageId] },
  }, () => { calls += 1; });
  try {
    await f.runReflection();
    assert.equal(calls, 1, "一次回顾只付一次模型调用");

    const [reflection] = await f.readReflection();
    assert.equal(reflection.decision, "committed");
    assert.equal(Number(reflection.baseline_persona_revision), 0);
    assert.equal(Number(reflection.pending_persona_revision), 1);
    assert.equal(reflection.strategy_version, "reflection-v1");

    // 依据固定下来了：读边是那次真的读到的消息，产出边指向落下的版本。
    const readEdges = await f.readEdges("read");
    assert.ok(readEdges.length >= 5, `read 边应覆盖段内消息，实际 ${readEdges.length}`);
    const producedEdges = await f.readEdges("produced");
    assert.deepEqual(producedEdges.map(edge => edge.source_kind).sort(),
      ["memory", "method", "persona_revision"]);

    // 排队不动当前版本：这一版还没生效，正在进行的会话不会被换人。
    const staged = await f.persona();
    assert.equal(staged.profileRevision, 0);
    assert.equal(staged.profile, null);
    assert.equal(staged.pending?.revision, 1);
    assert.equal(staged.pending?.author, "assistant_tool");
    assert.equal(staged.pending?.profile?.selfDescription,
      "我容易一上来就把读过的东西数一遍，被说过一次，正在改。");

    // 判断不是关于用户的事实：user_stated=false、留在空间、来源是她自己的解释。
    const memories = await admin`SELECT kind, content, user_stated, scope, source_speaker,
                                        source_event_ids, epistemic_status
                                  FROM assistant_memory_items WHERE user_id=${f.userId}`;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].kind, "judgment");
    assert.equal(memories[0].user_stated, false);
    assert.equal(memories[0].scope, "workspace");
    assert.equal(memories[0].source_speaker, "companion");
    assert.deepEqual(memories[0].source_event_ids, [f.correctionMessageId]);

    const methods = await admin`SELECT title, author, epistemic_status, trigger_condition
                                FROM companion_procedural_playbooks WHERE user_id=${f.userId}`;
    assert.equal(methods.length, 1);
    assert.equal(methods[0].author, "maintenance");
    assert.equal(methods[0].epistemic_status, "tentative");

    // 隔天：下一条被接受的新用户消息采用那一版；当前版本从此是第 1 版。
    await f.newTurn("早");
    const adopted = await f.persona();
    assert.equal(adopted.profileRevision, 1);
    assert.equal(adopted.pending, null);
    assert.equal(adopted.profile?.selfDescription,
      "我容易一上来就把读过的东西数一遍，被说过一次，正在改。");
  } finally {
    restore();
    await f.cleanup();
  }
});

test("重复投递同一段：不再跑第二次模型，也不多留一版人格", async () => {
  const f = await fixture();
  let calls = 0;
  const restore = reflectionModelFixture({
    judgments: [{ text: "一条有依据的判断", epistemicStatus: "tentative",
      sourceMessageIds: [f.correctionMessageId] }],
  }, () => { calls += 1; });
  try {
    await f.runReflection();
    await f.runReflection();
    await f.runReflection();
    assert.equal(calls, 1, "同一段相处的第二次、第三次投递都不该再花钱");
    const rows = await f.readReflection();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupe_key, companionReflectionDedupeKey(f.conversationId, 6));
    const versions = await admin`SELECT revision FROM companion_persona_profile_versions WHERE user_id=${f.userId}`;
    assert.equal(versions.length, 0, "只留了一条判断时不应推人格版本");
  } finally {
    restore();
    await f.cleanup();
  }
});

test("门未过的段落安静结束：没有模型调用，结论码可诊断", async () => {
  const f = await fixture();
  let calls = 0;
  const restore = reflectionModelFixture({}, () => { calls += 1; });
  try {
    // 只给一条用户发言（seq 1）——真的没来回过，不该花一次回顾。
    await f.runReflection({ fromSeq: 0, toSeq: 1 });
    assert.equal(calls, 0);
    const [reflection] = await f.readReflection();
    assert.equal(reflection.decision, "trigger_none");
    assert.match(String(reflection.decision_summary), /too_few_user_turns/);
  } finally {
    restore();
    await f.cleanup();
  }
});

test("引用了不在段内的消息 id：那条判断丢掉，其余照常留下并写下理由", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({
    judgments: [
      { text: "一条有依据的判断", epistemicStatus: "tentative", sourceMessageIds: [f.correctionMessageId] },
      { text: "一条引用了编造消息的判断", epistemicStatus: "supported", sourceMessageIds: [randomUUID()] },
    ],
  });
  try {
    await f.runReflection();
    const [reflection] = await f.readReflection();
    assert.equal(reflection.decision, "committed");
    const memories = await admin`SELECT content FROM assistant_memory_items WHERE user_id=${f.userId}`;
    assert.deepEqual(memories.map(row => row.content), ["一条有依据的判断"]);
    const stored = await admin`SELECT result_ref FROM companion_reflections WHERE user_id=${f.userId}`;
    assert.deepEqual((stored[0].result_ref as { dropped: string[] }).dropped, ["judgments#1:cited_source_not_in_snapshot"]);
  } finally {
    restore();
    await f.cleanup();
  }
});

test("依据被删除后不采用：清掉排队、写下原因，历史那一版仍可查", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({
    persona: { selfDescription: "我正在改一上来就数笔记的习惯。",
      reason: "对方明确说过招呼不要盘点笔记", sourceMessageIds: [f.correctionMessageId] },
  });
  try {
    await f.runReflection();
    assert.equal((await f.persona()).pending?.revision, 1);

    // 用户把那句原话删了（不是"她自己又说了一遍"）。
    await f.deleteMessage(f.correctionMessageId);
    await f.newTurn("早");

    const afterAdoptionAttempt = await f.persona();
    assert.equal(afterAdoptionAttempt.profileRevision, 0, "失去依据的自动改变不能留在人格里");
    assert.equal(afterAdoptionAttempt.pending, null);
    const [reflection] = await f.readReflection();
    assert.equal(reflection.decision, "source_invalid");
    const history = await admin`SELECT revision FROM companion_persona_profile_versions WHERE user_id=${f.userId}`;
    assert.equal(history.length, 1, "被作废的那一版仍在历史里，用户仍可查与恢复");
  } finally {
    restore();
    await f.cleanup();
  }
});

test("基线在回顾期间被推走：不提交，把冲突写在结论上", async () => {
  const f = await fixture();
  // 模型还在答的时候，用户自己动了人格：她这次回顾看到的是第 0 版，
  // 提交那一刻库里已经是第 1 版。此时**一个字都不写**，并把冲突记下来——
  // 迟到的一次后台结论不能盖掉用户刚刚亲手定下的样子。
  const bumpPersona = async () => {
    await admin`INSERT INTO companion_persona_profiles(user_id,revision,profile)
      VALUES(${f.userId},0,NULL) ON CONFLICT (user_id) DO NOTHING`;
    await admin`UPDATE companion_persona_profiles SET revision=1,
      profile=${admin.json({ presetId: "custom", name: "小猫", personalityTags: ["好奇"],
        speakingStyle: "用户亲自写的语气", examples: [], activeness: "quiet", boundaries: {} })}::jsonb
      WHERE user_id=${f.userId}`;
  };
  const restore = reflectionModelFixture({
    judgments: [{ text: "一条有依据的判断", epistemicStatus: "tentative",
      sourceMessageIds: [f.correctionMessageId] }],
    persona: { selfDescription: "我正在改一上来就数笔记的习惯。",
      reason: "对方明确说过招呼不要盘点笔记", sourceMessageIds: [f.correctionMessageId] },
  }, async () => { await bumpPersona(); });
  try {
    await f.runReflection();
    await new Promise(resolve => setTimeout(resolve, 200));
    const [reflection] = await f.readReflection();
    assert.equal(reflection.decision, "commit_conflict");
    assert.match(String(reflection.decision_summary), /基线已变/);
    const memories = await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`;
    assert.equal(memories.length, 0, "核对不过就不能写经验，也不能只写一半");
    const persona = await f.persona();
    assert.equal(persona.profile?.speakingStyle, "用户亲自写的语气", "用户写的那一句没有被后台结论盖掉");
    assert.equal(persona.pending, null);
  } finally {
    restore();
    await f.cleanup();
  }
});

test("提案身份：同一次运行两项都留，不相干的提议不互为改稿底稿", async () => {
  const f = await fixture();
  const runA = randomUUID(), runB = randomUUID(), reflectionId = randomUUID();
  const scope = { workspaceId: f.workspaceId, userId: f.userId };
  const edit = (proposal: { kind: "assistant_tool" | "assistant_reflection"; proposalId: string },
    field: "speakingStyle" | "personalityTags" | "selfDescription", value: unknown) =>
    withWorkerWorkspaceTransaction(scope, tx => applyAssistantPersonaEdit(tx, f.userId, field, value,
      "合成：她自己提的一次修订", { stage: true, expectedRevision: 0, sourceWorkspaceId: f.workspaceId, proposal }));
  try {
    // 同一次运行里先改语气、再改标签：两项都要留下（她提了一次，改了两处）。
    assert.equal((await edit({ kind: "assistant_tool", proposalId: runA }, "speakingStyle", "先接住眼前这句")).kind, "changed");
    const tags = await edit({ kind: "assistant_tool", proposalId: runA }, "personalityTags", ["松弛"]);
    assert.equal(tags.kind, "changed");
    const sameRun = await f.persona();
    assert.equal(sameRun.pending?.revision, 2);
    assert.equal(sameRun.pending?.profile?.speakingStyle, "先接住眼前这句");
    assert.deepEqual(sameRun.pending?.profile?.personalityTags, ["松弛"]);

    // 另一次运行提的：不并到那一版上。回到**当前生效**的那份人格重评，
    // 旧的排队被顶掉但仍在历史里（用户可查、可恢复）。
    const other = await edit({ kind: "assistant_tool", proposalId: runB }, "selfDescription", "我正在改一上来就数笔记的习惯。");
    assert.equal(other.kind, "changed");
    const superseded = await f.persona();
    assert.equal(superseded.pending?.revision, 3);
    assert.equal(superseded.pending?.profile?.selfDescription, "我正在改一上来就数笔记的习惯。");
    assert.notEqual(superseded.pending?.profile?.speakingStyle, "先接住眼前这句",
      "不相干提议的内容不该被并进这一版");
    assert.deepEqual(superseded.pending?.profile?.personalityTags,
      personaFromDefaultPreset(getDefaultPersonaPreset()).personalityTags,
      "当前生效的是什么就用什么当底稿，不拿上一版未采用的排队当底稿");
    const history = await admin`SELECT revision, proposal_kind, proposal_id
                                FROM companion_persona_profile_versions WHERE user_id=${f.userId} ORDER BY revision`;
    assert.deepEqual(history.map(row => row.revision), [1, 2, 3]);
    assert.equal(history[1].proposal_id, runA);
    assert.equal(history[2].proposal_id, runB);

    // 后台反思的提案与前台工具的提案同样是两笔：不能因为都是 assistant 就并成一版。
    const reflected = await edit({ kind: "assistant_reflection", proposalId: reflectionId }, "speakingStyle", "少用语气词");
    assert.equal(reflected.kind, "changed");
    const afterReflection = await f.persona();
    assert.equal(afterReflection.pending?.proposalKind, "assistant_reflection");
    assert.equal(afterReflection.pending?.profile?.selfDescription, undefined,
      "反思那一版也不继承工具那一版没被采用的内容");

    // 用户自己排的草稿在排队时，她的任何提案都不许拿它当底稿（§9.3 第一行）。
    const draftBase = await f.persona();
    await withWorkspaceTransaction(scope, tx => stagePetProfileRevision(tx, scope,
      { ...(draftBase.profile ?? personaFromDefaultPreset(getDefaultPersonaPreset())),
        revision: draftBase.profileRevision },
      new Date(), { author: "user", reason: "用户自己排的草稿，还没点生效" }));
    assert.equal((await edit({ kind: "assistant_reflection", proposalId: randomUUID() },
      "speakingStyle", "抢占用户草稿")).kind, "conflict",
      "用户排在队里的草稿是一次进行中的决定，不是她的改稿底稿");
    assert.equal((await f.persona()).pending?.author, "user");
  } finally {
    await f.cleanup();
  }
});

test("入队门按段落挑人：够格才投一条，同一段不重复投", async () => {
  const f = await fixture();
  try {
    const first = await admin`SELECT public.astella_enqueue_companion_reflection() AS enqueued`;
    assert.equal(Number(first[0].enqueued), 1, "这段真的来回过，应当投一条回顾");
    const again = await admin`SELECT public.astella_enqueue_companion_reflection() AS enqueued`;
    assert.equal(Number(again[0].enqueued), 0, "同一段（同一幂等键）不重复投");
    const jobs = await admin`SELECT payload FROM jobs WHERE type='companion_reflection' AND workspace_id=${f.workspaceId}`;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].payload as { conversationId: string }).conversationId, f.conversationId);
  } finally {
    await f.cleanup();
  }
});
