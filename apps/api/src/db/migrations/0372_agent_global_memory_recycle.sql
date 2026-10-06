-- Account-level memory copies keep one recycle deadline; the gap rows get the active window.

-- A plain delete has to reach every space of an account. `purge_after` used to be written
-- by a second, id-only UPDATE that ran *after* the copy-sync trigger had already spread
-- `deleted_at`, so the row on the other side kept `purge_after IS NULL` forever — and the
-- active recycle sweep (0345) only purges rows whose `purge_after` is set. It therefore
-- never reached the purge window there. Sync the column, then close the gap.

CREATE OR REPLACE FUNCTION public.astella_sync_global_companion_memory_copies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_syncing text;
  v_key uuid;
BEGIN
  v_syncing := NULLIF(current_setting('app.memory_sync', true), '');
  IF v_syncing = 'on' THEN
    RETURN NULL;
  END IF;

  v_key := COALESCE(NEW.global_key, OLD.global_key);
  IF v_key IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.memory_sync', 'on', true);

  UPDATE public.assistant_memory_items
     SET content = NEW.content,
         deleted_at = NEW.deleted_at,
         archived_at = NEW.archived_at,
         pinned = NEW.pinned,
         dismissed_at = NEW.dismissed_at,
         importance = NEW.importance,
         confidence = NEW.confidence,
         source_speaker = NEW.source_speaker,
         source_basis = NEW.source_basis,
         applies_when = NEW.applies_when,
         valid_from = NEW.valid_from,
         valid_until = NEW.valid_until,
         candidate = NEW.candidate,
         user_confirmed = NEW.user_confirmed,
         epistemic_status = NEW.epistemic_status,
         author_type = NEW.author_type,
         author_id = NEW.author_id,
         budget_tier = NEW.budget_tier,
         -- 回收时间随删除一起走（42 阶段 1 N）。
         --
         -- 恢复侧 `astella_restore_companion_memory`（0345）把 deleted_at 与 purge_after
         -- 一起清成 NULL，所以这一列不需要额外判断：源行活着时带过去的也是 NULL，
         -- 源行在回收区时带过去的是它自己的到期时间。**revision 仍然不同步**。
         purge_after = NEW.purge_after,
         updated_at = now()
   WHERE user_id = NEW.user_id
     AND global_key = v_key
     AND id <> NEW.id;

  PERFORM set_config('app.memory_sync', '', true);
  RETURN NULL;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.astella_sync_global_companion_memory_copies() IS
  '把一条跨空间记忆的变更同步到它在其他空间的副本（0268 建立，0342 补时窗，0371 补确认位/认识状态/作者/预算层，0372 补回收时间）。revision 刻意不同步。';

--> statement-breakpoint

-- 历史缺口：账号级软删行里 purge_after 为空的那些，按现役 30 天窗口补上到期时间。
--
-- 范围刻意很窄：只碰「带 global_key 且已软删且没有到期时间」的行。不删任何行，
-- 不碰活跃行，也不碰空间级规则。
--
-- 回填期间要关掉副本同步，否则同组里万一有一行还活着（deleted_at IS NULL），
-- 同步会把回收时间写到它头上——那才是真的改到了活跃行。四件事必须写在**同一个
-- DO 块**里：这里若是各自独立的事务，`set_config(..., true)` 的事务局部设置会在
-- 下一条语句之前就失效，关同步等于没关（实测过，见 phase1-n 结果报告）。旧值先存
-- 下来再原样恢复，不无条件写成空串——调用方本来就开着同步的话不能被这次迁移抹掉。
DO $backfill$
DECLARE
  v_previous_sync text;
BEGIN
  v_previous_sync := current_setting('app.memory_sync', true);
  PERFORM set_config('app.memory_sync', 'on', true);

  UPDATE public.assistant_memory_items
     SET purge_after = deleted_at + interval '30 days'
   WHERE global_key IS NOT NULL
     AND deleted_at IS NOT NULL
     AND purge_after IS NULL;

  PERFORM set_config('app.memory_sync', COALESCE(v_previous_sync, ''), true);
END
$backfill$;