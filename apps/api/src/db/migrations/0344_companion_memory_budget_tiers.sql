-- 0344: separate resident prompt memory from searchable and archived memory.

ALTER TABLE public.assistant_memory_items
  ADD COLUMN budget_tier text NOT NULL DEFAULT 'active',
  ADD CONSTRAINT assistant_memory_items_budget_tier_check
    CHECK (budget_tier IN ('resident', 'active', 'archived'));

--> statement-breakpoint

CREATE INDEX assistant_memory_items_budget_tier_idx
  ON public.assistant_memory_items (workspace_id, user_id, budget_tier, importance DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND candidate = false;

--> statement-breakpoint

CREATE TABLE public.assistant_memory_budget_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES public.assistant_memory_items(id) ON DELETE CASCADE,
  memory_revision integer NOT NULL CHECK (memory_revision >= 1),
  from_tier text NOT NULL CHECK (from_tier IN ('resident', 'active', 'archived')),
  to_tier text NOT NULL CHECK (to_tier IN ('resident', 'active', 'archived')),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'companion', 'maintenance')),
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_tier <> to_tier)
);

--> statement-breakpoint

CREATE INDEX assistant_memory_budget_events_owner_idx
  ON public.assistant_memory_budget_events (workspace_id, user_id, memory_id, created_at DESC);

--> statement-breakpoint

ALTER TABLE public.assistant_memory_budget_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_memory_budget_events FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY assistant_memory_budget_events_workspace_user_isolation
  ON public.assistant_memory_budget_events FOR ALL TO ailearn_api, ailearn_worker
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT ON public.assistant_memory_budget_events TO ailearn_api, ailearn_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON public.assistant_memory_budget_events FROM ailearn_api, ailearn_worker;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_move_companion_memory_budget_tier_v1(
  p_workspace_id uuid,
  p_user_id uuid,
  p_memory_id uuid,
  p_to_tier text,
  p_actor_type text,
  p_actor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  memory_row public.assistant_memory_items%ROWTYPE;
  resident_items integer := 0;
  resident_tokens integer := 0;
  resident_bytes bigint := 0;
  requested_tokens integer := 0;
  requested_bytes integer := 0;
  suggestions jsonb := '[]'::jsonb;
BEGIN
  IF p_to_tier NOT IN ('resident', 'active', 'archived') THEN
    RAISE EXCEPTION 'unsupported companion memory budget tier: %', p_to_tier
      USING ERRCODE = '22023';
  END IF;
  IF p_actor_type NOT IN ('user', 'companion', 'maintenance')
     OR (p_actor_type = 'user' AND p_actor_id IS DISTINCT FROM p_user_id)
     OR (p_actor_type <> 'user' AND p_actor_id IS NOT NULL)
     OR (CURRENT_USER = 'ailearn_api' AND p_actor_type <> 'user')
     OR (CURRENT_USER = 'ailearn_worker' AND p_actor_type = 'user') THEN
    RAISE EXCEPTION 'invalid companion memory budget actor'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(current_setting('app.workspace_id', true), '') IS DISTINCT FROM p_workspace_id::text
     OR NULLIF(current_setting('app.user_id', true), '') IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION 'companion memory budget scope does not match transaction scope'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize resident-capacity checks per workspace/user; row locks alone let two
  -- different memories both observe the same final free slot.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('companion-memory-budget:' || p_workspace_id::text || ':' || p_user_id::text, 0)
  );

  SELECT * INTO memory_row
    FROM public.assistant_memory_items
   WHERE id = p_memory_id
     AND workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;
  IF memory_row.budget_tier = p_to_tier THEN
    RETURN jsonb_build_object(
      'status', 'unchanged',
      'memoryId', memory_row.id,
      'tier', memory_row.budget_tier,
      'revision', memory_row.revision
    );
  END IF;
  IF p_to_tier = 'resident' AND memory_row.candidate THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  IF p_to_tier = 'resident' THEN
    requested_bytes := octet_length(memory_row.content);
    requested_tokens := GREATEST(1, CEIL(requested_bytes / 3.0)::integer);

    SELECT count(*)::integer,
           COALESCE(sum(GREATEST(1, CEIL(octet_length(content) / 3.0)::integer)), 0)::integer,
           COALESCE(sum(octet_length(content)), 0)::bigint
      INTO resident_items, resident_tokens, resident_bytes
      FROM public.assistant_memory_items
     WHERE workspace_id = p_workspace_id
       AND user_id = p_user_id
       AND budget_tier = 'resident'
       AND deleted_at IS NULL
       AND candidate = false
       AND id <> p_memory_id;

    IF resident_items + 1 > 6
       OR resident_tokens + requested_tokens > 320
       OR resident_bytes + requested_bytes > 1000 THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'memoryId', ranked.id,
               'title', left(ranked.content, 60),
               'revision', ranked.revision,
               'tokenEstimate', GREATEST(1, CEIL(octet_length(ranked.content) / 3.0)::integer),
               'byteCount', octet_length(ranked.content)
             )), '[]'::jsonb)
        INTO suggestions
        FROM (
          SELECT id, content, revision
            FROM public.assistant_memory_items
           WHERE workspace_id = p_workspace_id
             AND user_id = p_user_id
             AND budget_tier = 'resident'
             AND deleted_at IS NULL
             AND candidate = false
             AND id <> p_memory_id
           ORDER BY importance ASC, last_used_at ASC NULLS FIRST, updated_at ASC, id ASC
           LIMIT 10
        ) ranked;

      RETURN jsonb_build_object(
        'status', 'capacity',
        'memoryId', memory_row.id,
        'requestedTier', p_to_tier,
        'current', jsonb_build_object(
          'items', resident_items,
          'tokenEstimate', resident_tokens,
          'byteCount', resident_bytes
        ),
        'requested', jsonb_build_object(
          'items', 1,
          'tokenEstimate', requested_tokens,
          'byteCount', requested_bytes
        ),
        'limits', jsonb_build_object(
          'items', 6,
          'tokenEstimate', 320,
          'byteCount', 1000
        ),
        'suggestedDowngrades', suggestions
      );
    END IF;
  END IF;

  UPDATE public.assistant_memory_items
     SET budget_tier = p_to_tier,
         updated_at = now()
   WHERE id = memory_row.id
     AND workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND deleted_at IS NULL;

  INSERT INTO public.assistant_memory_budget_events (
    workspace_id, user_id, memory_id, memory_revision,
    from_tier, to_tier, actor_type, actor_id
  ) VALUES (
    p_workspace_id, p_user_id, memory_row.id, memory_row.revision,
    memory_row.budget_tier, p_to_tier, p_actor_type, p_actor_id
  );

  IF p_to_tier = 'resident' THEN
    resident_items := resident_items + 1;
    resident_tokens := resident_tokens + requested_tokens;
    resident_bytes := resident_bytes + requested_bytes;
  END IF;

  RETURN jsonb_build_object(
    'status', 'moved',
    'memoryId', memory_row.id,
    'fromTier', memory_row.budget_tier,
    'tier', p_to_tier,
    'revision', memory_row.revision,
    'residentUsage', jsonb_build_object(
      'items', resident_items,
      'tokenEstimate', resident_tokens,
      'byteCount', resident_bytes
    )
  );
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.ailearn_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_move_companion_memory_budget_tier_v1(uuid,uuid,uuid,text,text,uuid)
  TO ailearn_api, ailearn_worker;
