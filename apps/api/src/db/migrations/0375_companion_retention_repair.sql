-- Correct the live maintenance function; 0362 is already applied and remains historical.
CREATE OR REPLACE FUNCTION public.astella_enforce_companion_memory_retention()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE limits record; item_count integer; byte_count bigint; reclaimed integer := 0; changed integer;
BEGIN
  SELECT * INTO limits FROM public.astella_companion_memory_retention_limits();
  -- Expiry is independent of capacity. Every removal remains recoverable and suppressed.
  WITH expired AS (
    UPDATE public.assistant_memory_items SET deleted_at=now(),purge_after=now()+interval '30 days',updated_at=now()
      WHERE budget_tier='archived' AND deleted_at IS NULL AND valid_until IS NOT NULL AND valid_until<=now()
      RETURNING user_id,kind,source_event_id
  ), suppressed AS (
    INSERT INTO public.assistant_memory_source_suppressions(user_id,kind,source_event_id)
      SELECT user_id,kind,source_event_id FROM expired WHERE source_event_id IS NOT NULL
      ON CONFLICT(user_id,kind,source_event_id) DO NOTHING RETURNING 1
  ) SELECT count(*)::integer INTO reclaimed FROM expired;
  SELECT count(*)::integer,COALESCE(sum(octet_length(content)),0)::bigint INTO item_count,byte_count
    FROM public.assistant_memory_items WHERE budget_tier='archived' AND deleted_at IS NULL;
  IF item_count>limits.items OR byte_count>limits.byte_count THEN
    WITH removable AS (
      SELECT id FROM public.assistant_memory_items
        WHERE budget_tier='archived' AND deleted_at IS NULL AND pinned=false
        ORDER BY importance,last_used_at NULLS FIRST,updated_at,id
        LIMIT GREATEST(item_count-limits.items,0)+64
    ), evicted AS (
      UPDATE public.assistant_memory_items SET deleted_at=now(),purge_after=now()+interval '30 days',updated_at=now()
        WHERE id IN (SELECT id FROM removable) RETURNING user_id,kind,source_event_id
    ), suppressed AS (
      INSERT INTO public.assistant_memory_source_suppressions(user_id,kind,source_event_id)
        SELECT user_id,kind,source_event_id FROM evicted WHERE source_event_id IS NOT NULL
        ON CONFLICT(user_id,kind,source_event_id) DO NOTHING RETURNING 1
    ) SELECT count(*)::integer INTO changed FROM evicted;
    reclaimed := reclaimed+changed;
  END IF;
  RETURN reclaimed;
END;
$$;
REVOKE ALL ON FUNCTION public.astella_enforce_companion_memory_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enforce_companion_memory_retention() TO astella_api,astella_worker;
