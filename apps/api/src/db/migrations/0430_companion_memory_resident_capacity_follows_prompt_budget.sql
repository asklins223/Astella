-- 0430: 常驻记忆档的准入改为跟随提示词侧声明的容量。
--
-- 为什么动这个函数：0344 把常驻档钉在「6 条 / 320 tok / 1,000 B」三条线上，
-- 而注入侧（`workers/ai-worker/src/handlers/companion-context-orchestrator.ts`）
-- 的常驻容量是**按本轮声明的 token 预算**算的（8,000 × 0.8 = 6,400 tok）。
-- 两边不是一个数：用户明确说过的事第 7 条被拒，理由是"容量满了"，
-- 可她的上下文里那条位置本来还空着 6,000 多 tok。
--
-- 现在只剩一条判据：本轮装得下就准入。条数与字节数不再各自设卡
-- （它们本来就是 token 的代理，代理两条就等于三条线互相打架）。
-- 函数体其余部分逐字沿用 0344，只换这一处闸门与它回给你的 limits 读数。

CREATE OR REPLACE FUNCTION public.astella_move_companion_memory_budget_tier_v1(
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
     OR (CURRENT_USER = 'astella_api' AND p_actor_type <> 'user')
     OR (CURRENT_USER = 'astella_worker' AND p_actor_type = 'user') THEN
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

    -- 准入只看**一条声明出来的 token 预算**，不再看条数和字节数。
    -- 0344 那三条线（6 条 / 320 tok / 1,000 B）是同一件事的三个代理，而住在最前面的
    -- 那两条（条数、字节）恰恰不是任何地方声明过的容量：伴星提示词侧的常驻容量由
    -- `COMPANION_MEMORY_CONTEXT_ESTIMATE_BUDGET × RESIDENT_MEMORY_BUDGET_SHARE` 给出
    -- （8,000 × 0.8 = 6,400 tok）。写侧 320、注入侧 6,400 两个数各活各的，于是
    -- 「她能不能记住」由一个没人声明过的条数决定，而不是由这轮真能装多少决定。
    IF resident_tokens + requested_tokens > 6400 THEN
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
          'tokenEstimate', 6400
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
