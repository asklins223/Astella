-- 0330: 记忆被用户忘记后，抑制同一来源的自动抽取，避免软删除后再次复活。

--> statement-breakpoint

CREATE TABLE public.assistant_memory_source_suppressions (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'preference', 'goal', 'learning_context', 'interaction_note', 'episodic'
  )),
  source_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_memory_source_suppressions_pkey
    PRIMARY KEY (user_id, kind, source_event_id)
);

--> statement-breakpoint

ALTER TABLE public.assistant_memory_source_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_memory_source_suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_memory_source_suppressions_user_isolation
  ON public.assistant_memory_source_suppressions FOR ALL
  USING (
    CURRENT_USER = 'astella_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'astella_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

GRANT SELECT, INSERT ON public.assistant_memory_source_suppressions TO astella_api;
GRANT SELECT, INSERT ON public.assistant_memory_source_suppressions TO astella_worker;

--> statement-breakpoint

-- 已删除来源也必须维持抑制。旧版抽取器留下的合成来源 ID 会被保留为历史墓碑，
-- 不尝试猜测它们对应的消息 UUID。
INSERT INTO public.assistant_memory_source_suppressions (user_id, kind, source_event_id)
SELECT DISTINCT user_id, kind, source_event_id
  FROM public.assistant_memory_items
 WHERE deleted_at IS NOT NULL
   AND source_event_id IS NOT NULL
ON CONFLICT (user_id, kind, source_event_id) DO NOTHING;

--> statement-breakpoint

-- 成员离开空间时，先写抑制墓碑，再软删除本空间记忆；该 SECURITY DEFINER
-- 函数仍是跨用户清理的唯一入口。锁格式与应用/worker 共用。
CREATE OR REPLACE FUNCTION public.astella_retire_workspace_memories_on_departure(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_retired integer := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('companion-memory-write:' || p_user_id::text, 0)
  );

  INSERT INTO public.assistant_memory_source_suppressions (user_id, kind, source_event_id)
  SELECT DISTINCT user_id, kind, source_event_id
    FROM public.assistant_memory_items
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND scope = 'workspace'
     AND deleted_at IS NULL
     AND source_event_id IS NOT NULL
  ON CONFLICT (user_id, kind, source_event_id) DO NOTHING;

  UPDATE public.assistant_memory_items
     SET deleted_at = now(),
         updated_at = now()
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND scope = 'workspace'
     AND deleted_at IS NULL;

  GET DIAGNOSTICS v_retired = ROW_COUNT;
  RETURN v_retired;
END;
$function$;

--> statement-breakpoint

COMMENT ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid) IS
  '成员退出/被移出时软删除该空间记忆并抑制其来源的再次自动抽取；global 记忆不动。SECURITY DEFINER 用于跨用户清理。';

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid) TO astella_api;
GRANT EXECUTE ON FUNCTION public.astella_retire_workspace_memories_on_departure(uuid, uuid) TO astella_migrator;
