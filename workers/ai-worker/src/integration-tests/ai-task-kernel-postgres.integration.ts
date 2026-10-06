/**
 * 公共任务运行内核接**真租约**的集测（D5 §4.1 / 39d W3-1）。
 *
 * 单元那一层已经证明了外壳的判据（什么时候重跑、什么时候不许提交）。这一份要证的只有一件事：
 * **那道"旧尝试不许提交"的门不是测试自己造的**——它接的是产品里本来就在用的
 * `jobs.lease_token` 与 `lockJobLease`／`isJobLeaseActive`，在一个真的受限角色事务里。
 *
 * 所以这里的夹具形状全部照生产：
 *   - 写夹具用超级用户（`DATABASE_URL`，BYPASSRLS）；
 *   - 被测那三段各自 `withWorkerWorkspaceTransaction`（`astella_worker`，受限角色）；
 *   - 模型调用用 mock provider（**不花钱**；真模型那一手属每波末尾那一批）。
 *
 * 事务边界本身的实测（"外部等待期间不持行锁"）是 W3-2 的判据，这里刻意不做——
 * 那份证据要注入慢模型并看 `pg_stat_activity`，不该由一个 mock 冒充。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// `tx.execute(...)` 里的 tx 是 drizzle 的，要的是 drizzle 的 sql 标签；
// 这个文件顶层那条 `sql` 是 postgres.js 的**连接**（夹具用），两者同名会撞成
// `query.getSQL is not a function`——所以这里显式起个别名。
import { sql as drizzleSql } from "drizzle-orm";
// 类型是编译期擦掉的，所以静态 import 不会破坏"连接串在 `../db.ts` 加载时求值"那件事；
// 值一律走下面的动态 import。（esbuild 不接受动态 import 的解构里带内联 `type`。）
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { AiTaskDefinition } from "@astella/shared/ai-task-kernel";
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import type { JobLeaseContext } from "../lib/job-lease.ts";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const ADMIN_CONN = testDatabaseUrl("DATABASE_URL");
process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");

const sql = postgres(ADMIN_CONN, { max: 2 });

const { runAiTask } = await import("@astella/shared/ai-task-kernel");
const {
  withWorkerWorkspaceTransaction,
  closeDatabase,
  currentWorkerWorkspaceTransaction,
  resolveWorkerStatementTimeoutMs,
  resolveWorkerLockTimeoutMs,
  resolveWorkerIdleInTransactionTimeoutMs,
} = await import("../db.ts");
const { isJobLeaseActive, lockJobLease } = await import("../lib/job-lease.ts");
const { createProvider } = await import("../lib/ai-provider.ts");
const { MockProvider } = await import("../lib/providers/mock.ts");

const workspaceId = randomUUID();
const ownerId = randomUUID();

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await tx`DELETE FROM users WHERE id = ${ownerId}`;
  });
  await closeDatabase().catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

await sql.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, display_name)
           VALUES (${ownerId}, ${`kernel-it-${ownerId.slice(0, 8)}@example.test`}, ${"x"}, ${"内核集测"})`;
  await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${ownerId}, ${"内核集测空间"})`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES (${workspaceId}, ${ownerId}, 'owner')`;
});

/**
 * 造一条真实的 `jobs` 行并返回它。`leaseToken` 就是产品的租约令牌本身，
 * 不是测试编的字符串——换掉它等于 reaper 把这条 job 重领了一次。
 */
interface SeededJob extends JobLeaseContext {
  /** 业务落点：worker **可以**往里写的表（`companion_messages`），会话行由超级用户夹具种。 */
  conversationId: string;
}

async function seedJob(leaseToken: string): Promise<SeededJob> {
  const id = randomUUID();
  const conversationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`
      INSERT INTO jobs (id, type, workspace_id, payload, status, attempts, lease_token,
                        requested_by, priority, resource_class, idempotency_key, started_at)
      VALUES (${id}, 'ai_task_kernel_it', ${workspaceId}, ${tx.json({})}::jsonb, 'running', 1,
              ${leaseToken}, ${ownerId}, 100, 'interactive_ai', ${`idem-${id}`}, now())
    `;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status, next_message_seq, next_event_seq, next_generation)
             VALUES (${conversationId}, ${workspaceId}, ${ownerId}, 'dialogue', '内核集测会话', 'placeholder', 'active', 1, 1, 1)`;
  });
  return { id, workspaceId, requestedBy: ownerId, leaseToken, conversationId };
}

/** 一次运行的三段各自开了独立事务、顺序如何——用它断言"模型调用不在任何事务里"。 */
interface Trace {
  phases: string[];
  committedTitles: string[];
  transactionDurationsMs?: number[];
}

function buildDefinition(job: SeededJob, trace: Trace, titleTag: string): AiTaskDefinition<string, string> {
  const provider = new MockProvider();
  return {
    id: "kernel-it-task",
    version: 1,
    mode: "structured",
    resourceClass: "interactive_ai",
    budget: { maxModelCalls: 4, stepTimeoutMs: 2_000, taskDeadlineMs: 8_000, maxAutoRetries: 1 },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: provider.modelId, promptVersion: "it-v1", resourceClass: "interactive_ai" },
    // 短事务准备
    prepare: async () => {
      trace.phases.push("prepare");
      const startedAt = performance.now();
      const input = await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
        const rows = await tx.execute<{ id: string }>(drizzleSql`SELECT id FROM jobs WHERE id = ${job.id}`);
        return rows.length > 0 ? "input" : "missing";
      });
      trace.transactionDurationsMs?.push(performance.now() - startedAt);
      return input;
    },
    // 事务外执行：这里**没有** tx 可拿（D5 §5.2 第一件是类型，不是纪律）
    execute: async (input) => {
      trace.phases.push("execute");
      const answer = await provider.chatCompletion(
        [{ role: "user", content: `生成一个标题：${input}` }],
        { maxTokens: 64, temperature: 0 },
      );
      return { ok: true as const, output: `${titleTag}|${answer.content.slice(0, 40)}`, promptTokens: 3, completionTokens: 2 };
    },
    // 短事务保存：租约核对与业务写入在同一个事务里（D5 §3：每个检查点、结果与下一步投递同事务形成）
    commit: async (_ctx, attemptToken, output) => {
      trace.phases.push("commit");
      // 提交的租约身份**就是尝试令牌**——生产里两者是同一条 `jobs` 行的同一列，
      // 分成两个来源就会出现"核对放过、写入拒收"这种自相矛盾的闸。
      const live: JobLeaseContext = { ...job, leaseToken: attemptToken.leaseToken };
      const startedAt = performance.now();
      await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
        await lockJobLease(tx, live);
        // blocks 走 `JSON.stringify(...)::jsonb`：文本参数再显式 cast 才是 JSON 对象，
        // 直接丢 JS 对象会被驱动当成 Postgres 数组或双重编码成字符串标量。
        await tx.execute(drizzleSql`
          INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256)
          VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, ${job.conversationId}, 1, 'assistant', 'text',
                  ${JSON.stringify([{ type: "text", text: output }])}::jsonb, ${"0".repeat(64)})
        `);
      });
      trace.transactionDurationsMs?.push(performance.now() - startedAt);
      trace.committedTitles.push(output);
      return {
        outcome: "committed" as const, output,
        usage: { modelCalls: 1, promptTokens: 3, completionTokens: 2, elapsedMs: 0, autoRetriesUsed: 0 },
        failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 1,
      };
    },
  };
}

const context = () => ({
  workspaceId,
  userId: ownerId,
  inputSnapshotRef: { kind: "task" as const, id: workspaceId, hash: "sha-kernel-it" },
  permissionLevel: "guided",
});
const attemptFor = (job: JobLeaseContext) => ({
  taskId: "kernel-it-task",
  taskVersion: 1,
  attemptId: randomUUID(),
  leaseToken: job.leaseToken,
  idempotencyKey: `idem-${job.id}`,
  workspaceId,
  userId: ownerId,
});

test("接真租约跑通一段：prepare→execute→commit 各自一个事务，业务行落在库里", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  const receipt = await runAiTask(buildDefinition(job, trace, "ok"), {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(receipt.outcome, "committed", `没跑通：${JSON.stringify(receipt.failure)}`);
  assert.deepEqual(trace.phases, ["prepare", "execute", "commit"], "三段该各自独立，中间不该嵌在一个事务里");
  const rows = await sql`SELECT blocks FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows[0].blocks), /ok\|/, "落库的正文该是模型那一步产出的内容");
  assert.equal(receipt.usage.modelCalls, 1);
});

test("W3-2 bounded transaction baseline: prepare/commit phase durations", async () => {
  const durations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
    const trace: Trace = { phases: [], committedTitles: [], transactionDurationsMs: durations };
    const receipt = await runAiTask(buildDefinition(job, trace, `baseline-${index}`), {
      ctx: context(),
      attempt: attemptFor(job),
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
    });
    assert.equal(receipt.outcome, "committed", `第 ${index + 1} 个短事务样本失败`);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const quantile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  assert.equal(sorted.length, 40, "每个样本应测到 prepare 与 commit 两个事务");
  const result = {
    n: sorted.length,
    p50Ms: Math.round(quantile(0.5) * 100) / 100,
    p95Ms: Math.round(quantile(0.95) * 100) / 100,
    maxMs: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
  };
  assert.ok(result.maxMs < 5_000, `短事务基线超过 5 秒复核门：${JSON.stringify(result)}`);
  console.log(`W3-2 bounded transaction baseline: ${JSON.stringify(result)}`);
});

test("W3-2 worker DB session has statement, lock, and idle-transaction backstops", async () => {
  const rows = await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, (tx) =>
    tx.execute<{ name: string; setting: string }>(drizzleSql`
      SELECT name, setting FROM pg_settings
      WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')
    `));
  const settings = Object.fromEntries(rows.map((row) => [row.name, Number(row.setting)]));
  assert.equal(settings.statement_timeout, resolveWorkerStatementTimeoutMs());
  assert.equal(settings.lock_timeout, resolveWorkerLockTimeoutMs());
  assert.equal(settings.idle_in_transaction_session_timeout, resolveWorkerIdleInTransactionTimeoutMs());
  assert.equal(settings.lock_timeout, 5_000, "默认锁等待上界应来自已测量的 5 秒策略");
  assert.equal(settings.idle_in_transaction_session_timeout, 15_000, "默认事务空等上界应来自已测量的 15 秒策略");
  console.log(`W3-2 worker DB backstops: ${JSON.stringify(settings)}`);
});

test("reaper 重领之后，旧令牌的晚到结果提交不出去（真 `jobs` 行说的，不是测试说的）", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const before = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "stale");
  // 结果拿到的那一刻租约被换掉——D5 §4.3 的"worker 租约过期、旧结果晚到"那一行。
  const originalExecute = definition.execute;
  definition.execute = async (input, env) => {
    await sql`UPDATE jobs SET lease_token = ${"lease-taken-by-reaper"} WHERE id = ${job.id}`;
    return originalExecute(input, env);
  };
  const receipt = await runAiTask(definition, {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "lease_lost", `该拒收的是租约这一格，实际是 ${JSON.stringify(receipt.failure)}`);
  assert.equal(trace.committedTitles.length, 0);
  assert.ok(!trace.phases.includes("commit"), "提交段根本不该开始");
  // 钱已经花过：结果留在回执里，调用方可以选择"这一份丢弃、按新尝试重投"，
  // 但**不许**写进业务表（那会把旧数据盖到新尝试的轮次上）。
  assert.ok(receipt.preservedValidResult);
  const after = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(after[0].n, before[0].n, "旧尝试往业务表写了一行");
});

test("第二道闸独立成立：没有 verifyAttempt 时，提交事务里的行锁照样拒收", async () => {
  // 上面那道是内核层的"提交前核对"。这一条要证明**它不是唯一的闸**：忘了接
  // `verifyAttempt` 的调用方，仍会被 `lockJobLease` 挡在业务事务里——
  // 两道闸一道是外壳给的，一道是库里本来就在的。
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const before = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "double-fence");
  const originalExecute = definition.execute;
  definition.execute = async (input, env) => {
    await sql`UPDATE jobs SET lease_token = ${"lease-taken-by-reaper-2"} WHERE id = ${job.id}`;
    return originalExecute(input, env);
  };
  const receipt = await runAiTask(definition, { ctx: context(), attempt: attemptFor(job), currentActiveTransaction: currentWorkerWorkspaceTransaction });
  assert.equal(trace.phases.includes("commit"), true, "这一条走的就是'核对没接上、提交段开始了'的形状");
  assert.equal(receipt.outcome, "failed");
  assert.equal(trace.committedTitles.length, 0);
  const after = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(after[0].n, before[0].n, "行锁那道闸没挡住旧尝试");
});

test("取消落在提交之前：库里一行都不留", async () => {
  // 与上面两条对着读：取消与旧租约**结果一样**（都不提交），但类别不一样——
  // 用户按的是停止，不是"这一步没做好"，所以它既不重试也不算失败重跑。
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const controller = new AbortController();
  const before = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "cancel");
  definition.execute = async () => {
    controller.abort();
    return { ok: true as const, output: "不该被提交", promptTokens: 0, completionTokens: 0 };
  };
  const receipt = await runAiTask(definition, {
    ctx: { ...context(), signal: controller.signal },
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(trace.committedTitles.length, 0);
  const after = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(after[0].n, before[0].n, "取消之后仍然写了业务行");
});

test("真实模型慢调用期间不持业务事务与行锁（W3-2，需 REAL_MODEL_BATCH=1）", {
  skip: process.env.REAL_MODEL_BATCH === "1" ? false : "真实 provider＋隔离 PostgreSQL；每波专项真跑才开启",
}, async () => {
  const platform = resolveSystemPlatform("agent_turn");
  assert.ok(platform, "agent_turn provider 没有配置");
  const provider = createProvider(platform.type, {
    apiKey: platform.apiKey,
    baseUrl: platform.baseUrl,
    model: platform.model,
    modelProfile: platform.modelProfile,
    options: platform.options,
  });
  assert.ok(provider.executeAgentTurn, "配置的 provider 没有 executeAgentTurn");

  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = {
    ...buildDefinition(job, trace, "real-model"),
    id: "kernel-real-model-lock-probe",
    usageContext: {
      modelId: provider.modelId,
      promptVersion: "w3-2-real-model-lock-probe-v1",
      resourceClass: "interactive_ai",
    },
    budget: {
      maxModelCalls: 1,
      stepTimeoutMs: 100_000,
      taskDeadlineMs: 110_000,
      maxAutoRetries: 0,
    },
  };
  const request: AgentTurnRequest = {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: "你正在进行一个合成的性能探针。严格按用户要求生成长篇中文说明，不要询问问题。",
    messages: [{
      role: "user",
      content: "请写一篇关于检索练习与间隔复习如何配合的中文说明，分 10 段，每段约 160 字，总计不少于 1600 个汉字。每段要有不同的学习场景和可执行建议，只写正文，不要标题、列表或总结。",
    }],
    tools: [],
    toolChoice: "auto",
    maxTokens: 2_400,
    temperature: 0.4,
    model: platform.model,
  };
  const observation: {
    provider: string;
    model: string;
    elapsedMs: number;
    outputCharacters: number;
    promptTokens: number;
    completionTokens: number;
    finishReason: string;
    providerCallSucceeded: boolean | null;
    providerError: { name: string; code: string | null; status: number | null; providerCode: string | null } | null;
    sampledDuringProviderCall: boolean;
    transactionActiveDuringProviderCall: boolean;
    workerIdleSessions: number;
    idleWorkerTransactions: number;
    concurrentWrite: { blocked: boolean; elapsedMs: number } | null;
  } = {
    provider: provider.id,
    model: provider.modelId,
    elapsedMs: 0,
    outputCharacters: 0,
    promptTokens: 0,
    completionTokens: 0,
    finishReason: "unknown",
    providerCallSucceeded: null,
    providerError: null,
    sampledDuringProviderCall: false,
    transactionActiveDuringProviderCall: false,
    workerIdleSessions: 0,
    idleWorkerTransactions: 0,
    concurrentWrite: null,
  };
  const definitionWithRealModel: typeof definition = {
    ...definition,
    execute: async (_input, env) => {
      trace.phases.push("execute");
      const realRequestStartedAt = Date.now();
      let settled = false;
      const responsePromise = provider.executeAgentTurn!(request, env.signal).finally(() => {
        settled = true;
      });
      // 等 provider 已经处于请求中再探同一 jobs 行；过短的返回不会冒充慢调用证据。
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      observation.sampledDuringProviderCall = !settled;
      observation.transactionActiveDuringProviderCall = currentWorkerWorkspaceTransaction() !== undefined;
      if (observation.sampledDuringProviderCall) {
        const sessions = await sql`
          SELECT
            count(*) FILTER (WHERE state = 'idle')::int AS idle_sessions,
            count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_transactions
          FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'astella_worker'
        `;
        observation.workerIdleSessions = Number(sessions[0]?.idle_sessions ?? 0);
        observation.idleWorkerTransactions = Number(sessions[0]?.idle_transactions ?? 0);
        observation.concurrentWrite = await tryConcurrentUpdate(job.id);
      }
      let response: Awaited<ReturnType<NonNullable<typeof provider.executeAgentTurn>>>;
      try {
        response = await responsePromise;
        observation.providerCallSucceeded = true;
      } catch (error) {
        observation.providerCallSucceeded = false;
        const shaped = error instanceof Error
          ? error as Error & { code?: unknown; status?: unknown; providerCode?: unknown }
          : null;
        observation.providerError = {
          name: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
          code: typeof shaped?.code === "string" ? shaped.code.slice(0, 80) : null,
          status: typeof shaped?.status === "number" ? shaped.status : null,
          providerCode: typeof shaped?.providerCode === "string" ? shaped.providerCode.slice(0, 120) : null,
        };
        throw error;
      } finally {
        observation.elapsedMs = Date.now() - realRequestStartedAt;
      }
      observation.outputCharacters = response.content?.length ?? 0;
      observation.promptTokens = response.usage?.promptTokens ?? 0;
      observation.completionTokens = response.usage?.completionTokens ?? 0;
      observation.finishReason = response.finishReason;
      return {
        ok: true as const,
        // 只把长度和用量送进任务输出，绝不把模型正文写入夹具或 artifact。
        output: `real-model|chars=${observation.outputCharacters}`,
        promptTokens: observation.promptTokens,
        completionTokens: observation.completionTokens,
      };
    },
  };
  const receipt = await runAiTask(definitionWithRealModel, {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  if (observation.elapsedMs === 0) observation.elapsedMs = receipt.usage.elapsedMs;
  const artifactDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.impeccable/companion");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = resolve(artifactDir, `w32-real-model-lock-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const safeArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "synthetic-real-provider-through-ai-task-kernel",
    outcome: receipt.outcome,
    usage: receipt.usage,
    failureClass: receipt.failure?.class ?? null,
    observation,
  };
  await writeFile(artifactPath, JSON.stringify(safeArtifact, null, 2) + "\n", "utf8");

  const acceptedOutputCapFailure = receipt.outcome === "failed"
    && receipt.failure?.class === "transport"
    && observation.providerCallSucceeded === false
    && observation.providerError?.code === "output_truncated";
  assert.ok(
    receipt.outcome === "committed" || acceptedOutputCapFailure,
    `长时间 provider 请求既没有成功提交，也不是已确认的输出上限响应（${receipt.failure?.class ?? "unknown failure"}）`,
  );
  assert.equal(observation.sampledDuringProviderCall, true, "provider 返回过快，未观测到请求进行中的窗口");
  assert.equal(observation.transactionActiveDuringProviderCall, false, "真实 provider 请求期间仍处于 worker 事务作用域");
  assert.ok(observation.workerIdleSessions > 0, "真实请求期间 worker 池没有可用的 idle 会话");
  assert.equal(observation.idleWorkerTransactions, 0, "pg_stat_activity 观察到 worker 连接处于 idle in transaction");
  assert.ok(observation.concurrentWrite, "没有在 provider 请求进行中执行并发写探针");
  assert.equal(observation.concurrentWrite.blocked, false, "真实模型等待期间，并发写被行锁钉住");
  assert.ok(observation.concurrentWrite.elapsedMs < 400, `并发写耗时 ${observation.concurrentWrite.elapsedMs}ms`);
  assert.ok(observation.elapsedMs >= 30_000, `真实模型调用只耗时 ${observation.elapsedMs}ms，未满足 30 秒慢调用判据`);
  if (receipt.outcome === "committed") {
    assert.equal(observation.providerCallSucceeded, true);
    assert.ok(observation.outputCharacters > 0, "模型没有返回正文");
    assert.deepEqual(trace.phases, ["prepare", "execute", "commit"]);
    assert.equal(trace.committedTitles.length, 1);
  } else {
    assert.equal(observation.providerCallSucceeded, false);
    assert.deepEqual(trace.phases, ["prepare", "execute"], "provider 失败后不应开启提交事务");
    assert.equal(trace.committedTitles.length, 0);
  }
  assert.equal(receipt.usage.modelCalls, 1, "专项探针只允许发出一次付费模型调用");
  console.log(`W3-2 real-model observation: ${JSON.stringify({ artifactPath, ...observation, outcome: receipt.outcome })}`);
});

/**
 * 39d W3-2 的判据之一：**注入慢外部调用，真去看锁与并发写**（39c §5.2 末句明写
 * "验收不是只检查函数名或新增 `isolated:true`"）。
 *
 * 两条一起才算测出来：
 *   - 负对照先证明**这套探针看得见阻塞**（同一行被一个开着的事务 `FOR UPDATE` 钉住时，
 *     并发写立刻撞 `lock_timeout`）。少了这条，正向"没被钉住"可以靠"探针根本没在看"糊过去。
 *   - 正向跑内核的三段形状：`prepare` 里锁完就提交（锁随事务释放），慢调用发生在
 *     两个事务**之间** ⇒ 并发写不等它。
 *
 * 慢的那一段是**假**的（`setTimeout`），不是真模型：这里要量的是"外部等待期间
 * 数据库锁不跟着等"，与响应来自哪里无关。真模型 30 秒那一手属每波末尾那一次真跑。
 */
const SLOW_EXTERNAL_MS = 8_000;
const LOCK_PROBE_TIMEOUT = "500ms";

async function tryConcurrentUpdate(jobId: string): Promise<{ blocked: boolean; elapsedMs: number }> {
  const started = Date.now();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
      await tx`SELECT set_config('lock_timeout', ${LOCK_PROBE_TIMEOUT}, true)`;
      await tx`UPDATE jobs SET priority = priority WHERE id = ${jobId}`;
    });
    return { blocked: false, elapsedMs: Date.now() - started };
  } catch (err) {
    if (/canceling statement due to statement timeout|lock timeout/i.test(String(err))) {
      return { blocked: true, elapsedMs: Date.now() - started };
    }
    throw err;
  }
}

test("负对照：行锁在开着的事务里时，探针看得见并发写被钉住", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const holder = sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT id FROM jobs WHERE id = ${job.id} FOR UPDATE`;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const probe = await tryConcurrentUpdate(job.id);
  await holder;
  assert.equal(probe.blocked, true, "锁都持着还测得出并发写成功＝这套探针是瞎的，正向那条不可信");
  assert.ok(probe.elapsedMs < 1_400, `并发写真的等完了持锁方（${probe.elapsedMs}ms），lock_timeout 没生效`);
});

test("慢外部调用期间不持业务事务与行锁：三段形状实测（W3-2 判据）", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  // 这一步的预算必须**大于**假外部调用的时长，否则量不到东西：内核默认 2 秒的
  // 单步超时会在第 2 秒把它切掉（第一次跑就是这么红的——那反而是超时在生效的证据）。
  const definition = {
    ...buildDefinition(job, trace, "slow"),
    budget: { maxModelCalls: 4, stepTimeoutMs: SLOW_EXTERNAL_MS + 6_000, taskDeadlineMs: SLOW_EXTERNAL_MS + 12_000, maxAutoRetries: 1 },
  };
  const originalPrepare = definition.prepare;
  const probeTimes: number[] = [];

  definition.prepare = async (ctx, attemptToken) => {
    const input = await originalPrepare(ctx, attemptToken);
    // 锁在这一个短事务里拿、随它提交而释放——然后才是慢的那一段。
    await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM jobs WHERE id = ${job.id} FOR UPDATE`);
    });
    return input;
  };
  definition.execute = async (input, env) => {
    const stepped = await (async () => {
      // 外部等待期间去改同一行：不该等。
      const probe = await tryConcurrentUpdate(job.id);
      probeTimes.push(probe.elapsedMs);
      assert.equal(probe.blocked, false, "慢外部调用期间，并发写被钉住了");
      await new Promise((resolve) => setTimeout(resolve, SLOW_EXTERNAL_MS));
      return { ok: true as const, output: `slow|${input}`, promptTokens: 1, completionTokens: 1 };
    })();
    void env;
    return stepped;
  };

  const started = Date.now();
  const receipt = await runAiTask(definition, {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  const total = Date.now() - started;
  assert.equal(receipt.outcome, "committed");
  assert.equal(probeTimes.length, 1);
  // 并发写要在 lock_timeout 之内回来，而且远早于外部调用的耗时。
  assert.ok(probeTimes[0] < 400, `并发写花了 ${probeTimes[0]}ms——它确实在等那个外部调用`);
  assert.ok(total >= SLOW_EXTERNAL_MS, "外部调用没真等够时间，这条测量不成立");
  assert.equal(trace.committedTitles.length, 1, "提交段照常落地（不持锁不等于不提交）");
});

test("误用被边界拒绝：在真的 worker 事务里跑内核 ⇒ 一次模型都不发（隐式外层事务）", async () => {
  // 这一条是 W3-2 判据里"含隐式外层事务，不只查文本里有没有 transaction"那一手：
  // `definition.execute` 从头到尾**没有收到过任何事务对象**，它甚至在另一个文件里，
  // 挡得住它的只有 `AsyncLocalStorage` 那一个读数。
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "misuse");
  const reported: string[] = [];
  await assert.rejects(
    () => withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
      await tx.execute(drizzleSql`SELECT 1`);
      return runAiTask(definition, {
        ctx: context(),
        attempt: attemptFor(job),
        currentActiveTransaction: currentWorkerWorkspaceTransaction,
        reportDevelopmentError: (message) => reported.push(message),
        verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
      });
    }),
    /外部调用被拒/,
  );
  assert.equal(trace.phases.filter((p) => p === "execute").length, 0, "边界拒了却还是把模型调出去了");
  assert.equal(trace.committedTitles.length, 0);
  assert.equal(reported.length, 1, "拒绝了但没记开发错误＝下一轮没人知道是谁在锁上等模型");
  assert.match(reported[0], /kernel-it-task@v1/);

  // 同一个定义、同一个租约，在事务**外面**跑就过得去——被拒的原因是作用域，不是定义本身。
  const cleanTrace: Trace = { phases: [], committedTitles: [] };
  const clean = await runAiTask(buildDefinition(job, cleanTrace, "misuse"), {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(clean.outcome, "committed");
});
