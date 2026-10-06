-- 0332: make the diary tick match the current daily contract.
--
-- 0329 introduced a seven-day backfill, contrary to 40 §5.5: after an outage,
-- prepare only the most recent completed local day, never a stack of missed days.
-- It also lost the timezone-boundary cast from 0251. Explicitly cast DATE to
-- timestamp before AT TIME ZONE so Postgres interprets local midnight, not UTC
-- midnight converted into the requested timezone.
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_daily_summaries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tz text;
  local_date text;
  v_pair record;
  v_inserted integer := 0;
BEGIN
  FOR tz IN
    SELECT DISTINCT COALESCE(quiet_hours->>'timezone', 'Asia/Shanghai')
    FROM user_companion_account_state
    WHERE global_enabled = true
  LOOP
    -- Only prepare yesterday during the user's 01:00–06:59 quiet window.
    IF extract(hour FROM now() AT TIME ZONE tz) NOT BETWEEN 1 AND 6 THEN
      CONTINUE;
    END IF;

    local_date := to_char((now() AT TIME ZONE tz)::date - 1, 'YYYY-MM-DD');

    FOR v_pair IN
      SELECT u.user_id, wm.workspace_id
      FROM user_companion_account_state u
      JOIN workspace_members wm
        ON wm.user_id = u.user_id
       AND wm.left_at IS NULL
      WHERE u.global_enabled = true
        AND COALESCE(u.quiet_hours->>'timezone', 'Asia/Shanghai') = tz
      ORDER BY u.user_id, wm.joined_at
    LOOP
      IF NOT (
        EXISTS (
          SELECT 1 FROM companion_messages
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM assistant_page_contexts
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM learning_runs
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM notes
          WHERE workspace_id = v_pair.workspace_id AND created_by = v_pair.user_id
            AND deleted_at IS NULL
            AND (created_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
                 OR updated_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND updated_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz))
        )
        OR EXISTS (
          SELECT 1 FROM learning_cards_v2
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM sources
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= (local_date::date::timestamp AT TIME ZONE tz)
            AND created_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
        )
        OR EXISTS (
          SELECT 1 FROM jobs
          WHERE workspace_id = v_pair.workspace_id AND requested_by = v_pair.user_id
            AND type <> 'companion_daily_summary'
            AND (scheduled_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND scheduled_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz)
                 OR finished_at >= (local_date::date::timestamp AT TIME ZONE tz)
                 AND finished_at < ((local_date::date + 1)::timestamp AT TIME ZONE tz))
        )
      ) THEN
        CONTINUE;
      END IF;

      INSERT INTO jobs
        (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
      VALUES
        ('companion_daily_summary', v_pair.workspace_id, v_pair.user_id,
         jsonb_build_object('date', local_date, 'timezone', tz, 'userId', v_pair.user_id),
         'pending', 10, 'maintenance',
         'daily-summary:' || v_pair.workspace_id || ':' || v_pair.user_id || ':' || local_date)
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING;

      IF FOUND THEN
        v_inserted := v_inserted + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END
$$;

ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
  OWNER TO astella_migrator;
ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
  SECURITY DEFINER;
ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
  SET search_path = pg_catalog, public;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_daily_summaries()
  TO astella_worker;

-- The 0329 lookback overload has no current caller and enables an obsolete
-- multi-day backfill path, so remove it with the contract change.
DROP FUNCTION IF EXISTS public.astella_enqueue_companion_daily_summaries(integer);
