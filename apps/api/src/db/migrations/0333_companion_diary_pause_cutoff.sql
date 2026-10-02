-- 0333: give automatic diaries their own account-level pause and material cutoff.
-- A disabled interval contributes no material. Re-enabling starts a new window;
-- it does not make messages or edits from the paused interval eligible later.
ALTER TABLE public.user_companion_account_state
  ADD COLUMN IF NOT EXISTS diary_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.user_companion_account_state
  ADD COLUMN IF NOT EXISTS diary_enabled_since timestamptz;

-- Existing users start a fresh eligible period at rollout. A globally disabled
-- account stays paused until its next explicit re-enable transition.
UPDATE public.user_companion_account_state
SET diary_enabled_since = date_trunc('milliseconds', now())
WHERE global_enabled = true
  AND diary_enabled = true
  AND diary_enabled_since IS NULL;

COMMENT ON COLUMN public.user_companion_account_state.diary_enabled IS
  'Whether automatic companion diary generation is enabled independently of learning and reminders.';
COMMENT ON COLUMN public.user_companion_account_state.diary_enabled_since IS
  'Start of the current uninterrupted diary-enabled period; diary material before this timestamp is ineligible.';

CREATE OR REPLACE FUNCTION public.ailearn_enqueue_companion_daily_summaries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tz text;
  local_date text;
  day_start timestamptz;
  day_end timestamptz;
  material_start timestamptz;
  v_pair record;
  v_inserted integer := 0;
BEGIN
  FOR tz IN
    SELECT DISTINCT COALESCE(quiet_hours->>'timezone', 'Asia/Shanghai')
    FROM user_companion_account_state
    WHERE global_enabled = true
      AND diary_enabled = true
      AND diary_enabled_since IS NOT NULL
  LOOP
    -- Only prepare yesterday during the user's 01:00–06:59 quiet window.
    IF extract(hour FROM now() AT TIME ZONE tz) NOT BETWEEN 1 AND 6 THEN
      CONTINUE;
    END IF;

    local_date := to_char((now() AT TIME ZONE tz)::date - 1, 'YYYY-MM-DD');
    day_start := local_date::date::timestamp AT TIME ZONE tz;
    day_end := (local_date::date + 1)::timestamp AT TIME ZONE tz;

    FOR v_pair IN
      SELECT u.user_id, u.diary_enabled_since, wm.workspace_id
      FROM user_companion_account_state u
      JOIN workspace_members wm
        ON wm.user_id = u.user_id
       AND wm.left_at IS NULL
      WHERE u.global_enabled = true
        AND u.diary_enabled = true
        AND u.diary_enabled_since IS NOT NULL
        AND COALESCE(u.quiet_hours->>'timezone', 'Asia/Shanghai') = tz
      ORDER BY u.user_id, wm.joined_at
    LOOP
      material_start := GREATEST(day_start, v_pair.diary_enabled_since);

      IF NOT (
        EXISTS (
          SELECT 1 FROM companion_messages
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= material_start AND created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM assistant_page_contexts
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= material_start AND created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM learning_runs
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND created_at >= material_start AND created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM notes
          WHERE workspace_id = v_pair.workspace_id AND created_by = v_pair.user_id
            AND deleted_at IS NULL
            AND (created_at >= material_start AND created_at < day_end
                 OR updated_at >= material_start AND updated_at < day_end)
        )
        OR EXISTS (
          SELECT 1 FROM learning_cards_v2
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= material_start AND created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM sources
          WHERE workspace_id = v_pair.workspace_id
            AND created_at >= material_start AND created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM jobs
          WHERE workspace_id = v_pair.workspace_id AND requested_by = v_pair.user_id
            AND type <> 'companion_daily_summary'
            AND (scheduled_at >= material_start AND scheduled_at < day_end
                 OR finished_at >= material_start AND finished_at < day_end)
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

ALTER FUNCTION public.ailearn_enqueue_companion_daily_summaries()
  OWNER TO ailearn_migrator;
ALTER FUNCTION public.ailearn_enqueue_companion_daily_summaries()
  SECURITY DEFINER;
ALTER FUNCTION public.ailearn_enqueue_companion_daily_summaries()
  SET search_path = pg_catalog, public;
GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries()
  TO ailearn_worker;
