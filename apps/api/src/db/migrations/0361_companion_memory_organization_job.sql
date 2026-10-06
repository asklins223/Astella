-- 0361: 把后台语义整理真正接上电（40 §4.6.3 / §4.6.9）。
--
-- ## 要修的事实
--
-- `companion-memory-organization.ts` 里五样东西都写好了：
--   memoryOrganizationGate / memoryOrganizationBatchSize
--   acquireMemoryOrganizationLease / commitMemoryOrganization / memoryOrganizationSurface
-- 0340 之前那一版（0350）也建好了 `companion_memory_organization_state` 的
-- `surface` 列与租约表。**但它们一个生产调用方都没有**：
--
--   - worker 的 job 自入队白名单里没有整理任务类型（0213）；
--   - 没有任何调度器去算「自上次成功整理以来的累计积压」；
--   - 因此租约永远拿得到，`surface` 永远是 NULL，`companion_read_playbook`
--     永远展开不出一条记录。
--
-- 也就是说 §4.6.3 的周期整理、§4.6.9 的交接后整理、§4.6.10 的手册
-- **在今天的产品里一次也不会跑**。判据写得对，但没人调它。
--
-- ## 为什么入队要在数据库侧
--
-- 积压是「跨全部 (workspace_id, user_id) 的计数」，RLS 下 worker 读不到别人的行。
-- 同目录的日记调度（0332/0333）也是这个理由走 SECURITY DEFINER。
-- 阈值本身不重写：30 条 + 7 天 + 最旧 30 天兜底三档判据已经在
-- `memoryOrganizationGate` 里并且有单测；这里只负责**把够格的用户挑出来投 job**，
-- 真正的「这一轮要不要跑、跑多少条」仍由 worker 侧那份判据决定——
-- 两处各判一次是有意的：DB 侧少投（省掉不必要的 job），
-- worker 侧多判一次（租约与积压可能在这几秒里变了）。
--
-- ## 顺带把 job 类型加进白名单
--
-- 不加就插不进去：`jobs` 上有一条 `worker_type_allowlist_insert_guard` RLS 策略，
-- worker 只能投这四种 type。

-- statement-breakpoint

DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard" ON public.jobs;
CREATE POLICY "worker_type_allowlist_insert_guard"
  ON public.jobs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'astella_worker'::name
    AND "type" IN (
      'companion_agent', 'companion_memory_extract', 'companion_summarizer',
      'companion_daily_summary', 'companion_memory_organize'
    )
  );

--> statement-breakpoint

-- 积压判据的三个数字。数字在这里、阈值判据在 worker 的
-- memoryOrganizationGate —— 两处写同一个数会漂移，所以由
-- `0361-companion-memory-organization-job-migration.test.ts`
-- 断言它们与 TS 那边一致。
CREATE OR REPLACE FUNCTION public.astella_companion_memory_organization_thresholds()
RETURNS TABLE (min_backlog bigint, min_interval_days int, oldest_pending_days int)
LANGUAGE sql
STABLE
AS $$
  SELECT 30::bigint, 7::int, 30::int;
$$;

--> statement-breakpoint

-- 挑出「够格整理」的 (workspace_id, user_id) 并投 job。
--
-- 三档判据与 40 §4.6.3 一一对应：
--   1. 有上次成功整理时间：积压 ≥30 **且** 距上次 ≥7 天；
--   2. 从没整理过：按**最早待处理**那条计时，满 30 天也做（有预算的小批）；
--   3. 有积压但两项都不够：不动。
--
-- 「累计待处理量」的分子是**真的待整理**的行：没删、没忽略、没归档、
-- 不是候选、没被抑制、有来源。它不是「当天新增」——那是会让低频用户
-- 永远不触发的分母。
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_memory_organize()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_thresholds record;
  v_inserted integer := 0;
  v_row record;
BEGIN
  SELECT * INTO v_thresholds FROM public.astella_companion_memory_organization_thresholds();

  FOR v_row IN
    WITH pending AS (
      SELECT m.workspace_id,
             m.user_id,
             MIN(m.updated_at) AS oldest_pending_at,
             COUNT(*)::bigint AS backlog
        FROM public.assistant_memory_items m
       WHERE m.deleted_at IS NULL
         AND m.candidate = false
         AND m.dismissed_at IS NULL
         AND m.archived_at IS NULL
         AND m.kind <> 'judgment'
       GROUP BY m.workspace_id, m.user_id
      HAVING COUNT(*) > 0
    ),
    last_done AS (
      SELECT workspace_id, user_id, last_success_at
        FROM public.companion_memory_organization_state
    )
    SELECT p.workspace_id, p.user_id
      FROM pending p
      LEFT JOIN last_done d
        ON d.workspace_id = p.workspace_id AND d.user_id = p.user_id
     WHERE (
       -- 从没整理过：按最早待处理那条计时，满窗口就做一次有界小批。
       d.last_success_at IS NULL
         AND p.oldest_pending_at <= now() - make_interval(days => v_thresholds.oldest_pending_days)
     ) OR (
       -- 正常路径：两个条件同时成立。
       d.last_success_at IS NOT NULL
         AND p.backlog >= v_thresholds.min_backlog
         AND d.last_success_at <= now() - make_interval(days => v_thresholds.min_interval_days)
     )
  LOOP
    INSERT INTO public.jobs
      (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
    VALUES (
      'companion_memory_organize',
      v_row.workspace_id,
      v_row.user_id,
      jsonb_build_object('userId', v_row.user_id::text),
      'pending', 40, 'maintenance',
      'companion-memory-organize:' || v_row.workspace_id::text || ':' || v_row.user_id::text
        || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    )
    ON CONFLICT (workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING;
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_enqueue_companion_memory_organize() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.astella_companion_memory_organization_thresholds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_memory_organize() TO astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_companion_memory_organization_thresholds() TO astella_worker;