-- Manual global preferences use a scoped API entry; fanout has one implementation.
-- Source ownership and active membership are checked explicitly under SECURITY DEFINER.
-- Copies share adoption/withdrawal state, while each row retains its own revision history.

CREATE OR REPLACE FUNCTION public.astella_fanout_agent_global_preference(
  p_source_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_raw text;
  v_space_raw text;
  v_actor_user uuid;
  v_actor_space uuid;
  v_src record;
  v_member boolean;
BEGIN
  v_user_raw := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  v_space_raw := NULLIF(pg_catalog.current_setting('app.workspace_id', true), '');
  IF v_user_raw IS NULL OR v_space_raw IS NULL THEN
    RAISE EXCEPTION 'agent global fanout requires an actor-scoped transaction'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_space_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'agent global fanout received a malformed transaction context'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_actor_user := v_user_raw::uuid;
  v_actor_space := v_space_raw::uuid;

  SELECT m.user_id, m.workspace_id, m.scope, m.deleted_at
    INTO v_src
    FROM public.assistant_memory_items m
   WHERE m.id = p_source_id;

  IF NOT FOUND
     OR v_src.user_id <> v_actor_user
     OR v_src.workspace_id <> v_actor_space THEN
    RAISE EXCEPTION 'agent global fanout source memory is not available to the acting user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_src.deleted_at IS NOT NULL OR v_src.scope <> 'global' THEN
    RETURN 0;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = v_actor_space
       AND user_id = v_actor_user
       AND left_at IS NULL
  ) INTO v_member;
  IF NOT v_member THEN
    RAISE EXCEPTION 'agent global fanout requires an active workspace membership'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.astella_fanout_global_companion_memory(p_source_id);
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.astella_fanout_agent_global_preference(uuid) IS
  '受控铺开入口：先验事务身份、源行归属与活跃成员，再委派 0267 的唯一铺开实现。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_fanout_agent_global_preference(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_fanout_agent_global_preference(uuid) TO astella_api;
GRANT EXECUTE ON FUNCTION public.astella_fanout_agent_global_preference(uuid) TO astella_migrator;

--> statement-breakpoint

-- Frozen domain state is copied; embedding is computed within each workspace.

CREATE OR REPLACE FUNCTION public.astella_fanout_global_companion_memory(
  p_source_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  src record;
  target record;
  v_inserted integer := 0;
  v_key uuid;
BEGIN
  SELECT id, workspace_id, user_id, kind, content, scope, importance, confidence,
         user_stated, user_confirmed, candidate, source_event_id, source_session_id,
         source_type, source_speaker, source_basis, applies_when, valid_from, valid_until,
         epistemic_status, author_type, author_id, budget_tier, pinned, dismissed_at,
         archived_at, global_key
    INTO src
    FROM public.assistant_memory_items
   WHERE id = p_source_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF src.scope <> 'global' THEN
    RETURN 0;
  END IF;

  v_key := COALESCE(src.global_key, src.id);
  IF src.global_key IS DISTINCT FROM v_key THEN
    UPDATE public.assistant_memory_items SET global_key = v_key WHERE id = src.id;
  END IF;

  FOR target IN
    SELECT m.workspace_id
      FROM public.workspace_members m
     WHERE m.user_id = src.user_id
       AND m.left_at IS NULL
       AND m.workspace_id <> src.workspace_id
  LOOP
    INSERT INTO public.assistant_memory_items
      (workspace_id, user_id, kind, content, source_event_id, source_session_id,
       source_speaker, source_basis, applies_when, valid_from, valid_until,
       user_stated, user_confirmed, candidate, importance, confidence, scope,
       source_type, epistemic_status, author_type, author_id, budget_tier,
       dismissed_at, archived_at, embedding_status, global_key, pinned, created_at, updated_at)
    VALUES
      (target.workspace_id, src.user_id, src.kind, src.content, src.source_event_id,
       src.source_session_id, src.source_speaker, src.source_basis, src.applies_when,
       src.valid_from, src.valid_until, src.user_stated, src.user_confirmed, src.candidate,
       src.importance, src.confidence, 'global', src.source_type, src.epistemic_status,
       src.author_type, src.author_id, src.budget_tier, src.dismissed_at, src.archived_at,
       'pending', v_key, src.pinned, now(), now())
    ON CONFLICT (workspace_id, global_key) WHERE global_key IS NOT NULL AND deleted_at IS NULL
      DO NOTHING;
    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.astella_fanout_global_companion_memory(uuid) IS
  '把一条 scope=global 的记忆铺到该用户所有活跃空间（0267 建立，0342 补时窗，0371 让副本与源行在确认/候选/作者/认识状态/预算层/撤回状态上从一开始就对齐）。';

--> statement-breakpoint

-- Changes propagate to copies without overwriting their local revision counters.

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
  '把一条跨空间记忆的变更同步到它在其他空间的副本（0268 建立，0342 补时窗，0371 补确认位/认识状态/作者/预算层）。revision 刻意不同步。';

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'assistant_memory_items_sync_copies' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '副本同步触发器不在，重定义函数不会生效';
  END IF;
  IF NOT has_function_privilege('astella_api',
       'public.astella_fanout_agent_global_preference(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'astella_api 拿不到受控入口：API 写入的 global 规则仍然不会铺开';
  END IF;
END
$$;