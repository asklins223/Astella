/**
 * 账号级（跨空间）记忆的**写入守卫**（42 阶段 1 E）。
 *
 * 洞在哪：跨空间判据原先只长在抽取器里，API 写入端完全不知道它——用户在记忆中心把
 * "正在学数据库索引优化"存成账号级偏好，服务端照写不误，0371 的受控铺开还会把它真的
 * 复制到别的空间去。判据现在共用 `@ailearn/shared/companion-memory-scope`。
 *
 * 不连数据库：断言的是"有没有发出那条写语句"与"回执长什么样"——服务在已开的事务里
 * 抛错会回滚，而**写入前就被拦下**是比回滚更强的一条保证。真实库上的副本与历史，
 * 由 `assistant-memory-postgres.integration.ts` 对着库验。
 */
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { readFileSync } from "node:fs";
import type { ApiTransaction } from "../../../../db/client.ts";
import {
  MemoryGlobalScopeRejectedError,
  correctMemory,
  upsertMemory,
  type MemoryScope,
} from "../memory-service.ts";
import {
  MEMORY_GLOBAL_SCOPE_REJECTED_STATUS,
  memoryGlobalScopeRejection,
} from "../memory-routes.ts";
import { executeCompanionMemoryProposalAction } from "../../companion-memory-proposal-action.ts";
import { CompanionConversationError } from "../../turn/turn-service.ts";
import { accountPreferenceRejectionMessage } from "@ailearn/shared/companion-memory-scope";

const SCOPE: MemoryScope = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
};

/** 一条看起来完整的库内行（`toContract` 读得到它需要的每一位）。 */
function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: SCOPE.workspaceId,
    userId: SCOPE.userId,
    kind: "preference",
    content: "习惯晚上学习",
    sourceEventId: null,
    sourceSessionId: null,
    sourceSpeaker: null,
    sourceBasis: null,
    appliesWhen: null,
    validFrom: null,
    validUntil: null,
    userStated: true,
    userConfirmed: true,
    candidate: false,
    importance: 0.8,
    confidence: 0.9,
    scope: "workspace",
    pinned: false,
    archivedAt: null,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "none",
    sourceType: "user_stated",
    revision: 1,
    authorType: "user",
    authorId: SCOPE.userId,
    epistemicStatus: "supported",
    globalKey: null,
    createdAt: new Date("2026-10-04T00:00:00.000Z"),
    updatedAt: new Date("2026-10-04T00:00:00.000Z"),
    ...overrides,
  };
}

interface FakeTxOptions {
  /** `select` 依次回的行队列（upsert 的既有行、修订后回读、交付结账……）。 */
  selects?: Array<Array<Record<string, unknown>>>;
  /**
   * 原子 upsert **落库后**返回的那一行。
   *
   * 真实库里这一行既可能是新插的，也可能是 `ON CONFLICT ... DO UPDATE` 更新出来的
   * 既有 global 行——它的最终 `applies_when` 来自 `coalesce(excluded, 库里旧值)`，
   * 写入前看不见。默认：用 insert 的载荷当成回读行。
   */
  insertedRow?: Record<string, unknown> | null;
}

interface FakeTx {
  tx: ApiTransaction;
  ops: Array<{ op: string; payload?: Record<string, unknown> }>;
  executedSql: string[];
}

/**
 * 把 drizzle 的 SQL 片段摊成可搜索的文本：`String(obj)` 只会得到一串 `[object Object]`，
 * 于是"有没有触发跨空间铺开"这条断言会永远为假。
 */
function sqlText(query: unknown): string {
  if (query == null) return "";
  if (typeof query === "string") return query;
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) return chunks.map(sqlText).join("");
  const values = (query as { value?: unknown[] }).value;
  if (Array.isArray(values)) return values.map(sqlText).join("");
  return String(query);
}

function fakeTx(options: FakeTxOptions = {}): FakeTx {
  const ops: Array<{ op: string; payload?: Record<string, unknown> }> = [];
  const executedSql: string[] = [];
  const selects = options.selects ?? [];
  let selectIndex = 0;
  let lastValues: Record<string, unknown> | null = null;
  let lastSet: Record<string, unknown> | null = null;

  const chain = (terminal: () => unknown) => {
    const target: Record<string, unknown> = {};
    for (const step of [
      "from", "where", "orderBy", "values", "set",
      "onConflictDoUpdate", "onConflictDoNothing", "returning", "limit",
    ]) {
      target[step] = (...args: unknown[]) => {
        if (step === "values") {
          lastValues = args[0] as Record<string, unknown>;
          ops.push({ op: "insert", payload: lastValues });
        }
        if (step === "set") {
          lastSet = { ...(lastSet ?? {}), ...(args[0] as Record<string, unknown>) };
          ops.push({ op: "update", payload: lastSet });
        }
        return target;
      };
    }
    target.then = (resolve: (value: unknown) => unknown) => Promise.resolve(terminal()).then(resolve);
    return target;
  };

  const tx = {
    select: () => {
      const rows = selects[selectIndex++] ?? [];
      return chain(() => rows);
    },
    insert: () => chain(() => {
      if ("insertedRow" in options) return options.insertedRow ? [options.insertedRow] : [];
      // 回读行补上 `deletedAt: null`——真实库里新行一定有这个位，
      // 少了它服务里的 `deletedAt !== null` 会把这条当成已删除而跳过铺开。
      return lastValues ? [{ deletedAt: null, ...lastValues }] : [];
    }),
    // 回读：把刚 set 进去的字段并回最近读到的那一行。
    update: () => chain(() => {
      const base: Record<string, unknown> = selects[Math.max(selectIndex - 1, 0)]?.[0] ?? {};
      const updated: Record<string, unknown> = { deletedAt: null, ...base, ...(lastSet ?? {}) };
      if (lastSet?.content !== undefined && lastSet.content !== base.content) {
        updated.revision = Number(base.revision ?? 1) + 1;
      }
      return [updated];
    }),
    execute: async (query: unknown) => {
      executedSql.push(sqlText(query));
      return [];
    },
    delete: () => chain(() => []),
  };
  return { tx: tx as unknown as ApiTransaction, ops, executedSql };
}

/** 服务在事务里已经写过跨空间传播？那守卫就晚了：这里要求拒绝发生在传播之前。 */
function fannedOut(fake: FakeTx): boolean {
  return fake.executedSql.some((text) => text.includes("ailearn_fanout_agent_global_preference"));
}

describe("新建账号级偏好", () => {
  it("普通全局偏好照常写入并铺开", async () => {
    const fake = fakeTx({ selects: [[]] });
    const item = await upsertMemory(fake.tx, SCOPE, {
      kind: "preference",
      content: "习惯晚上九点之后写笔记",
      userStated: true,
      candidate: false,
      scope: "global",
    });
    assert.equal(item.scope, "global");
    assert.ok(fake.ops.some((op) => op.op === "insert"), "普通全局偏好根本没写进去");
    assert.ok(fannedOut(fake), "账号级写入没有触发铺开：它在别的空间不会被记住");
  });

  it("非 preference 的种类不能写成全局", async () => {
    for (const kind of ["goal", "learning_context", "interaction_note", "episodic", "judgment"] as const) {
      const fake = fakeTx({ selects: [[]] });
      await assert.rejects(
        upsertMemory(fake.tx, SCOPE, { kind, content: "习惯晚上九点之后写笔记", scope: "global" }),
        (error: unknown) =>
          error instanceof MemoryGlobalScopeRejectedError && error.reason === "kind_not_preference",
        `${kind} 被写成了账号级`,
      );
      assert.equal(fake.ops.some((op) => op.op === "insert"), false, `${kind} 那条已经写进去了`);
    }
  });

  it("提到科目/当前书房的正文不能写成全局", async () => {
    for (const content of [
      "正在学数据库索引优化",
      "这个班的作业每周三交",
      "下个月要考日语N3",
    ]) {
      const fake = fakeTx({ selects: [[]] });
      await assert.rejects(
        upsertMemory(fake.tx, SCOPE, { kind: "preference", content, scope: "global" }),
        (error: unknown) =>
          error instanceof MemoryGlobalScopeRejectedError && error.reason === "content_workspace_bound",
        `「${content}」被写成了账号级`,
      );
      assert.equal(fake.ops.some((op) => op.op === "insert"), false);
      assert.equal(fannedOut(fake), false, "被拒之前就已经铺到别的空间去了");
    }
  });

  it("本地适用条件不能挂在账号级偏好上", async () => {
    const fake = fakeTx({ selects: [[]] });
    await assert.rejects(
      upsertMemory(fake.tx, SCOPE, {
        kind: "preference",
        content: "提醒我先看反例",
        appliesWhen: "复习这门课时",
        scope: "global",
      }),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "applies_when_workspace_bound",
    );
    assert.equal(fake.ops.some((op) => op.op === "insert"), false);
  });

  it("workspace / task 记忆照常写入：这条守卫只管账号级", async () => {
    for (const scope of ["workspace", "task", undefined] as const) {
      const fake = fakeTx({ selects: [[]] });
      const item = await upsertMemory(fake.tx, SCOPE, {
        kind: "goal",
        content: "下个月要考日语N3",
        scope,
      });
      assert.ok(item.memoryItemId);
      assert.ok(fake.ops.some((op) => op.op === "insert"), `scope=${String(scope)} 的正常写入被拦掉了`);
    }
  });
});

describe("同来源更新的两条分支", () => {
  it("命中既有行：改成涉及当前书房的内容时，一条 UPDATE 都不发", async () => {
    const existing = memoryRow({ scope: "global", globalKey: "44444444-4444-4444-8444-444444444444" });
    const fake = fakeTx({ selects: [[existing], [existing]] });
    await assert.rejects(
      upsertMemory(fake.tx, SCOPE, {
        kind: "preference",
        content: "正在学数据库索引优化",
        sourceEventId: "evt-1",
        scope: "global",
        userStated: true,
      }),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "content_workspace_bound",
    );
    assert.equal(fake.ops.some((op) => op.op === "update"), false, "源行被改了");
    assert.equal(fake.ops.some((op) => op.op === "insert"), false, "另起了一条");
    assert.equal(fannedOut(fake), false, "拒绝之前已经把副本铺出去了");
  });

  it("输入省略 scope：也不能把一条 global 行改成新的本地正文", async () => {
    // 省略 scope = 沿用库里的 global。这条路今天不会抛，但守卫按**最终**形状判，
    // 所以明天有人调换 coalesce 顺序也照样拦得住。
    const existing = memoryRow({ scope: "global", globalKey: "55555555-5555-4555-8555-555555555555" });
    const fake = fakeTx({ selects: [[existing], [existing]] });
    await assert.rejects(
      upsertMemory(fake.tx, SCOPE, {
        kind: "preference",
        content: "这个班的作业每周三交",
        sourceEventId: "evt-1",
        userStated: true,
      }),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "content_workspace_bound",
    );
    assert.equal(fake.ops.some((op) => op.op === "update"), false);
  });

  it("原子 upsert 命中既有 global 行：落库后的最终形状也要过判据", async () => {
    // 这一格是并发分支：`ON CONFLICT ... DO UPDATE` 的 applies_when 是
    // `coalesce(excluded.applies_when, 库里旧值)`——写入前看不见那一条旧值。
    // 只看输入字段的实现会在这里放过"输入干净、库里那条条件绑本地"的情况。
    const finalRow = memoryRow({
      scope: "global",
      content: "提醒我先看反例",
      appliesWhen: "复习这门课时",
      globalKey: "66666666-6666-4666-8666-666666666666",
    });
    const fake = fakeTx({ selects: [[]], insertedRow: finalRow });
    await assert.rejects(
      upsertMemory(fake.tx, SCOPE, {
        kind: "preference",
        content: "提醒我先看反例",
        sourceEventId: "evt-concurrent",
      }),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "applies_when_workspace_bound",
      "并发分支把一条账号级规则的条件改成了当前书房专属的那条，却没人拦",
    );
    assert.equal(fannedOut(fake), false, "拒绝之前就已经铺到别的空间去了");
  });
});

describe("修订已有账号级规则", () => {
  it("改成涉及科目/当前书房的内容：返回领域错误且一条 UPDATE 都不发", async () => {
    const existing = memoryRow({ scope: "global", globalKey: "77777777-7777-4777-8777-777777777777" });
    const fake = fakeTx({ selects: [[existing]] });
    await assert.rejects(
      correctMemory(fake.tx, SCOPE, existing.id as string, {
        content: "下个月要考日语N3",
        expectedRevision: 1,
      }),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "content_workspace_bound",
    );
    assert.equal(fake.ops.some((op) => op.op === "update"), false, "源行被改了：revision 与历史都会跟着动");
  });

  it("省略适用条件时沿用旧条件，旧条件也要判", async () => {
    const existing = memoryRow({
      scope: "global",
      appliesWhen: "复习这门课时",
      globalKey: "88888888-8888-4888-8888-888888888888",
    });
    const fake = fakeTx({ selects: [[existing]] });
    await assert.rejects(
      correctMemory(fake.tx, SCOPE, existing.id as string, {
        content: "提醒我先看反例",
        expectedRevision: 1,
      }),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "applies_when_workspace_bound",
      "本次没传条件就绕过了检查——省���不等于免检",
    );
    assert.equal(fake.ops.some((op) => op.op === "update"), false);
  });

  it("有效的一般偏好照常修订；条件显式清空按 null 的现役语义判", async () => {
    const existing = memoryRow({ scope: "global", appliesWhen: "我累的时候" });
    const fake = fakeTx({ selects: [[existing]] });
    const revised = await correctMemory(fake.tx, SCOPE, existing.id as string, {
      content: "提醒我先看反例，再看定义",
      expectedRevision: 1,
      appliesWhen: null,
    });
    assert.ok(revised);
    assert.equal(revised.appliesWhen, null, "清空条件没有生效");
    const update = fake.ops.find((op) => op.op === "update");
    assert.ok(update, "有效修订没有写进去");
    assert.equal(update.payload?.content, "提醒我先看反例，再看定义");
  });

  it("空间内规则（workspace）不受这条守卫约束", async () => {
    const existing = memoryRow({ scope: "workspace", content: "复习顺序偏好" });
    const fake = fakeTx({ selects: [[existing]] });
    const revised = await correctMemory(fake.tx, SCOPE, existing.id as string, {
      content: "正在学数据库索引优化，先复习索引",
      expectedRevision: 1,
    });
    assert.ok(revised, "空间内记忆的正常修订被账号级守卫拦掉了");
  });
});

describe("回执：稳定 4xx + 可读文案", () => {
  it("三种理由都是 4xx，并带着可执行的下一步", () => {
    for (const reason of ["kind_not_preference", "content_workspace_bound", "applies_when_workspace_bound"] as const) {
      const rejection = memoryGlobalScopeRejection(new MemoryGlobalScopeRejectedError(reason));
      assert.ok(
        rejection.statusCode >= 400 && rejection.statusCode < 500,
        `${reason} 回的是 ${rejection.statusCode}：不是 4xx 就没法和"重试就好"区分开`,
      );
      assert.equal(rejection.statusCode, MEMORY_GLOBAL_SCOPE_REJECTED_STATUS);
      assert.equal(rejection.body.error, "memory_global_scope_rejected", "错误码不稳定的回执没法被客户端分支处理");
      assert.equal(rejection.body.reason, reason, "理由没有原样回传，前端给不出针对性建议");
      assert.match(rejection.body.message, /当前书房/,
        `${reason} 的文案没有告诉用户接下来能做什么`);
    }
  });

  it("两条写入路由都把这个领域错误翻成 4xx，而不是让它冒成 500 或被当成功", () => {
    // 没有数据库就发不出真实请求，所以这里钉的是**映射挂在哪两条路由上**：
    // 少挂一条，那条路就会把拒绝当成内部错误（500）或更糟——当成成功。
    const source = readFileSync(new URL("../memory-routes.ts", import.meta.url), "utf8");
    const handled = source.match(/if \(error instanceof MemoryGlobalScopeRejectedError\)/g) ?? [];
    assert.equal(handled.length, 2, `只挂了 ${handled.length} 条写入路由`);
    const mapped = source.match(/memoryGlobalScopeRejection\(error\)/g) ?? [];
    assert.equal(mapped.length, 2, "有路由判断了错误却没走统一映射");
    assert.equal(
      source.split("reply.code(rejection.statusCode).send(rejection.body)").length - 1,
      2,
      "统一映射没有被两条路由都用来发回执",
    );
  });
});

test("守卫的位置不改变既有语义：自动抽取仍不得改写用户手写的版本", async () => {
  // 这条断言的是**放进去的位置**：authorType 早退在守卫之前，所以"用户手写的版本"
  // 连判据都不走，直接原样返回。把它挪到守卫之后或之前都会改变这个结果。
  const existing = memoryRow({ authorType: "user", scope: "global", content: "习惯晚上学习" });
  const fake = fakeTx({ selects: [[existing]] });
  const result = await upsertMemory(fake.tx, SCOPE, {
    kind: "preference",
    content: "正在学数据库索引优化",
    sourceEventId: "evt-user",
  });
  assert.equal(result.memoryItemId, existing.id);
  assert.equal(fake.ops.some((op) => op.op === "update"), false, "自动抽取改写了用户手写的版本");
});

describe("guided 提案确认链：拒绝也要有可读回执", () => {
  it("修订账号级规则被拒 → 4xx + 与记忆中心同一句文案，且不发 UPDATE", async () => {
    const existing = memoryRow({
      scope: "global",
      content: "习惯晚上九点之后写笔记",
      globalKey: "99999999-9999-4999-8999-999999999999",
    });
    const fake = fakeTx({ selects: [[existing]] });
    await assert.rejects(
      executeCompanionMemoryProposalAction({
        tx: fake.tx,
        workspaceId: SCOPE.workspaceId,
        userId: SCOPE.userId,
        proposal: { conversation_id: "44444444-4444-4444-8444-444444444444", source_message_id: null },
        payload: {
          kind: "revise_memory",
          memoryId: existing.id,
          expectedRevision: 1,
          content: "下个月要考日语N3",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CompanionConversationError,
          `提案链抛出的不是 companion 错误合同：${(error as Error)?.name}`);
        assert.equal(error.statusCode, 422, "不是 4xx 就会按 500 脱敏，用户看不到发生了什么");
        assert.equal(error.code, "INVALID_REQUEST");
        assert.equal(
          error.message,
          accountPreferenceRejectionMessage("content_workspace_bound"),
          "提案链的文案与记忆中心不是同一句：同一个拒绝说了两种话",
        );
        return true;
      },
    );
    assert.equal(fake.ops.some((op) => op.op === "update"), false, "提案链仍然把内容改了");
    assert.equal(fake.ops.some((op) => op.op === "insert"), false);
  });

  it("有效的账号级修订仍然走通提案链", async () => {
    const existing = memoryRow({ scope: "global", content: "习惯晚上九点之后写笔记" });
    const fake = fakeTx({ selects: [[existing]] });
    const outcome = await executeCompanionMemoryProposalAction({
      tx: fake.tx,
      workspaceId: SCOPE.workspaceId,
      userId: SCOPE.userId,
      proposal: { conversation_id: "44444444-4444-4444-8444-444444444444", source_message_id: null },
      payload: {
        kind: "revise_memory",
        memoryId: existing.id,
        expectedRevision: 1,
        content: "习惯晚上九点之后写笔记，白天只做采集",
      },
    });
    assert.equal(outcome?.resultRef, existing.id);
    assert.ok(fake.ops.some((op) => op.op === "update"), "正常的账号级修订被守卫拦掉了");
  });

  it("CAS 冲突仍然是 ACTION_STALE/409，不被新映射吞掉", async () => {
    const existing = memoryRow({ scope: "global", revision: 3 });
    const fake = fakeTx({ selects: [[existing]] });
    await assert.rejects(
      executeCompanionMemoryProposalAction({
        tx: fake.tx,
        workspaceId: SCOPE.workspaceId,
        userId: SCOPE.userId,
        proposal: { conversation_id: "44444444-4444-4444-8444-444444444444", source_message_id: null },
        payload: {
          kind: "revise_memory",
          memoryId: existing.id,
          expectedRevision: 1,
          content: "习惯晚上九点之后写笔记，白天只做采集",
        },
      }),
      (error: unknown) =>
        error instanceof CompanionConversationError
        && error.code === "ACTION_STALE"
        && error.statusCode === 409,
      "版本冲突被账号级拒绝的映射顶掉了：客户端会按 422 去重试而不是重新读取",
    );
  });
});