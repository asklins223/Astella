-- 0345: 普通删除进**可恢复的回收区**，并与「彻底清除」分成两条路（40 §4.6.4 / A47）。
--
-- 合同原话：
--   「普通删除即时抑制召回并进入可恢复回收区，沿用 30 天窗口；
--     明确彻底清除不以版本历史为由延后，按既有删除合同完成。」
--
-- 修的是什么：以前 `deleteMemory` 只写 `deleted_at`，而 `restoreMemory` 要求
-- `deleted_at IS NULL`、且它清的是 `archived_at`——**软删除的记忆永远恢复不了**，
-- 也没有任何清理，于是软删除的行无限堆积。A47 两半都不成立。
--
-- 三件事：
--   1. `purge_after`：软删除时写下"什么时候可以真正抹掉"，窗口 30 天。
--   2. `astella_restore_companion_memory`：把回收区里的记忆放回去（清两个列）。
--   3. `astella_purge_expired_companion_memory`：到期**真删**。它只删已过
--      `purge_after` 的行，不碰在用的——回收区窗口不是「到期自动消失」，
--      而是「到期之后用户随时可以要求彻底清除时不再有版本历史挡路」。

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  ADD COLUMN purge_after timestamptz;

COMMENT ON COLUMN public.assistant_memory_items.purge_after IS
  '软删除后的回收区到期时间（= deleted_at + 30 天）。NULL 表示这条没被软删除过。';

--> statement-breakpoint

-- 回收区到期扫描：只索引软删除的行（active 部分很小），并且只在有到期行时命中。
CREATE INDEX assistant_memory_items_purge_after_idx
  ON public.assistant_memory_items (purge_after)
  WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL;

--> statement-breakpoint

-- 既有软删除行按当初删除时间补上窗口。没有这一段的话，
-- 老数据会永远停在「没有 purge_after ⇒ 永远不进回收区」的状态。
UPDATE public.assistant_memory_items
   SET purge_after = deleted_at + interval '30 days'
 WHERE deleted_at IS NOT NULL
   AND purge_after IS NULL;

--> statement-breakpoint

-- 恢复：只放回收区里的这一条，且必须还是本人的、这个空间的。
-- 用函数而不是直接 UPDATE，是因为 assistant_memory_items 的 RLS 策略
-- 不给客户端 DELETE，而**撤销删除**同样要绕过它（这一列是被 RLS 之外的
-- 函数写回去的，见 memory-service.restoreDeletedMemory 的调用方）。
CREATE OR REPLACE FUNCTION public.astella_restore_companion_memory(
  p_memory_item_id uuid,
  p_workspace_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  restored integer;
BEGIN
  UPDATE public.assistant_memory_items
     SET deleted_at = NULL,
         purge_after = NULL,
         updated_at = now()
   WHERE id = p_memory_item_id
     AND workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS restored = ROW_COUNT;
  RETURN restored > 0;
END;
$$;

--> statement-breakpoint

-- 到期彻底清除。**只**删已经过了回收区窗口的行。
-- 「用户明确要求彻底清除」走的是另一条路（eraseMemory），不等这个函数。
CREATE OR REPLACE FUNCTION public.astella_purge_expired_companion_memory()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH purged AS (
    DELETE FROM public.assistant_memory_items
     WHERE deleted_at IS NOT NULL
       AND purge_after IS NOT NULL
       AND purge_after <= now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM purged;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_restore_companion_memory(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.astella_purge_expired_companion_memory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_restore_companion_memory(uuid, uuid, uuid) TO astella_api;
GRANT EXECUTE ON FUNCTION public.astella_purge_expired_companion_memory() TO astella_api;