import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTextTokens } from "@astella/agent-core";
import type { ProviderCapability } from "@astella/shared";
import { companionMemoryContentMaxLength } from "@astella/shared/companion-memory-desktop-contracts";
import {
  assembleCompanionContext,
  budgetCompanionMemoryDirectory,
} from "../companion-context-orchestrator.ts";
import { resolveRouteInputTokens } from "../companion-context-handoff.ts";
import { taskEntityFromPersistedPageContext } from "../companion-task-memory.ts";
import type { CompanionMemoryDirectoryEntry } from "../companion-memory-vector.ts";

function memoryId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** 一条只声明了窗口与最大输出的路由档案：容量由它解析出来，测试不自造 token 数。 */
function routeCapability(contextWindowTokens: number, maxOutputTokens = 4_096): ProviderCapability {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    visionModelId: "test-vision",
    toolMode: "native_tools",
    contextWindowTokens,
    reservedOutputTokens: maxOutputTokens,
    maxInputTokens: contextWindowTokens,
    maxOutputTokens,
    fingerprint: "f".repeat(64),
  };
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

test("active 目录按声明容量整条取舍，少给了几条当场说清楚", () => {
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
  // 度量与实现同一个来源（agent-core 的保守字节口径）。以前这里写的是
  // `Buffer.byteLength/2`，于是测试算的是一套数、实现算的是另一套——
  // 判据红的时候分不清是取舍错了还是尺子不一样长。
  const measureTokens = (entry: CompanionMemoryDirectoryEntry) => estimateTextTokens(JSON.stringify(entry));
  const totalTokens = (entries: readonly CompanionMemoryDirectoryEntry[]) =>
    entries.reduce((total, entry) => total + measureTokens(entry), 0);

  // 容量给足：40 条整条进来，一条都不该被剪字。
  const wide = budgetCompanionMemoryDirectory(source, 100_000);
  assert.equal(wide.entries.length, 40);
  assert.equal(wide.omittedCount, 0);
  assert.deepEqual(wide.entries, source, "目录条目的标题与适用条件整条给，不再按字符剪短");
  assert.equal(wide.tokenEstimate, totalTokens(source), "读数按整条计量，不是剪过之后再量");

  // 容量收紧：整条装不下的就不给，但少给的数量必须是看得见的。
  const tight = budgetCompanionMemoryDirectory(source, 1_024);
  assert.ok(tight.entries.length > 0);
  assert.ok(tight.entries.length < 40);
  assert.equal(tight.entries.length + tight.omittedCount, 40);
  assert.ok(tight.tokenEstimate <= 1_024, "入选的整条仍停在声明容量之内");
  assert.equal(tight.tokenEstimate, totalTokens(tight.entries));
  // 入选的仍是**那一条完整的目录项**：不是把标题剪短来凑容量
  for (const entry of tight.entries) {
    assert.ok(source.some((original) => original.memoryId === entry.memoryId
      && original.title === entry.title && original.appliesWhen === entry.appliesWhen),
    "目录条目被剪过再入选");
  }
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
    { match: /method_state='active' AND p\.epistemic_status <> 'disputed'/, why: "手册目录与候选一次取回" },
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

/** resident 那一条读返回给定行，其余读（目录、手册、整理结论）返回空。 */
function residentTx(rows: readonly Record<string, unknown>[]) {
  let calls = 0;
  return {
    execute: async () => {
      calls += 1;
      return calls === 1 ? [...rows] : [];
    },
  } as never;
}

test("resident 正文整条装配：装不下的整条不入选并可计数，不再逐条校字数与字节", async () => {
  const bodies = {
    short: "中".repeat(100),
    mid: "文".repeat(120),
    // 正文长度的唯一声明源是写入合同那条线（shared），到线的那一条仍然整条进来。
    // 以前这里还要再过「每条 ≤1000 字符 / ≤1000 字节 / 320 token / 6 条」四道闸门。
    longest: "长".repeat(companionMemoryContentMaxLength),
    overContract: "超".repeat(companionMemoryContentMaxLength + 50),
  };
  const rows = [
    { id: memoryId(201), content: bodies.short },
    { id: memoryId(202), content: bodies.mid },
    { id: memoryId(203), content: bodies.longest },
    { id: memoryId(204), content: bodies.overContract },
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

  // 容量给足：三条整条装配，最长那条一字不减；超出写入合同那条线的整条不入选**并计数**。
  const wide = await assembleCompanionContext(residentTx(rows),
    { workspaceId: "workspace-1", userId: "user-1" }, { runId: "run-1", pageContext: null });
  assert.deepEqual(wide.residentMemories.map((memory) => memory.content),
    [bodies.short, bodies.mid, bodies.longest], "resident 正文整条给，不剪半句");
  assert.ok(!wide.residentMemoryIds.includes(memoryId(204)), "超出写入合同长度线的该整条不入选");
  assert.ok(!wide.residentMemories.some((memory) => memory.content.includes("超")),
    "超长那条被剪短后入选了——剪过的记忆她会照着剪过的话说");
  assert.equal(wide.residentOmittedCount, 1, "少带的那一条必须计数，否则与「没有这条记忆」同一个读数");
  assert.equal(wide.residentByteCount,
    [bodies.short, bodies.mid, bodies.longest]
      .reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0));
  assert.equal(wide.residentTokenEstimate,
    [bodies.short, bodies.mid, bodies.longest].reduce((total, content) => total + estimateTextTokens(content), 0));

  // 容量收紧：整条装不下的不进 prompt，少了几条仍然对得上。
  const capability = routeCapability(6_644);
  const tight = await assembleCompanionContext(residentTx(rows),
    { workspaceId: "workspace-1", userId: "user-1" },
    { runId: "run-2", pageContext: null, modelCapability: capability });
  assert.equal(tight.memoryCapacityTokens, resolveRouteInputTokens(capability),
    "取舍用的容量必须来自这条路由声明的窗口，不是抄在代码里的数");
  assert.ok(tight.residentMemories.length > 0, "紧容量也不该把正文全清空：至少装得下第一条");
  assert.ok(tight.residentMemories.length < 3, "这一轮没发生取舍，样本就没造好");
  assert.equal(tight.residentMemories.length + (tight.residentOmittedCount ?? 0), rows.length);
  assert.ok(tight.residentTokenEstimate <= (tight.memoryCapacityTokens ?? 0));
  for (const memory of tight.residentMemories) {
    assert.ok(Object.values(bodies).includes(memory.content), "入选的正文不再是整条");
  }
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
