-- 0362: 归档保留上限走回收区，不再硬删（40 §4.6.4 / §4.6.6）。
--
-- ## 要修的事实
--
-- 0346 的 `astella_enforce_companion_memory_retention()` 用两条**硬 DELETE**
-- 做归档保留上限：
--
--   1. 删掉已过声明期限的 archived 行；
--   2. 仍超上限就按 `importance / last_used_at / updated_at` 机械删到超额数 +64。
--
-- 硬删绕过了整条 §4.6.4 的删除边界：
--
--   - 不写 `deleted_at` / `purge_after` ⇒ **不进回收区**，用户无法恢复；
--   - 不写 `assistant_memory_source_suppressions` ⇒ 同源抽取会把同一条记忆
--     重新记一遍，删了个寂寞；
--   - `assistant_memory_items` 的版本捕获触发器是 `BEFORE UPDATE`/`INSERT`，
--     DELETE 根本不经它 ⇒ **没有版本快照**。
--
-- 而 §4.6.4 的原话是「记录动作、依据 ID、前后版本与作者……来源与版本记录是
-- 业务合同，**不能静默丢失**」。这条硬删路径是唯一一条会静默丢失版本的路径。
--
-- ## 改成什么
--
-- 两步都改成**软删 + 抑制墓碑**，与 `memory-service.ts` 的 `deleteMemory`
-- 同一条语义：deleted_at、purge_after = +30 天、写抑制。回收区里能恢复，
-- 到期之后才由 `astella_purge_expired_companion_memory` 真正清掉。
--
-- 容量语义不变：`budget_tier='archived' AND deleted_at IS NULL` 是容量统计的
-- 分母，所以软删之后这两行立刻不再占预算——「腾出了空间」这件事仍然成立，
-- 只是腾出来的方式从"消失"变成"可以捞回来"。
--
-- ## 为什么容量压力不该比用户删除更狠
--
-- 同一个动作，用户自己点删除是有意为之；后台按容量淘汰是机械的。
-- 让后者更难恢复，等于让系统对自己的容量压力比用户的意愿更不可逆。

-- statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_enforce_companion_memory_retention()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  limits record;
  archived_items integer;
  archived_bytes bigint;
  evicted integer := 0;
  reclaimed integer;
  n integer;
BEGIN
  SELECT * INTO limits FROM public.astella_companion_memory_retention_limits();

  SELECT count(*)::integer, COALESCE(sum(octet_length(content)), 0)::bigint
    INTO archived_items, archived_bytes
    FROM public.assistant_memory_items
   WHERE budget_tier = 'archived'
     AND deleted_at IS NULL;

  IF archived_items <= limits.limit_items AND archived_bytes <= limits.limit_bytes THEN
    RETURN 0;
  END IF;

  -- 第一步：已过**声明期限**的。这些不是「被容量挤掉的」，它们本来就该过期。
  WITH reclaimed AS (
    UPDATE public.assistant_memory_items
       SET deleted_at = now(),
           purge_after = now() + interval '30 days',
           updated_at = now()
     WHERE budget_tier = 'archived'
       AND deleted_at IS NULL
       AND valid_until IS NOT NULL
       AND valid_until <= now()
     RETURNING id, kind, source_event_id
  ), suppressed AS (
    INSERT INTO public.assistant_memory_source_suppressions (user_id, kind, source_event_id)
    SELECT user_id, kind, source_event_id FROM reclaimed
     WHERE source_event_id IS NOT NULL
    ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO reclaimed FROM reclaimed;

  SELECT count(*)::integer, COALESCE(sum(octet_length(content)), 0)::bigint
    INTO archived_items, archived_bytes
    FROM public.assistant_memory_items
   WHERE budget_tier = 'archived'
     AND deleted_at IS NULL;

  -- 第二步：仍超上限则按机械顺序把最不重要的挪进回收区。
  -- pinned 的不参与（§4.6.6：「固定表达重要性」——反过来也一样，
  -- 固定的东西不该因为容量压力被悄悄淘汰）。
  IF archived_items > limits.limit_items OR archived_bytes > limits.limit_bytes THEN
    WITH removable AS (
      SELECT id
        FROM public.assistant_memory_items
       WHERE budget_tier = 'archived'
         AND deleted_at IS NULL
         AND pinned = false
       ORDER BY importance ASC, last_used_at ASC NULLS FIRST, updated_at ASC, id ASC
       LIMIT GREATEST(archived_items - limits.limit_items, 0) + 64
    ), reclaimed AS (
      UPDATE public.assistant_memory_items
         SET deleted_at = now(),
             purge_after = now() + interval '30 days',
             updated_at = now()
       WHERE id IN (SELECT id FROM removable)
       RETURNING id, kind, source_event_id
    ), suppressed AS (
      INSERT INTO public.assistant_memory_source_suppressions (user_id, kind, source_event_id)
      SELECT user_id, kind, source_event_id FROM reclaimed
       WHERE source_event_id IS NOT NULL
      ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::integer INTO n FROM reclaimed;
    reclaimed := COALESCE(reclaimed, 0) + n;
  END IF;

  RETURN COALESCE(reclaimed, 0);
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_enforce_companion_memory_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enforce_companion_memory_retention() TO astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_enforce_companion_memory_retention() TO astella_api;