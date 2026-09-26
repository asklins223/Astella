/**
 * 公共 HTTP 出口闸门的真库对照（39d W3-2 第三刀）。
 *
 * `assertOutsideRegisteredTransactions` 的判据逻辑在 shared 单测里用**假读者**证过；
 * 这一份要证的只有一件事：**worker 进程真的把自己的作用域读者登记进去了**
 * （`db.ts` 模块加载时那次 `registerActiveTransactionReader` 不是摆设）——
 *   - 在真的 `withWorkerWorkspaceTransaction`（`ailearn_worker` 受限角色）里发起
 *     一次公共 HTTP 请求，会被 `ExternalCallInsideTransactionError` 当场拒掉；
 *   - 事务外同一个请求不再报这道闸（失败来自 SSRF 守卫/连接层，而不是事务边界）。
 *
 * 端点用 `https://127.0.0.1:1/`（确定性快速失败，不花钱）。它可能被 SSRF 守卫
 * （非公共地址）或连接拒绝挡下——两种失败都不是 `ExternalCallInsideTransactionError`，
 * 负对照要的正是这个区分。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { ExternalCallInsideTransactionError } from "@ailearn/shared/workspace-transaction";

process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");

const { withWorkerWorkspaceTransaction, closeDatabase } = await import("../db.ts");
const { postJsonToPublicEndpoint } = await import("@ailearn/shared/public-json-http");

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const PROBE_URL = "https://127.0.0.1:1/v1/chat/completions";

after(async () => {
  await closeDatabase().catch(() => undefined);
});

test("事务内发公共 HTTP：被出口闸门当场拒绝（worker 的作用域读者已登记）", async () => {
  await assert.rejects(
    () => withWorkerWorkspaceTransaction(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      async () => postJsonToPublicEndpoint(PROBE_URL, {}, { probe: true }),
    ),
    ExternalCallInsideTransactionError,
  );
});

test("事务外同一请求：不再报闸门（失败来自连接层，而不是事务边界）", async () => {
  await assert.rejects(
    () => postJsonToPublicEndpoint(PROBE_URL, {}, { probe: true }),
    (error: unknown) => !(error instanceof ExternalCallInsideTransactionError),
  );
});
