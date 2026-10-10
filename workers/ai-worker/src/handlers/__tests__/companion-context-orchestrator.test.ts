import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleCompanionContext,
  budgetCompanionMemoryDirectory,
} from "../companion-context-orchestrator.ts";
import { taskEntityFromPersistedPageContext } from "../companion-task-memory.ts";
import type { CompanionMemoryDirectoryEntry } from "../companion-memory-vector.ts";

function memoryId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

test("任务身份只从持久化页面上下文中的合法实体 ID 推导", () => {
  const runId = "00000000-0000-4000-8000-000000000111";
  const cardId = "00000000-0000-4000-8000-000000000222";

  assert.deepEqual(
    taskEntityFromPersistedPageContext({ context: { pageKind: "learning_run", runId } }),
    { entityType: "learning_run", entityId: runId },
  );
  assert.deepEqual(
    taskEntityFromPersistedPageContext({ context: { pageKind: "review", cardId } }),
    { entityType: "card", entityId: cardId },
  );
  assert.equal(
    taskEntityFromPersistedPageContext({ context: { pageKind: "learning_run", runId: "forged" } }),
    null,
  );
  assert.equal(taskEntityFromPersistedPageContext({ context: { pageKind: "home" } }), null);
});

test("active 目录按条数与保守 token 预算截断，并限制标题和适用条件长度", () => {
  const source: CompanionMemoryDirectoryEntry[] = Array.from({ length: 40 }, (_, index) => ({
    memoryId: memoryId(index + 1),
    kind: "preference",
    title: "记忆标题".repeat(30),
    appliesWhen: "解释新概念时".repeat(20),
    validFrom: null,
    validUntil: null,
    revision: 1,
    epistemicStatus: null,
  }));
  const budgeted = budgetCompanionMemoryDirectory(source);
  const measuredTokens = budgeted.entries.reduce(
    (total, entry) => total + Math.ceil(Buffer.byteLength(JSON.stringify(entry), "utf8") / 2),
    0,
  );

  assert.ok(budgeted.entries.length > 0);
  assert.ok(budgeted.entries.length <= 12);
  assert.ok(measuredTokens <= 1024);
  assert.equal(budgeted.tokenEstimate, measuredTokens);
  assert.ok(budgeted.entries.every((entry) => entry.title.length <= 56));
  assert.ok(budgeted.entries.every((entry) => (entry.appliesWhen?.length ?? 0) <= 64));
});

test("普通对话只注入 resident 正文和 active 元数据目录", async () => {
  const residentId = memoryId(101);
  const activeId = memoryId(102);
  const calls: string[] = [];
  const tx = {
    execute: async (query: unknown) => {
      const text = (query as { queryChunks?: Array<{ value?: string[] }> }).queryChunks
        ?.map((chunk) => chunk.value?.join("") ?? "")
        .join("") ?? "";
      calls.push(text);
      if (calls.length === 1) {
        return [{
          id: residentId,
          kind: "goal",
          content: "本周想搞懂光合作用",
          budget_tier: "resident",
          revision: 2,
          importance: 0.9,
          pinned: true,
          last_used_at: null,
          user_confirmed: true,
        }];
      }
      if (calls.length === 2) {
        return [{
          id: activeId,
          kind: "preference",
          content: "喜欢先看反例再读定义。正文不应自动进入提示词。",
          applies_when: "解释新概念时",
          valid_from: null,
          valid_until: null,
          revision: 3,
        }];
      }
      return [];
    },
  };
  const context = await assembleCompanionContext(
    tx as never,
    { workspaceId: "workspace-1", userId: "user-1" },
    { runId: "run-1", pageContext: null },
  );

  // epistemicStatus 随正文一起进上下文（40 §4.5.4）：有争议/已替代的条目
  // 必须能被标出来，否则她会把它们当定论复述。`null` = 有据，不用标。
  assert.deepEqual(context.residentMemories, [{ kind: "goal", content: "本周想搞懂光合作用", epistemicStatus: null, userConfirmed: true }]);
  assert.deepEqual(context.memoryDirectory, [{
    memoryId: activeId,
    kind: "preference",
    // 目录项也带认识状态：争议/已替代的条目不进「可以直接引用」的行列。
    epistemicStatus: null,
    title: "喜欢先看反例再读定义。",
    appliesWhen: "解释新概念时",
    validFrom: null,
    validUntil: null,
    revision: 3,
  }]);
  assert.deepEqual(context.memoryRefs, [{
    memoryId: residentId,
    kind: "goal",
    content: "本周想搞懂光合作用",
  }]);
  assert.deepEqual(context.usedMemoryIds, [residentId, activeId]);
  assert.equal(context.retrievalMode, "directory");
  assert.ok(!JSON.stringify(context.memoryDirectory).includes("正文不应自动进入提示词"));
  assert.match(calls[0] ?? "", /budget_tier = 'resident'/);
  assert.match(calls[1] ?? "", /budget_tier = 'active'/);
  // 4 次查询：resident 正文、active 目录、手册目录与候选（**一次取回**，两条通道靠 SQL 的
  // CASE 分桶）、整理结论（§4.5.10 的 surface，一次性消费）。
  // 仍然全是**读**——统计写入在独立的 best-effort 事务里，那条不变。
  const reads = [
    { match: /budget_tier = 'resident'/, why: "resident 正文" },
    { match: /budget_tier = 'active'/, why: "active 目录" },
    { match: /method_state='active' AND p\.epistemic_status='supported'/, why: "手册目录与候选一次取回" },
    { match: /UPDATE companion_memory_organization_state/, why: "整理结论（一次性消费）" },
  ];
  assert.equal(calls.length, reads.length, `context assembly 只读数据：${reads.map((r) => r.why).join(" + ")}`);
  for (const read of reads) {
    assert.ok(calls.some((sql) => read.match.test(sql)), `缺少这一条读：${read.why}`);
  }
  // 两个桶的谓词在同一条 SQL 里：只留下目录那道门，候选就会被一并放进来。
  assert.ok(calls.some((sql) => /method_state='candidate' AND p\.epistemic_status <> 'disputed'/.test(sql)),
    "候选的判据必须与目录同一条查询出现");
  assert.doesNotMatch(calls.join("\n"), /UPDATE assistant_memory_items|memory_usage_log/);
});

test("resident 正文装配再次校验条数、估算 token 与 UTF-8 字节预算", async () => {
  const rows = [
    { id: memoryId(201), content: "中".repeat(200) },
    { id: memoryId(202), content: "文".repeat(160) },
    { id: memoryId(203), content: "abc" },
  ].map((row) => ({
    ...row,
    kind: "goal",
    budget_tier: "resident",
    revision: 1,
    importance: 0.8,
    pinned: false,
    last_used_at: null,
    user_confirmed: true,
  }));
  let calls = 0;
  const context = await assembleCompanionContext(
    { execute: async () => { calls += 1; return calls === 1 ? rows : []; } } as never,
    { workspaceId: "workspace-1", userId: "user-1" },
    { runId: "run-1", pageContext: null },
  );

  assert.deepEqual(context.usedMemoryIds, [memoryId(201), memoryId(203)]);
  assert.equal(context.residentByteCount, Buffer.byteLength("中".repeat(200) + "abc", "utf8"));
  assert.ok(context.residentByteCount <= 1000);
  assert.ok(context.residentTokenEstimate <= 320);
  assert.equal(context.residentMemories.length, 2);
});

test("正式学习 tutor 不读取或注入 resident 与 active 记忆", async () => {
  let calls = 0;
  const context = await assembleCompanionContext(
    { execute: async () => { calls += 1; return []; } } as never,
    { workspaceId: "workspace-1", userId: "user-1" },
    { runId: "run-1", groundedTutorContext: { claim: "只用证据" } },
  );

  assert.equal(calls, 0);
  assert.deepEqual(context.residentMemories, []);
  assert.deepEqual(context.memoryDirectory, []);
  assert.equal(context.retrievalMode, "disabled");
});
