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

/**
 * ⑧ 反思产出的经验要**读得回来**。
 *
 * 这条链以前只有一半：`upsertReflectionMethod` 把做法落成 `candidate`+`tentative`，
 * 而目录那道门只放 `active`+`supported`（那条门是对的——没核对的东西不该占「可照做」
 * 的名额）。结果是她提炼的任何东西都进不了下一次相处，§16 第 6 步
 * 「用户改过之后下一轮不再照旧的来」在方法这一侧根本没有落点。
 * 这里钉的是那条读回边完整存在：权威读 → worker 投影 → 装配 → 进请求。
 */
test("⑧ 自主方法进入读取目录，认识状态与来源独立于采用", () => {
  const hostMethods = read("packages/agent-host/src/methods.ts");
  // 目录与候选是一次取回（2026-10-10：同表同事务，分两条 SQL 只是每轮多一次往返），
  // 但**两道门一条不能省**：谁进哪个桶由这一条 SQL 的 CASE 决定。
  assert.match(hostMethods, /export async function listAgentMethodBuckets/,
    "agent-host 要有一条把目录与候选分桶的权威查询");
  assert.match(hostMethods, /WHEN p\.method_state='active' AND p\.epistemic_status <> 'disputed' THEN 'catalog'/,
    "可尝试的 active 方法无需用户批准，disputed 仍不能照做");
  assert.match(hostMethods, /WHEN p\.method_state='candidate' AND p\.epistemic_status <> 'disputed' THEN 'candidate'/,
    "候选那条按生命周期读，且排除依据已被纠正的");

  const playbooks = read("workers/ai-worker/src/handlers/companion-playbooks.ts");
  assert.match(playbooks, /retrievePlaybookViews/);
  assert.match(playbooks, /renderPlaybookCandidates/);
  assert.match(playbooks, /PLAYBOOK_CANDIDATE_LIMIT/,
    "候选的条数要有自己的源，不与目录的 20 条共用一个数");
  assert.match(playbooks, /candidateLimit: PLAYBOOK_CANDIDATE_LIMIT/,
    "两个上限分别作用在各自的桶上，不能互相挤占");

  const orchestrator = read("workers/ai-worker/src/handlers/companion-context-orchestrator.ts");
  assert.match(orchestrator, /await retrievePlaybookViews\(tx, scope\)/);
  const dialogue = read("workers/ai-worker/src/handlers/companion-dialogue.ts");
  assert.match(dialogue, /methodCandidates: read\.groundedTutorContext \? "" : renderPlaybookCandidates/,
    "正式作答那一档不带候选：讲解只按材料与题面来");
  const content = read("workers/ai-worker/src/handlers/companion-dialogue-content.ts");
  assert.match(content, /add\("method_candidates", input\.methodCandidates/,
    "候选要作为自己的一个来源进 44 的来源计划，否则预算回执里看不见它");
});
