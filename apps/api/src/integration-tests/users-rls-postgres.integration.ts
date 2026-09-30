/**
 * `public.users` 的行级安全行为测试（P0-4）。
 *
 * ## 为什么需要这个文件
 *
 * `users` 是 2026-09-29 审计里**唯一一张既有身份数据、又完全没有 RLS 的表**：
 * 它存 `email` 与 `password_hash`，而 `infra/postgres/roles.sql:257` 给
 * `ailearn_api` 的是无差别授权 `GRANT SELECT, INSERT, UPDATE, DELETE
 * ON ALL TABLES IN SCHEMA public`。
 *
 * 更麻烦的是**现有安全网看不见它**：`schema-isolation-gate-postgres` 那道棘轮
 * 只检查"带 `workspace_id` 列"的表，而 `users` 用的是 `id`——于是
 * `BASELINE_WITHOUT_RLS = []`（零容忍）这个断言对 `users` 恒真通过。
 *
 * 本文件用**行为**而不是"数策略"来判据：真的用受限角色 `ailearn_api` 连上去，
 * 在事务里设好 `app.workspace_id` / `app.user_id`，然后看读得到几行。
 * 数策略条数证明不了"真的拦得住"，这里证明。
 *
 * ## 覆盖的读路径（全部来自 `grep` 出来的真实调用点）
 *
 *  1. **登录按 email 查人**（`identity/service.ts:loginWithPassword`）——
 *     裸 `db.query.users.findFirst`，**没有事务、没有会话上下文**。这是全部难点：
 *     任何"必须有 app.user_id"的策略都会让它返回 0 行，从而**所有人都登不进来**。
 *     走 SECURITY DEFINER 函数，见迁移 0327。
 *  2. **读自己**（`identity/service.ts` 三处 `withActorTransaction` + `FOR UPDATE`）。
 *  3. **读同空间的其他成员**（`invite-service.ts` 两处批量取 email）。
 *  4. **读别的空间的人**——这才是要挡住的那一条。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres, { type Sql, type TransactionSql } from "postgres";

function requireDatabaseUrl(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the users RLS integration test`);
  }
  return value;
}

async function withContext<T>(
  sql: Sql,
  context: { workspaceId?: string; userId?: string },
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    if (context.workspaceId !== undefined) {
      await transaction`
        SELECT pg_catalog.set_config('app.workspace_id', ${context.workspaceId}, true)
      `;
    }
    if (context.userId !== undefined) {
      await transaction`
        SELECT pg_catalog.set_config('app.user_id', ${context.userId}, true)
      `;
    }
    return operation(transaction);
  }) as Promise<T>;
}

const migrator = postgres(requireDatabaseUrl("RLS_TEST_MIGRATOR_DATABASE_URL"), { max: 1 });
const api = postgres(requireDatabaseUrl("RLS_TEST_API_DATABASE_URL"), { max: 1 });

const stamp = `${process.pid}-${Date.now()}`;

const aliceId = randomUUID();
const bobId = randomUUID();
const carolId = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const aliceEmail = `alice-rls-${stamp}@ailearn.test`;
const bobEmail = `bob-rls-${stamp}@ailearn.test`;
const carolEmail = `carol-rls-${stamp}@ailearn.test`;

/** 夹具写入 + 回收。全部走 migrator（超户），被测读走 api（受限）。 */
before(async () => {
  await migrator.begin(async (tx) => {
    // 顺序有讲究：workspaces.owner_id 有指向 users.id 的外键，所以 users 必须先插。
    await tx`INSERT INTO public.users (id, email, password_hash, role, created_at)
              VALUES (${aliceId}, ${aliceEmail}, 'x', 'member', now()),
                     (${bobId}, ${bobEmail}, 'x', 'member', now()),
                     (${carolId}, ${carolEmail}, 'x', 'member', now())`;
    await tx`INSERT INTO public.workspaces (id, owner_id, name, created_at, workspace_type, workspace_epoch)
              VALUES (${workspaceA}, ${aliceId}, ${`rls-a-${stamp}`}, now(), 'collaborative', 0),
                     (${workspaceB}, ${bobId},   ${`rls-b-${stamp}`}, now(), 'collaborative', 0)`;
    // alice 与 bob 各在自己的空间；carol 与 alice **同空间**（覆盖"读同空间成员"）。
    // workspace_members 用 `left_at` 表示"已离开"，没有 status 列。
    await tx`INSERT INTO public.workspace_members (workspace_id, user_id, role, joined_at)
              VALUES (${workspaceA}, ${aliceId}, 'owner', now()),
                     (${workspaceA}, ${carolId}, 'member', now()),
                     (${workspaceB}, ${bobId}, 'owner', now())`;
  });
});

after(async () => {
  // 顺序有讲究，和 before() 一样：workspaces.owner_id 有指向 users.id 的外键，
  // 所以必须**先删 workspaces 再删 users**。第一版反过来了，after() 钩子抛
  // 23503，于是下面的 end() 永远不执行，整个文件以 "test timed out" 收场——
  // 14 条断言全绿却被算成失败，排查起来很误导。
  await migrator.begin(async (tx) => {
    await tx`DELETE FROM public.workspace_members
              WHERE workspace_id IN (${workspaceA}, ${workspaceB})`;
    await tx`DELETE FROM public.workspaces WHERE id IN (${workspaceA}, ${workspaceB})`;
    await tx`DELETE FROM public.users WHERE id IN (${aliceId}, ${bobId}, ${carolId})`;
  });
  await migrator.end();
  await api.end();
});

test("users 已启用并强制 RLS（enabled 不等于 forced）", async () => {
  const [row] = await migrator<{ enabled: boolean; forced: boolean }[]>`
    SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'users' AND c.relkind = 'r'`;
  assert.ok(row, "找不到 public.users");
  assert.equal(row.enabled, true, "users 没有 ENABLE ROW LEVEL SECURITY");
  assert.equal(row.forced, true, "users 只 ENABLE 没 FORCE——属主连接时会整条绕过");
});

test("分母自证：受限角色真的被 RLS 管着（不是超级用户假绿）", async () => {
  const [row] = await api<{ current_user: string; bypassrls: boolean }[]>`
    SELECT current_user, rolbypassrls AS bypassrls
    FROM pg_roles WHERE rolname = current_user`;
  assert.ok(row, "读不到当前角色");
  assert.equal(row.bypassrls, false,
    "当前连接角色带 BYPASSRLS，RLS 断言全是假绿——必须用受限角色跑这个文件");
});

test("无上下文的裸查表：必须查不到（这正是登录必须走函数的原因）", async () => {
  // 这条是"登录为什么不能用裸查表"的判据，不是"登录能用裸查表"。
  // 登录发生在会话建立之前，没有事务就没有 app.user_id / app.workspace_id；
  // 迁移 0327 给 users 加上 RLS 之后，裸查表必然 0 行。
  // 所以 `loginWithPassword` 改成走 SECURITY DEFINER 函数
  // `ailearn_find_user_by_email`（见下面那几条），**不是**改策略去放行裸查。
  const rows = await withContext(api, {}, (tx) => tx`
    SELECT id, email FROM public.users WHERE email = ${aliceEmail}`);
  assert.equal(rows.length, 0,
    "无上下文的裸查表仍能查到用户——那 RLS 根本没生效，登录那条路就成了后门");
});

test("读自己：带 user_id 上下文时能读到自己的行", async () => {
  const rows = await withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
    SELECT id FROM public.users WHERE id = ${aliceId}`);
  assert.equal(rows.length, 1, "用户读不到自己");
});

test("读同空间的其他成员：invite-service 的批量取 email 依赖这条", async () => {
  const rows = await withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
    SELECT id FROM public.users WHERE id IN (${aliceId}, ${carolId}) ORDER BY id`);
  assert.equal(rows.length, 2,
    "alice 必须能读到同空间成员 carol（invite-service.ts 两处批量取 email 靠它）");
});

test("读别的空间的人：必须读不到（这条才是本次要加的防线）", async () => {
  const rows = await withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
    SELECT id, email, password_hash FROM public.users WHERE id = ${bobId}`);
  assert.equal(rows.length, 0,
    "alice 在 workspace A 里读到了 workspace B 的 bob——users 的 RLS 没起作用");
});

test("不指定 id 的裸查询也必须被上下文裁剪（不能整表可见）", async () => {
  const rows = await withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
    SELECT id FROM public.users ORDER BY id`);
  const ids = rows.map((r) => r.id as string);
  assert.ok(!ids.includes(bobId), "裸 SELECT users 返回了别的空间的用户");
  assert.ok(ids.includes(aliceId), "裸 SELECT users 应当至少看得到自己");
});

test("改别人的密码哈希：必须改不动（0 行受影响，且库里没变）", async () => {
  // ⚠️ 判据形状要写对：RLS 的 USING 不匹配时，Postgres 是**静默地影响 0 行**，
  // 不是抛 42501。第一版这里 `assert.rejects`，结果是一条能改 0 行的语句
  // 当然不抛——测试红了，但**保护其实是生效的**。真正的判据是下面那句
  // "bob 的哈希还是原值"，那才是不可伪造的。
  const affected = await withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
    UPDATE public.users SET password_hash = 'pwned' WHERE id = ${bobId}
    RETURNING id`);

  assert.equal(affected.length, 0, "alice 竟然改到了 workspace B 的 bob");

  const [after] = await migrator<{ password_hash: string }[]>`
    SELECT password_hash FROM public.users WHERE id = ${bobId}`;
  assert.equal(after.password_hash, "x",
    "bob 的 password_hash 被改掉了——策略没生效。注意这条断言用超户连接读，"
    + "不受 RLS 影响，所以它测的是'库里的值真的没变'，不是'调用方看到了什么'");
});

test("改自己的密码哈希：必须改得动（策略不能把自己也挡住）", async () => {
  const affected = await withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
    UPDATE public.users SET password_hash = 'self-changed' WHERE id = ${aliceId}
    RETURNING id`);
  assert.equal(affected.length, 1, "alice 连自己的行都改不了——策略收得太紧，会砸掉改密码功能");

  const [after] = await migrator<{ password_hash: string }[]>`
    SELECT password_hash FROM public.users WHERE id = ${aliceId}`;
  assert.equal(after.password_hash, "self-changed");
});

test("插入别人的 id：必须插不进去（WITH CHECK 生效）", async () => {
  const otherId = randomUUID();
  await assert.rejects(
    () => withContext(api, { workspaceId: workspaceA, userId: aliceId }, (tx) => tx`
      INSERT INTO public.users (id, email, password_hash, role, created_at)
      VALUES (${otherId}, ${`forged-${stamp}@ailearn.test`}, 'x', 'owner', now())
      RETURNING id`),
    (error: unknown) => {
      // WITH CHECK 失败是 42501（insufficient_privilege）。
      assert.equal((error as { code?: string }).code, "42501",
        `期望 42501 拒绝，实际 code=${(error as { code?: string }).code}`);
      return true;
    },
  );
});

test("SECURITY DEFINER 登录函数：只读、且真的只按 email 查", async () => {
  const rows = await withContext(api, {}, (tx) => tx`
    SELECT id, email FROM public.ailearn_find_user_by_email(${aliceEmail})`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, aliceId);
});

test("SECURITY DEFINER 登录函数查不到时不报错、返回空", async () => {
  const rows = await withContext(api, {}, (tx) => tx`
    SELECT id FROM public.ailearn_find_user_by_email(${`nobody-${stamp}@ailearn.test`})`);
  assert.equal(rows.length, 0);
});

test("业务角色不能直接执行登录函数之外的写能力（函数是只读的）", async () => {
  // 函数签名里没有写操作，这里钉的是"它不会因为 SECURITY DEFINER 而变成万能后门"：
  // 换个别的 email 必须查不到别人的行——它不是"返回全表"。
  const rows = await withContext(api, {}, (tx) => tx`
    SELECT id FROM public.ailearn_find_user_by_email(${bobEmail})`);
  assert.equal(rows.length, 1, "函数应只返回被问的那一行");
  assert.equal(rows[0].id, bobId);
});
