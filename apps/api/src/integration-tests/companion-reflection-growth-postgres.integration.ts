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
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { MockProvider } from "../../../../workers/ai-worker/src/lib/providers/mock.ts";
import { loadCompanionRunDoctorV1 } from "../modules/companion-conversation/run-doctor.ts";
import { runCompanionReflectionJob, companionReflectionDedupeKey }
  from "../../../../workers/ai-worker/src/handlers/companion-reflection.ts";
import { applyAssistantPersonaEdit }
  from "../../../../workers/ai-worker/src/handlers/companion-persona-self-edit.ts";
import { retrievePlaybookViews }
  from "../../../../workers/ai-worker/src/handlers/companion-playbooks.ts";
import { createHash } from "node:crypto";
import { upsertAgentMethodCandidate, adoptPendingPersonaForNewTurn, pendingPersonaProposalSources,
  createAgentMethodStore } from "@astella/agent-host";
import { closeDatabase as closeWorkerDatabase, withWorkerWorkspaceTransaction }
  from "../../../../workers/ai-worker/src/db.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { getPetProfileState, stagePetProfileRevision, upsertPetProfile }
  from "../modules/companion-conversation/pet-profile-service.ts";
import { personaFromDefaultPreset } from "@astella/shared/pet-persona-merge";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import { createCompanionTurn } from "../modules/companion-conversation/turn/turn-service.ts";
import { correctMemory } from "../modules/companion-conversation/memory/memory-service.ts";

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
  retryReflection: () => Promise<void>;
  replaceLease: () => Promise<void>;
  readReflection: () => Promise<Record<string, unknown>[]>;
  readEdges: (relation: string) => Promise<Record<string, unknown>[]>;
  persona: () => Promise<Awaited<ReturnType<typeof getPetProfileState>>>;
  /** 回这一轮的 run id：§12.2 的诊断是按 run 读的。 */
  newTurn: (text: string) => Promise<string>;
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
  let lastJob: Parameters<typeof runCompanionReflectionJob>[0] | null = null;
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
      lastJob = {
        id: jobId, workspaceId, requestedBy: userId, leaseToken,
        payload: { userId, workspaceId, conversationId, fromSeq, toSeq },
      };
      await runCompanionReflectionJob(lastJob);
    },
    async retryReflection() {
      assert.ok(lastJob);
      await runCompanionReflectionJob(lastJob);
    },
    async replaceLease() {
      assert.ok(lastJob);
      const renewed = { ...lastJob, leaseToken: randomUUID() };
      await mutate(tx => tx`UPDATE jobs SET lease_token=${renewed.leaseToken} WHERE id=${renewed.id}`);
      lastJob = renewed;
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
      // 回给用例这一轮的 run：§12.2 的诊断是按 run 读的。
      return (result.body as { runId: string }).runId;
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

    // 读回边（§16 第 6 步在方法这一侧的落点）：那条候选要能在下一次相处里
    // 被她看见，而「可以照做」那本目录仍然不放它进去——两个集合各读各的。
    const scope = { workspaceId: f.workspaceId, userId: f.userId };
    // 一次取回，两个桶：这正是下一轮装配用的那一条读。
    const views = await withWorkerWorkspaceTransaction(scope, (tx) => retrievePlaybookViews(tx, scope));
    const candidates = views.candidates;
    assert.deepEqual(candidates.map((entry) => entry.title), ["招呼只接眼前这句"]);
    assert.equal(candidates[0].triggerCondition, "对方只说了一句招呼");
    assert.deepEqual(candidates[0].exceptions, ["对方点名要接着昨天那篇时照常接续"],
      "例外要一起读回来：刚提炼的经验最容易过度套用");
    assert.equal(candidates[0].epistemicStatus, "tentative");
    assert.equal(views.catalog.length, 0, "没核对的候选不得占「可以照做」那本目录");

    // §16 第 6 步的另一半：用户把候选取下来之后，下一轮读不回来；**迟到的反思也不能把它复活**。
    // 「取下来」在这里直接用 SQL 置 disabled（那是用户停用会落到的那一列），
    // 写的那一侧仍走真实的 `upsertAgentMethodCandidate`——它按设计遇到 disabled 就不并存。
    await admin`UPDATE companion_procedural_playbooks SET method_state = 'disabled' WHERE user_id = ${f.userId}`;
    const afterWithdraw = await withWorkerWorkspaceTransaction(scope,
      (tx) => retrievePlaybookViews(tx, scope));
    assert.equal(afterWithdraw.candidates.length, 0, "停用之后不该再读回来");
    // 同一个触发条件 → 反思那条路会算出的同一个 playbookKey（键由触发条件定型）。
    const sameKey = `reflection:${createHash("sha256").update("对方只说了一句招呼").digest("hex").slice(0, 24)}`;
    const lateReflection = await withWorkerWorkspaceTransaction(scope, (tx) =>
      upsertAgentMethodCandidate(tx, scope, {
        playbookKey: sameKey, title: "迟到的一次提炼", triggerCondition: "对方只说了一句招呼",
        steps: ["先接住这一句"], exceptions: [], evidence: [{ eventId: `message:${f.correctionMessageId}` }],
        epistemicStatus: "tentative", author: "maintenance",
      }));
    assert.equal(lateReflection, null, "用户说过「别再给我这条」，同条件的迟到提炼不该长出孪生候选");

    // 隔天：下一条被接受的新用户消息采用那一版；当前版本从此是第 1 版。
    const adoptedRunId = await f.newTurn("早");
    const adopted = await f.persona();
    assert.equal(adopted.profileRevision, 1);
    assert.equal(adopted.pending, null);
    assert.equal(adopted.profile?.selfDescription,
      "我容易一上来就把读过的东西数一遍，被说过一次，正在改。");

    // §12.2：诊断要能说出这一格——回顾成了、那一版已被这一轮采用、没有东西还在排队。
    const doctor = await withWorkspaceTransaction({ workspaceId: f.workspaceId, userId: f.userId },
      (tx) => loadCompanionRunDoctorV1(tx, { workspaceId: f.workspaceId, userId: f.userId }, adoptedRunId));
    assert.ok(doctor, "刚接受的回合应当能读出诊断");
    assert.equal(doctor.growth?.reflection?.decision, "committed");
    assert.equal(doctor.growth?.reflection?.pendingPersonaRevision, 1);
    assert.equal(doctor.growth?.persona?.currentRevision, 1);
    assert.equal(doctor.growth?.persona?.pendingRevision, null,
      "已采用就不该再有排队的版本");
    // 钉版本发生在 worker 真正跑这一轮的时候（0341/0356 那条锁），这里没有跑它：
    // 那一格必须是 null，而不是替这一轮编一个"已经用上了"。
    assert.equal(doctor.growth?.persona?.pinnedThisRun, null);
    assert.equal(doctor.findings.some((finding) => finding.code === "growth_staged_not_adopted"), false,
      "排队已经清了还报「在排队」，就是把诊断写成了装饰");
    // 这一轮还没被 worker 跑过，装配回执不存在：那一格必须是 null，而不是「都带上了」。
    assert.equal(doctor.growth?.context, null);
    assert.match(doctor.markdown, /## 成长闭环/);
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

test("来源在模型等待中换版：旧判断与人格均不提交", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({
    judgments: [{ text: "招呼不要数笔记", epistemicStatus: "tentative", sourceMessageIds: [f.correctionMessageId] }],
  }, async () => {
    await admin`UPDATE companion_messages SET content_sha256=${"1".repeat(64)},
      blocks=${admin.json([{ type: "text", text: "这次可以盘点" }])} WHERE id=${f.correctionMessageId}`;
  });
  try {
    await f.runReflection();
    assert.equal((await f.readReflection())[0].decision, "source_invalid");
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length, 0);
  } finally { restore(); await f.cleanup(); }
});

test("等待中用户暂存人格草稿：整个反思不写半份经验", async () => {
  const f = await fixture();
  const scope = { workspaceId: f.workspaceId, userId: f.userId };
  const restore = reflectionModelFixture({
    judgments: [{ text: "招呼不要数笔记", epistemicStatus: "tentative", sourceMessageIds: [f.correctionMessageId] }],
    persona: { selfDescription: "我正在改盘点笔记的习惯。", reason: "对方明确纠正过", sourceMessageIds: [f.correctionMessageId] },
  }, async () => {
    await withWorkspaceTransaction(scope, tx => stagePetProfileRevision(tx, scope,
      { ...personaFromDefaultPreset(getDefaultPersonaPreset()), revision: 0 }, new Date(), { author: "user" }));
  });
  try {
    await f.runReflection();
    assert.equal((await f.readReflection())[0].decision, "commit_conflict");
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length, 0,
      "人格冲突不能留下未记产出关系的判断");
    assert.equal((await f.persona()).pending?.author, "user");
  } finally { restore(); await f.cleanup(); }
});

test("终态保存失败：副作用一并回滚；同一 job 从检查点恢复不再调用模型", async () => {
  const f = await fixture();
  let calls = 0;
  const restore = reflectionModelFixture({
    judgments: [{ text: "招呼不要数笔记", epistemicStatus: "tentative", sourceMessageIds: [f.correctionMessageId] }],
  }, () => { calls += 1; });
  try {
    await admin.unsafe(`CREATE FUNCTION plan50_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id = '${f.userId}'::uuid AND NEW.decision = 'committed' THEN
        RAISE EXCEPTION 'injected finalize failure'; END IF; RETURN NEW; END $$`);
    await admin`CREATE TRIGGER plan50_fail_finalize BEFORE UPDATE ON companion_reflections
      FOR EACH ROW EXECUTE FUNCTION plan50_fail_finalize()`;
    await assert.rejects(f.runReflection(), error =>
      String((error as Error & { cause?: Error }).cause?.message).includes("injected finalize failure"));
    await admin`DROP TRIGGER plan50_fail_finalize ON companion_reflections`;
    await admin`DROP FUNCTION plan50_fail_finalize()`;
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length, 0,
      "结论没保存，判断也应回滚");
    // 新消息到达也不改变已冻结输入和检查点的身份。
    await admin`INSERT INTO assistant_memory_items(workspace_id,user_id,kind,content,scope,source_type)
      VALUES(${f.workspaceId},${f.userId},'preference','之后新增的条目','workspace','model_inferred')`;
    await f.retryReflection();
    assert.equal(calls, 1, "恢复应读原输入检查点");
    assert.equal((await f.readReflection())[0].decision, "committed");
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId} AND kind='judgment'`).length, 1);
  } finally {
    await admin`DROP TRIGGER IF EXISTS plan50_fail_finalize ON companion_reflections`;
    await admin`DROP FUNCTION IF EXISTS plan50_fail_finalize()`;
    restore(); await f.cleanup();
  }
});

test("人格采用只核自己的依据：另一条判断的原话不能代替被删掉的纠正", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({
    judgments: [{ text: "眼前这句招呼无需安排", epistemicStatus: "tentative", sourceMessageIds: [f.messageIds[0]] }],
    persona: { selfDescription: "我正在改盘点笔记的习惯。", reason: "对方明确纠正过", sourceMessageIds: [f.correctionMessageId] },
  });
  try {
    await f.runReflection();
    await f.deleteMessage(f.correctionMessageId);
    await f.newTurn("早");
    assert.equal((await f.persona()).profileRevision, 0);
    assert.equal((await f.persona()).pending, null);
  } finally { restore(); await f.cleanup(); }
});

test("账号世代在模型等待中撤销：迟到反思不能提交", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({
    judgments: [{ text: "招呼不要数笔记", epistemicStatus: "tentative", sourceMessageIds: [f.correctionMessageId] }],
  }, async () => { await admin`UPDATE user_companion_account_state SET epoch=epoch+1 WHERE user_id=${f.userId}`; });
  try {
    await f.runReflection();
    assert.equal((await f.readReflection())[0].decision, "governance_denied");
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length, 0);
  } finally { restore(); await f.cleanup(); }
});

test("来源采用后删除：只恢复自动字段，保留用户新设置和未生效草稿", async () => {
  const f = await fixture();
  const scope = { workspaceId: f.workspaceId, userId: f.userId };
  const restore = reflectionModelFixture({ persona: { selfDescription: "我正在改盘点笔记的习惯。",
    reason: "对方明确纠正过", sourceMessageIds: [f.correctionMessageId] } });
  try {
    await f.runReflection();
    await f.newTurn("早");
    const adopted = await f.persona();
    await withWorkspaceTransaction(scope, tx => upsertPetProfile(tx,scope,{
      ...adopted.profile!, name: "用户新名字", revision: adopted.profileRevision,
    }));
    const changed = await f.persona();
    await withWorkspaceTransaction(scope, tx => stagePetProfileRevision(tx,scope,{
      ...changed.profile!, name: "尚未生效的名字", revision: changed.profileRevision,
    },new Date(),{ author: "user" }));
    await f.deleteMessage(f.correctionMessageId);
    await f.newTurn("早");
    const after = await f.persona();
    assert.equal(after.profile?.selfDescription, undefined);
    assert.equal(after.profile?.name, "用户新名字");
    assert.equal(after.pending?.author, "user");
    assert.equal(after.pending?.profile?.name, "尚未生效的名字");
    assert.equal(after.pending?.profile?.selfDescription, undefined,"用户草稿不能复活继承的失效自动字段");
    assert.equal((await f.readReflection())[0].decision, "source_invalid");
    await f.retryReflection();
    assert.equal((await f.persona()).profileRevision, after.profileRevision, "旧任务不恢复已撤回字段");
  } finally { restore(); await f.cleanup(); }
});

test("失效 pending 清掉后版本号不复用，用户仍能正常编辑", async () => {
  const f = await fixture();
  const scope = { workspaceId: f.workspaceId, userId: f.userId };
  const restore = reflectionModelFixture({ persona: { selfDescription: "我正在改盘点笔记的习惯。",
    reason: "对方明确纠正过", sourceMessageIds: [f.correctionMessageId] } });
  try {
    await f.runReflection();
    await f.deleteMessage(f.correctionMessageId);
    await f.newTurn("早");
    await withWorkspaceTransaction(scope,tx=>upsertPetProfile(tx,scope,{
      ...personaFromDefaultPreset(getDefaultPersonaPreset()), name:"用户新名字", revision:0,
    }));
    assert.equal((await f.persona()).profileRevision, 2);
  } finally { restore(); await f.cleanup(); }
});

test("旧反思缺少新增元数据时仍恢复已采用字段，并保留合法表达风格", async () => {
  const f = await fixture();
  const initial = personaFromDefaultPreset(getDefaultPersonaPreset());
  const restore = reflectionModelFixture({ persona:{ selfDescription:"我正在改盘点笔记的习惯。",speakingStyle:"先简单回应招呼",
    reason:"对方明确纠正过",sourceMessageIds:[f.correctionMessageId] } });
  try {
    await f.runReflection();
    await f.newTurn("早");
    await admin`UPDATE companion_reflections SET result_ref='{}' WHERE user_id=${f.userId}`;
    await f.deleteMessage(f.correctionMessageId);
    await f.newTurn("早");
    const after = await f.persona();
    assert.equal(after.profile?.speakingStyle,initial.speakingStyle);
    assert.equal(after.profile?.selfDescription,undefined);
    assert.equal((await f.readReflection())[0].decision,"source_invalid");
  } finally { restore(); await f.cleanup(); }
});

test("连续两版依赖同一失效来源时，一次新回合完成逐层撤回", async () => {
  const f = await fixture();
  let restore = reflectionModelFixture({ persona:{ selfDescription:"第一版自动描述",reason:"对方明确纠正过",
    sourceMessageIds:[f.correctionMessageId] } });
  try {
    await f.runReflection();
    await f.newTurn("早");
    await admin`UPDATE companion_reflections SET created_at=now()-interval '25 hours' WHERE user_id=${f.userId}`;
    await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256)
      VALUES(${randomUUID()},${f.workspaceId},${f.userId},${f.conversationId},'assistant',8,'text',
        ${admin.json([{ type:"text",text:"早。" }])},${HASH})`;
    await admin`UPDATE companion_conversations SET next_message_seq=9 WHERE id=${f.conversationId}`;
    restore();
    restore = reflectionModelFixture({ persona:{ selfDescription:"第二版自动描述",reason:"继续调整表达",
      sourceMessageIds:[f.correctionMessageId] } });
    await f.runReflection({ fromSeq:0,toSeq:8 });
    await f.newTurn("再打个招呼");
    assert.equal((await f.persona()).profile?.selfDescription,"第二版自动描述");
    await f.deleteMessage(f.correctionMessageId);
    await f.newTurn("早");
    assert.equal((await f.persona()).profile?.selfDescription,undefined);
    assert.ok((await f.readReflection()).every(r=>r.decision==="source_invalid"));
  } finally { restore(); await f.cleanup(); }
});

test("另一空间的新回合采用账号人格只查来源有效性，不泄漏原文", async () => {
  const f = await fixture();
  const secondSpace = randomUUID();
  const restore = reflectionModelFixture({ persona: { selfDescription: "我正在改盘点笔记的习惯。",
    reason: "对方明确纠正过", sourceMessageIds: [f.correctionMessageId] } });
  try {
    await admin`INSERT INTO workspaces(id,name,owner_id) VALUES(${secondSpace},'第二空间',${f.userId})`;
    await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${secondSpace},${f.userId},'owner')`;
    await f.runReflection();
    const scope = { workspaceId: secondSpace, userId:f.userId };
    const adopted = await withWorkspaceTransaction(scope,tx=>adoptPendingPersonaForNewTurn(tx,f.userId,
      p=>pendingPersonaProposalSources(tx,f.userId,p)));
    assert.deepEqual(adopted,{ kind:"adopted",revision:1 });
  } finally {
    restore(); await admin`DELETE FROM workspace_members WHERE workspace_id=${secondSpace}`;
    await admin`DELETE FROM workspaces WHERE id=${secondSpace}`; await f.cleanup();
  }
});

test("角色初始化后受限 worker 仍有调度权限", async () => {
  const f = await fixture();
  try {
    await withWorkerWorkspaceTransaction({ workspaceId:f.workspaceId,userId:f.userId },async tx=>{
      await tx.execute(sql`SELECT astella_enqueue_companion_reflection()`);
    });
    assert.equal((await admin`SELECT id FROM jobs WHERE type='companion_reflection' AND workspace_id=${f.workspaceId}`).length,1);
  } finally { await f.cleanup(); }
});

test("调度按真实待处理 jobs 限制账号积压，同一会话不排重叠水位", async () => {
  const f = await fixture();
  const conversations = [randomUUID(),randomUUID(),randomUUID()];
  const scope = { workspaceId:f.workspaceId,userId:f.userId };
  const schedule = () => withWorkerWorkspaceTransaction(scope,tx=>tx.execute(sql`SELECT astella_enqueue_companion_reflection()`));
  try {
    for (const id of conversations) {
      await admin`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
        VALUES(${id},${f.workspaceId},${f.userId},'dialogue','另一段交流','system','active')`;
      await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256)
        SELECT gen_random_uuid(),workspace_id,user_id,${id},role,seq,kind,blocks,content_sha256
        FROM companion_messages WHERE conversation_id=${f.conversationId}`;
    }
    await Promise.all([schedule(),schedule()]);
    const jobs = await admin`SELECT id,payload FROM jobs WHERE type='companion_reflection' AND requested_by=${f.userId}`;
    assert.equal(jobs.length,3,"未被 worker 读取的排队任务也占账号积压名额");
    assert.equal(new Set(jobs.map(j=>j.payload.conversationId)).size,3);
    for (const job of jobs) {
      await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256)
        VALUES(${randomUUID()},${f.workspaceId},${f.userId},${job.payload.conversationId},'assistant',7,'text',
          ${admin.json([{ type:"text",text:"后续补充。" }])},${HASH})`;
    }
    await admin`UPDATE jobs SET status='succeeded' WHERE id=${jobs[0].id}`;
    await schedule();
    const active = await admin`SELECT payload FROM jobs WHERE requested_by=${f.userId} AND status IN ('pending','running')`;
    assert.equal(active.length,3);
    assert.equal(new Set(active.map(j=>j.payload.conversationId)).size,3,"同一会话排队时不重复收新水位");
  } finally {
    await admin`DELETE FROM companion_messages WHERE conversation_id IN ${admin(conversations)}`;
    await admin`DELETE FROM companion_conversations WHERE id IN ${admin(conversations)}`;
    await f.cleanup();
  }
});

test("来源改写后自动判断与方法不再读回，并清除检查点正文", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({
    judgments:[{ text:"招呼不要数笔记",epistemicStatus:"tentative",sourceMessageIds:[f.correctionMessageId] }],
    experiences:[{ title:"先接眼前招呼",triggerCondition:"只是招呼",steps:["不盘点笔记"],exceptions:[],
      sourceMessageIds:[f.correctionMessageId] }],
  });
  try {
    await f.runReflection();
    await admin`UPDATE companion_messages SET content_sha256=${"2".repeat(64)},
      blocks=${admin.json([{ type:"text",text:"招呼时可以接昨天笔记" }])} WHERE id=${f.correctionMessageId}`;
    const scope = { workspaceId:f.workspaceId,userId:f.userId };
    const views = await withWorkerWorkspaceTransaction(scope,tx=>retrievePlaybookViews(tx,scope));
    assert.equal(views.candidates.length,0);
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId} AND deleted_at IS NULL`).length,0);
    assert.equal((await admin`SELECT job_id FROM companion_reflection_checkpoints WHERE user_id=${f.userId}`).length,0);
  } finally { restore(); await f.cleanup(); }
});

test("迟到模型回调不能终结新租约的反思，重试仍可正常完成", async () => {
  const f = await fixture();
  let calls = 0;
  const restore = reflectionModelFixture({ judgments:[{ text:"招呼不要数笔记",epistemicStatus:"tentative",
    sourceMessageIds:[f.correctionMessageId] }] },async()=>{
    calls += 1;
    if (calls===1) await f.replaceLease();
  });
  try {
    await f.runReflection();
    assert.equal((await f.readReflection())[0].decision,"running");
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length,0);
    await f.retryReflection();
    assert.equal((await f.readReflection())[0].decision,"committed");
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length,1);
  } finally { restore(); await f.cleanup(); }
});

test("重试耗尽的反思释放账号门槛并清除冻结输入", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({ judgments:[{ text:"招呼不要数笔记",epistemicStatus:"tentative",
    sourceMessageIds:[f.correctionMessageId] }] },()=>f.replaceLease());
  try {
    await f.runReflection();
    assert.equal((await f.readReflection())[0].decision,"running");
    await admin`UPDATE jobs SET status='dead' WHERE workspace_id=${f.workspaceId} AND type='companion_reflection'`;
    const [after] = await admin`SELECT decision,input_snapshot FROM companion_reflections WHERE user_id=${f.userId}`;
    assert.equal(after.decision,"lease_lost");
    assert.equal(after.input_snapshot,null);
    assert.equal((await admin`SELECT job_id FROM companion_reflection_checkpoints WHERE user_id=${f.userId}`).length,0);
  } finally { restore(); await f.cleanup(); }
});

test("来源清除保留用户亲自修订的判断与方法", async () => {
  const f = await fixture();
  const scope = { workspaceId:f.workspaceId,userId:f.userId };
  const restore = reflectionModelFixture({
    judgments:[{ text:"招呼不要数笔记",epistemicStatus:"tentative",sourceMessageIds:[f.correctionMessageId] }],
    experiences:[{ title:"先接眼前招呼",triggerCondition:"只是招呼",steps:["不盘点笔记"],exceptions:[],
      sourceMessageIds:[f.correctionMessageId] }],
  });
  try {
    await f.runReflection();
    const [memory] = await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`;
    const [method] = await admin`SELECT id FROM companion_procedural_playbooks WHERE user_id=${f.userId}`;
    await withWorkspaceTransaction(scope,tx=>correctMemory(tx,scope,memory.id,{
      content:"用户重新确认的判断",expectedRevision:1,
    }));
    const methods = createAgentMethodStore({ transaction:withWorkspaceTransaction,id:randomUUID });
    await methods.revise(scope,method.id,{ expectedRevision:1,title:"用户改过的方法",appliesWhen:"用户确认的适用范围",
      steps:["先问用户"],exceptions:[],reason:"用户自行调整" });
    await f.deleteMessage(f.correctionMessageId);
    const [afterMemory] = await admin`SELECT content,deleted_at,user_stated,author_type FROM assistant_memory_items WHERE id=${memory.id}`;
    const [afterMethod] = await admin`SELECT title,epistemic_status,user_controlled FROM companion_procedural_playbooks WHERE id=${method.id}`;
    assert.equal(afterMemory.content,"用户重新确认的判断");
    assert.equal(afterMemory.deleted_at,null);
    assert.equal(afterMemory.user_stated,false);
    assert.equal(afterMemory.author_type,"user");
    assert.equal(afterMethod.title,"用户改过的方法");
    assert.equal(afterMethod.user_controlled,true);
    assert.equal(afterMethod.epistemic_status,"tentative");
  } finally { restore(); await f.cleanup(); }
});

test("模型等待中清除来源后，迟到响应不重建检查点或冻结正文", async () => {
  const f = await fixture();
  const restore = reflectionModelFixture({ judgments:[{ text:"招呼不要数笔记",epistemicStatus:"tentative",
    sourceMessageIds:[f.correctionMessageId] }] },()=>f.deleteMessage(f.correctionMessageId));
  try {
    await f.runReflection();
    const [row] = await admin`SELECT decision,input_snapshot FROM companion_reflections WHERE user_id=${f.userId}`;
    assert.equal(row.decision,"source_invalid");
    assert.equal(row.input_snapshot,null);
    assert.equal((await admin`SELECT job_id FROM companion_reflection_checkpoints WHERE user_id=${f.userId}`).length,0);
    assert.equal((await admin`SELECT id FROM assistant_memory_items WHERE user_id=${f.userId}`).length,0);
  } finally { restore(); await f.cleanup(); }
});

test("并发 worker 只领取同账号一个反思，其他账号不受阻塞，完成后再领取下一空间", async () => {
  const f = await fixture(), other = await fixture();
  const secondSpace = randomUUID();
  try {
    await admin`INSERT INTO workspaces(id,name,owner_id) VALUES(${secondSpace},'第二反思空间',${f.userId})`;
    await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${secondSpace},${f.userId},'owner')`;
    const ids = [randomUUID(),randomUUID(),randomUUID()];
    for (const [i,id] of ids.entries()) {
      await admin`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,resource_class,scheduled_at)
        VALUES(${id},'companion_reflection',${i===1 ? secondSpace : i===2 ? other.workspaceId : f.workspaceId},
          ${i===2 ? other.userId : f.userId},'{}','pending','maintenance',now()+${i}*interval '1 millisecond'-interval '1 second')`;
    }
    const claim = () => withWorkerWorkspaceTransaction({ workspaceId:f.workspaceId,userId:f.userId },async tx=>
      tx.execute<{ id:string; requested_by:string }>(sql`SELECT * FROM astella_claim_jobs(8,8,3)`));
    const groups = await Promise.all([claim(),claim()]);
    const claimed = groups.flat();
    assert.equal(claimed.length,2);
    assert.equal(claimed.filter(j=>j.requested_by===f.userId).length,1);
    assert.equal(claimed.filter(j=>j.requested_by===other.userId).length,1);
    assert.ok(claimed.some(j=>j.id===ids[0]),"同账号先领取最早水位");
    await admin`UPDATE jobs SET status='succeeded',lease_token=NULL WHERE id=${ids[0]}`;
    assert.deepEqual((await claim()).map(j=>j.id),[ids[1]]);
  } finally {
    await admin`DELETE FROM jobs WHERE workspace_id=${secondSpace}`;
    await admin`DELETE FROM workspace_members WHERE workspace_id=${secondSpace}`;
    await admin`DELETE FROM workspaces WHERE id=${secondSpace}`;
    await f.cleanup(); await other.cleanup();
  }
});

test("用户亲自固定的表达不被后台人格建议覆盖", async () => {
  const f = await fixture();
  const scope = { workspaceId:f.workspaceId,userId:f.userId };
  const restore = reflectionModelFixture({ persona:{ selfDescription:"后台不该覆盖的描述",speakingStyle:"后台不该覆盖的风格",
    reason:"一次建议",sourceMessageIds:[f.correctionMessageId] } });
  try {
    await withWorkspaceTransaction(scope,tx=>upsertPetProfile(tx,scope,{
      ...personaFromDefaultPreset(getDefaultPersonaPreset()), revision:0,
      speakingStyle:"用户固定风格",selfDescription:"用户固定描述",
      fieldOrigin:{ speakingStyle:"user",selfDescription:"user" },
    }));
    await f.runReflection();
    assert.equal((await f.persona()).pending,null);
    assert.equal((await f.persona()).profile?.speakingStyle,"用户固定风格");
    assert.equal((await f.readReflection())[0].decision,"no_change");
  } finally { restore(); await f.cleanup(); }
});
