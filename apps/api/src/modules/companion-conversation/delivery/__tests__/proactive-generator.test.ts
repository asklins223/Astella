/**
 * Orchestrator 模型生成接线测试（单元：schema 严格 + 降级语义）。
 *
 * 真实 LLM 调用在 demonstrated 纵切（assistant-memory-postgres.integration.ts
 * P8 Orchestrator 测试，.env 配置后由 hook 真实触发）中覆盖；此处验证：
 * - 无配置 → null（静默降级）
 * - 输出 schema strict（缺字段/超长拒绝）
 * - extractJson 围栏/裸 JSON 提取
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";

const { generateMemoryCandidates, memoryCandidateOutputSchema } = await import(
  "../proactive-generator.ts"
);

// 单元测试不依赖 env：显式清空后验证 null 降级，再验证 strict schema。
const savedUrl = process.env.ASSESSMENT_CRITIC_URL;
const savedKey = process.env.ASSESSMENT_CRITIC_KEY;
const savedDash = process.env.DASHSCOPE_API_KEY;

after(() => {
  if (savedUrl !== undefined) process.env.ASSESSMENT_CRITIC_URL = savedUrl;
  if (savedKey !== undefined) process.env.ASSESSMENT_CRITIC_KEY = savedKey;
  if (savedDash !== undefined) process.env.DASHSCOPE_API_KEY = savedDash;
});

// 2026-10-02：生成接到 41a 统一内核后，函数多两个必填参数——`input.runId`
// （进输入快照身份与幂等键）与 `scope`（归属 + 「当前作用域有没有活动事务」
// 那一个读数）。单元测试没有真实事务，边界读数传 `() => undefined`。
const scope = {
  workspaceId: "w-test",
  userId: "u-test",
  currentActiveTransaction: () => undefined,
};

test("真 LLM 生成（.env 配置后真实调用 DashScope）", { skip: !(savedUrl && (savedKey || savedDash)) && "未配置 critic env" }, async () => {
  if (savedUrl) process.env.ASSESSMENT_CRITIC_URL = savedUrl;
  if (savedKey) process.env.ASSESSMENT_CRITIC_KEY = savedKey;
  if (savedDash) process.env.DASHSCOPE_API_KEY = savedDash;
  const result = await generateMemoryCandidates({
    outcome: "demonstrated",
    trustOutcome: "demonstrated",
    keyPointClaim: "遗忘曲线表明复习间隔决定长期记忆",
    scheduleImpact: "created",
    runId: "run-test-1",
  }, scope);
  assert.ok(result, "真实 LLM 应产出记忆候选");
  assert.ok(result.learningContext.length >= 2);
});

test("无配置 → null（静默降级，不阻塞结算）", async () => {
  delete process.env.ASSESSMENT_CRITIC_URL;
  delete process.env.ASSESSMENT_CRITIC_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  const result = await generateMemoryCandidates({
    outcome: "demonstrated",
    trustOutcome: "demonstrated",
    keyPointClaim: "遗忘曲线",
    scheduleImpact: "created",
    runId: "run-test-2",
  }, scope);
  assert.equal(result, null);
});

/**
 * 41a 的正控制：证明这一发**真的走了内核**，而不是"外面包了个看不见的壳"。
 *
 * 量的是**事务边界读数被读过**——内核在发外部请求之前一定��调它
 * （`RunAiTaskOptions.currentActiveTransaction` 是必填端口）。没接内核的话，
 * 这个 reader 一次都不会被碰到，断言立刻红。
 *
 * 「有活动事务 ⇒ 返回 null」单看是空断言（无配置也是 null），所以这条的判据是
 * **读数被调过**，不是返回值。
 */
test("41a：内核在发外部请求前核过事务边界读数", async () => {
  process.env.ASSESSMENT_CRITIC_URL = savedUrl ?? "https://example.invalid/v1";
  process.env.ASSESSMENT_CRITIC_KEY = savedKey ?? savedDash ?? "test-key";
  delete process.env.DASHSCOPE_API_KEY;

  let consulted = 0;
  // 有活动事务 ⇒ 内核拒绝发请求 ⇒ 走既有 fail-open 语义返回 null。
  const result = await generateMemoryCandidates(
    {
      outcome: "demonstrated",
      trustOutcome: "demonstrated",
      keyPointClaim: "遗忘曲线",
      scheduleImpact: "created",
      runId: "run-test-boundary",
    },
    { ...scope, currentActiveTransaction: () => { consulted += 1; return { active: true }; } },
  );
  assert.ok(consulted > 0, "事务边界读数一次都没被读过——这一发没有走统一内核");
  assert.equal(result, null, "有活动事务时不得发出外部生成请求");
});

test("输出 schema strict：缺字段/超长/未知字段拒绝", () => {  const schema = memoryCandidateOutputSchema;  assert.ok(schema, "schema 应导出");
  // 缺 needsFollowup → 拒绝
  assert.equal(
    schema.safeParse({ learningContext: { content: "ok" } }).success,
    false,
  );
  // 超长 content → 拒绝
  assert.equal(
    schema.safeParse({
      learningContext: { content: "x".repeat(401), needsFollowup: true },
    }).success,
    false,
  );
  // 未知字段 → 拒绝（strict）
  assert.equal(
    schema.safeParse({
      learningContext: { content: "ok", needsFollowup: true, extra: 1 },
    }).success,
    false,
  );
  // 合法 → 通过
  assert.equal(
    schema.safeParse({
      learningContext: { content: "已掌握遗忘曲线的核心", needsFollowup: false },
      interactionNote: { content: "三天后提醒巩固" },
    }).success,
    true,
  );
});
