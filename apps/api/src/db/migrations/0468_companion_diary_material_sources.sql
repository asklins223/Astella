-- 0468: point the diary tick at material tables that still exist.
--
-- 0449 retired the learning-run / card chain and dropped learning_runs and
-- learning_cards_v2, but the tick still probed both. PL/pgSQL short-circuits
-- EXISTS, so a chatty day hid it; the first note-only day inside a 01:00–06:59
-- window raised `relation "learning_runs" does not exist` and aborted the whole
-- call — nobody in that timezone got a diary that minute, every minute.
--
-- The probes now mirror what the writer reads (notes, sources, note learning
-- cards and attempts, study time), so a queued diary always has material
-- behind it. Accounts left with a NULL diary_enabled_since by the early agent
-- bootstrap start a fresh eligible window here instead of never qualifying.
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_daily_summaries()
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
          SELECT 1 FROM notes
          WHERE workspace_id = v_pair.workspace_id AND created_by = v_pair.user_id
            AND deleted_at IS NULL
            AND (created_at >= material_start AND created_at < day_end
                 OR updated_at >= material_start AND updated_at < day_end)
        )
        OR EXISTS (
          SELECT 1 FROM sources
          WHERE workspace_id = v_pair.workspace_id AND created_by = v_pair.user_id
            AND created_at >= material_start AND created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM note_learning_card_attempts a
          WHERE a.workspace_id = v_pair.workspace_id AND a.user_id = v_pair.user_id
            AND (a.started_at >= material_start AND a.started_at < day_end
                 OR a.completed_at >= material_start AND a.completed_at < day_end)
        )
        OR EXISTS (
          SELECT 1 FROM note_learning_cards c
          JOIN notes card_note ON card_note.id = c.note_id
          WHERE c.workspace_id = v_pair.workspace_id
            AND card_note.created_by = v_pair.user_id
            AND c.created_at >= material_start AND c.created_at < day_end
        )
        OR EXISTS (
          SELECT 1 FROM learning_metric_events
          WHERE workspace_id = v_pair.workspace_id AND user_id = v_pair.user_id
            AND occurred_at >= material_start AND occurred_at < day_end
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

ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
  OWNER TO astella_migrator;
ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
  SECURITY DEFINER;
ALTER FUNCTION public.astella_enqueue_companion_daily_summaries()
  SET search_path = pg_catalog, public;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_daily_summaries()
  TO astella_worker;

COMMENT ON FUNCTION public.astella_enqueue_companion_daily_summaries() IS
  '桌宠日记调度：本地 01:00–06:59 窗口内为昨天有材料（对话/页面/笔记/资料/学习卡/学习时长/任务）且尚未入队的账号投一篇日记。';

-- Rows created by the early agent bootstrap never got a diary window, so they
-- were structurally ineligible. Enabled accounts that still have no window
-- start one now; paused accounts stay paused.
UPDATE public.user_companion_account_state
SET diary_enabled_since = date_trunc('milliseconds', now())
WHERE global_enabled = true
  AND diary_enabled = true
  AND diary_enabled_since IS NULL;
