/**
 * 后台反思「接电」的守卫（方案 50 §9 / §12.2，与 0361 那份同一条路子）。
 *
 * ## 它挡住的是什么
 *
 * 反思这条链有五个环节：库里的入队函数、worker 的调度 tick、handler 注册、
 * 超时档位、以及那段真实交流被读回来的判据。任何一环没接上，前面写的都不算数——
 * 而失败形态是"她从没有回顾过"，不是"回顾报错了"。这类缺口只有接线检查抓得住。
 *
 * ## 为什么用源码判据而不是跑真库
 *
 * 这几条都是「注册在哪」的问题，跑库验证不了；真跑那一段由
 * `companion-reflection-gate.test.ts`（判据）与
 * `apps/api/src/integration-tests/companion-reflection-growth-postgres.integration.ts`
 * （真库闭环）负责。
 *
 * ## 两处同一个数字
 *
 * 入队门槛的数字住在迁移 0400，判据实现住在 agent-host 的
 * `COMPANION_REFLECTION_THRESHOLDS`。两处各写一遍一定会漂，所以这里当场比对
 * （沿用 0361 已经生效的做法）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COMPANION_REFLECTION_THRESHOLDS,
  COMPANION_REFLECTION_STRATEGY_VERSION,
} from "@astella/agent-host";

// 从 src/__tests__/ 往上四级是仓库根：__tests__ → src → ai-worker → workers → 仓库根
const REPO = new URL("../../../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(new URL(relative, REPO), "utf8");
}

const indexSource = read("workers/ai-worker/src/index.ts");
const migration = read("apps/api/src/db/migrations/0400_companion_persona_reflection.sql");

test("① handler 注册进 job 映射表 —— 没注册就等于这条链不存在", () => {
  assert.match(indexSource, /companion_reflection:\s*runCompanionReflectionJob/,
    "worker 的 HANDLERS 必须认识 companion_reflection；否则 job 投了也没人跑");
  assert.match(indexSource, /from "\.\/handlers\/companion-reflection\.ts"/);
});

test("② 调度 tick 被 index.ts 导入并在 claim 之前调用", () => {
  assert.match(indexSource, /tickCompanionReflectionScheduler/,
    "0400 那个 SECURITY DEFINER 函数没人叫醒就永不入队");
  assert.match(indexSource, /from "\.\/handlers\/companion-reflection-scheduler\.ts"/);
  const tickCall = indexSource.indexOf("await tickCompanionReflectionScheduler()");
  const claimCall = indexSource.indexOf("await claimJobs(");
  assert.ok(tickCall >= 0 && claimCall >= 0 && tickCall < claimCall,
    "入队 tick 必须在 claim 之前：没有 job 可认领的那一轮也要能把段落挑出来");
});

test("③ job 类型在 worker 自入队白名单里 —— 不在就插不进去", () => {
  assert.match(migration, /DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard"/);
  assert.match(migration, /'companion_reflection'/,
    "白名单里没有 companion_reflection，worker 的 INSERT 会被 RLS 策略直接挡掉");
});

test("④ 超时与资源车道都登记过（后台任务不能挤占前台交互）", () => {
  const timeouts = read("workers/ai-worker/src/lib/handler-timeout-config.ts");
  assert.match(timeouts, /companion_reflection:\s*DEFAULT_AI_TASK_TIMEOUT_MS/);
  const scheduler = read("workers/ai-worker/src/handlers/companion-reflection-scheduler.ts");
  assert.match(scheduler, /astella_enqueue_companion_reflection\(\)/);
});

test("⑤ 入队门槛的数字与 TS 判据一致（两处各写一遍必漂）", () => {
  const declared = migration.match(
    /SELECT (\d+)::bigint, (\d+)::bigint, (\d+)::int, (\d+)::int;/,
  );
  assert.ok(declared, "0400 里找不到 astella_companion_reflection_thresholds 的那一行 SELECT");
  assert.deepEqual(
    [Number(declared![1]), Number(declared![2]), Number(declared![3]), Number(declared![4])],
    [COMPANION_REFLECTION_THRESHOLDS.minUserMessages,
      COMPANION_REFLECTION_THRESHOLDS.minAssistantMessages,
      COMPANION_REFLECTION_THRESHOLDS.minIntervalHours,
      COMPANION_REFLECTION_THRESHOLDS.maxOpenPerAccount],
  );
});

test("⑥ 幂等键与 worker 侧的 dedupe key 同一个形状（两边各算一次就要对上）", () => {
  const handler = read("workers/ai-worker/src/handlers/companion-reflection.ts");
  assert.match(handler, /companion-reflection:\$\{conversationId\}:\$\{toSeq\}/,
    "worker 的 dedupe key 形状与迁移里的 idempotency_key 不一致时，同一段会留下两条反思");
  assert.match(migration, /'companion-reflection:' \|\| v_row\.conversation_id::text \|\| ':' \|\| v_row\.to_seq::text/);
});

test("⑦ 策略版本进幂等判据：换策略能重新回顾同一段，不冒充「已经看过」", () => {
  assert.match(migration, /strategy_version text NOT NULL/);
  assert.equal(COMPANION_REFLECTION_STRATEGY_VERSION, "reflection-v1");
  const content = read("workers/ai-worker/src/handlers/companion-reflection-content.ts");
  assert.match(content, /COMPANION_REFLECTION_PROMPT_VERSION/);
  assert.match(content, /strategyVersion/);
});
