-- 0350: 后台整理的**串行租约**与提交状态（40 §4.6.9）。
--
-- ## 合同要求
--
--   「同一 `(workspace_id, user_id)` 的后台整理**串行**，最多一项整理任务持有提交租约；
--     用户纠正与删除仍可即时提交并推进 revision，不等待模型。」
--   「模型只拿快照与必要记忆版本，在**事务外**生成改动建议。提交时复查当前来源权限、
--     删除抑制与各条版本；**冲突不覆盖用户新修改**。」
--
-- ## 为什么租约必须是**数据库**的，而不是进程内的
--
-- 整理跑在 worker 上，而 worker 有多个副本。进程内的互斥只能防住"同一个进程里
-- 两次整理撞车"，防不住"两个副本各整理一次"——而那正是本条要禁止的：
-- 两份整理建议同时按 revision 提交，后到的那份要么覆盖先到的，要么被静默丢弃。
--
-- 做法是**唯一约束**，不是应用层判断：`PRIMARY KEY (workspace_id, user_id)` 让
-- 第二个租约插不进去。哪怕将来有人忘了先查再插，数据库也会挡住。
--
-- ## 纠正与删除为什么不受这个租约约束
--
-- 它们走的是自己的路径（`memory-service.correctMemory` / `deleteMemory`），
-- 不申请这张租约，也不等它释放——这就是合同那句「用户纠正与删除仍可即时提交」。
-- 两者相遇时，**用户赢**：整理提交时按 revision 复查，用户改过的那条就跳过。
--
-- ## 状态表与租约分开
--
-- `..._state` 记的是「上次成功整理到哪儿了」，它比租约活得久；
-- `..._leases` 记的是「现在谁在整理」，它有到期时间。
-- 分开的理由：租约过期要能被回收，而"上次成功"不能因为租约丢失就清零——
-- 否则一次崩溃就会让累计积压从头算，等于给「低频用户永远不触发」开了个后门。

--> statement-breakpoint

CREATE TABLE public.companion_memory_organization_state (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 上一次**成功**整理的时刻。分母从这里起算（§4.6.3「自上次成功整理以来的累计待处理量」）。
  last_success_at timestamptz,
  -- 上一次成功的待处理条数，用来判断"这一轮清了没有"。
  last_success_backlog integer NOT NULL DEFAULT 0,
  -- 最近一次整理返回的那段 surface 结论（§4.6.9「至多返回一段」）。
  -- 纯文本、可为 null；**不**存正文副本。
  surface text CHECK (surface IS NULL OR char_length(surface) <= 240),
  surface_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_memory_organization_state_pkey
    PRIMARY KEY (workspace_id, user_id)
);

--> statement-breakpoint

COMMENT ON COLUMN public.companion_memory_organization_state.last_success_at IS
  '上一次**成功**整理的时刻。失败不改写它——否则一次反复失败的整理会把间隔'
  '窗口无限往后推，而积压一直不清。';

--> statement-breakpoint

CREATE TABLE public.companion_memory_organization_leases (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 持有者标识（副本 id + job id）。到期后由回收函数清掉。
  holder text NOT NULL CHECK (char_length(holder) BETWEEN 1 AND 200),
  run_id uuid,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  -- 到期时间：worker 崩溃时租约不会永久占住，否则这个用户**再也不会**被整理。
  expires_at timestamptz NOT NULL,
  CONSTRAINT companion_memory_organization_leases_pkey
    PRIMARY KEY (workspace_id, user_id)
);

--> statement-breakpoint

COMMENT ON TABLE public.companion_memory_organization_leases IS
  '每个 (workspace,user) 同时最多一条 —— §4.6.9「最多一项整理任务持有提交租约」。'
  '唯一约束就是那个"最多一项"；应用层先查后插只是为了让错误更好读。';

--> statement-breakpoint

-- 回收过期租约。放在租约表上而不是应用层：崩溃的副本不会执行任何清理。
CREATE OR REPLACE FUNCTION public.astella_reclaim_stale_memory_organization_leases()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cleared AS (
    DELETE FROM public.companion_memory_organization_leases
     WHERE expires_at <= now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM cleared;
$$;

--> statement-breakpoint

-- 提交一次整理：先复查 revision，再推进 last_success_at。
--
-- 复查放在**事务内且带 WHERE 条件**，而不是先 SELECT 再 UPDATE——后者在并发纠正下
-- 会用一份过期的判断去覆盖用户刚写下的内容。
--
-- 返回 false 表示"本轮没能提交"：要么租约不在手里，要么状态被别人推进过。
-- 两种情况下调用方都**不得**把建议当成已落地（§4.6.9「冲突不覆盖用户新修改」）。
CREATE OR REPLACE FUNCTION public.astella_commit_memory_organization(
  p_workspace_id uuid,
  p_user_id uuid,
  p_holder text,
  p_surface text,
  p_backlog integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  committed integer;
BEGIN
  -- 租约必须在手里，且没过期。过期租约持有一轮再提交，等于让一个已经不存在的
  -- 进程写进状态。
  DELETE FROM public.companion_memory_organization_leases
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND holder = p_holder
     AND expires_at > now();

  UPDATE public.companion_memory_organization_state
     SET last_success_at = now(),
         last_success_backlog = p_backlog,
         surface = CASE WHEN p_surface IS NULL THEN NULL ELSE left(p_surface, 240) END,
         surface_at = CASE WHEN p_surface IS NULL THEN surface_at ELSE now() END,
         updated_at = now()
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     -- 冲突不覆盖：别人已经推进过状态（多半是并发的另一轮或一次纠正），本轮让位。
     AND (last_success_at IS NULL OR last_success_at <= now() - interval '1 second')
   RETURNING 1 INTO committed;

  RETURN committed IS NOT NULL;
END;
$$;

--> statement-breakpoint

ALTER TABLE public.companion_memory_organization_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_memory_organization_state FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_memory_organization_state_user_isolation
  ON public.companion_memory_organization_state FOR ALL
  USING (
    CURRENT_USER = 'astella_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'astella_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

ALTER TABLE public.companion_memory_organization_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_memory_organization_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY companion_memory_organization_leases_user_isolation
  ON public.companion_memory_organization_leases FOR ALL
  USING (
    CURRENT_USER = 'astella_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'astella_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_memory_organization_state TO astella_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_memory_organization_leases TO astella_worker;
GRANT SELECT ON public.companion_memory_organization_state TO astella_api;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_reclaim_stale_memory_organization_leases() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.astella_commit_memory_organization(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_reclaim_stale_memory_organization_leases() TO astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_commit_memory_organization(uuid, uuid, text, text, integer) TO astella_worker;