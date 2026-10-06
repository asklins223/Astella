-- 0346: `archived` 层也要受**保留上限**约束（40 §4.6.6 / A74）。
--
-- 合同原话：
--   §4.6.6「archived | 数量与有界搜索入口 | 不常驻上下文；**仍受全量存储/保留预算
--          和权限约束，不承诺无限增长**」
--   A74「累计触发可达；token/条数双预算，**归档也受保留上限**」
--
-- 补的是什么：0344 给了三层里的 `resident` 完整双预算，但 `archived` 只有
-- "数量与有界搜索入口"，**没有任何上限**——所以它实际上就是无界增长。
--
-- ## 为什么是「淘汰」而不是「拒绝移入」
--
-- 最直白的做法是像 resident 那样，在 `astella_move_companion_memory_budget_tier`
-- 里拒绝超预算的移入。但那会造成一个荒谬的后果：**归档满了就再也删不掉记忆**
-- （用户想删一条得先把它移出去，而移不出去）。容量上限绝不能变成功能锁。
--
-- 所以上限由**保留清扫**执行：超了就淘汰，淘汰顺序是确定性的机械规则——
--   1. 先淘汰**已过声明期限**的（valid_until <= now()）：它们本来就要过期；
--   2. 还超就按 (importance ASC, last_used_at ASC NULLS FIRST) 淘汰最不重要的。
--
-- 这条顺序是机械的、可复现的，**不是**「最新写入驱逐有效记录」——
-- 那是 §4.6.6 明令禁止的（「语义淘汰不因最新写入自动驱逐有效记录」）。

--> statement-breakpoint

-- 归档保留上限。与 0344 的 resident 一样是**条数 + 字节双预算**：
-- 只看条数会让一条超长记忆占满整层，只看字节会让几千条短记忆挤进来。
CREATE OR REPLACE FUNCTION public.astella_companion_memory_retention_limits()
RETURNS TABLE (items integer, byte_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 500::integer, 400000::bigint;
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_enforce_companion_memory_retention()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  limit_items integer;
  limit_bytes bigint;
  archived_items integer;
  archived_bytes bigint;
  evicted integer := 0;
BEGIN
  SELECT items, byte_count INTO limit_items, limit_bytes
    FROM public.astella_companion_memory_retention_limits();

  SELECT count(*)::integer, COALESCE(sum(octet_length(content)), 0)::bigint
    INTO archived_items, archived_bytes
    FROM public.assistant_memory_items
   WHERE budget_tier = 'archived'
     AND deleted_at IS NULL;

  -- 两项都还够：什么都不做。这是绝大多数日子。
  IF archived_items <= limit_items AND archived_bytes <= limit_bytes THEN
    RETURN 0;
  END IF;

  -- 第一步：先清已过声明期限的。这些不是"被容量挤掉的"，它们本来就该过期。
  WITH expired AS (
    DELETE FROM public.assistant_memory_items
     WHERE budget_tier = 'archived'
       AND deleted_at IS NULL
       AND valid_until IS NOT NULL
       AND valid_until <= now()
    RETURNING 1
  ), counted AS (
    SELECT count(*)::integer AS n FROM expired
  )
  SELECT evicted = evicted + n FROM counted;

  SELECT count(*)::integer, COALESCE(sum(octet_length(content)), 0)::bigint
    INTO archived_items, archived_bytes
    FROM public.assistant_memory_items
   WHERE budget_tier = 'archived'
     AND deleted_at IS NULL;

  -- 第二步：仍超上限则按机械顺序淘汰最不重要的。
  -- pinned 的不参与（§4.6.6：「固定表达重要性，不能绕过有效期、事实检查、权限或预算」
  -- ——反过来也一样，固定的东西不该因为容量压力被悄悄淘汰）。
  IF archived_items > limit_items OR archived_bytes > limit_bytes THEN
    WITH removable AS (
      SELECT id
        FROM public.assistant_memory_items
       WHERE budget_tier = 'archived'
         AND deleted_at IS NULL
         AND pinned = false
       ORDER BY importance ASC, last_used_at ASC NULLS FIRST, updated_at ASC, id ASC
       LIMIT GREATEST(archived_items - limit_items, 0) + 64
    ), deleted_rows AS (
      DELETE FROM public.assistant_memory_items
       WHERE id IN (SELECT id FROM removable)
      RETURNING 1
    ), counted AS (
      SELECT count(*)::integer AS n FROM deleted_rows
    )
    SELECT evicted = evicted + n FROM counted;
  END IF;

  RETURN evicted;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_companion_memory_retention_limits() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.astella_enforce_companion_memory_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_companion_memory_retention_limits() TO astella_api;
GRANT EXECUTE ON FUNCTION public.astella_companion_memory_retention_limits() TO astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_enforce_companion_memory_retention() TO astella_api;