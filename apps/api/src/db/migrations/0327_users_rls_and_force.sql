-- 0327: 给 `public.users` 补行级安全，并把剩下一张 enabled-not-forced 的表补齐 FORCE。
--
-- ─── 为什么 users 一直是个洞 ───
--
-- 2026-09-29 审计发现：`users` 是**唯一一张既有身份数据、又完全没有 RLS 的表**。
-- 它存 `email` 与 `password_hash`，而 `infra/postgres/roles.sql:257` 给
-- `astella_api` 的是无差别授权
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO astella_api
--
-- 更糟的是**现有安全网结构性地看不见它**：
-- `schema-isolation-gate-postgres` 那道"零容忍"棘轮（`BASELINE_WITHOUT_RLS = []`）
-- 的查询带 `JOIN pg_attribute ... AND a.attname = 'workspace_id'`，只检查**带
-- workspace_id 列**的表。`users` 用的是 `id`，于是它对那道断言恒不可见。
--
-- 不是理论问题。`apps/api/src/integration-tests/users-rls-postgres.integration.ts`
-- 在本迁移**之前**实跑的结果（受限角色 astella_api，事务内设好上下文）：
--   - alice（workspace A）**读到了** bob（workspace B）的 email 与 password_hash
--   - alice 能**裸 SELECT users** 把整表拉出来
--   - alice 能 **UPDATE** bob 的 password_hash
-- 本迁移落地后，同一个文件的这三条必须转绿。
--
-- ─── 难点：登录路径没有会话上下文 ───
--
-- `identity/service.ts` 的 `loginWithPassword` 是**裸查询**：
--   db.query.users.findFirst({ where: eq(users.email, normalizedEmail) })
-- 没有事务，所以 `app.workspace_id` / `app.user_id` 都没设。任何"必须有 app.user_id"
-- 的策略都会让它返回 0 行——**所有人都登不进来**。
--
-- 所以登录这一条走 SECURITY DEFINER 函数 `astella_find_user_by_email`：
-- 这是"刻意的、有名字的、窄口径的"跨用户读路径，与 `jobs` 表那套
-- `astella_claim_job` / `astella_renew_job_lease` 是同一个既有模式
-- （见 0018 / 0022 迁移）。它只按 email 查一行，**不回写**。
--
-- 其余读路径都带上下文，逐条核过（`grep` 结果）：
--   - 读自己 FOR UPDATE ×3：identity/service.ts 的 withActorTransaction
--   - 读同空间成员（批量取 email） ×2：invite-service.ts，在 workspace 事务里
--   - INSERT：注册走 `withActorTransaction({ userId: newUserId })`——**actor 就是新用户本人**
--   - UPDATE ×4：changePassword / updateUserProfile / 改密 / 邀请开通，全是 self 写
--   - 换头像：原先是裸 `db.transaction` **没有上下文**，本迁移配套改成 withActorTransaction
--
-- ─── 与既有策略的形状对齐 ───
--
-- 沿用 sec01 系列的命名与 RESTRICTIVE/PERMISSIVE 配法：
--   RESTRICTIVE  tenant guard（workspace 级）+ PERMISSIVE 具体访问面。
-- 不写"47 张表"这类硬编码名单——名单会随迁移漂移，交给下面第 3 段的验证收口。

-- ─── 1. 登录用的窄口径 SECURITY DEFINER 读函数 ────────────────────────

CREATE OR REPLACE FUNCTION public.astella_find_user_by_email(p_email text)
RETURNS TABLE (
  id uuid,
  email text,
  password_hash text,
  role text,
  created_at timestamptz,
  updated_at timestamptz,
  personal_workspace_id uuid,
  display_name text,
  avatar_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, u.email, u.password_hash, u.role, u.created_at, u.updated_at,
           u.personal_workspace_id, u.display_name, u.avatar_url
    FROM public.users u
    WHERE u.email = p_email;
END;
$$;

COMMENT ON FUNCTION public.astella_find_user_by_email(text) IS
  '登录按 email 查用户。刻意 SECURITY DEFINER：登录发生在会话建立之前，'
  'app.user_id / app.workspace_id 都还没设，RLS 上下文不存在。'
  '只读一行、只读这一列集，不提供任何写能力。';

REVOKE ALL ON FUNCTION public.astella_find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_find_user_by_email(text) TO astella_api, astella_worker;

-- 2.3 需要的"这个人是不是我的同空间成员"判定。
--
-- 为什么不能直接在策略里写 EXISTS(SELECT ... FROM workspace_members)：
-- **策略里的子查询同样受 RLS 约束**。`workspace_members` 自己的策略是
-- `user_id = app.user_id`（sec01_v1_workspace_members_actor_read），
-- 于是 alice 在 users 策略里只能看见**她自己那一行** membership，
-- 看不见 carol 的——`invite-service.ts` 两处批量取同空间成员 email 会被挡成空。
-- 这就是 RLS 里最经典的那个坑：不 SECURITY DEFINER 的策略子查询会自我收窄。
--
-- 函数由迁移角色（表属主 + BYPASSRLS）创建，SECURITY DEFINER 下不受 RLS 约束。
-- `STABLE` 很重要：同一条语句里所有行传的参数相同，PG 只会算一次。
CREATE OR REPLACE FUNCTION public.astella_user_in_workspace(p_user_id uuid, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user_id IS NOT NULL
     AND p_workspace_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.workspace_members m
       WHERE m.user_id = p_user_id
         AND m.workspace_id = p_workspace_id
         AND m.left_at IS NULL
     );
$$;

COMMENT ON FUNCTION public.astella_user_in_workspace(uuid, uuid) IS
  '判某人是否是给定空间的活跃成员。SECURITY DEFINER 是必需的：'
  'workspace_members 自己有 RLS，策略里的裸子查询会被它收窄成"只看自己"。';

REVOKE ALL ON FUNCTION public.astella_user_in_workspace(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_user_in_workspace(uuid, uuid) TO astella_api, astella_worker;

-- ─── 2. users 的 RLS ─────────────────────────────────────────────────

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

-- 2.1 **不**给 users 加 RESTRICTIVE 空间守卫——这是踩过一次的坑，记在这里免得
--     下一个人按"别的表都有守卫"的惯例再补一条。
--
--     第一版写了 `RESTRICTIVE ... USING (id = app.user_id)`，想表达"租户隔离"。
--     PG 语义是 RESTRICTIVE 与 PERMISSIVE **AND** 组合，于是它把下面 2.3 的
--     "同空间成员可读"直接乘成 false：alice 读不到同空间的 carol，
--     而 `invite-service.ts` 两处批量取成员 email 靠的就是这条。
--
--     根因是 `users` **没有 workspace_id 列**——它不是"按空间分区的表"，
--     而是一张"按人"的表。空间隔离在这里的表达方式只能是
--     PERMISSIVE 策略里的 `astella_user_in_workspace(...)`（2.3），
--     套一层 workspace 语义的 RESTRICTIVE 守卫在概念上就是错的。
--
--     不设守卫也不会漏：RLS 开了之后默认拒绝，列出的 4 条 PERMISSIVE
--     没覆盖到的面（DELETE、别的角色、没上下文的裸查）全都是"读不到/改不动"。

-- 2.2 读自己
DROP POLICY IF EXISTS sec02_users_self_read ON public.users;
CREATE POLICY sec02_users_self_read ON public.users
  AS PERMISSIVE FOR SELECT TO astella_api, astella_worker
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- 2.3 读同空间的其他成员。
--     invite-service.ts 两处要批量取 workspace 成员的 email（邀请码消费人、
--     成员列表），没有这条就取不到——这是"加 RLS 最容易踩的坑"：
--     只按 user_id 判会把同空间的其他成员也挡掉。
DROP POLICY IF EXISTS sec02_users_workspace_member_read ON public.users;
CREATE POLICY sec02_users_workspace_member_read ON public.users
  AS PERMISSIVE FOR SELECT TO astella_api, astella_worker
  USING (
    public.astella_user_in_workspace(
      public.users.id,
      NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
  );

-- 2.4 注册：actor 就是新用户本人（`withActorTransaction({ userId: newUserId })`），
--     邀请开通同理。WITH CHECK 保证"只能插入 id 等于自己的行"。
DROP POLICY IF EXISTS sec02_users_self_insert ON public.users;
CREATE POLICY sec02_users_self_insert ON public.users
  AS PERMISSIVE FOR INSERT TO astella_api, astella_worker
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- 2.5 写自己（改资料 / 换头像 / 改密码）。不给 DELETE——删用户走工作区解散，
--     那是系统级动作，不在业务角色的策略面里。
DROP POLICY IF EXISTS sec02_users_self_update ON public.users;
CREATE POLICY sec02_users_self_update ON public.users
  AS PERMISSIVE FOR UPDATE TO astella_api, astella_worker
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- ─── 3. 补齐 FORCE（按当前状态批量跑，名单不硬编码）──────────────────
--
-- 0258 已经做过一次同样的批量补齐。之所以又出现缺口，是**它之后新建的表**
-- 只 ENABLE 没 FORCE。实库当前只剩 objective_review_holds_v2 一张。

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.relname);
    RAISE NOTICE 'RLS FORCE 已补：%', target.relname;
  END LOOP;
END
$$;

--> statement-breakpoint

-- ─── 4. fail-closed 验证 ────────────────────────────────────────────
--
-- 两条不变式都写成"违反就抛"，让迁移失败而不是留给下一次审计才发现：
--   4.1 users 必须 enabled **且** forced
--   4.2 全库不存在 enabled-not-forced 的表
--
-- 4.3 另加一条"users 必须有策略"：只 ENABLE 不建策略等于全表拒绝，
--     那会让所有人登不进来——比没 RLS 更糟，必须在这一层就挡住。

DO $$
DECLARE
  v_state text;
  v_policy_count int;
BEGIN
  SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
  INTO v_state
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'users' AND c.relkind = 'r';

  IF v_state IS DISTINCT FROM 'true/true' THEN
    RAISE EXCEPTION 'users 的 RLS 状态应为 enabled+forced，实际是 %', COALESCE(v_state, '表不存在');
  END IF;

  SELECT count(*) INTO v_policy_count
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'users' AND rowsecurity;

  IF v_policy_count = 0 THEN
    RAISE EXCEPTION 'users 已开 RLS 但一条策略都没有——那等于全表拒绝，所有人都会登不进来';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO v_state
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relrowsecurity AND NOT c.relforcerowsecurity;

  IF v_state IS NOT NULL THEN
    RAISE EXCEPTION '仍有表是 enabled-not-forced：%', v_state;
  END IF;
END
$$;
