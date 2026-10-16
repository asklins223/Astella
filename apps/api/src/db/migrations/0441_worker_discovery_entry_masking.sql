-- 0441: let the worker mask only the discovery-bookmark quotes attached to a memory item.
--
-- Worker intentionally has no privileges at all on companion_discovery_entries (see the
-- Worker privilege matrix in infra/postgres/roles.sql). That stays true: 40 §7 requires
-- that a forgotten memory's quote stops showing in the user's discovery book, and the
-- model's own companion_forget_memory path needs that effect, so it goes through one
-- narrowly bound SECURITY DEFINER function — the same shape as 0343's
-- astella_close_companion_memory_delivery.
--
-- Before this, only the API delete path masked entries; a memory forgotten by the tool
-- kept its bookmark quote pointing at a tombstone.

CREATE OR REPLACE FUNCTION public.astella_mask_companion_memory_discovery_entries(
  p_workspace_id uuid,
  p_user_id uuid,
  p_memory_item_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  masked_count integer := 0;
BEGIN
  -- Bind the privileged operation to an existing memory row and its owner/scope, so the
  -- function cannot be used to mask arbitrary rows for another user or workspace.
  IF NOT EXISTS (
    SELECT 1
      FROM public.assistant_memory_items m
     WHERE m.id = p_memory_item_id
       AND m.workspace_id = p_workspace_id
       AND m.user_id = p_user_id
  ) THEN
    RETURN 0;
  END IF;

  -- Mask rather than delete: "this was once kept" is itself information 40 §7 preserves.
  UPDATE public.companion_discovery_entries
     SET masked = true,
         updated_at = now()
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND source = 'memory'
     AND source_id = p_memory_item_id::text
     AND NOT masked;
  GET DIAGNOSTICS masked_count = ROW_COUNT;

  RETURN masked_count;
END;
$$;

COMMENT ON FUNCTION public.astella_mask_companion_memory_discovery_entries(uuid,uuid,uuid) IS
  'Mask the discovery-bookmark quotes sourced from one existing memory item in the supplied workspace/user scope; worker has no direct privileges on companion_discovery_entries.';

-- Owner is part of the contract: roles.sql asserts every privileged queue/memory function is
-- owned by astella_migrator with a pinned search_path, so an explicit OWNER TO is required
-- whenever the migration runner is not itself the migrator role.
ALTER FUNCTION public.astella_mask_companion_memory_discovery_entries(uuid, uuid, uuid)
  OWNER TO astella_migrator;

REVOKE ALL ON FUNCTION public.astella_mask_companion_memory_discovery_entries(uuid,uuid,uuid)
  FROM PUBLIC, astella_api, astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_mask_companion_memory_discovery_entries(uuid,uuid,uuid)
  TO astella_worker;
