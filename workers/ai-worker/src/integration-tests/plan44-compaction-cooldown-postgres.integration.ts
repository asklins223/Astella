/**
 * 方案 44 §5.4 后半：压缩冷却与无进展状态在**真实数据库**上的行为（0385）。
 *
 * ## 这条要验的是什么
 *
 * `MAX_COMPACTION_ATTEMPTS = 3` 的全部意义在于「反复失败会停下来」。而
 * `recordCompactionAttemptState` 原来是**先 SELECT 再按绝对值写回**：
 *
 *   读状态 → 在 JS 里算出 next → UPSERT 写 next
 *
 * 两次并发的尝试都会读到 attempts=0，都算出 1，都写 1——**计数被抹平**。
 * 唯一索引挡住了「各插一行」，但挡不住「同一行上的一次丢失更新」。结果是：
 * 一个重试的系统会一直以为自己还有额度，于是每轮都折、每轮都等，情况一点没变——
 * 正是 §5.4 明令禁止的那条路。
 *
 * 并发在这里不是假设：闸拦下之后 fold + 重发可能与下一次心跳重叠，
 * 两个 job 也可能拿到同一个 run。
 *
 * 运行：DATABASE_URL_API=... npm run test:plan44-cooldown:postgres
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import type { AgentSqlExecutor } from "@ailearn/agent-host";
import {
  readCompactionCooldownState,
  recordCompactionAttemptState,
} from "@ailearn/agent-host";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";

process.env.DATABASE_URL_API = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_WORKER = testDatabaseUrl("DATABASE_URL_WORKER");

interface Scope { workspaceId: string; userId: string }
const scope: Scope = { workspaceId: randomUUID(), userId: randomUUID() };
const email = `plan44k-${scope.userId.slice(0, 8)}@example.test`;

/** worker 侧的真实事务：设 app.workspace_id / app.user_id，走 RLS 与真实连接池。 */
const inWorker = <T>(action: (tx: WorkerTransaction) => Promise<T>): Promise<T> =>
  withWorkerWorkspaceTransaction(scope, action);

/** 冷却是**按来源版本**分开的：换来源哈希 = 另一段历史，不该继承冷却。 */
const keyFor = (sourceHash: string) => ({
  conversationId: randomUUID(),
  sourceHash,
  providerId: "openai_compatible",
  modelId: "qwen3.8-flash",
});

async function seedScope(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  // id 由应用侧生成（randomUUID），不交给数据库算：postgres.js 无法为
  // `VALUES ($1, …)` 里的 `gen_random_uuid()` 推断参数类型，报
  // `could not determine data type of parameter $1`——那是夹具的问题，
  // 与被验的冷却逻辑无关，却会让整个文件红掉、看不出断言过没过。
  await admin`INSERT INTO users (id, email, password_hash) VALUES (${scope.userId}, ${email}, 'x')
    ON CONFLICT (id) DO NOTHING`;
  await admin`INSERT INTO workspaces (id, owner_id, name) VALUES (${scope.workspaceId}, ${scope.userId}, 'w')
    ON CONFLICT (id) DO NOTHING`;
  await admin.end({ timeout: 5 });
}

async function dropScope(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  await admin`DELETE FROM workspaces WHERE id = ${scope.workspaceId}`.catch(() => {});
  await admin`DELETE FROM users WHERE id = ${scope.userId}`.catch(() => {});
  await admin.end({ timeout: 5 });
}

after(async () => { await dropScope(); });

test("0385：两次并发的尝试不会把计数抹平——否则「最多折 N 次」形同虚设", async () => {
  await seedScope();
  const key = keyFor("a".repeat(64));

  // 并发：两个连接各自读、各自写。原来的读-改-写会双双读到 0。
  await Promise.all([
    inWorker((tx) => recordCompactionAttemptState(tx as unknown as AgentSqlExecutor, scope, key,
      { inputTokens: 20_000, reason: "over_trigger_line", at: new Date() })),
    inWorker((tx) => recordCompactionAttemptState(tx as unknown as AgentSqlExecutor, scope, key,
      { inputTokens: 20_000, reason: "over_trigger_line", at: new Date() })),
  ]);

  const state = await inWorker((tx) =>
    readCompactionCooldownState(tx as unknown as AgentSqlExecutor, scope, key));
  assert.equal(state!.attempts, 2,
    `并发两次尝试后 attempts 应该是 2，实际 ${state!.attempts}——计数被抹平了`);
});

test("0385：换来源哈希就是另一段历史，不继承上一份冷却", async () => {
  const key = keyFor("b".repeat(64));
  await inWorker((tx) => recordCompactionAttemptState(tx as unknown as AgentSqlExecutor, scope, key,
    { inputTokens: 20_000, reason: "over_trigger_line", at: new Date() }));
  const other = await inWorker((tx) =>
    readCompactionCooldownState(tx as unknown as AgentSqlExecutor, scope, { ...key, sourceHash: "c".repeat(64) }));
  assert.equal(other, null, "换来源哈希还读到旧冷却 = 摘要或消息已重算，却在继承针对旧输入的失败");
});

test("0385：折小了算有进展，连续无进展会累加——上限正是 §5.4 的那条停止条件", async () => {
  const key = keyFor("d".repeat(64));
  const attempt = (inputTokens: number) => inWorker((tx) =>
    recordCompactionAttemptState(tx as unknown as AgentSqlExecutor, scope, key,
      { inputTokens, reason: "over_trigger_line", at: new Date() }));

  assert.equal((await attempt(20_000)).noProgressStreak, 0, "第一次还没有「上一次」可比较");
  assert.equal((await attempt(20_000)).noProgressStreak, 1, "同样大小 = 没进展");
  assert.equal((await attempt(19_000)).noProgressStreak, 0, "折小了算有进展");
  assert.equal((await attempt(19_000)).noProgressStreak, 1);
  // 连续无进展被夹住——不封顶就会一直涨，而它的用途就是「这条路走不通了」。
  assert.ok((await attempt(19_000)).noProgressStreak <= 3);
  assert.equal((await attempt(19_000)).attempts, 6);
});
