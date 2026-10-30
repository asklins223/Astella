-- 0462: Remove lexical admission from persisted memory maintenance.
-- Existing ownership, once-per-day, pin and retention behavior is preserved.

CREATE OR REPLACE FUNCTION public.astella_run_companion_memory_maintenance()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run_date date := CURRENT_DATE;
  v_claimed_date date;
  v_archived integer := 0;
  v_decayed integer := 0;
  v_promoted integer := 0;
BEGIN
  INSERT INTO public.companion_memory_maintenance_runs (run_date)
  VALUES (v_run_date)
  ON CONFLICT (run_date) DO NOTHING
  RETURNING run_date INTO v_claimed_date;

  IF v_claimed_date IS NULL THEN
    RETURN 0;
  END IF;

  -- 先解禁再归档：解禁后的行如果本来就满足归档条件（低重要性、久未使用），
  -- 同一轮里就该被归档，不该多活一天。
  WITH promoted AS (
    UPDATE public.assistant_memory_items
    SET candidate = false
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND candidate = true
      AND created_at < now() - interval '3 days'

    RETURNING 1
  )
  SELECT count(*)::integer INTO v_promoted FROM promoted;

  UPDATE public.assistant_memory_items
  SET archived_at = now(), updated_at = now()
  WHERE deleted_at IS NULL
    AND archived_at IS NULL
    AND pinned = false
    AND (
      (
        (last_used_at IS NULL OR last_used_at < now() - interval '30 days')
        AND importance < 0.4
      )
      OR (
        last_used_at < now() - interval '90 days'
        AND importance < 0.6
      )
    );
  GET DIAGNOSTICS v_archived = ROW_COUNT;

  WITH stale AS (
    UPDATE public.pet_profiles
    SET familiarity = GREATEST(familiarity - 0.05, 0),
        updated_at = now()
    WHERE last_active_at IS NOT NULL
      AND last_active_at < now() - interval '14 days'
      AND familiarity > 0
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_decayed FROM stale;

  RETURN v_archived + v_decayed + v_promoted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.astella_run_companion_memory_maintenance() TO astella_worker;

COMMENT ON FUNCTION public.astella_run_companion_memory_maintenance() IS
  '记忆维护按候选状态、时间、重要性与实际使用记录执行；不根据正文词语阻止候选晋升，不冒充用户确认。';
