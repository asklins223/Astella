-- Skip memory rows whose workspace or active membership no longer exists.
-- One stale row must not abort the global organizer enqueue.
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_memory_organize()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_thresholds record;
  v_inserted integer := 0;
  v_row_inserted integer;
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
        JOIN public.workspaces w ON w.id = m.workspace_id
        JOIN public.workspace_members member
          ON member.workspace_id = m.workspace_id AND member.user_id = m.user_id
         AND member.left_at IS NULL
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
    GET DIAGNOSTICS v_row_inserted = ROW_COUNT;
    v_inserted := v_inserted + v_row_inserted;
  END LOOP;

  RETURN v_inserted;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_enqueue_companion_memory_organize() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.astella_companion_memory_organization_thresholds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_memory_organize() TO astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_companion_memory_organization_thresholds() TO astella_worker;

--> statement-breakpoint

-- Historical questions retrieve their own frozen selection through this key.
CREATE INDEX IF NOT EXISTS companion_turn_runs_user_message_id_idx
  ON public.companion_turn_runs (user_message_id);

--> statement-breakpoint

-- roles.sql previously erased migration 0330 grants when bootstrapping roles.
GRANT SELECT, INSERT ON public.assistant_memory_source_suppressions TO astella_worker;

--> statement-breakpoint

-- Migration 0360 changed the author vocabulary but left the old default behind.
ALTER TABLE public.assistant_memory_items ALTER COLUMN author_type SET DEFAULT 'extractor';
