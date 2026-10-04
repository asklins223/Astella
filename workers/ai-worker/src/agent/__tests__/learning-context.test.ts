/**
 * Agent 采用「已确认合作规则」这一层的单元测试（方案 42 阶段 1B）。
 *
 * 这里只钉三件**纯函数与接线**的事；时窗、软删、隔离与真实撤回/纠正行为在
 * `src/integration-tests/agent-learning-preferences-postgres.integration.ts`，
 * 那一份用真实 memory service 走一遍，单元测试不去镜像它。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentSqlExecutor } from "@ailearn/agent-host";
import { loadAgentLearningContext } from "../learning-context.ts";
import {
  ADOPTABLE_EPISTEMIC_STATUSES,
  ADOPTABLE_PREFERENCE_SCOPES,
  AGENT_PREFERENCE_LIMIT,
  AGENT_PREFERENCE_TEXT_LIMIT,
  adoptAgentPreferences,
  type AgentPreferenceRow,
} from "../learning-preferences.ts";

const MEMORY_ID = "3f2b8c1a-5d64-4a7e-9b21-0c5e7a9d4f13";
const SCOPE = { workspaceId: "0b6d3f5a-1c22-4a88-9e30-7f4d5b6c8e91", userId: "9c1d0e44-27ab-4f36-8e15-7a3d2b6c0e88" };

function row(overrides: Partial<AgentPreferenceRow> = {}): AgentPreferenceRow {
  return {
    id: MEMORY_ID, revision: 1, scope: "workspace",
    content: "讲学习内容时，先举日常例子，再给公式。",
    applies_when: null, epistemic_status: "supported", ...overrides,
  };
}

/** 回放预设结果，同时留下 `loadAgentLearningContext` 实际发出去的查询。 */
function executor(replies: unknown[]) {
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  let index = 0;
  const tx: AgentSqlExecutor = { async execute(query) {
    queries.push(new PgDialect().sqlToQuery(query));
    return replies[index++] ?? [];
  } };
  return { tx, queries };
}

test("采用的那一条带上真实 id、修订号与范围，正文与适用条件长度有界", () => {
  const [adopted, ...rest] = adoptAgentPreferences([
    row({ revision: 3, scope: "global", applies_when: "讲新概念时", epistemic_status: "tentative" }),
    row({ content: `长正文：${"x".repeat(AGENT_PREFERENCE_TEXT_LIMIT * 2)}` }),
  ]);
  assert.equal(rest.length, 1);
  assert.deepEqual(adopted, {
    memoryId: MEMORY_ID, revision: 3, scope: "global", kind: "preference",
    content: "讲学习内容时，先举日常例子，再给公式。",
    appliesWhen: "讲新概念时", epistemicStatus: "tentative",
  });
  assert.equal(rest[0]?.content.length, AGENT_PREFERENCE_TEXT_LIMIT);
  assert.equal(adoptAgentPreferences([row({ applies_when: "   " })])[0]?.appliesWhen, null);
});

test("认识状态用正向白名单：词表将来变宽不会把新值悄悄当成偏好", () => {
  // 白名单里的每个取值都必须真能采用，否则 SQL 放行的行会被这一层丢掉，
  // 「用户点过确认」在 Agent 侧就失效了。
  for (const status of ADOPTABLE_EPISTEMIC_STATUSES) {
    assert.equal(adoptAgentPreferences([row({ epistemic_status: status })]).length, 1,
      `${status} 在白名单里却没被采用`);
  }
  // 白名单之外一律不采用。最后两项是这条测试的价值所在：否定式写法会默默放行它们。
  for (const status of ["disputed", "superseded", "retracted", "assumed", ""]) {
    assert.deepEqual(adoptAgentPreferences([row({ epistemic_status: status })]), [], `${status} 不该被采用`);
  }
});

test("旧任务与空间级以外的范围不进长期偏好", () => {
  for (const scope of ADOPTABLE_PREFERENCE_SCOPES) {
    assert.equal(adoptAgentPreferences([row({ scope })]).length, 1, `${scope} 应当可以采用`);
  }
  for (const scope of ["task", "", "WORKSPACE"]) {
    assert.deepEqual(adoptAgentPreferences([row({ scope })]), [], `${scope} 不该被采用`);
  }
});

test("读出来的那一行仍要过一遍白名单——守卫接在真实调用路径上", async () => {
  // 库返回了一行争议中的偏好：无论 SQL 那一刻怎么写，都不采用。
  const { tx } = executor([
    [{ profile: null }],
    [row({ epistemic_status: "disputed" }), row({ epistemic_status: "tentative" })],
  ]);
  const context = await loadAgentLearningContext(tx, SCOPE);
  assert.equal(context.persona, null);
  assert.equal(context.preferences.length, 1);
  assert.equal(context.preferences[0]?.memoryId, MEMORY_ID);
  assert.equal(context.preferences[0]?.epistemicStatus, "tentative");
});

test("查询向数据库要的是正向白名单与最多 4 条", async () => {
  const { tx, queries } = executor([[{ profile: null }], []]);
  await loadAgentLearningContext(tx, SCOPE);
  const preferenceQuery = queries[1];
  assert.ok(preferenceQuery, "没有发出偏好查询");
  const bound = preferenceQuery.params.map(param => String(param));
  for (const value of [...ADOPTABLE_EPISTEMIC_STATUSES, ...ADOPTABLE_PREFERENCE_SCOPES]) {
    assert.ok(bound.includes(value), `查询没有绑定 ${value}`);
  }
  for (const status of ["disputed", "superseded"]) {
    assert.ok(!bound.includes(status), `${status} 不该出现在查询参数里`);
  }
  // 作用域与上限是参数化传下去的，不是拼进 SQL 文本。
  assert.ok(bound.includes(SCOPE.workspaceId) && bound.includes(SCOPE.userId));
  assert.ok(bound.includes(String(AGENT_PREFERENCE_LIMIT)), "上限没有传给数据库");
});

test("人格是账号级的：读得到就用，读不到就是 null", async () => {
  const profile = { name: "小伴", speakingStyle: "先讲人话", personalityTags: ["耐心"], examples: [] };
  const present = await loadAgentLearningContext(executor([[{ profile }], []]).tx, SCOPE);
  assert.equal(present.persona?.name, "小伴");
  const missing = await loadAgentLearningContext(executor([[], []]).tx, SCOPE);
  assert.equal(missing.persona, null, "没有人格行时应当是 null，而不是空壳");
  assert.deepEqual(missing.preferences, []);
});