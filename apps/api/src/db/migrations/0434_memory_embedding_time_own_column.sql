-- 0434: 向量记账不再改写记忆的「内容时间」，被抹平的那一批按创建时间复原。
--
-- 为什么要动这一处（2026-10-14 按开发库核对）：`companion-memory-embedding.ts` 落
-- embedding 状态时顺手 `updated_at = now()`，而 0431 的补偿入队又拿
-- `updated_at < now() - interval '1 day'` 当「这条 ready 很久没重算」的判据——两句话
-- 咬成一个循环：每天一次的全量重算把**每一条** ready 记忆的 updated_at 刷成同一分钟，
-- 第二天再全量重算一遍。实测开发库 77 条 ready 记忆的 `updated_at` 全部等于
-- 2026-10-14 00:42，最早的那批是 10-07 建的。
--
-- 后果正落在改版刚修好的那条排序上：目录选取与词法召回都是
-- `ORDER BY matched_terms DESC, pinned DESC, importance DESC, updated_at DESC`
-- （`companion-memory-vector.ts:442`），时效那一路现在恒等，等于没排。她「上周说要
-- 改回普通话」和「三个月前说要河南话」在判据上同 weight。
--
-- 修法：向量侧的时间自己记一列（`embedding_checked_at`），入队判据用它；内容时间还给
-- `updated_at`。已刷平的那批只有两种来历——从没改过内容（`revision = 1`，占绝大多数）
-- 与真改过（有版本行，时间从版本行取），两种都能算回真值，不猜。
--
-- 与 0431 同一套授权形状：函数体重建后 privilege 仍在 pg_proc 那一行上，但
-- dev 库实测过「文件里有不等于库里有」，这里照旧重授一次，并在 roles.sql 的白名单里
-- 已经有对应条目（0431 那次补的），不用再加行。

ALTER TABLE public.assistant_memory_items
  ADD COLUMN IF NOT EXISTS embedding_checked_at timestamptz;

--> statement-breakpoint

-- 已有向量行的时间就是它上一次被重算的时间；没有的按「从没被记账过」处理（NULL）。
UPDATE public.assistant_memory_items m
   SET embedding_checked_at = e.updated_at
  FROM public.assistant_memory_embeddings e
 WHERE e.memory_id = m.id
   AND m.embedding_checked_at IS NULL;

--> statement-breakpoint

-- 内容时间复原：`revision = 1` 的那一批从建出来就没改过内容（版本行表没有逐次时间列，
-- 改过的算不回真值），所以它们的内容时间就是创建时间。开发库里这一类是 76 条，
-- `revision > 1` 的 7 条**不动**——猜一个时间比留着那个被刷平的值更容易被她引用错。
UPDATE public.assistant_memory_items
   SET updated_at = created_at
 WHERE deleted_at IS NULL
   AND embedding_status = 'ready'
   AND revision = 1
   AND updated_at > created_at;

--> statement-breakpoint

-- 补偿入队改看向量自己那列时间；判据其余部分与 0431 逐字一致。
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
        OR (m.embedding_status = 'failed'
            AND COALESCE(m.embedding_checked_at, m.updated_at) < now() - interval '1 hour')
        OR (m.embedding_status = 'ready'
            AND COALESCE(m.embedding_checked_at, m.updated_at) < now() - interval '1 day'
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

--> statement-breakpoint

-- 「最近哪条被重算过」按向量自己的时间查，不再借内容时间。
CREATE INDEX IF NOT EXISTS assistant_memory_items_embedding_checked_idx
  ON public.assistant_memory_items (workspace_id, user_id, embedding_checked_at)
  WHERE embedding_status = 'ready' AND deleted_at IS NULL;
