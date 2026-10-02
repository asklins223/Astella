import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkspaceTransactionContextCompatible,
  normalizeWorkspaceTransactionContext,
  scopeOfSession,
  WorkspaceTransactionContextError,
} from "../db/client.ts";

const WORKSPACE_ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const USER_ID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

test("workspace transaction context validates and canonicalizes UUIDs without a database", () => {
  assert.deepEqual(
    normalizeWorkspaceTransactionContext({ workspaceId: ` ${WORKSPACE_ID} `, userId: USER_ID }),
    {
      workspaceId: WORKSPACE_ID.toLowerCase(),
      userId: USER_ID.toLowerCase(),
    },
  );
  assert.throws(
    () => normalizeWorkspaceTransactionContext({ workspaceId: "not-a-uuid", userId: USER_ID }),
    WorkspaceTransactionContextError,
  );
  assert.throws(
    () => normalizeWorkspaceTransactionContext({ workspaceId: WORKSPACE_ID, userId: "" }),
    WorkspaceTransactionContextError,
  );
  assert.throws(
    () => normalizeWorkspaceTransactionContext({ workspaceId: WORKSPACE_ID, userId: null as never }),
    WorkspaceTransactionContextError,
  );
});

test("nested workspace transaction context fails closed on tenant or actor changes", () => {
  const active = normalizeWorkspaceTransactionContext({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  assert.doesNotThrow(() => assertWorkspaceTransactionContextCompatible(active, { ...active }));
  assert.throws(
    () => assertWorkspaceTransactionContextCompatible(active, {
      workspaceId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      userId: active.userId,
    }),
    /cannot change workspace or user context/,
  );
  assert.throws(
    () => assertWorkspaceTransactionContextCompatible(active, {
      workspaceId: active.workspaceId,
      userId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    }),
    /cannot change workspace or user context/,
  );
});

/**
 * 回归：`scopeOfSession` 曾把函数体写成 `return scopeOfSession(session)`——
 * 一次「把 120 处作用域字面量收口成函数」的重构里，函数体本身也被替成了自调用。
 *
 * 后果不是编译失败，而是**运行期栈溢出**：168 个调用点 / 36 个文件全部 500
 * （`RangeError: Maximum call stack size exceeded`，表面看像容器或 DB 问题）。
 *
 * 两条断言缺一不可：
 * - 深Equal 是**正控制**——证明它真的取到了 session 的两个字段；
 * - 不抛是**回归本体**——自调用会抛 RangeError，直接把这条打红。
 * 只有「不抛」而没有深Equal 的话，一个恒返回 undefined 的空实现也能骗过它。
 */
test("scopeOfSession returns the session scope and never recurses into itself", () => {
  const session = { workspaceId: WORKSPACE_ID, userId: USER_ID };
  const scope = scopeOfSession(session);
  assert.deepEqual(scope, { workspaceId: WORKSPACE_ID, userId: USER_ID });
  // 两个不同的 session 必须互不串味（防止实现被改成复用某个模块级缓存）。
  const other = { workspaceId: "cccccccc-cccc-cccc-cccc-cccccccccccc", userId: "dddddddd-dddd-dddd-dddd-dddddddddddd" };
  assert.deepEqual(scopeOfSession(other), other);
  assert.deepEqual(scopeOfSession(session), session);
});
