-- 0343: let the worker close only the durable delivery attached to a memory item.
-- Worker intentionally has INSERT but no UPDATE on assistant_deliveries; memory
-- forget/revise still need an atomic terminal transition after a user-confirmed action.

CREATE OR REPLACE FUNCTION public.ailearn_close_companion_memory_delivery(
  p_workspace_id uuid,
  p_user_id uuid,
  p_memory_item_id uuid,
  p_transition text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  closed_count integer := 0;
BEGIN
  IF p_transition NOT IN ('acted', 'dismissed') THEN
    RAISE EXCEPTION 'unsupported memory delivery transition: %', p_transition
      USING ERRCODE = '22023';
  END IF;

  -- Bind the privileged operation to an existing memory row and its owner/scope.
  IF NOT EXISTS (
    SELECT 1
      FROM public.assistant_memory_items m
     WHERE m.id = p_memory_item_id
       AND m.workspace_id = p_workspace_id
       AND m.user_id = p_user_id
  ) THEN
    RETURN 0;
  END IF;

  UPDATE public.assistant_deliveries
     SET state = p_transition,
         display_lease = NULL,
         updated_at = now()
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND payload_ref ->> 'memoryItemId' = p_memory_item_id::text
     AND state IN ('queued', 'delivered', 'displayed', 'snoozed');
  GET DIAGNOSTICS closed_count = ROW_COUNT;

  IF closed_count > 0 THEN
    PERFORM pg_catalog.pg_notify(
      'ailearn_companion_inbox_v1',
      jsonb_build_object('userId', p_user_id)::text
    );
  END IF;
  RETURN closed_count;
END;
$$;

COMMENT ON FUNCTION public.ailearn_close_companion_memory_delivery(uuid,uuid,uuid,text) IS
  'Close only active inbox deliveries tied to an existing memory item in the supplied workspace/user scope; worker cannot update assistant_deliveries directly.';

REVOKE ALL ON FUNCTION public.ailearn_close_companion_memory_delivery(uuid,uuid,uuid,text)
  FROM PUBLIC, ailearn_api, ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_close_companion_memory_delivery(uuid,uuid,uuid,text)
  TO ailearn_worker;
