-- 0431: 向量记忆的补偿重建走 SECURITY DEFINER 入队函数。
--
-- 为什么要动这一处：worker 的补偿调度器 `tickCompanionMemoryEmbeddingScheduler`
-- 是**跨账号**扫 `assistant_memory_items` 再替每个待补的账号排一次重建任务。
-- 它跑在 worker 的裸连接池上，`app.workspace_id` / `app.user_id` 都没设，
-- 而 0098 那条 RESTRICTIVE 策略 `sec01_v1_jobs_insert_actor_guard` 要求
-- `requested_by = current_setting('app.user_id')` —— 于是那句 INSERT 每一轮都抛
-- "new row violates row-level security policy"，又被调用方的 warn-only catch 咽掉。
-- 结果：写入侧的 `memory-embedding:<jobId>` 那条路正常（用户确认记忆时当场排），
-- 而**所有历史遗留的 pending 向量永远不会有人补**（实测开发库 151 条记忆里
-- ready 只有写入侧刚带上的那几条，其余 100 条一直躺在 pending）。
--
-- 修法沿用仓库里已经成立的形状：把「谁该补 + 排队」整段搬进 SECURITY DEFINER
-- 函数，由函数属主落库，worker 只负责按时叫它一次
-- （同 `astella_enqueue_companion_reflection` 0400、`astella_companion_memory_organize` 0361）。
-- 选行条件与幂等键逐字保持调度器原来那一份，不改语义。

CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_memory_embedding_repair()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_enqueued integer := 0;
BEGIN
  WITH eligible AS (
    SELECT DISTINCT m.workspace_id, m.user_id,
      CASE
        WHEN m.embedding_status = 'ready' THEN 'daily'
        ELSE 'retry'
      END AS bucket
    FROM public.assistant_memory_items m
    JOIN public.user_ai_settings s ON s.user_id = m.user_id
    WHERE m.deleted_at IS NULL
      AND m.candidate = false
      AND s.consent_at IS NOT NULL
      AND s.consent_version IS NOT NULL
      AND (
        m.embedding_status IN ('none', 'pending')
        OR (m.embedding_status = 'failed' AND m.updated_at < now() - interval '1 hour')
        OR (m.embedding_status = 'ready' AND m.updated_at < now() - interval '1 day'
          AND EXISTS (
            SELECT 1 FROM public.assistant_memory_embeddings e
             WHERE e.memory_id = m.id
               AND e.workspace_id = m.workspace_id
               AND e.user_id = m.user_id
          ))
      )
  ),
  queued AS (
    INSERT INTO public.jobs
      (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
    SELECT 'companion_memory_embedding_rebuild', e.workspace_id, e.user_id,
      jsonb_build_object('userId', e.user_id), 'pending', 10, 'maintenance',
      'memory-embedding-scheduler:' || e.user_id::text || ':' || e.bucket || ':' ||
      CASE WHEN e.bucket = 'daily' THEN to_char(date_trunc('day', now()), 'YYYY-MM-DD')
           ELSE to_char(date_trunc('hour', now()), 'YYYY-MM-DD-HH24') END
    FROM eligible e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.jobs j
       WHERE j.workspace_id = e.workspace_id
         AND j.type = 'companion_memory_embedding_rebuild'
         AND j.requested_by = e.user_id
         AND j.status IN ('pending', 'running')
         AND j.scheduled_at > now() - interval '1 day'
    )
    ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
  )
  SELECT count(*)::integer INTO v_enqueued FROM queued;

  RETURN v_enqueued;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_enqueue_companion_memory_embedding_repair() FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_memory_embedding_repair() TO astella_worker;
